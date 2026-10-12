//! The page itself, compiled into the binary, plus the small HTTP endpoints beside it.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use axum::Json;
use axum::extract::{Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::AppState;

/// `web/`. A debug build reads it from disk at every request, so editing the page needs a
/// reload, not a rebuild; a release build carries it inside the binary.
#[derive(RustEmbed)]
#[folder = "web/"]
struct Assets;

/// What every page file's URL is prefixed with: `/v/<this>/`, a hash of the whole of
/// `web/`. A change to any file makes new URLs, so a cache in front (Cloudflare rewrites
/// `no-cache` on scripts to four hours) can never mix a new page with old scripts. A debug
/// build reads `web/` from disk, so it hashes again each time; a release build once.
pub fn asset_version() -> String {
    #[cfg(debug_assertions)]
    {
        compute_version()
    }
    #[cfg(not(debug_assertions))]
    {
        static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        VERSION.get_or_init(compute_version).clone()
    }
}

fn compute_version() -> String {
    let mut paths: Vec<_> = Assets::iter().collect();
    paths.sort();
    let mut h = Sha256::new();
    for p in paths {
        if let Some(f) = Assets::get(&p) {
            h.update(p.as_bytes());
            h.update(f.metadata.sha256_hash());
        }
    }
    hex(&h.finalize()[..6])
}

/// The page, with its scripts and stylesheet pointed at this version's URLs.
fn versioned_page(html: &[u8], version: &str) -> Vec<u8> {
    String::from_utf8_lossy(html)
        .replace("\"/js/", &format!("\"/v/{version}/js/"))
        .replace("\"/css/", &format!("\"/v/{version}/css/"))
        .into_bytes()
}

/// Serves a file from `web/`. A path with no file extension that matches nothing is a
/// page route (`/r/<code>`), and gets index.html.
///
/// Under `/v/<version>/` a file is the same file, cached for a year: the URL changes with
/// the content. A version this server does not have (an old and a new pod side by side
/// during a rollout) still gets the file, but marked never to be stored.
pub async fn asset(uri: Uri, headers: HeaderMap) -> Response {
    let version = asset_version();
    let raw = uri.path().trim_start_matches('/');
    let (path, cache) = match raw.strip_prefix("v/") {
        Some(rest) => {
            let (token, inner) = rest.split_once('/').unwrap_or((rest, ""));
            let cache = if token == version {
                "public, max-age=31536000, immutable"
            } else {
                "private, no-store"
            };
            (inner, cache)
        }
        None => (raw, "no-cache"),
    };
    let path = if path.is_empty() { "index.html" } else { path };
    let (path, file) = match Assets::get(path) {
        Some(f) => (path, f),
        None if !path.rsplit('/').next().unwrap_or("").contains('.') => {
            match Assets::get("index.html") {
                Some(f) => ("index.html", f),
                None => return StatusCode::NOT_FOUND.into_response(),
            }
        }
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    let page = path == "index.html";
    // The page names this version's URLs, so it is never cached, and its ETag covers both.
    let cache = if page { "no-cache" } else { cache };
    let hash = file.metadata.sha256_hash();
    let etag = if page {
        format!("\"{}-{version}\"", hex(&hash[..8]))
    } else {
        format!("\"{}\"", hex(&hash[..12]))
    };
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        == Some(etag.as_str())
    {
        return (
            StatusCode::NOT_MODIFIED,
            [
                (header::ETAG, etag),
                (header::CACHE_CONTROL, cache.to_string()),
            ],
        )
            .into_response();
    }
    let mime = match path.rsplit('.').next() {
        Some("js" | "mjs") => "text/javascript; charset=utf-8".to_string(),
        Some("html") => "text/html; charset=utf-8".to_string(),
        Some("css") => "text/css; charset=utf-8".to_string(),
        Some("webmanifest") => "application/manifest+json".to_string(),
        _ => mime_guess::from_path(path)
            .first_or_octet_stream()
            .to_string(),
    };
    let body = if page {
        versioned_page(&file.data, &version)
    } else {
        file.data.into_owned()
    };
    (
        [
            (header::CONTENT_TYPE, mime),
            (header::ETAG, etag),
            (header::CACHE_CONTROL, cache.to_string()),
        ],
        body,
    )
        .into_response()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A host header value safe to repeat inside a Content-Security-Policy.
fn safe_host(headers: &HeaderMap) -> Option<&str> {
    let host = headers.get(header::HOST)?.to_str().ok()?;
    let ok = !host.is_empty()
        && host.len() <= 255
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':' | b'[' | b']'));
    ok.then_some(host)
}

/// Headers every response carries. The page loads nothing from anywhere else, and its one
/// connection is the signaling WebSocket back to this host.
/// The origin of a ws:// or wss:// URL (`wss://host:port`), when it is safe to repeat
/// inside a Content-Security-Policy.
pub fn ws_origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme != "ws" && scheme != "wss" {
        return None;
    }
    let host = rest.split(['/', '?', '#']).next()?;
    let ok = !host.is_empty()
        && host.len() <= 255
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':' | b'[' | b']'));
    ok.then(|| format!("{scheme}://{host}"))
}

