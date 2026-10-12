//! One signaling connection: the hello, then a loop that relays what the page sends and
//! writes what the hub queues for it.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use tokio::sync::{Notify, mpsc};
use tokio::time::{MissedTickBehavior, interval, timeout};

use crate::AppState;
use crate::hub::{Admission, Link, Outbound};
use crate::ip;
use crate::names;
use crate::protocol::{ClientMsg, DeviceInfo, PROTOCOL_VERSION, PeerInfo, RoomInfo, ServerMsg};

/// Largest frame the page may send. An SDP offer with every candidate inlined is a few KB.
const MAX_FRAME: usize = 64 * 1024;
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// The page pings every 20 s; a connection silent for this long is gone.
const IDLE_TIMEOUT: Duration = Duration::from_secs(65);
const PING_EVERY: Duration = Duration::from_secs(25);
const OUTBOUND_QUEUE: usize = 256;
/// Token bucket: a burst big enough for a full ICE trickle, a rate no honest page reaches.
const BURST: f64 = 200.0;
const PER_SECOND: f64 = 50.0;
/// Messages dropped for rate before the connection is closed.
const MAX_STRIKES: u32 = 100;

pub async fn handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if state.draining.load(Ordering::Relaxed) {
        return (StatusCode::SERVICE_UNAVAILABLE, "restarting").into_response();
    }
    if !same_origin(&headers) {
        return (StatusCode::FORBIDDEN, "cross-origin connection refused").into_response();
    }
    let ip = state.ip_policy.client_ip(peer, &headers);
    let known = ip::address_known(ip, &headers);
    let admission = match state.hub.admit(ip) {
        Ok(a) => a,
        Err(e) => return (StatusCode::TOO_MANY_REQUESTS, e.to_string()).into_response(),
    };
    ws.max_message_size(MAX_FRAME)
        .max_frame_size(MAX_FRAME)
        .on_upgrade(move |socket| session(socket, state, ip, known, admission))
}

/// A browser always sends Origin on a WebSocket. Refusing other sites' pages keeps one from
/// quietly listing the devices on its visitor's network; a client with no Origin is not a
/// browser and can see no more than it could by connecting itself.
fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return true;
    };
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let origin_host = origin.split_once("://").map_or("", |(_, rest)| rest);
    origin_host.eq_ignore_ascii_case(host)
}

/// The page's id: derived from the tab's secret, so a reconnect keeps it and no one who
/// lacks the secret can claim it.
pub fn peer_id(secret: &str) -> String {
    let digest = Sha256::digest(format!("uploadmyshit/peer/v1\0{secret}").as_bytes());
    digest[..10].iter().map(|b| format!("{b:02x}")).collect()
}

/// A page's connection id, passed through untouched when it is short and plain.
fn opaque_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Once per process: the deployment hides visitors' addresses, so network rooms cannot work
/// until it is fixed. `proxy` is the address the server sees instead, never a visitor's.
fn warn_address_unknown(proxy: IpAddr) {
    static WARNED: AtomicBool = AtomicBool::new(false);
    if !WARNED.swap(true, Ordering::Relaxed) {
        tracing::warn!(
            %proxy,
            "visitors come through Cloudflare, but the address worked out for them is {proxy}, \
             not the one Cloudflare saw: a proxy in between hides it. Network rooms stay off \
             (they would put strangers together) until --client-ip-header is set to \
             cf-connecting-ip (chart: server.clientIpHeader)"
        );
    }
}

