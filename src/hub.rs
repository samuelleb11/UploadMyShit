//! Rooms and the devices in them, in memory. A device is in exactly one room; it hears who
//! joins and leaves that room, and can pass signaling messages to the others in it and to
//! no one else.
//!
//! One mutex guards everything. Signaling is a few messages per device per connection, so
//! contention is not worth the complexity of anything finer, and nothing awaits under it:
//! every delivery is a `try_send` into the connection's own queue.

use std::collections::HashMap;
use std::fmt;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, MutexGuard};

use axum::extract::ws::Utf8Bytes;
use serde_json::value::RawValue;
use tokio::sync::{Notify, mpsc};

use crate::protocol::{PeerInfo, ServerMsg};

/// What a connection's writer sends. Text is shared bytes, so a broadcast serializes once.
#[derive(Debug)]
pub enum Outbound {
    Text(Utf8Bytes),
    /// Say goodbye with this reason and close.
    Close(&'static str),
}

/// The handle the hub keeps for one connection.
#[derive(Clone)]
pub struct Link {
    pub tx: mpsc::Sender<Outbound>,
    /// Notified when the connection's queue overflows: a client that does not read is cut
    /// off rather than buffered for.
    pub kill: Arc<Notify>,
    pub conn: u64,
}

impl Link {
    fn deliver(&self, msg: Outbound) {
        if self.tx.try_send(msg).is_err() {
            self.kill.notify_one();
        }
    }
}

struct Member {
    info: PeerInfo,
    link: Link,
}

#[derive(Default)]
struct Inner {
    rooms: HashMap<String, HashMap<String, Member>>,
    /// Peer id to the key of the room it is in.
    locations: HashMap<String, String>,
    per_ip: HashMap<IpAddr, usize>,
    connections: usize,
    next_conn: u64,
}

impl Inner {
    fn broadcast(&self, room: &str, except: &str, text: &Utf8Bytes) {
        if let Some(members) = self.rooms.get(room) {
            for (id, m) in members {
                if id != except {
                    m.link.deliver(Outbound::Text(text.clone()));
                }
            }
        }
    }

    /// Takes a member out of its room, tells the room, and drops the room once empty.
    fn remove(&mut self, id: &str) -> Option<Member> {
        let room = self.locations.remove(id)?;
        let members = self.rooms.get_mut(&room)?;
        let member = members.remove(id)?;
        if members.is_empty() {
            self.rooms.remove(&room);
        } else {
            let text = ServerMsg::PeerLeft { id }.to_json().into();
            self.broadcast(&room, id, &text);
        }
        Some(member)
    }
}

pub struct Hub {
    inner: Mutex<Inner>,
    max_room_peers: usize,
    max_connections: usize,
    max_per_ip: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub enum HubError {
    ServerFull,
    TooManyFromAddress,
    RoomFull,
    UnknownPeer,
}

impl fmt::Display for HubError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            HubError::ServerFull => "the server is at its connection limit",
            HubError::TooManyFromAddress => "too many connections from this address",
            HubError::RoomFull => "this room is full",
            HubError::UnknownPeer => "that device is not in your room",
        })
    }
}

impl HubError {
    pub fn code(&self) -> &'static str {
        match self {
            HubError::ServerFull => "server-full",
            HubError::TooManyFromAddress => "too-many-connections",
            HubError::RoomFull => "room-full",
            HubError::UnknownPeer => "unknown-peer",
        }
    }
}

/// A counted connection. Dropping it gives its slot back.
pub struct Admission {
    hub: Arc<Hub>,
    ip: IpAddr,
    pub conn: u64,
}

impl Drop for Admission {
    fn drop(&mut self) {
        let mut g = self.hub.lock();
        g.connections = g.connections.saturating_sub(1);
        if let Some(n) = g.per_ip.get_mut(&self.ip) {
            *n -= 1;
            if *n == 0 {
                g.per_ip.remove(&self.ip);
            }
        }
    }
}

#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct HubStats {
    pub connections: usize,
    pub peers: usize,
    pub rooms: usize,
}

