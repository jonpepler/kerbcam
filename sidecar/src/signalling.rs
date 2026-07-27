//! HTTP signalling endpoint. Two endpoints + the bundled web UI:
//!
//! - `GET /cameras` returns a JSON list of currently-attached cameras
//!   (with `part_title`, `vessel_name`, etc); the browser fetches this
//!   to populate its picker before opening a peer connection.
//! - `POST /offer` takes `{ sdp, cameras: [flight_id, ...] }`, creates a
//!   `KerbcastPeer` with one video track per selected camera AND a
//!   "kerbcast-control" data channel, answers the SDP, and returns the
//!   answer. Unknown camera IDs are dropped with a warning rather than
//!   failing the whole request.
//! - `GET /` serves the bundled kerbcast web UI (web/dist/index.html,
//!   embedded at compile time via include_str!).
//! - `GET /assets/mediabunny.min.mjs` serves the Mediabunny remux-trim
//!   package the web page's grouped-recording flow dynamic-imports (also
//!   embedded at compile time, from web/dist/assets/mediabunny.min.mjs --
//!   see web/vite.config.ts's copyMediabunnyAsset step). Kept out of
//!   index.html's own single-file bundle so a page load that never touches
//!   grouped recording never pays for it; served locally so the trim works
//!   offline/LAN with no CDN.
//!
//! Per-camera operational state (layer mask, render size, future zoom)
//! is no longer exposed over HTTP — it's owned by the data channel
//! protocol in `crate::protocol`. The protocol is bidirectional so the
//! sidecar can also push state changes back (adaptive shed events,
//! vessel changes) without the client polling.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};
use tracing::{info, warn};

use crate::cameras::{CameraInfo, CameraRegistry, StatusLogEntry};
use crate::encoder::EncoderChoice;
use crate::webrtc::KerbcastPeer;

#[derive(Clone)]
pub struct AppState {
    pub registry: Arc<CameraRegistry>,
    pub peers: Arc<RwLock<Vec<Arc<KerbcastPeer>>>>,
    /// Carried through so peers and the consume loop initialise encoders
    /// against the same settings. Encoders themselves live in the
    /// registry; AppState just plumbs the configuration.
    pub encoder_choice: EncoderChoice,
    pub fps: u32,
    pub bitrate_bps: u32,
}

#[derive(Debug, Deserialize)]
pub struct OfferRequest {
    pub sdp: String,
    /// flight IDs the browser wants tracks for. With no `slots` field, empty
    /// = subscribe to every currently-known camera (the dev test page). With
    /// `slots` set (the dynamic model) these are the *initial* subscription
    /// bound to the first slots; empty then means "no initial subscription".
    #[serde(default)]
    pub cameras: Vec<u32>,
    /// Slot-pool size = the number of recv-only video transceivers in the
    /// offer. Absent (older clients) → one slot per initial camera, i.e. the
    /// old one-track-per-camera behaviour. When set, spare slots beyond the
    /// initial subscription stay idle until a runtime `Subscribe`.
    #[serde(default)]
    pub slots: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct AnswerResponse {
    pub sdp: String,
    /// Echo of the cameras actually subscribed (after filtering unknown
    /// IDs). The browser uses this to render the right number of video
    /// elements.
    pub cameras: Vec<u32>,
}

#[derive(Debug, Serialize)]
pub struct CamerasResponse {
    pub cameras: Vec<CameraInfo>,
}

#[derive(Debug, Serialize)]
pub struct DumpLogsResponse {
    pub entries: Vec<StatusLogEntry>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(serve_index))
        .route("/assets/mediabunny.min.mjs", get(serve_mediabunny))
        .route("/health", get(health))
        .route("/cameras", get(cameras))
        .route("/offer", post(offer))
        .route("/dumpLogs", get(dump_logs))
        .route("/dumpLogs/reset", post(reset_logs))
        .route("/profile", get(profile))
        .route("/profile/render", post(profile_render))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state)
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok\n")
}

async fn serve_index() -> impl IntoResponse {
    (
        StatusCode::OK,
        [("content-type", "text/html; charset=utf-8")],
        include_str!("../../web/dist/index.html"),
    )
}

/// Serves the Mediabunny bundle the embedded page's grouped-recording trim
/// dynamic-imports (`web/src/mediabunnyAsset.ts`). Mirrors `serve_index`:
/// embedded at compile time, no filesystem read at request time.
async fn serve_mediabunny() -> impl IntoResponse {
    (
        StatusCode::OK,
        [("content-type", "text/javascript; charset=utf-8")],
        include_str!("../../web/dist/assets/mediabunny.min.mjs"),
    )
}

async fn cameras(State(state): State<AppState>) -> impl IntoResponse {
    let list = state.registry.list().await;
    (StatusCode::OK, Json(CamerasResponse { cameras: list })).into_response()
}