fn valid_secret(s: &str) -> bool {
    (16..=128).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

struct Bucket {
    tokens: f64,
    at: Instant,
}

impl Bucket {
    fn new() -> Self {
        Bucket {
            tokens: BURST,
            at: Instant::now(),
        }
    }

    fn take(&mut self) -> bool {
        let now = Instant::now();
        self.tokens =
            (self.tokens + now.duration_since(self.at).as_secs_f64() * PER_SECOND).min(BURST);
        self.at = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

type Sink = SplitSink<WebSocket, Message>;
type Stream = SplitStream<WebSocket>;

async fn next_text(stream: &mut Stream) -> Option<Utf8Bytes> {
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(t) => return Some(t),
            Message::Ping(_) | Message::Pong(_) => continue,
            _ => return None,
        }
    }
    None
}

async fn refuse(mut sink: Sink, code: &str, message: &str) {
    let _ = sink
        .send(Message::Text(
            ServerMsg::Error { code, message }.to_json().into(),
        ))
        .await;
    let _ = sink
        .send(Message::Close(Some(CloseFrame {
            code: 1008,
            reason: code.to_string().into(),
        })))
        .await;
}

/// `known`: whether `ip` is the visitor's own address (ip::address_known), so it can key a
/// network room.
async fn session(
    socket: WebSocket,
    state: Arc<AppState>,
    ip: IpAddr,
    known: bool,
    admission: Admission,
) {
    let (sink, mut stream) = socket.split();
    let hello = match timeout(HELLO_TIMEOUT, next_text(&mut stream)).await {
        Ok(Some(t)) => t,
        _ => return,
    };
    let (secret, room, name, device, page) = match ClientMsg::parse(&hello) {
        Ok(ClientMsg::Hello {
            secret,
            room,
            name,
            device,
            page,
        }) => (secret, room, name, device, page),
        _ => return refuse(sink, "bad-hello", "the first message must be a hello").await,
    };
    if !valid_secret(&secret) {
        return refuse(
            sink,
            "bad-hello",
            "the secret must be 16 to 128 of A-Z a-z 0-9 - _",
        )
        .await;
    }
    let id = peer_id(&secret);
    let (room_key, room_info) = match room.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        Some(raw) => match names::clean_room_code(raw) {
            Some(code) => (format!("room:{code}"), RoomInfo::Private { code }),
            None => return refuse(sink, "bad-room", "a room code is 4 to 64 of a-z 0-9 - _").await,
        },
        None if state.cfg.network_rooms && known => (
            ip::network_room_key(ip, state.cfg.ipv4_prefix, state.cfg.ipv6_prefix),
            RoomInfo::Network,
        ),
        None if state.cfg.network_rooms => {
            warn_address_unknown(ip);
            (format!("solo:{id}"), RoomInfo::AddressUnknown)
        }
        None => (format!("solo:{id}"), RoomInfo::None),
    };
    let name = name
        .as_deref()
        .and_then(names::clean_name)
        .unwrap_or_else(names::random_name);
    let device = device.unwrap_or_default();
    let info = PeerInfo {
        id: id.clone(),
        name: name.clone(),
        device: DeviceInfo {
            kind: names::clean_device_field(&device.kind),
            os: names::clean_device_field(&device.os),
            browser: names::clean_device_field(&device.browser),
        },
        page: page.filter(|p| opaque_id(p)),
    };

    let (tx, rx) = mpsc::channel(OUTBOUND_QUEUE);
    let kill = Arc::new(Notify::new());
    let link = Link {
        tx: tx.clone(),
        kill: kill.clone(),
        conn: admission.conn,
    };
    let peers = match state.hub.join(&room_key, info, link) {
        Ok(p) => p,
        Err(e) => return refuse(sink, e.code(), &e.to_string()).await,
    };
    let ice = state.ice.config(&id).await;
    let assets = crate::web::asset_version();
    let welcome = ServerMsg::Welcome {
        protocol: PROTOCOL_VERSION,
        version: crate::VERSION,
        assets: &assets,
        id: &id,
        name: &name,
        room: room_info,
        ice: &ice,
        relay: state.relay.is_some(),
        peers,
    }
    .to_json();
    tracing::debug!(peer = %id, room = %room_key, "joined");

    // The writer sends the welcome first, then whatever was queued meanwhile, in order.
    let mut writer = tokio::spawn(write_loop(sink, rx, welcome.into()));
    let reply = |msg: ServerMsg<'_>| {
        if tx.try_send(Outbound::Text(msg.to_json().into())).is_err() {
            kill.notify_one();
        }
    };

    let mut bucket = Bucket::new();
    let mut strikes = 0u32;
    loop {
        let msg = tokio::select! {
            m = timeout(IDLE_TIMEOUT, stream.next()) => m,
            _ = kill.notified() => break,
            _ = &mut writer => break,
        };
        let text = match msg {
            Ok(Some(Ok(Message::Text(t)))) => t,
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
            // Closed, binary (not part of the protocol), an error, or silent too long.
            _ => break,
        };
        if !bucket.take() {
            strikes += 1;
            if strikes > MAX_STRIKES {
                break;
            }
            reply(ServerMsg::Error {
                code: "rate-limited",
                message: "too many messages; slow down",
            });
            continue;
        }
        match ClientMsg::parse(&text) {
            Ok(ClientMsg::Signal { to, data }) => {
                if let Err(e) = state.hub.relay(&id, &to, &data) {
                    reply(ServerMsg::Error {
                        code: e.code(),
                        message: &e.to_string(),
                    });
                }
            }
            Ok(ClientMsg::Rename { name }) => match names::clean_name(&name) {
                Some(name) => {
                    if let Some(info) = state.hub.rename(&id, admission.conn, name) {
                        reply(ServerMsg::PeerUpdated { peer: &info });
                    }
                }
                None => reply(ServerMsg::Error {
                    code: "bad-name",
                    message: "that name is empty",
                }),
            },
            Ok(ClientMsg::Relay { to, sid, rsid }) => match &state.relay {
                Some(relay) => {
                    let t = relay.mint();
                    let sid = sid.as_deref().filter(|s| opaque_id(s));
                    let rsid = rsid.as_deref().filter(|s| opaque_id(s));
                    let theirs = ServerMsg::Relay {
                        peer: &id,
                        url: &t.url,
                        session: &t.session,
                        role: "b",
                        exp: t.exp,
                        sig: t.sig.as_deref(),
                        sid,
                        rsid,
                    };
                    match state.hub.send_to(&id, &to, theirs.to_json()) {
                        Ok(()) => reply(ServerMsg::Relay {
                            peer: &to,
                            url: &t.url,
                            session: &t.session,
                            role: "a",
                            exp: t.exp,
                            sig: t.sig.as_deref(),
                            sid,
                            rsid,
                        }),
                        Err(e) => reply(ServerMsg::Error {
                            code: e.code(),
                            message: &e.to_string(),
                        }),
                    }
                }
                None => reply(ServerMsg::Error {
                    code: "no-relay",
                    message: "this server has no relay",
                }),
            },
            Ok(ClientMsg::GetIce) => {
                let ice = state.ice.config(&id).await;
                reply(ServerMsg::Ice { ice: &ice });
            }
            Ok(ClientMsg::Ping) => reply(ServerMsg::Pong),
            Ok(ClientMsg::Hello { .. }) => reply(ServerMsg::Error {
                code: "already-greeted",
                message: "hello is sent once",
            }),
            Err(_) => reply(ServerMsg::Error {
                code: "bad-message",
                message: "unknown or malformed message",
            }),
        }
    }

    state.hub.leave(&id, admission.conn);
    tracing::debug!(peer = %id, "left");
    // Dropping the last sender ends the writer once it has flushed what is queued.
    drop(tx);
    if !writer.is_finished() {
        let _ = timeout(Duration::from_secs(2), &mut writer).await;
        writer.abort();
    }
    drop(admission);
}