impl Hub {
    pub fn new(max_room_peers: usize, max_connections: usize, max_per_ip: usize) -> Self {
        Hub {
            inner: Mutex::new(Inner::default()),
            max_room_peers,
            max_connections,
            max_per_ip,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // Nothing under this lock can leave the maps half-updated, so a panic elsewhere
        // while it was held leaves usable data behind.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Counts a new connection from `ip`, or refuses it at either limit.
    pub fn admit(self: &Arc<Self>, ip: IpAddr) -> Result<Admission, HubError> {
        let mut g = self.lock();
        if g.connections >= self.max_connections {
            return Err(HubError::ServerFull);
        }
        let from_ip = g.per_ip.get(&ip).copied().unwrap_or(0);
        if from_ip >= self.max_per_ip {
            return Err(HubError::TooManyFromAddress);
        }
        g.connections += 1;
        g.per_ip.insert(ip, from_ip + 1);
        g.next_conn += 1;
        let conn = g.next_conn;
        Ok(Admission {
            hub: Arc::clone(self),
            ip,
            conn,
        })
    }

    /// Puts a device in a room and returns who else is there. The same peer id connecting
    /// again (a reconnect, or a duplicated tab) replaces the older connection, which is told
    /// `replaced` and closed.
    pub fn join(&self, room: &str, info: PeerInfo, link: Link) -> Result<Vec<PeerInfo>, HubError> {
        let mut g = self.lock();
        let previous_room = g.locations.get(&info.id).cloned();
        let rejoin = previous_room.as_deref() == Some(room);
        let occupied = g.rooms.get(room).map_or(0, |m| m.len());
        if !rejoin && occupied >= self.max_room_peers {
            return Err(HubError::RoomFull);
        }
        if let Some(prev) = previous_room {
            let old = if rejoin {
                g.locations.remove(&info.id);
                g.rooms.get_mut(&prev).and_then(|m| m.remove(&info.id))
            } else {
                g.remove(&info.id)
            };
            if let Some(old) = old {
                old.link.deliver(Outbound::Close("replaced"));
            }
        }
        let members = g.rooms.entry(room.to_string()).or_default();
        let others: Vec<PeerInfo> = members.values().map(|m| m.info.clone()).collect();
        let text: Utf8Bytes = if rejoin {
            ServerMsg::PeerUpdated { peer: &info }.to_json().into()
        } else {
            ServerMsg::PeerJoined { peer: &info }.to_json().into()
        };
        let id = info.id.clone();
        members.insert(id.clone(), Member { info, link });
        g.locations.insert(id.clone(), room.to_string());
        g.broadcast(room, &id, &text);
        Ok(others)
    }

    /// Takes a device out of its room, unless a newer connection has replaced this one.
    pub fn leave(&self, id: &str, conn: u64) {
        let mut g = self.lock();
        let current = g
            .locations
            .get(id)
            .and_then(|room| g.rooms.get(room))
            .and_then(|m| m.get(id))
            .map(|m| m.link.conn);
        if current == Some(conn) {
            g.remove(id);
        }
    }

    /// Passes a signaling message to a device in the sender's room.
    pub fn relay(&self, from: &str, to: &str, data: &RawValue) -> Result<(), HubError> {
        let g = self.lock();
        let room = g.locations.get(from).ok_or(HubError::UnknownPeer)?;
        if from == to || g.locations.get(to) != Some(room) {
            return Err(HubError::UnknownPeer);
        }
        let target = g
            .rooms
            .get(room)
            .and_then(|m| m.get(to))
            .ok_or(HubError::UnknownPeer)?;
        let text = ServerMsg::Signal { from, data }.to_json().into();
        target.link.deliver(Outbound::Text(text));
        Ok(())
    }

    /// Changes a device's display name and tells its room.
    pub fn rename(&self, id: &str, conn: u64, name: String) -> Option<PeerInfo> {
        let mut g = self.lock();
        let room = g.locations.get(id)?.clone();
        let member = g.rooms.get_mut(&room)?.get_mut(id)?;
        if member.link.conn != conn {
            return None;
        }
        member.info.name = name;
        let info = member.info.clone();
        let text = ServerMsg::PeerUpdated { peer: &info }.to_json().into();
        g.broadcast(&room, id, &text);
        Some(info)
    }

    /// Asks every connection to close with `reason`.
    pub fn close_all(&self, reason: &'static str) {
        let g = self.lock();
        for m in g.rooms.values().flat_map(|r| r.values()) {
            m.link.deliver(Outbound::Close(reason));
        }
    }

    pub fn stats(&self) -> HubStats {
        let g = self.lock();
        HubStats {
            connections: g.connections,
            peers: g.locations.len(),
            rooms: g.rooms.len(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::DeviceInfo;

    fn peer(id: &str) -> PeerInfo {
        PeerInfo {
            id: id.into(),
            name: format!("Name {id}"),
            device: DeviceInfo::default(),
        }
    }

    fn link(conn: u64) -> (Link, mpsc::Receiver<Outbound>) {
        let (tx, rx) = mpsc::channel(16);
        (
            Link {
                tx,
                kill: Arc::new(Notify::new()),
                conn,
            },
            rx,
        )
    }

    fn texts(rx: &mut mpsc::Receiver<Outbound>) -> Vec<String> {
        let mut out = Vec::new();
        while let Ok(m) = rx.try_recv() {
            out.push(match m {
                Outbound::Text(t) => t.to_string(),
                Outbound::Close(r) => format!("close:{r}"),
            });
        }
        out
    }

    #[test]
    fn join_announces_and_lists() {
        let hub = Hub::new(10, 100, 10);
        let (la, mut ra) = link(1);
        assert!(hub.join("r", peer("a"), la).unwrap().is_empty());
        let (lb, mut rb) = link(2);
        let others = hub.join("r", peer("b"), lb).unwrap();
        assert_eq!(others, vec![peer("a")]);
        let got = texts(&mut ra);
        assert_eq!(got.len(), 1);
        assert!(got[0].starts_with(r#"{"t":"peer-joined","peer":{"id":"b""#));
        assert!(texts(&mut rb).is_empty());

        hub.leave("b", 2);
        assert_eq!(
            texts(&mut ra),
            vec![r#"{"t":"peer-left","id":"b"}"#.to_string()]
        );
        assert_eq!(hub.stats().peers, 1);
        hub.leave("a", 1);
        assert_eq!(hub.stats().rooms, 0);
    }

    #[test]
    fn relay_stays_inside_the_room() {
        let hub = Hub::new(10, 100, 10);
        let (la, _ra) = link(1);
        let (lb, mut rb) = link(2);
        let (lc, mut rc) = link(3);
        hub.join("r1", peer("a"), la).unwrap();
        hub.join("r1", peer("b"), lb).unwrap();
        hub.join("r2", peer("c"), lc).unwrap();
        let data = RawValue::from_string(r#"{"x":1}"#.into()).unwrap();
        hub.relay("a", "b", &data).unwrap();
        assert_eq!(
            texts(&mut rb),
            vec![r#"{"t":"signal","from":"a","data":{"x":1}}"#.to_string()]
        );
        assert_eq!(hub.relay("a", "c", &data), Err(HubError::UnknownPeer));
        assert_eq!(hub.relay("a", "a", &data), Err(HubError::UnknownPeer));
        assert_eq!(hub.relay("a", "zz", &data), Err(HubError::UnknownPeer));
        assert!(texts(&mut rc).is_empty());
    }

    #[test]
    fn reconnect_replaces_the_old_connection() {
        let hub = Hub::new(10, 100, 10);
        let (la, mut ra) = link(1);
        let (la2, _ra2) = link(2);
        let (lb, mut rb) = link(3);
        hub.join("r", peer("b"), lb).unwrap();
        hub.join("r", peer("a"), la).unwrap();
        texts(&mut rb);
        hub.join("r", peer("a"), la2).unwrap();
        assert_eq!(texts(&mut ra), vec!["close:replaced".to_string()]);
        // The room hears an update, not a leave and a join.
        let got = texts(&mut rb);
        assert_eq!(got.len(), 1);
        assert!(got[0].starts_with(r#"{"t":"peer-updated""#));
        // The replaced connection leaving later changes nothing.
        hub.leave("a", 1);
        assert_eq!(hub.stats().peers, 2);
        hub.leave("a", 2);
        assert_eq!(hub.stats().peers, 1);
    }

    #[test]
    fn moving_rooms_leaves_the_old_one() {
        let hub = Hub::new(10, 100, 10);
        let (la, _ra) = link(1);
        let (la2, _ra2) = link(2);
        let (lb, mut rb) = link(3);
        hub.join("r1", peer("b"), lb).unwrap();
        hub.join("r1", peer("a"), la).unwrap();
        texts(&mut rb);
        hub.join("r2", peer("a"), la2).unwrap();
        assert_eq!(
            texts(&mut rb),
            vec![r#"{"t":"peer-left","id":"a"}"#.to_string()]
        );
    }

    #[test]
    fn limits() {
        let hub = Arc::new(Hub::new(1, 2, 1));
        let ip: IpAddr = "192.0.2.1".parse().unwrap();
        let first = hub.admit(ip).unwrap();
        assert_eq!(hub.admit(ip).err(), Some(HubError::TooManyFromAddress));
        let other = hub.admit("192.0.2.2".parse().unwrap()).unwrap();
        assert_eq!(
            hub.admit("192.0.2.3".parse().unwrap()).err(),
            Some(HubError::ServerFull)
        );
        drop(first);
        drop(other);
        assert_eq!(hub.stats().connections, 0);
        assert!(hub.admit(ip).is_ok());

        let (la, _ra) = link(1);
        let (lb, _rb) = link(2);
        hub.join("r", peer("a"), la).unwrap();
        assert_eq!(hub.join("r", peer("b"), lb).err(), Some(HubError::RoomFull));
    }

    #[test]
    fn overflowing_queue_trips_the_kill_switch() {
        let hub = Hub::new(10, 100, 10);
        let (tx, _rx) = mpsc::channel(1);
        let kill = Arc::new(Notify::new());
        hub.join(
            "r",
            peer("a"),
            Link {
                tx,
                kill: kill.clone(),
                conn: 1,
            },
        )
        .unwrap();
        let (lb, _rb) = link(2);
        let (lc, _rc) = link(3);
        hub.join("r", peer("b"), lb).unwrap(); // fills a's queue
        hub.join("r", peer("c"), lc).unwrap(); // overflows it
        let notified = kill.notified();
        tokio::pin!(notified);
        assert!(futures_util::FutureExt::now_or_never(notified).is_some());
    }

    #[test]
    fn rename_broadcasts() {
        let hub = Hub::new(10, 100, 10);
        let (la, _ra) = link(1);
        let (lb, mut rb) = link(2);
        hub.join("r", peer("a"), la).unwrap();
        hub.join("r", peer("b"), lb).unwrap();
        assert_eq!(hub.rename("a", 1, "New".into()).unwrap().name, "New");
        assert!(texts(&mut rb)[0].contains(r#""name":"New""#));
        assert!(hub.rename("a", 99, "Stale".into()).is_none());
    }
}
