//! Tickets for the relay Worker (worker/relay.js): the way devices that cannot connect
//! directly, or want more bandwidth than a direct connection gives, reach each other.
//!
//! The server never relays anything itself. It names a fresh session for two devices in the
//! same room and signs it; the Worker checks the signature with the same secret.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;

use crate::config::Config;

pub struct Relay {
    url: String,
    secret: Option<String>,
    ttl: Duration,
}

/// What one side needs to connect: the Worker, the session, and the ticket for it.
pub struct Ticket {
    pub url: String,
    pub session: String,
    pub exp: u64,
    /// Absent when the Worker checks no tickets.
    pub sig: Option<String>,
}

/// The Worker's check: base64url (no padding) of HMAC-SHA256 over `<session>.<exp>`.
pub fn sign(secret: &str, session: &str, exp: u64) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC takes any key length");
    mac.update(format!("{session}.{exp}").as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

impl Relay {
    pub fn from_config(cfg: &Config) -> Option<Self> {
        Some(Relay {
            url: cfg.relay_url.as_ref()?.trim_end_matches('/').to_string(),
            secret: cfg.relay_secret.clone(),
            ttl: Duration::from_secs(cfg.relay_ttl),
        })
    }

    /// A new session, unguessable, and its ticket. Both sides of it get the same one.
    pub fn mint(&self) -> Ticket {
        let mut raw = [0u8; 16];
        rand::rng().fill_bytes(&mut raw);
        let session = URL_SAFE_NO_PAD.encode(raw);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let exp = now + self.ttl.as_secs();
        let sig = self.secret.as_deref().map(|s| sign(s, &session, exp));
        Ticket {
            url: self.url.clone(),
            session,
            exp,
            sig,
        }
    }

    pub fn describe(&self) -> String {
        format!(
            "{}, {}",
            self.url,
            if self.secret.is_some() {
                "signed tickets"
            } else {
                "NO tickets: anyone with the URL can relay"
            }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn signature_matches_the_worker() {
        // printf '%s' 'AAAAAAAAAAAAAAAAAAAAAA.1700000000' \
        //   | openssl dgst -sha256 -hmac 'not-a-real-secret' -binary | base64 | tr '+/' '-_' | tr -d '='
        assert_eq!(
            sign("not-a-real-secret", "AAAAAAAAAAAAAAAAAAAAAA", 1_700_000_000),
            "3ut__c_JUvjo4dZ3sahwHKo0VJ5uCDAi3oOHY7WLbpY"
        );
    }

    #[test]
    fn tickets_are_fresh_and_signed() {
        let cfg = Config::try_parse_from([
            "uploadmyshit",
            "--relay-url=wss://relay.example.com/",
            "--relay-secret=k",
        ])
        .unwrap();
        let relay = Relay::from_config(&cfg).unwrap();
        let a = relay.mint();
        let b = relay.mint();
        assert_ne!(a.session, b.session);
        assert_eq!(a.session.len(), 22);
        assert_eq!(a.url, "wss://relay.example.com");
        assert_eq!(
            a.sig.as_deref(),
            Some(sign("k", &a.session, a.exp).as_str())
        );
        let unsigned =
            Config::try_parse_from(["uploadmyshit", "--relay-url=ws://localhost:8787"]).unwrap();
        assert!(Relay::from_config(&unsigned).unwrap().mint().sig.is_none());
        assert!(Relay::from_config(&Config::try_parse_from(["uploadmyshit"]).unwrap()).is_none());
    }
}
