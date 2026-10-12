//! The signaling protocol: JSON text frames, each an object with a `t` (type) field.
//!
//! The server only introduces devices to each other and passes their WebRTC negotiation
//! along. What `signal` carries is opaque to it; file bytes never reach it at all.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::ice::IceConfig;

/// Bumped when a change would break an older page talking to a newer server.
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug)]
pub enum ClientMsg {
    /// The first frame. `secret` is the browser tab's own random token: the peer id is
    /// derived from it, so a reconnecting tab keeps its id and nobody else can take it.
    Hello {
        secret: String,
        /// A private room's code. Absent: the visitor's network room.
        room: Option<String>,
        name: Option<String>,
        device: Option<DeviceInfo>,
    },
    /// WebRTC negotiation for one other device in the same room.
    Signal {
        to: String,
        data: Box<RawValue>,
    },
    Rename {
        name: String,
    },
    /// Fresh ICE servers, for TURN credentials close to expiring.
    GetIce,
    /// Keep-alive. Browsers cannot see WebSocket pings, so the page sends its own.
    Ping,
}

/// Every field any client message has, flat. serde cannot hand a `RawValue` through an
/// internally tagged enum (it buffers the content first), so frames parse into this and
/// convert.
#[derive(Deserialize)]
struct Frame {
    t: String,
    secret: Option<String>,
    room: Option<String>,
    name: Option<String>,
    device: Option<DeviceInfo>,
    to: Option<String>,
    data: Option<Box<RawValue>>,
}

impl ClientMsg {
    pub fn parse(text: &str) -> Result<ClientMsg, String> {
        let f: Frame = serde_json::from_str(text).map_err(|e| e.to_string())?;
        let missing = |field: &str| format!("{} needs {field}", f.t);
        Ok(match f.t.as_str() {
            "hello" => ClientMsg::Hello {
                secret: f.secret.clone().ok_or_else(|| missing("secret"))?,
                room: f.room,
                name: f.name,
                device: f.device,
            },
            "signal" => ClientMsg::Signal {
                to: f.to.clone().ok_or_else(|| missing("to"))?,
                data: f.data.ok_or_else(|| format!("{} needs data", f.t))?,
            },
            "rename" => ClientMsg::Rename {
                name: f.name.clone().ok_or_else(|| missing("name"))?,
            },
            "get-ice" => ClientMsg::GetIce,
            "ping" => ClientMsg::Ping,
            other => return Err(format!("unknown message type {other:?}")),
        })
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeviceInfo {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub os: String,
    #[serde(default)]
    pub browser: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PeerInfo {
    pub id: String,
    pub name: String,
    pub device: DeviceInfo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RoomInfo {
    /// Everyone behind the same public address.
    Network,
    /// A shared link.
    Private { code: String },
    /// Network rooms are turned off and no code was given: alone until joining one.
    None,
}

#[derive(Debug, Serialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum ServerMsg<'a> {
    Welcome {
        protocol: u32,
        version: &'a str,
        id: &'a str,
        name: &'a str,
        room: RoomInfo,
        ice: &'a IceConfig,
        peers: Vec<PeerInfo>,
    },
    PeerJoined {
        peer: &'a PeerInfo,
    },
    PeerLeft {
        id: &'a str,
    },
    PeerUpdated {
        peer: &'a PeerInfo,
    },
    Signal {
        from: &'a str,
        data: &'a RawValue,
    },
    Ice {
        ice: &'a IceConfig,
    },
    Pong,
    Error {
        code: &'a str,
        message: &'a str,
    },
    /// The server is closing this connection: `replaced` (the same tab connected again),
    /// `restart` (the server is stopping; reconnect).
    Bye {
        reason: &'a str,
    },
}

impl ServerMsg<'_> {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("server messages always serialize")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_messages_parse() {
        let m = ClientMsg::parse(
            r#"{"t":"hello","secret":"abc","room":"xyz1","device":{"kind":"desktop","os":"macOS","browser":"Chrome"}}"#,
        )
        .unwrap();
        assert!(matches!(m, ClientMsg::Hello { room: Some(ref r), .. } if r == "xyz1"));
        let m = ClientMsg::parse(r#"{"t":"signal","to":"p1","data":{"sdp":{"type":"offer"}}}"#)
            .unwrap();
        match m {
            ClientMsg::Signal { to, data } => {
                assert_eq!(to, "p1");
                assert_eq!(data.get(), r#"{"sdp":{"type":"offer"}}"#);
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(matches!(
            ClientMsg::parse(r#"{"t":"get-ice"}"#).unwrap(),
            ClientMsg::GetIce
        ));
        assert!(ClientMsg::parse(r#"{"t":"nope"}"#).is_err());
        assert!(ClientMsg::parse(r#"{"t":"signal","to":"p1"}"#).is_err());
        assert!(ClientMsg::parse(r#"{"t":"hello"}"#).is_err());
        assert!(ClientMsg::parse("not json").is_err());
    }

    #[test]
    fn server_messages_serialize() {
        let peer = PeerInfo {
            id: "a".into(),
            name: "Calm Otter".into(),
            device: DeviceInfo::default(),
        };
        let json = ServerMsg::PeerJoined { peer: &peer }.to_json();
        assert_eq!(
            json,
            r#"{"t":"peer-joined","peer":{"id":"a","name":"Calm Otter","device":{"kind":"","os":"","browser":""}}}"#
        );
        let room = serde_json::to_string(&RoomInfo::Private {
            code: "abcd".into(),
        })
        .unwrap();
        assert_eq!(room, r#"{"kind":"private","code":"abcd"}"#);
    }
}
