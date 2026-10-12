//! The signaling server end to end, over real WebSocket connections.

use std::net::SocketAddr;
use std::time::Duration;

use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use uploadmyshit::config::Config;
use uploadmyshit::{AppState, router};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn start(args: &[&str]) -> SocketAddr {
    let mut argv = vec!["uploadmyshit"];
    argv.extend_from_slice(args);
    let cfg = Config::try_parse_from(argv).unwrap();
    cfg.validate().unwrap();
    let state = AppState::new(cfg);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(
            listener,
            router(state).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    addr
}

async fn connect(addr: SocketAddr) -> Ws {
    connect_async(format!("ws://{addr}/ws")).await.unwrap().0
}

async fn send(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(v.to_string().into())).await.unwrap();
}

async fn recv(ws: &mut Ws) -> Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("a message within 5 s")
            .expect("the connection is open")
            .unwrap();
        match msg {
            Message::Text(t) => return serde_json::from_str(&t).unwrap(),
            Message::Ping(_) | Message::Pong(_) => continue,
            other => panic!("unexpected frame {other:?}"),
        }
    }
}

async fn hello(addr: SocketAddr, secret: &str, room: Option<&str>, name: &str) -> (Ws, Value) {
    let mut ws = connect(addr).await;
    send(
        &mut ws,
        json!({"t": "hello", "secret": secret, "room": room, "name": name,
        "device": {"kind": "desktop", "os": "macOS", "browser": "Chrome"}}),
    )
    .await;
    let welcome = recv(&mut ws).await;
    assert_eq!(welcome["t"], "welcome", "{welcome}");
    (ws, welcome)
}

#[tokio::test]
async fn devices_on_one_network_find_each_other_and_signal() {
    let addr = start(&[]).await;
    let (mut a, wa) = hello(addr, "secret-a-0123456789", None, "Alpha").await;
    assert_eq!(wa["room"]["kind"], "network");
    assert_eq!(wa["peers"], json!([]));
    assert_eq!(
        wa["ice"]["iceServers"][0]["urls"][0],
        "stun:stun.cloudflare.com:3478"
    );
    let a_id = wa["id"].as_str().unwrap().to_string();

    let (mut b, wb) = hello(addr, "secret-b-0123456789", None, "Bravo").await;
    let b_id = wb["id"].as_str().unwrap().to_string();
    assert_eq!(wb["peers"][0]["id"], a_id.as_str());
    assert_eq!(wb["peers"][0]["name"], "Alpha");

    let joined = recv(&mut a).await;
    assert_eq!(joined["t"], "peer-joined");
    assert_eq!(joined["peer"]["id"], b_id.as_str());
    assert_eq!(joined["peer"]["device"]["browser"], "Chrome");

    // Negotiation passes through untouched.
    let sdp = json!({"description": {"type": "offer", "sdp": "v=0\r\n..."}});
    send(&mut a, json!({"t": "signal", "to": b_id, "data": sdp})).await;
    let got = recv(&mut b).await;
    assert_eq!(got, json!({"t": "signal", "from": a_id, "data": sdp}));

    // Rename reaches the other side.
    send(&mut b, json!({"t": "rename", "name": "  Bravo  Two "})).await;
    assert_eq!(recv(&mut b).await["peer"]["name"], "Bravo Two");
    let updated = recv(&mut a).await;
    assert_eq!(updated["t"], "peer-updated");
    assert_eq!(updated["peer"]["name"], "Bravo Two");

    send(&mut a, json!({"t": "ping"})).await;
    assert_eq!(recv(&mut a).await, json!({"t": "pong"}));

    b.close(None).await.unwrap();
    assert_eq!(recv(&mut a).await, json!({"t": "peer-left", "id": b_id}));
}

#[tokio::test]
async fn private_rooms_are_isolated() {
    let addr = start(&[]).await;
    let (mut a, wa) = hello(addr, "secret-a-0123456789", Some("Family-42"), "A").await;
    assert_eq!(wa["room"], json!({"kind": "private", "code": "family-42"}));
    let (_n, wn) = hello(addr, "secret-n-0123456789", None, "Net").await;
    assert_eq!(
        wn["peers"],
        json!([]),
        "a network-room device does not see a private room"
    );

    let n_id = wn["id"].as_str().unwrap();
    send(&mut a, json!({"t": "signal", "to": n_id, "data": {}})).await;
    let err = recv(&mut a).await;
    assert_eq!(err["t"], "error");
    assert_eq!(err["code"], "unknown-peer");

    let (_b, wb) = hello(addr, "secret-b-0123456789", Some("family-42"), "B").await;
    assert_eq!(wb["peers"][0]["id"], wa["id"]);
}