/// Serves the plugin's latest `global.status.json` (the per-phase render/
/// readback timings + GC counters written when `EnableTelemetry` is on).
/// The sidecar runs on the same machine as KSP, so this is the egress for
/// reading that Deck-local tmpfs file remotely — hit it per scene to build a
/// profile. Returns 404 with a hint when the file isn't there yet (telemetry
/// off, or no camera has rendered).
async fn profile(State(state): State<AppState>) -> impl IntoResponse {
    let path = state.registry.shm_dir().join("global.status.json");
    match tokio::fs::read_to_string(&path).await {
        Ok(body) => (
            StatusCode::OK,
            [("content-type", "application/json")],
            body,
        )
            .into_response(),
        Err(e) => (
            StatusCode::NOT_FOUND,
            format!(
                "no telemetry at {}: {e} \
                 (is EnableTelemetry=true and a camera rendering? try POST /profile/render?on=true)",
                path.display()
            ),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct RenderParams {
    /// true → keep every live camera subscribed so it renders without a peer
    /// (profiling); false → release the override, back to normal.
    pub on: bool,
}

/// Profiling override: force the plugin to render every camera (full per-frame
/// cost) without a streaming client, so per-scene perf can be measured from
/// anywhere. Render-only — no peer means no encode, so this isolates the
/// plugin's KSP-frametime cost. `POST /profile/render?on=true` to engage,
/// `?on=false` to release.
async fn profile_render(
    State(state): State<AppState>,
    axum::extract::Query(params): axum::extract::Query<RenderParams>,
) -> impl IntoResponse {
    state.registry.set_force_render(params.on);
    (StatusCode::OK, format!("force_render = {}\n", params.on)).into_response()
}

/// Returns every `global.status.json` snapshot the sidecar has seen
/// since the last `POST /dumpLogs/reset` (or since startup). The
/// harness fires this after `[BASELINE-DONE]` to capture the full
/// kspFps / shedLevel / per-camera timeline without polling during
/// the measurement window. Dedup-by-equality keeps the buffer small.
async fn dump_logs(State(state): State<AppState>) -> impl IntoResponse {
    let entries = state.registry.dump_run_logs().await;
    (StatusCode::OK, Json(DumpLogsResponse { entries })).into_response()
}

/// Clears the in-memory status-log ring. The harness fires this
/// immediately before AG1 so each run gets a clean window.
async fn reset_logs(State(state): State<AppState>) -> impl IntoResponse {
    state.registry.reset_run_logs().await;
    (StatusCode::OK, "ok\n")
}

async fn offer(State(state): State<AppState>, Json(req): Json<OfferRequest>) -> impl IntoResponse {
    match handle_offer(state, req).await {
        Ok(resp) => (StatusCode::OK, Json(resp)).into_response(),
        Err(e) => {
            warn!(error = %e, "offer handling failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("offer handling failed: {e}"),
            )
                .into_response()
        }
    }
}

async fn handle_offer(state: AppState, req: OfferRequest) -> anyhow::Result<AnswerResponse> {
    // Resolve selection: if the browser didn't ask for specific cameras,
    // subscribe to all of them. Useful for the v0.2 test page which
    // populates the picker from /cameras but lets the user click
    // "connect to all" without an explicit selection.
    // Legacy/test-page path: no explicit pool size AND no cameras = subscribe
    // to all. With an explicit `slots` (the dynamic model), an empty `cameras`
    // means "no initial subscription".
    let requested: Vec<u32> = if req.slots.is_none() && req.cameras.is_empty() {
        state
            .registry
            .list()
            .await
            .iter()
            .map(|c| c.flight_id)
            .collect()
    } else {
        req.cameras
    };

    // Pool size = the offer's recv-only video transceiver count. Absent
    // (older clients) → one slot per initial camera (the old behaviour).
    let slot_count = req.slots.map(|s| s as usize).unwrap_or(requested.len());

    let peer = Arc::new(KerbcastPeer::new(state.registry.clone(), &requested, slot_count).await?);
    let answer_sdp = peer.answer_to_offer(req.sdp).await?;
    let subscribed = peer.subscribed.clone();

    let peer_count = {
        let mut peers = state.peers.write().await;
        peers.push(peer);
        peers.len()
    };
    info!(
        peer_count,
        cameras = ?subscribed,
        "peer registered, returning answer",
    );

    Ok(AnswerResponse {
        sdp: answer_sdp,
        cameras: subscribed,
    })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use tower::ServiceExt;

    use super::*;

    /// An `AppState` with no attached cameras or peers -- enough to exercise
    /// the static routes (`/`, `/assets/mediabunny.min.mjs`, `/health`),
    /// which read no registry/peer state.
    fn empty_state() -> AppState {
        AppState {
            registry: Arc::new(CameraRegistry::new(PathBuf::from("/tmp"))),
            peers: Arc::new(RwLock::new(Vec::new())),
            encoder_choice: EncoderChoice::Auto,
            fps: 30,
            bitrate_bps: 2_000_000,
        }
    }

    #[tokio::test]
    async fn serves_mediabunny_with_the_right_content_type_and_a_nonempty_body() {
        let app = router(empty_state());
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/assets/mediabunny.min.mjs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let content_type = response
            .headers()
            .get("content-type")
            .expect("content-type header")
            .to_str()
            .unwrap();
        assert!(
            content_type.starts_with("text/javascript"),
            "unexpected content-type: {content_type}",
        );

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        // The real pre-minified Mediabunny bundle is several hundred KB; a
        // missing/truncated embed would be nowhere close, so this also
        // guards against an accidentally-empty include_str!.
        assert!(
            body.len() > 400_000,
            "expected the real Mediabunny bundle, got {} bytes",
            body.len(),
        );
    }

    #[tokio::test]
    async fn serves_index_html_at_the_root() {
        let app = router(empty_state());
        let response = app
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let content_type = response
            .headers()
            .get("content-type")
            .expect("content-type header")
            .to_str()
            .unwrap();
        assert!(content_type.starts_with("text/html"));

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert!(!body.is_empty());
        // index.html must stay lean: nowhere near Mediabunny's own bundle
        // size, i.e. it was never inlined into the single-file page.
        assert!(
            body.len() < 500_000,
            "index.html grew to {} bytes -- did Mediabunny get inlined?",
            body.len(),
        );
    }
}
