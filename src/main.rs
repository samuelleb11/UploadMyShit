use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::atomic::Ordering;
use std::time::Duration;

use clap::Parser;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;
use uploadmyshit::config::{Config, LogFormat};
use uploadmyshit::{AppState, VERSION, router};

#[tokio::main]
async fn main() -> ExitCode {
    let cfg = Config::parse();
    let filter = EnvFilter::try_from_env("UMS_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    match cfg.log_format {
        LogFormat::Text => tracing_subscriber::fmt().with_env_filter(filter).init(),
        LogFormat::Json => tracing_subscriber::fmt()
            .json()
            .with_env_filter(filter)
            .init(),
    }
    if let Err(e) = cfg.validate() {
        tracing::error!("{e}");
        return ExitCode::from(2);
    }

    let listener = match TcpListener::bind(cfg.bind).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("cannot listen on {}: {e}", cfg.bind);
            return ExitCode::FAILURE;
        }
    };
    let state = AppState::new(cfg);
    tracing::info!(
        version = VERSION,
        bind = %state.cfg.bind,
        network_rooms = state.cfg.network_rooms,
        client_ip_header = state.cfg.client_ip_header.as_deref().unwrap_or("-"),
        ice = %state.ice.describe(),
        relay = %state.relay.as_ref().map_or("none".to_string(), |r| r.describe()),
        "listening"
    );

    let shutdown = {
        let state = state.clone();
        async move {
            wait_for_signal().await;
            state.draining.store(true, Ordering::Relaxed);
            let delay = Duration::from_secs(state.cfg.shutdown_delay);
            tracing::info!(
                "stopping: readiness off, closing connections in {}s",
                delay.as_secs()
            );
            tokio::time::sleep(delay).await;
            // Pages reconnect, to the replacement if there is one. Transfers already
            // running are browser to browser and carry on without this server.
            state.hub.close_all("restart");
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    };
    let app = router(state).into_make_service_with_connect_info::<SocketAddr>();
    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await
    {
        tracing::error!("server error: {e}");
        return ExitCode::FAILURE;
    }
    tracing::info!("stopped");
    ExitCode::SUCCESS
}

async fn wait_for_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler installs");
        tokio::select! {
            _ = ctrl_c => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = ctrl_c.await;
    }
}
