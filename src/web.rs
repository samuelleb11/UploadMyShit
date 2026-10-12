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

use crate::AppState;

/// `web/`. A debug build reads it from disk at every request, so editing the page needs a
/// reload, not a rebuild; a release build carries it inside the binary.
#[derive(RustEmbed)]
#[folder = "web/"]
struct Assets;

/// Serves a file from `web/`. A path with no file extension that matches nothing is a
/// page route (`/r/<code>`), and gets index.html.
pub async fn asset(uri: Uri, headers: HeaderMap) -> Response {
    let path = uri.path().trim_start_matches('/');
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
    let hash = file.metadata.sha256_hash();
    let etag = format!("\"{}\"", hex(&hash[..12]));
    // No build step means no hashed file names, so every file is revalidated on each load;
    // the ETag makes that a 304.
    let cache = HeaderValue::from_static("no-cache");
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        == Some(etag.as_str())
    {
        return (
            StatusCode::NOT_MODIFIED,
            [
                (header::ETAG, etag),
                (header::CACHE_CONTROL, cache.to_str().unwrap().to_string()),
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
    (
        [
            (header::CONTENT_TYPE, mime),
            (header::ETAG, etag),
            (header::CACHE_CONTROL, cache.to_str().unwrap().to_string()),
        ],
        file.data,
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
pub async fn security_headers(req: Request, next: Next) -> Response {
    let connect = match safe_host(req.headers()) {
        Some(host) => format!("'self' wss://{host} ws://{host}"),
        None => "'self'".to_string(),
    };
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
