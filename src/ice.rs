//! The ICE servers handed to browsers. The server hosts no STUN or TURN of its own: it
//! names external ones, and for TURN mints or fetches the short-lived credentials they take.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use tokio::sync::Mutex;

use crate::config::Config;

/// One `RTCIceServer`, exactly as a browser takes it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IceServer {
    #[serde(deserialize_with = "one_or_many")]
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

/// `urls` may be a string or a list.
fn one_or_many<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        One(String),
        Many(Vec<String>),
    }
    Ok(match OneOrMany::deserialize(d)? {
        OneOrMany::One(s) => vec![s],
        OneOrMany::Many(v) => v,
    })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct IceConfig {
    #[serde(rename = "iceServers")]
    pub ice_servers: Vec<IceServer>,
    /// Unix seconds after which the TURN credentials stop working; absent when nothing
    /// expires. The page asks for fresh ones before connecting past it.
    #[serde(rename = "expiresAt", skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
}

enum Turn {
    None,
    Static {
        urls: Vec<String>,
        username: String,
        credential: String,
    },
    /// Time-limited credentials from a shared secret: the TURN REST scheme coturn
    /// implements as `use-auth-secret`.
    SharedSecret {
        urls: Vec<String>,
        secret: String,
        ttl: Duration,
    },
}

struct Cloudflare {
    key_id: String,
    api_token: String,
    ttl: Duration,
    url_base: String,
}

#[derive(Default)]
struct CloudflareCache {
    servers: Vec<IceServer>,
    expires_at: u64,
    refresh_at: Option<Instant>,
}