#[tokio::test]
async fn reconnecting_tab_keeps_its_id_and_replaces_the_old_socket() {
    let addr = start(&[]).await;
    let (mut other, _) = hello(addr, "secret-o-0123456789", None, "Other").await;
    let (mut first, w1) = hello(addr, "secret-x-0123456789", None, "X").await;
    assert_eq!(recv(&mut other).await["t"], "peer-joined");
    let (_second, w2) = hello(addr, "secret-x-0123456789", None, "X").await;
    assert_eq!(w1["id"], w2["id"]);
    assert_eq!(
        recv(&mut first).await,
        json!({"t": "bye", "reason": "replaced"})
    );
    assert_eq!(recv(&mut other).await["t"], "peer-updated");
}

#[tokio::test]
async fn bad_hellos_are_refused() {
    let addr = start(&[]).await;
    let mut ws = connect(addr).await;
    send(&mut ws, json!({"t": "hello", "secret": "short"})).await;
    assert_eq!(recv(&mut ws).await["code"], "bad-hello");

    let mut ws = connect(addr).await;
    send(&mut ws, json!({"t": "ping"})).await;
    assert_eq!(recv(&mut ws).await["code"], "bad-hello");

    let mut ws = connect(addr).await;
    send(
        &mut ws,
        json!({"t": "hello", "secret": "secret-z-0123456789", "room": "a b"}),
    )
    .await;
    assert_eq!(recv(&mut ws).await["code"], "bad-room");
}

#[tokio::test]
async fn without_network_rooms_a_device_is_alone_until_it_joins_one() {
    let addr = start(&["--network-rooms", "false"]).await;
    let (_a, wa) = hello(addr, "secret-a-0123456789", None, "A").await;
    let (_b, wb) = hello(addr, "secret-b-0123456789", None, "B").await;
    assert_eq!(wa["room"]["kind"], "none");
    assert_eq!(wb["peers"], json!([]));
}

#[tokio::test]
async fn cross_origin_pages_are_refused() {
    let addr = start(&[]).await;
    let mut req = format!("ws://{addr}/ws").into_client_request().unwrap();
    req.headers_mut()
        .insert("origin", "https://evil.example.net".parse().unwrap());
    assert!(connect_async(req).await.is_err());

    let mut req = format!("ws://{addr}/ws").into_client_request().unwrap();
    req.headers_mut()
        .insert("origin", format!("http://{addr}").parse().unwrap());
    assert!(connect_async(req).await.is_ok());
}

#[tokio::test]
async fn turn_credentials_are_minted_per_device() {
    let addr = start(&[
        "--turn-urls=turn:turn.example.com:3478",
        "--turn-secret=topsecret",
    ])
    .await;
    let (mut a, wa) = hello(addr, "secret-a-0123456789", None, "A").await;
    let turn = &wa["ice"]["iceServers"][1];
    assert_eq!(turn["urls"][0], "turn:turn.example.com:3478");
    assert!(
        turn["username"]
            .as_str()
            .unwrap()
            .ends_with(wa["id"].as_str().unwrap())
    );
    assert!(wa["ice"]["expiresAt"].as_u64().is_some());
    send(&mut a, json!({"t": "get-ice"})).await;
    let fresh = recv(&mut a).await;
    assert_eq!(fresh["t"], "ice");
    assert_eq!(fresh["ice"]["iceServers"][1]["urls"], turn["urls"]);
}

async fn http_get(addr: SocketAddr, path: &str) -> String {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let req = format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    tokio::io::AsyncWriteExt::write_all(&mut stream, req.as_bytes())
        .await
        .unwrap();
    let mut buf = Vec::new();
    tokio::io::AsyncReadExt::read_to_end(&mut stream, &mut buf)
        .await
        .unwrap();
    String::from_utf8_lossy(&buf).to_string()
}

