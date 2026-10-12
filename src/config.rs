//! Command line and environment configuration. Every flag has a `UMS_*` variable, which is
//! how the container and the Helm chart set them.

use std::net::SocketAddr;
use std::time::Duration;

use clap::{ArgAction, Parser, ValueEnum};

use crate::ip::Cidr;

#[derive(Parser, Debug, Clone)]
#[command(name = "uploadmyshit", version = crate::VERSION, about)]
pub struct Config {
    /// Address and port to listen on.
    #[arg(long, env = "UMS_BIND", default_value = "0.0.0.0:8080")]
    pub bind: SocketAddr,

    /// Header that carries the visitor's address when the TCP peer is a trusted proxy,
    /// e.g. `x-forwarded-for` or `x-real-ip`. Unset: the TCP peer address is the visitor.
    #[arg(long, env = "UMS_CLIENT_IP_HEADER")]
    pub client_ip_header: Option<String>,

    /// Proxies whose client-address header is believed, as comma-separated CIDRs. The
    /// visitor is the right-most address in the header that is not one of these.
    #[arg(long, env = "UMS_TRUSTED_PROXIES", value_delimiter = ',')]
    pub trusted_proxies: Vec<Cidr>,

    /// Put visitors that share a public address (the same NAT) in one automatic room, as
    /// ShareDrop does. Off: only private rooms (shared links) exist.
    #[arg(long, env = "UMS_NETWORK_ROOMS", default_value_t = true, action = ArgAction::Set)]
    pub network_rooms: bool,

    /// IPv4 prefix length that makes up one network room.
    #[arg(long, env = "UMS_IPV4_PREFIX", default_value_t = 32, value_parser = clap::value_parser!(u8).range(8..=32))]
    pub ipv4_prefix: u8,

    /// IPv6 prefix length that makes up one network room (a home LAN is usually one /64).
    #[arg(long, env = "UMS_IPV6_PREFIX", default_value_t = 64, value_parser = clap::value_parser!(u8).range(16..=128))]
    pub ipv6_prefix: u8,

    /// Most devices one room holds.
    #[arg(long, env = "UMS_MAX_ROOM_PEERS", default_value_t = 50)]
    pub max_room_peers: usize,

    /// Most signaling connections the server holds at once.
    #[arg(long, env = "UMS_MAX_CONNECTIONS", default_value_t = 10_000)]
    pub max_connections: usize,

    /// Most signaling connections from one visitor address.
    #[arg(long, env = "UMS_MAX_CONNECTIONS_PER_IP", default_value_t = 64)]
    pub max_connections_per_ip: usize,

    /// STUN servers handed to browsers, comma-separated. Empty list: none.
    #[arg(
        long,
        env = "UMS_STUN_URLS",
        value_delimiter = ',',
        default_value = "stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302"
    )]
    pub stun_urls: Vec<String>,

    /// TURN servers (external) handed to browsers, comma-separated `turn:`/`turns:` URLs.
    /// Needs either --turn-username/--turn-credential or --turn-secret.
    #[arg(long, env = "UMS_TURN_URLS", value_delimiter = ',')]
    pub turn_urls: Vec<String>,

    /// Static TURN username.
    #[arg(long, env = "UMS_TURN_USERNAME")]
    pub turn_username: Option<String>,

    /// Static TURN password.
    #[arg(long, env = "UMS_TURN_CREDENTIAL", hide_env_values = true)]
    pub turn_credential: Option<String>,

    /// Shared secret for time-limited TURN credentials (the TURN REST scheme, coturn's
    /// `use-auth-secret`/`static-auth-secret`).
    #[arg(long, env = "UMS_TURN_SECRET", hide_env_values = true)]
    pub turn_secret: Option<String>,

    /// Lifetime of generated TURN credentials, in seconds. Make it longer than the longest
    /// transfer: a relay cannot refresh its allocation once they expire.
    #[arg(long, env = "UMS_TURN_TTL", default_value_t = 86_400)]
    pub turn_ttl: u64,

    /// Cloudflare Realtime TURN key id. With the API token, the server asks Cloudflare for
    /// short-lived ICE servers and hands those out.
    #[arg(long, env = "UMS_CLOUDFLARE_TURN_KEY_ID")]
    pub cloudflare_turn_key_id: Option<String>,

    /// Cloudflare Realtime TURN key API token.
    #[arg(long, env = "UMS_CLOUDFLARE_TURN_API_TOKEN", hide_env_values = true)]
    pub cloudflare_turn_api_token: Option<String>,

    /// The relay Worker's address (worker/), e.g. `wss://relay.example.workers.dev`. Devices
    /// that cannot connect directly relay through it, and fast transfers add lanes through
    /// it. Unset: no relay.
    #[arg(long, env = "UMS_RELAY_URL")]
    pub relay_url: Option<String>,

    /// The secret the relay Worker checks tickets with (its RELAY_SECRET).
    #[arg(long, env = "UMS_RELAY_SECRET", hide_env_values = true)]
    pub relay_secret: Option<String>,

    /// Lifetime of a relay ticket, in seconds. A ticket opens connections until it expires;
    /// connections already open stay open.
    #[arg(long, env = "UMS_RELAY_TTL", default_value_t = 21_600)]
    pub relay_ttl: u64,

    /// Seconds to keep serving after SIGTERM (readiness already failing) before closing
    /// every signaling connection, so a load balancer stops sending new ones first.
    #[arg(long, env = "UMS_SHUTDOWN_DELAY", default_value_t = 5)]
    pub shutdown_delay: u64,

    /// Log output format.
    #[arg(long, env = "UMS_LOG_FORMAT", value_enum, default_value_t = LogFormat::Text)]
    pub log_format: LogFormat,
}