pub struct IceProvider {
    stun: Vec<String>,
    turn: Turn,
    cloudflare: Option<Cloudflare>,
    cache: Mutex<CloudflareCache>,
    http: reqwest::Client,
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// coturn's REST credential: the username is `<expiry>:<user>`, the password the
/// base64 HMAC-SHA1 of the username under the shared secret.
pub fn rest_credential(secret: &str, expires_at: u64, user: &str) -> (String, String) {
    let username = format!("{expires_at}:{user}");
    let mut mac =
        Hmac::<Sha1>::new_from_slice(secret.as_bytes()).expect("HMAC takes any key length");
    mac.update(username.as_bytes());
    (username, BASE64.encode(mac.finalize().into_bytes()))
}

/// A URL on port 53: browsers block it, so it would only ever time out.
fn on_port_53(url: &str) -> bool {
    let rest = url.split_once(':').map_or(url, |(_, r)| r);
    let hostport = rest.split('?').next().unwrap_or(rest);
    hostport
        .rsplit_once(':')
        .is_some_and(|(_, port)| port == "53")
}

impl IceProvider {
    pub fn from_config(cfg: &Config) -> Self {
        let stun = cfg
            .stun_urls
            .iter()
            .filter(|u| !u.is_empty())
            .cloned()
            .collect();
        let turn = match (&cfg.turn_username, &cfg.turn_credential, &cfg.turn_secret) {
            _ if cfg.turn_urls.is_empty() => Turn::None,
            (Some(u), Some(c), _) => Turn::Static {
                urls: cfg.turn_urls.clone(),
                username: u.clone(),
                credential: c.clone(),
            },
            (_, _, Some(secret)) => Turn::SharedSecret {
                urls: cfg.turn_urls.clone(),
                secret: secret.clone(),
                ttl: cfg.turn_ttl(),
            },
            _ => Turn::None,
        };
        let cloudflare = match (&cfg.cloudflare_turn_key_id, &cfg.cloudflare_turn_api_token) {
            (Some(key_id), Some(api_token)) => Some(Cloudflare {
                key_id: key_id.clone(),
                api_token: api_token.clone(),
                ttl: cfg.turn_ttl(),
                url_base: "https://rtc.live.cloudflare.com/v1/turn/keys".into(),
            }),
            _ => None,
        };
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .user_agent(concat!("uploadmyshit/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("the HTTP client builds");
        IceProvider {
            stun,
            turn,
            cloudflare,
            cache: Mutex::new(CloudflareCache::default()),
            http,
        }
    }

    /// A one-line description for the startup log, with no secret in it.
    pub fn describe(&self) -> String {
        let turn = match &self.turn {
            Turn::None => "none".to_string(),
            Turn::Static { urls, .. } => format!("{} url(s), static credentials", urls.len()),
            Turn::SharedSecret { urls, ttl, .. } => {
                format!(
                    "{} url(s), shared-secret credentials for {}s",
                    urls.len(),
                    ttl.as_secs()
                )
            }
        };
        let cf = if self.cloudflare.is_some() {
            ", Cloudflare TURN"
        } else {
            ""
        };
        format!("stun: {} url(s); turn: {turn}{cf}", self.stun.len())
    }

    /// The ICE configuration for one device. TURN credentials are minted per device where
    /// the scheme allows it, so a leaked one names who it was given to.
    pub async fn config(&self, peer_id: &str) -> IceConfig {
        let mut servers = Vec::new();
        let mut expires_at: Option<u64> = None;
        if !self.stun.is_empty() {
            servers.push(IceServer {
                urls: self.stun.clone(),
                username: None,
                credential: None,
            });
        }
        match &self.turn {
            Turn::None => {}
            Turn::Static {
                urls,
                username,
                credential,
            } => servers.push(IceServer {
                urls: urls.clone(),
                username: Some(username.clone()),
                credential: Some(credential.clone()),
            }),
            Turn::SharedSecret { urls, secret, ttl } => {
                let exp = now_unix() + ttl.as_secs();
                let (username, credential) = rest_credential(secret, exp, peer_id);
                servers.push(IceServer {
                    urls: urls.clone(),
                    username: Some(username),
                    credential: Some(credential),
                });
                expires_at = Some(exp);
            }
        }
        if self.cloudflare.is_some() {
            let (cf, exp) = self.cloudflare_servers().await;
            if !cf.is_empty() {
                expires_at = Some(expires_at.map_or(exp, |e| e.min(exp)));
            }
            for mut server in cf {
                server
                    .urls
                    .retain(|u| !servers.iter().any(|s| s.urls.contains(u)));
                if !server.urls.is_empty() {
                    servers.push(server);
                }
            }
        }
        IceConfig {
            ice_servers: servers,
            expires_at,
        }
    }

    /// Cloudflare's ICE servers, fetched once and shared until half their lifetime has
    /// passed. A failed fetch keeps serving the last ones while they are still valid and is
    /// retried after 30 s, never on every connection.
    async fn cloudflare_servers(&self) -> (Vec<IceServer>, u64) {
        let Some(cf) = &self.cloudflare else {
            return (Vec::new(), 0);
        };
        let mut cache = self.cache.lock().await;
        let due = cache.refresh_at.is_none_or(|t| Instant::now() >= t);
        if due {
            match self.fetch_cloudflare(cf).await {
                Ok(servers) => {
                    cache.servers = servers;
                    cache.expires_at = now_unix() + cf.ttl.as_secs();
                    cache.refresh_at = Some(Instant::now() + cf.ttl / 2);
                    tracing::info!(
                        servers = cache.servers.len(),
                        "fetched Cloudflare TURN credentials"
                    );
                }
                Err(e) => {
                    tracing::warn!(error = %e, "Cloudflare TURN credentials could not be fetched");
                    cache.refresh_at = Some(Instant::now() + Duration::from_secs(30));
                }
            }
        }
        if cache.expires_at > now_unix() + 60 {
            (cache.servers.clone(), cache.expires_at)
        } else {
            (Vec::new(), 0)
        }
    }

    async fn fetch_cloudflare(&self, cf: &Cloudflare) -> Result<Vec<IceServer>, String> {
        #[derive(Deserialize)]
        struct Reply {
            #[serde(rename = "iceServers")]
            ice_servers: OneOrManyServers,
        }
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum OneOrManyServers {
            Many(Vec<IceServer>),
            One(IceServer),
        }
        let url = format!(
            "{}/{}/credentials/generate-ice-servers",
            cf.url_base, cf.key_id
        );
        let resp = self
            .http
            .post(url)
            .bearer_auth(&cf.api_token)
            .json(&serde_json::json!({ "ttl": cf.ttl.as_secs() }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "HTTP {status}: {}",
                body.chars().take(200).collect::<String>()
            ));
        }
        let reply: Reply = resp.json().await.map_err(|e| e.to_string())?;
        let servers = match reply.ice_servers {
            OneOrManyServers::Many(v) => v,
            OneOrManyServers::One(s) => vec![s],
        };
        Ok(servers
            .into_iter()
            .map(|mut s| {
                s.urls.retain(|u| !on_port_53(u));
                s
            })
            .filter(|s| !s.urls.is_empty())
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    fn provider(args: &[&str]) -> IceProvider {
        let mut argv = vec!["uploadmyshit"];
        argv.extend_from_slice(args);
        let cfg = Config::try_parse_from(argv).unwrap();
        cfg.validate().unwrap();
        IceProvider::from_config(&cfg)
    }

    #[test]
    fn rest_credentials_match_coturn() {
        // printf '%s' '1700000000:peer1' | openssl dgst -sha1 -hmac 'not-a-real-secret' -binary | base64
        let (u, p) = rest_credential("not-a-real-secret", 1_700_000_000, "peer1");
        assert_eq!(u, "1700000000:peer1");
        assert_eq!(p, "mYi7Bqe2so72AioGeQ+WlYFGaHg=");
    }

    #[test]
    fn port_53_detection() {
        assert!(on_port_53("turn:turn.cloudflare.com:53?transport=udp"));
        assert!(on_port_53("stun:example.com:53"));
        assert!(!on_port_53("turn:turn.cloudflare.com:3478?transport=udp"));
        assert!(!on_port_53("turns:turn.cloudflare.com:5349?transport=tcp"));
        assert!(!on_port_53("stun:stun53.example.com"));
    }

    #[tokio::test]
    async fn stun_only_by_default() {
        let ice = provider(&[]).config("p").await;
        assert_eq!(ice.ice_servers.len(), 1);
        assert!(ice.ice_servers[0].username.is_none());
        assert_eq!(ice.expires_at, None);
        let json = serde_json::to_string(&ice).unwrap();
        assert!(json.starts_with(r#"{"iceServers":[{"urls":["stun:"#));
    }

    #[tokio::test]
    async fn shared_secret_credentials_are_per_peer_and_expire() {
        let p = provider(&[
            "--turn-urls=turn:t.example.com:3478",
            "--turn-secret=s",
            "--stun-urls=",
        ]);
        let ice = p.config("peer9").await;
        assert_eq!(ice.ice_servers.len(), 1);
        let s = &ice.ice_servers[0];
        let user = s.username.as_deref().unwrap();
        assert!(user.ends_with(":peer9"));
        let exp: u64 = user.split(':').next().unwrap().parse().unwrap();
        assert_eq!(Some(exp), ice.expires_at);
        assert!(exp > now_unix() + 86_000);
        assert_eq!(
            s.credential.as_deref().unwrap(),
            rest_credential("s", exp, "peer9").1
        );
    }

    #[tokio::test]
    async fn static_credentials_pass_through() {
        let p = provider(&[
            "--turn-urls=turns:t.example.com:443",
            "--turn-username=u",
            "--turn-credential=c",
        ]);
        let ice = p.config("x").await;
        assert_eq!(ice.ice_servers[1].username.as_deref(), Some("u"));
        assert_eq!(ice.ice_servers[1].credential.as_deref(), Some("c"));
        assert_eq!(ice.expires_at, None);
    }

    #[test]
    fn cloudflare_reply_shapes_parse() {
        let many: Vec<IceServer> = serde_json::from_str(
            r#"[{"urls":["stun:stun.cloudflare.com:3478"]},{"urls":["turn:turn.cloudflare.com:3478?transport=udp"],"username":"u","credential":"c"}]"#,
        )
        .unwrap();
        assert_eq!(many.len(), 2);
        let one: IceServer =
            serde_json::from_str(r#"{"urls":"turn:x:3478","username":"u","credential":"c"}"#)
                .unwrap();
        assert_eq!(one.urls, vec!["turn:x:3478".to_string()]);
    }
}