#[tokio::test]
async fn http_endpoints() {
    let addr = start(&[]).await;
    let health = http_get(addr, "/healthz").await;
    assert!(health.starts_with("HTTP/1.1 200"), "{health}");
    assert!(health.contains(r#""status":"ok""#));
    let index = http_get(addr, "/").await;
    assert!(index.starts_with("HTTP/1.1 200"));
    assert!(
        index
            .to_ascii_lowercase()
            .contains("content-security-policy: default-src 'none'")
    );
    // A page route falls back to the page; a missing file does not.
    assert!(
        http_get(addr, "/r/some-room")
            .await
            .starts_with("HTTP/1.1 200")
    );
    assert!(
        http_get(addr, "/missing.js")
            .await
            .starts_with("HTTP/1.1 404")
    );
    let qr = http_get(addr, "/api/qr?d=https%3A%2F%2Fexample.com%2Fr%2Fabcd").await;
    assert!(
        qr.starts_with("HTTP/1.1 200") && qr.contains("<svg"),
        "{qr}"
    );
}

/// Against the real Cloudflare API, with the key from the environment:
///   UMS_CLOUDFLARE_TURN_KEY_ID=... UMS_CLOUDFLARE_TURN_API_TOKEN=... cargo test -- --ignored
#[tokio::test]
#[ignore = "needs a Cloudflare TURN key in the environment"]
async fn cloudflare_turn_credentials_live() {
    // Config::parse reads the UMS_CLOUDFLARE_* variables itself.
    let addr = start(&[]).await;
    let (_a, wa) = hello(addr, "secret-a-0123456789", None, "A").await;
    let servers = wa["ice"]["iceServers"].as_array().unwrap();
    let turn = servers
        .iter()
        .find(|s| {
            s["urls"]
                .as_array()
                .unwrap()
                .iter()
                .any(|u| u.as_str().unwrap().starts_with("turn"))
        })
        .unwrap_or_else(|| panic!("no TURN server in {servers:?}"));
    assert!(turn["username"].is_string() && turn["credential"].is_string());
    let on_53 = |u: &str| u.split('?').next().unwrap().ends_with(":53");
    assert!(
        !turn["urls"]
            .as_array()
            .unwrap()
            .iter()
            .any(|u| on_53(u.as_str().unwrap())),
        "{turn}"
    );
    eprintln!(
        "{}",
        serde_json::to_string_pretty(&wa["ice"]["iceServers"])
            .unwrap()
            .replace(turn["credential"].as_str().unwrap(), "<redacted>")
    );
    assert!(wa["ice"]["expiresAt"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn relay_tickets_go_to_both_devices_and_no_one_else() {
    let addr = start(&["--relay-url=wss://relay.example.com", "--relay-secret=k"]).await;
    let (mut a, wa) = hello(addr, "secret-a-0123456789", None, "A").await;
    assert_eq!(wa["relay"], true);
    let (mut b, wb) = hello(addr, "secret-b-0123456789", None, "B").await;
    assert_eq!(recv(&mut a).await["t"], "peer-joined");
    let b_id = wb["id"].as_str().unwrap();

    send(&mut a, json!({"t": "relay", "to": b_id})).await;
    let ta = recv(&mut a).await;
    let tb = recv(&mut b).await;
    assert_eq!(ta["t"], "relay");
    assert_eq!(tb["t"], "relay");
    assert_eq!(ta["session"], tb["session"]);
    assert_eq!(
        (ta["role"].as_str(), tb["role"].as_str()),
        (Some("a"), Some("b"))
    );
    assert_eq!(ta["peer"], b_id);
    assert_eq!(tb["peer"], wa["id"]);
    assert_eq!(ta["url"], "wss://relay.example.com");
    let session = ta["session"].as_str().unwrap();
    let exp = ta["exp"].as_u64().unwrap();
    assert_eq!(
        ta["sig"].as_str().unwrap(),
        uploadmyshit::relay::sign("k", session, exp)
    );

    // A device in another room cannot be reached.
    let (_c, wc) = hello(addr, "secret-c-0123456789", Some("elsewhere"), "C").await;
    send(&mut a, json!({"t": "relay", "to": wc["id"]})).await;
    assert_eq!(recv(&mut a).await["code"], "unknown-peer");
}

#[tokio::test]
async fn without_a_relay_the_server_says_so() {
    let addr = start(&[]).await;
    let (mut a, wa) = hello(addr, "secret-a-0123456789", None, "A").await;
    assert_eq!(wa["relay"], false);
    let (_b, wb) = hello(addr, "secret-b-0123456789", None, "B").await;
    recv(&mut a).await; // peer-joined
    send(&mut a, json!({"t": "relay", "to": wb["id"]})).await;
    assert_eq!(recv(&mut a).await["code"], "no-relay");
}