#[derive(ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogFormat {
    Text,
    Json,
}

impl Config {
    /// Refuses combinations that would hand browsers an ICE configuration they reject.
    pub fn validate(&self) -> Result<(), String> {
        let static_creds = self.turn_username.is_some() || self.turn_credential.is_some();
        if static_creds && self.turn_secret.is_some() {
            return Err(
                "give either --turn-username/--turn-credential or --turn-secret, not both".into(),
            );
        }
        if static_creds && (self.turn_username.is_none() || self.turn_credential.is_none()) {
            return Err("--turn-username and --turn-credential go together".into());
        }
        if !self.turn_urls.is_empty() && !static_creds && self.turn_secret.is_none() {
            return Err("--turn-urls needs --turn-username/--turn-credential or --turn-secret: browsers refuse a TURN server without credentials".into());
        }
        if self.turn_urls.is_empty() && (static_creds || self.turn_secret.is_some()) {
            return Err("TURN credentials were given but --turn-urls is empty".into());
        }
        for url in self.stun_urls.iter().filter(|u| !u.is_empty()) {
            if !(url.starts_with("stun:") || url.starts_with("stuns:")) {
                return Err(format!(
                    "STUN URL {url:?} does not start with stun: or stuns:"
                ));
            }
        }
        for url in &self.turn_urls {
            if !(url.starts_with("turn:") || url.starts_with("turns:")) {
                return Err(format!(
                    "TURN URL {url:?} does not start with turn: or turns:"
                ));
            }
        }
        if self.cloudflare_turn_key_id.is_some() != self.cloudflare_turn_api_token.is_some() {
            return Err(
                "--cloudflare-turn-key-id and --cloudflare-turn-api-token go together".into(),
            );
        }
        if self.client_ip_header.is_some() && self.trusted_proxies.is_empty() {
            return Err(
                "--client-ip-header is only read from --trusted-proxies; give at least one".into(),
            );
        }
        if self.turn_ttl < 600 {
            return Err("--turn-ttl below 600 seconds would expire mid-transfer".into());
        }
        if let Some(url) = &self.relay_url
            && !(url.starts_with("wss://") || url.starts_with("ws://"))
        {
            return Err(format!(
                "--relay-url {url:?} does not start with wss:// or ws://"
            ));
        }
        if self.relay_secret.is_some() && self.relay_url.is_none() {
            return Err("--relay-secret was given but --relay-url is empty".into());
        }
        if self.relay_ttl < 60 {
            return Err("--relay-ttl below 60 seconds leaves no time to connect".into());
        }
        Ok(())
    }

    pub fn turn_ttl(&self) -> Duration {
        Duration::from_secs(self.turn_ttl)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Config {
        let mut argv = vec!["uploadmyshit"];
        argv.extend_from_slice(args);
        Config::try_parse_from(argv).expect("parses")
    }

    #[test]
    fn defaults_are_valid() {
        let cfg = parse(&[]);
        assert!(cfg.validate().is_ok());
        assert!(cfg.network_rooms);
        assert_eq!(cfg.stun_urls.len(), 2);
    }

    #[test]
    fn turn_without_credentials_is_refused() {
        let cfg = parse(&["--turn-urls", "turn:turn.example.com:3478"]);
        assert!(cfg.validate().is_err());
        let cfg = parse(&[
            "--turn-urls",
            "turn:t.example.com",
            "--turn-secret",
            "s3cret",
        ]);
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn mixed_credentials_are_refused() {
        let cfg = parse(&[
            "--turn-urls=turn:t.example.com",
            "--turn-secret=x",
            "--turn-username=u",
            "--turn-credential=p",
        ]);
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn client_ip_header_needs_trusted_proxies() {
        let cfg = parse(&["--client-ip-header", "x-forwarded-for"]);
        assert!(cfg.validate().is_err());
        let cfg = parse(&[
            "--client-ip-header=x-forwarded-for",
            "--trusted-proxies=10.0.0.0/8",
        ]);
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn network_rooms_can_be_turned_off() {
        assert!(!parse(&["--network-rooms", "false"]).network_rooms);
    }

    #[test]
    fn relay_settings() {
        assert!(
            parse(&["--relay-url=wss://relay.example.com"])
                .validate()
                .is_ok()
        );
        assert!(
            parse(&["--relay-url=https://relay.example.com"])
                .validate()
                .is_err()
        );
        assert!(parse(&["--relay-secret=s"]).validate().is_err());
        assert!(
            parse(&["--relay-url=wss://r.example.com", "--relay-ttl=10"])
                .validate()
                .is_err()
        );
    }
}