async fn write_loop(mut sink: Sink, mut rx: mpsc::Receiver<Outbound>, first: Utf8Bytes) {
    if sink.send(Message::Text(first)).await.is_err() {
        return;
    }
    let mut ping = interval(PING_EVERY);
    ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
    ping.tick().await;
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Some(Outbound::Text(t)) => {
                    if sink.send(Message::Text(t)).await.is_err() {
                        return;
                    }
                }
                Some(Outbound::Close(reason)) => {
                    let _ = sink.send(Message::Text(ServerMsg::Bye { reason }.to_json().into())).await;
                    // 1012: service restart; 1000: normal (replaced by a newer connection).
                    let code = if reason == "restart" { 1012 } else { 1000 };
                    let _ = sink.send(Message::Close(Some(CloseFrame { code, reason: reason.into() }))).await;
                    return;
                }
                None => {
                    let _ = sink.close().await;
                    return;
                }
            },
            _ = ping.tick() => {
                if sink.send(Message::Ping(Default::default())).await.is_err() {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn peer_ids_are_stable_and_distinct() {
        let a = peer_id("aaaaaaaaaaaaaaaaaaaa");
        assert_eq!(a, peer_id("aaaaaaaaaaaaaaaaaaaa"));
        assert_ne!(a, peer_id("aaaaaaaaaaaaaaaaaaab"));
        assert_eq!(a.len(), 20);
    }

    #[test]
    fn secrets() {
        assert!(valid_secret("abcdefghijklmnop"));
        assert!(valid_secret("A-_9xxxxxxxxxxxxxxxx"));
        assert!(!valid_secret("short"));
        assert!(!valid_secret("has space xxxxxxxxxxxxx"));
        assert!(!valid_secret(&"x".repeat(129)));
    }

    #[test]
    fn origin_check() {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_static("drop.example.com"));
        assert!(same_origin(&h), "no Origin: not a browser");
        h.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://drop.example.com"),
        );
        assert!(same_origin(&h));
        h.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://evil.example.net"),
        );
        assert!(!same_origin(&h));
        h.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:8080"),
        );
        h.insert(header::HOST, HeaderValue::from_static("localhost:8080"));
        assert!(same_origin(&h));
    }

    #[test]
    fn bucket_limits_bursts() {
        let mut b = Bucket::new();
        let allowed = (0..1000).filter(|_| b.take()).count();
        assert!((200..=205).contains(&allowed), "{allowed}");
    }
}
