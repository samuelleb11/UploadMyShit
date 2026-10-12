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
        /// The asset version the page's scripts came from (opaque here).
        page: Option<String>,
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
    /// A relay session with one other device in the same room: both get a ticket. `sid` and
    /// `rsid` are the page's own connection ids, opaque here, passed back on both tickets so
    /// each page can tell a ticket for its current connection from a stale one.
    Relay {
        to: String,
        sid: Option<String>,
        rsid: Option<String>,
    },
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
    sid: Option<String>,
    rsid: Option<String>,
    page: Option<String>,
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
                page: f.page,
            },
            "signal" => ClientMsg::Signal {
                to: f.to.clone().ok_or_else(|| missing("to"))?,
                data: f.data.ok_or_else(|| format!("{} needs data", f.t))?,
            },
            "rename" => ClientMsg::Rename {
                name: f.name.clone().ok_or_else(|| missing("name"))?,
            },
            "get-ice" => ClientMsg::GetIce,
            "relay" => ClientMsg::Relay {
                to: f.to.clone().ok_or_else(|| missing("to"))?,
                sid: f.sid,
                rsid: f.rsid,
            },
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
    /// The version of the page that device runs: the others mark it outdated when it is not
    /// the server's. Absent from pages too old to say.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<String>,
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
        /// The page's current asset version (web::asset_version): a tab whose scripts came
        /// from another one is out of date and reloads.
        assets: &'a str,
        id: &'a str,
        name: &'a str,
        room: RoomInfo,
        ice: &'a IceConfig,
        /// Whether a relay Worker is configured (tickets are asked for with `relay`).
        relay: bool,
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
    /// A relay session with `peer`: connect to `<url>/v1/<session>/<role>/<lane>?exp=&sig=`.
    /// The other device gets the same session with the other role.
    Relay {
        peer: &'a str,
        url: &'a str,
        session: &'a str,
        role: &'a str,
        exp: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        sig: Option<&'a str>,
        /// The requesting page's connection ids, as it sent them.
        #[serde(skip_serializing_if = "Option::is_none")]
        sid: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        rsid: Option<&'a str>,
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
        assert!(matches!(
            ClientMsg::parse(r#"{"t":"relay","to":"p2","sid":"s1"}"#).unwrap(),
            ClientMsg::Relay { ref to, sid: Some(ref s), rsid: None } if to == "p2" && s == "s1"
        ));
        assert!(ClientMsg::parse(r#"{"t":"relay"}"#).is_err());
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
            page: None,
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