pub async fn security_headers(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Response {
    let mut connect = match safe_host(req.headers()) {
        Some(host) => format!("'self' wss://{host} ws://{host}"),
        None => "'self'".to_string(),
    };
    // The page also connects to the relay Worker, when there is one.
    if let Some(origin) = state.cfg.relay_url.as_deref().and_then(ws_origin) {
        connect.push(' ');
        connect.push_str(&origin);
    }
    let mut resp = next.run(req).await;
    let h = resp.headers_mut();
    let csp = format!(
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; \
         connect-src {connect}; worker-src 'self'; manifest-src 'self'; base-uri 'none'; \
         form-action 'none'; frame-ancestors 'none'"
    );
    if let Ok(v) = HeaderValue::from_str(&csp) {
        h.insert(header::CONTENT_SECURITY_POLICY, v);
    }
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(
        "cross-origin-opener-policy",
        HeaderValue::from_static("same-origin"),
    );
    h.insert(
        "permissions-policy",
        HeaderValue::from_static("camera=(), microphone=(), geolocation=(), payment=(), usb=()"),
    );
    resp
}

#[cfg(test)]
mod tests {
    use super::ws_origin;

    #[test]
    fn relay_origins() {
        assert_eq!(
            ws_origin("wss://relay.example.workers.dev").as_deref(),
            Some("wss://relay.example.workers.dev")
        );
        assert_eq!(
            ws_origin("ws://127.0.0.1:8787/v1/x").as_deref(),
            Some("ws://127.0.0.1:8787")
        );
        assert_eq!(ws_origin("https://relay.example.com"), None);
        assert_eq!(ws_origin("wss://bad host; script-src *"), None);
    }
}

#[derive(Deserialize)]
pub struct QrQuery {
    d: String,
}

/// A QR code for a room link, as SVG, so a phone can join by pointing its camera.
pub async fn qr(Query(q): Query<QrQuery>) -> Response {
    if q.d.is_empty() || q.d.len() > 512 {
        return (StatusCode::BAD_REQUEST, "d must be 1 to 512 bytes").into_response();
    }
    let code = match qrcode::QrCode::with_error_correction_level(q.d.as_bytes(), qrcode::EcLevel::M)
    {
        Ok(c) => c,
        Err(_) => return (StatusCode::BAD_REQUEST, "cannot encode").into_response(),
    };
    let svg = code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(240, 240)
        .quiet_zone(true)
        .dark_color(qrcode::render::svg::Color("#111111"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build();
    (
        [
            (header::CONTENT_TYPE, "image/svg+xml"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        svg,
    )
        .into_response()
}

/// Liveness: the process answers.
pub async fn healthz(State(state): State<Arc<AppState>>) -> Response {
    Json(serde_json::json!({
        "status": "ok",
        "version": crate::VERSION,
        "stats": state.hub.stats(),
    }))
    .into_response()
}

/// Readiness: false from the moment shutdown starts, so the load balancer sends new
/// visitors elsewhere while this one finishes.
pub async fn readyz(State(state): State<Arc<AppState>>) -> Response {
    if state.draining.load(Ordering::Relaxed) {
        (StatusCode::SERVICE_UNAVAILABLE, "draining").into_response()
    } else {
        (StatusCode::OK, "ready").into_response()
    }
}
