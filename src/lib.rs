//! UploadMyShit's server: it serves the page and introduces browsers to each other over a
//! WebSocket. The files themselves go browser to browser over WebRTC and never touch it.

pub mod config;
pub mod hub;
pub mod ice;
pub mod ip;
pub mod names;
pub mod protocol;
pub mod relay;
pub mod web;
pub mod ws;

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use axum::Router;
use axum::middleware;
use axum::routing::get;

use crate::config::Config;
use crate::hub::Hub;
use crate::ice::IceProvider;
use crate::ip::ClientIpPolicy;
use crate::relay::Relay;

/// `<crate version>+<git commit>`, or `+unknown` when built outside a checkout.
pub const VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), "+", env!("UMS_BUILD_SHA"));

pub struct AppState {
    pub cfg: Config,
    pub hub: Arc<Hub>,
    pub ice: IceProvider,
    pub relay: Option<Relay>,
    pub ip_policy: ClientIpPolicy,
    /// Set once shutdown starts: readiness fails and new connections are refused.
    pub draining: AtomicBool,
}

impl AppState {
    pub fn new(cfg: Config) -> Arc<Self> {
        let hub = Arc::new(Hub::new(
            cfg.max_room_peers,
            cfg.max_connections,
            cfg.max_connections_per_ip,
        ));
        let ice = IceProvider::from_config(&cfg);
        let relay = Relay::from_config(&cfg);
        let ip_policy = ClientIpPolicy {
            header: cfg
                .client_ip_header
                .as_ref()
                .map(|h| h.to_ascii_lowercase()),
            trusted: cfg.trusted_proxies.clone(),
        };
        Arc::new(AppState {
            cfg,
            hub,
            ice,
            relay,
            ip_policy,
            draining: AtomicBool::new(false),
        })
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/ws", get(ws::handler))
        .route("/healthz", get(web::healthz))
        .route("/readyz", get(web::readyz))
        .route("/api/qr", get(web::qr))
        .fallback(web::asset)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            web::security_headers,
        ))
        .with_state(state)
}
