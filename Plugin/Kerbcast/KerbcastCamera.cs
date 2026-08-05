/* Per-Hullcam VDS tracking. Owns Unity Cameras (near / scaled / galaxy,
   plus a spike far-local layer) parented to the part's transform, an
   AsyncGPUReadback request in flight at most, and writes RGBA frames
   into a per-camera mmap ring on each completed readback.

   Layered camera shape matches KSP's flight camera: galaxy renders skybox
   + distant celestials, scaled renders planet terrain/atmosphere at scale,
   far (spike) renders the mid-range terrain band between the near clip and
   the scaled-space handoff, near renders close parts + atmosphere effects.
   All layers target the same RenderTexture so one readback captures the
   composite.

   Render path: all cameras are permanently disabled (enabled=false) so
   Unity's auto-render never fires them. Instead, Refresh() calls
   camera.Render() explicitly each frame in galaxy -> scaled -> far -> near
   order. */
// This prevents KSP's deferred "Composite Shadows" CommandBuffer from
// running against the wrong framebuffer when our cameras render — that
// buffer would otherwise null out sun diffuse on planet surfaces, leaving
// them black while the atmospheric limb (a separate render path) stayed
// bright. ScaledSunLightHelper strips and restores the buffer around the
// Scaled layer's Render() call. Per-layer shedding is now expressed as
// "skip camera.Render() this tick" rather than toggling enabled.
//
// Atmospheric FX: kerbcast's own pluggable plasma overlay (the stock FXCamera
// effect couldn't be faithfully reproduced offscreen — see
// atmospheric_fx_parked.md). A per-camera FxHost owns a set of IAtmoFxEffect
// layers (core sheath, bowshock, trail, embers). The core effect attaches a
// CommandBuffer to _nearCam at AfterForwardAlpha that re-draws the vessel's
// part renderers with our additive plasma material — inside the near render, so
// it composites against the near depth (correct occlusion). See Fx/.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using HullcamVDS;
using UnityEngine;

namespace Kerbcast
{
    internal sealed class KerbcastCamera : ICamera
    {
        public uint FlightId { get; }
        /* Placement + identity + optional zoom/pan capabilities, decoupled from
           MuMechModuleHullCamera. Every former Hullcam read now goes through this. */
        public ICameraMountSource Mount { get; }
        /* Promoted for ICamera: core no longer reaches through Mount directly. */
        public bool OwnsPart(Part part) => Mount.OwnsPart(part);
        public Vessel Vessel => Mount.Vessel;
        /* Part liveness, used by KerbcastCore's churn sweeps. */
        public bool IsAlive => Mount.IsAlive;
        public int MaxWidth { get; }
        public int MaxHeight { get; }
        public int RenderWidth { get; private set; }
        public int RenderHeight { get; private set; }
        /// <summary>Operator-requested render size — ceiling for adaptive
        /// downscale (level 3 halves below this).</summary>
        public int OperatorWidth { get; private set; }
        public int OperatorHeight { get; private set; }

        /// <summary>True when the mount exposes a zoom capability with a
        /// real range (`Mount.Zoom != null` and `FovMax > FovMin`). A
        /// fixed-FoV or zero-width source reports false and hides the zoom
        /// control.</summary>
        public bool SupportsZoom { get; }
        public float FovMin { get; }
        public float FovMax { get; }
        public float Fov { get; private set; }

        /* Consecutive Refresh() exceptions, owned by KerbcastCore's capture
           loop: reset on a clean pass, camera quarantined at the threshold
           so one persistently-broken camera can't break the rest. */
        public int RefreshFailureStreak { get; set; }

        /* Pan capability from the mount (null when the source can't pan). Owns
           the joint resolution + the YawInvert/axis mapping; core keeps the
           target solve, rate integration, slew and clamp, reading the rate
           config + resolved joint through the IPanCapability contract so it
           stays source-agnostic. */
        private readonly IPanCapability _pan;
        public bool SupportsPan => _pan != null;
        public float PanYawMin => _pan != null ? _pan.YawMin : 0f;
        public float PanYawMax => _pan != null ? _pan.YawMax : 0f;
        public float PanPitchMin => _pan != null ? _pan.PitchMin : 0f;
        public float PanPitchMax => _pan != null ? _pan.PitchMax : 0f;
        /// <summary>Current interpolated yaw (degrees). Use this for
        /// status reporting — not the target — so operators see what
        /// is actually on-screen, not the commanded position.</summary>
        public float PanYaw => _panYawCurrent;
        /// <summary>Current interpolated pitch (degrees).</summary>
        public float PanPitch => _panPitchCurrent;

        // Snapshot of identity fields captured at construction. Used by
        // WriteInfoManifest and WriteDestroyedManifest so neither method
        // needs to touch Hullcam.part (which may be null or dying by the
        // time Dispose is called from a part-destruction handler).
        private readonly string _cachedPartName;
        private readonly string _cachedPartTitle;
        private readonly string _cachedCameraName;
        private readonly string _cachedVesselName;

        private Camera _nearCam;
        private Camera _scaledCam;
        private Camera _galaxyCam;
        /* Spike: far-local camera cloned from KSP's "Camera 01". Renders the
           mid-range terrain band between Camera 01's near clip and the
           scaled-space handoff. Null when "Camera 01" is not present. */
        private Camera _farCam;
        // Whether this camera should replicate KSP's atmospheric FX. Set from
        // settings.cfg at construction; flipped at runtime by the control file.
        private bool _enableFx;
        // Visual-mod integration host (TUFX, and Scatterer/EVE/... as they land).
        // Null until SetCameras constructs it. The only mod-aware surface in this class.
        private IntegrationHost _integrationHost;
        // Pluggable atmospheric-FX host for this camera. Owns the enabled FX
        // effects (core sheath, bowshock, …); each effect renders into the near
        // pass. Null until SetCameras builds it.
        private FxHost _fxHost;
        // Which FX layers this camera runs (subject to the _enableFx master).
        private AtmoFxLayers _fxLayers;
        // Reusable capture tail: owns the pooled capture/readback RT pair, the
        // in-flight readback bookkeeping, the ReadbackTargetTracker and the ring
        // write. This camera renders its layer stack into _capture.CaptureRt then
        // hands the blit/flip/readback/produce tail to CaptureCore. Shared with
        // future camera types (kerbal-face) so the streaming path stays one impl.
        private CaptureCore _capture;
        // Cached blit delegate for _capture.Publish (assigned once, no per-frame
        // closure allocation on the hot path).
        private readonly Action<RenderTexture, RenderTexture> _captureBlit;
        private readonly MmapFrameRing _ring;
        private readonly string _ringPath;
        private readonly string _infoPath;
        private readonly string _controlPath;
        // Shared-memory control block written by the sidecar (replaces the
        // <flight_id>.control.json poll). Opened lazily once the file appears.
        // Its monotonic seqlock counter is the change detector — collision-proof,
        // unlike the mtime/content compare it replaces, so a rate=0 stop right
        // after a drag can never be silently dropped.
        private ControlBlock _controlBlock;
        private int _controlCheckCountdown;

        // Pan/tilt interpolation state. Target is written by PollControlFile
        // from operator control.json; Current tracks toward it each Refresh()
        // at SlewDegPerSec. Near-cam rotation and mesh transforms are driven
        // from Current, so status echoes what is actually on-screen.
        private float _panYawTarget;
        private float _panPitchTarget;
        private float _panYawCurrent;
        private float _panPitchCurrent;
        // Persistent velocities from set-pan-rate / set-zoom-rate, normalised
        // -1..1. Each holds its last value until a new rate supersedes it
        // (a missing JSON field leaves the rate unchanged; only an explicit 0
        // stops). Integrated every Refresh() into the pan/fov targets.
        //   +panYawRate   = pan right    (matches absolute panYaw sign)
        //   +panPitchRate = pan up       (matches absolute panPitch sign)
        //   +zoomRate     = zoom IN      (FoV DECREASES — subtracted from target)
        private float _panYawRate;
        private float _panPitchRate;
        private float _zoomRate;
        // Smoothed FoV target. SetFov and the zoom-rate integrator write this;
        // Fov slews toward it each Refresh() at _zoomCap.FovSlewDegPerSec so both
        // discrete set-fov and hold-to-zoom animate rather than snap. Initialised
        // to the camera's starting FoV in the constructor (snapped, not slewed).
        private float _fovTarget;
        // Last-seen absolute-command sequence numbers (panSeq / fovSeq in
        // control.json). control.json is a full-state snapshot the sidecar
        // re-serialises on *every* command, so the stale absolute panYaw /
        // panPitch / fov rides along on unrelated writes — and on the
        // rate-stop flush itself. While a rate has integrated the target away
        // from that stale absolute, re-applying it would snap the camera back
        // (e.g. every release slews back to the last preset). The sidecar
        // bumps these seqs ONLY on an absolute set-pan / set-fov (never on a
        // rate command or the disconnect deadman), so we apply the absolute
        // only when its seq changes — a re-serialised stale value is then
        // idempotent, while a genuine new absolute (even re-issuing the same
        // value, e.g. re-clicking a preset after drift) still lands. Init to
        // -1 (no real seq) so the first snapshot carrying an absolute applies.
        private long _lastPanSeq = -1;
        private long _lastFovSeq = -1;
        // Zoom rate caps. No per-part table — every camera carries the default
        // rates; they only matter when SupportsZoom. Must NOT be left as
        // default(ZoomCapability): all-zero would freeze the FoV slew.
        private readonly ZoomCapability _zoomCap = ZoomCapability.Default;
        // Base rotation of the near camera at part-attach time. Pan is applied
        // as baseRot * Euler(-pitch, yaw, 0) so the camera's natural forward
        // direction is the zero point.
        private Quaternion _baseRotation;
        /* Mesh joints + rest poses live in HullcamPanCapability now; core reads
           the resolved yaw joint (for near-camera parenting + the aim solve)
           through _pan and drives the joints via _pan.Steer. */

        private CameraLayers _layers = CameraLayers.All;
        /// <summary>
        /// Ceiling for the effective layer mask. Adaptive shedding can
        /// reduce <c>_layers</c> below this, but never expand past it.
        /// Set on construction (from settings.cfg) and on operator
        /// control-file updates.
        /// </summary>
        private CameraLayers _operatorLayers = CameraLayers.All;
        /// <summary>
        /// Subscriber-aware capture gate. False (the default on attach
        /// until the sidecar writes a control.json with subscribed=true)
        /// means the per-layer Unity Camera components are disabled and
        /// Refresh() short-circuits — no GPU readback, no ring write,
        /// no encoder work downstream. Flipped by the sidecar when a
        /// peer-track is added / the last one drops, surfaced via the
        /// same control.json poll that carries layer / fov / render-size
        /// changes.
        /// </summary>
        private bool _subscribed;
        /// <summary>Whether a peer is currently streaming this camera. Staggering
        /// is budgeted over the subscribed set only — idle cameras cost nothing
        /// and must not consume capture permits.</summary>
        public bool Subscribed => _subscribed;

        /* Background "background capture" pacing: a subscribed camera nothing is displaying at
           size still ticks over at a reduced rate, so switching to it promotes
           an already-flowing stream. Decision logic lives in CapturePacing so
           it is unit-testable without Unity. */
        private CapturePacing _pacing;
        public float EffectiveCaptureFps(float primaryFps, float backgroundCeilingFps)
            => _pacing.Effective(primaryFps, backgroundCeilingFps);
        public bool CaptureDue(float now, float effectiveFps, float primaryFps)
            => _pacing.Due(now, effectiveFps, primaryFps);
        public void MarkCaptureGranted(float now) => _pacing.MarkGranted(now);

        private bool _disposed;
        private bool _firstRender = true;
        private bool _firstPixelCheck = true;
        private struct FaderState
        {
            public Renderer Renderer;
            public bool WasEnabled;
            public float OriginalFade;
        }
        // Pre-allocated; cleared and repopulated each scaled render to avoid
        // per-frame GC pressure. FaderState is a struct, so the list stores them
        // inline (no per-entry GC).
        private readonly List<FaderState> _faderOverrides = new List<FaderState>();
        // Reused across bodies and frames. Previously the fader loop did
        // `new MaterialPropertyBlock()` twice per overridden body, per camera,
        // per frame — a steady stream of Mono garbage (stop-the-world GC ⇒
        // frametime spikes). GetPropertyBlock overwrites it each call, so a
        // single shared scratch instance is correct.
        private readonly MaterialPropertyBlock _faderMpb = new MaterialPropertyBlock();
        // Scaled-body renderers, cached on first use. Celestial bodies don't
        // change during a flight and the camera is recreated on vessel change,
        // so this avoids a GetComponent<Renderer> over every body on every
        // scaled render. Entries can still go null defensively (handled below).
        private List<Renderer> _scaledBodyRenderers;
        private static readonly int _fadeAltitudeId = Shader.PropertyToID("_FadeAltitude");

        private int _consecutiveErrors;

        // Per-phase render-timing accumulator (last / EMA / rolling-max per
        // phase). Populated only when KerbcastSettings.EnableTelemetry is true;
        // the status writer reads it and aggregates across cameras. Always
        // allocated (cheap, one small object per camera) but never written to
        // when telemetry is off, so the OFF path stays allocation-free.
        private readonly PhaseTimings _phaseTimings = new PhaseTimings();
        /// <summary>Per-phase render timings for this camera. Read by the 1Hz
        /// status writer; only meaningful when telemetry is enabled.</summary>
        public PhaseTimings PhaseTimings => _phaseTimings;
        // Cached for this Refresh tick (read once at the top). When false, every
        // timing bracket is skipped so the OFF path makes zero GetTimestamp
        // calls. Passed to _capture.BeginTick so the capture tail's Blit/Readback
        // samples share the same per-tick snapshot.
        private bool _telemetry;
        // Milliseconds per Stopwatch tick — computed once. Stopwatch.GetTimestamp
        // returns raw ticks (no allocation, no shared mutable Stopwatch state);
        // multiply the tick delta by this to get milliseconds.
        private static readonly double _msPerTick =
            1000.0 / System.Diagnostics.Stopwatch.Frequency;

        // HullcamVDS per-part shader filter (NightVision, MovieTime,
        // CRT scanlines etc — 9 modes total enumerated by
        // HullcamVDS.CameraFilter.eCameraMode). Created from
        // hullcam.cameraMode at attach; null if the mode is Normal
        // (no filter), if creation failed, or if EnableHullcamEffects
        // is false in settings.cfg. When non-null, replaces the plain
        // capture-RT to readback-RT blit in CaptureBlit with a filter pass
        // that lands the post-processed pixels into the readback RT for the
        // existing AsyncGPUReadback path to read.
        private CameraFilter _cameraFilter;
        /* dockingdisplay.png, passed to RenderTitlePage before each blit so
           the _Title/_TitleTex uniforms are set deterministically per camera
           rather than inherited from stale shared state. LoadTextureFile
           decodes a fresh Texture2D from disk (it is NOT the GameDatabase
           instance); the static field keeps the single copy alive for the
           plugin's lifetime, shared by every kerbcast camera. */
        private static Texture2D _hullcamTitleTex;
        /* Per-camera private-material blit mechanism (the c00fe16 fix):
           owns this camera's private clone of HullcamVDS's MovieTime
           material and the mtShader static redirect around each filter
           pass. Mechanism lives in HullcamBlit/HullcamFilterBlit.cs (a
           KSP-free file the ci/kerbcast-shaders determinism test compiles
           verbatim); this class only supplies the CameraFilter type and
           the render pass below. */
        private readonly HullcamFilterBlit _filterBlit =
            new HullcamFilterBlit(typeof(CameraFilter));
        // Bound once in the constructor so the per-frame Run call
        // allocates no closure.
        private readonly Action<RenderTexture, RenderTexture> _filterRenderPass;
        // kerbcast's own NightVision material, used instead of HullcamVDS's
        // additive-shift filter when the shader bundle is available.
        private Material _nvMaterial;

        public KerbcastCamera(
            ICameraMountSource mount,
            uint flightId,
            string ringDir,
            int slotCount,
            int maxWidth,
            int maxHeight,
            int renderWidth,
            int renderHeight,
            CameraLayers initialLayers,
            bool enableAtmosphericFx,
            AtmoFxLayers fxLayers)
        {
            Mount = mount;
            // Pan is delivered through the mount as the IPanCapability contract;
            // core steers purely through the interface, never a concrete type.
            _pan = mount.Pan;
            FlightId = flightId;
            MaxWidth = maxWidth;
            MaxHeight = maxHeight;
            OperatorWidth = renderWidth;
            OperatorHeight = renderHeight;
            RenderWidth = renderWidth;
            RenderHeight = renderHeight;
            _operatorLayers = initialLayers;
            _layers = initialLayers;
            _enableFx = enableAtmosphericFx;
            _fxLayers = fxLayers;

            // Capability-derived zoom range (the subclass check + FovMaxCap clamp
            // live inside HullcamZoomCapability). The zero-width verdict stays
            // here: a zero-width range (e.g. DC.munCam 25/25) still yields a
            // capability, but the range isn't wide enough to call zoomable.
            SupportsZoom = mount.Zoom != null && mount.Zoom.FovMax > mount.Zoom.FovMin + 0.01f;
            FovMin = mount.Zoom != null ? mount.Zoom.FovMin : mount.DefaultFieldOfView;
            FovMax = mount.Zoom != null ? mount.Zoom.FovMax : mount.DefaultFieldOfView;
            // Snap both the displayed FoV and the slew target so a fresh camera
            // starts settled (SetFov now only moves _fovTarget; the constructor
            // is the one place that snaps Fov directly).
            Fov = _fovTarget = Mathf.Clamp(mount.DefaultFieldOfView, FovMin, FovMax);

            // Cache identity fields now while the Part is guaranteed live. The
            // mount snapshots them off its part; WriteDestroyedManifest (called
            // from Dispose during part destruction) reads these cached values so
            // it never touches a dying part.
            _cachedPartName = mount.PartName;
            _cachedPartTitle = mount.PartTitle;
            _cachedCameraName = mount.CameraName; // mount guarantees non-empty (empty -> PartTitle)
            _cachedVesselName = mount.VesselDisplayName;

            _filterRenderPass = RenderFilterPass;
            _captureBlit = CaptureBlit;

            _ringPath = Path.Combine(ringDir, $"{FlightId}.ring");
            _infoPath = Path.Combine(ringDir, $"{FlightId}.info.json");
            _controlPath = Path.Combine(ringDir, $"{FlightId}.control.bin");
            // Ring is allocated at the global max — adaptive resolution
            // shrinks the rendered frame but the ring's slot capacity
            // stays the same. Each slot's header carries the actual
            // content size so the sidecar encodes at the current dim.
            _ring = MmapFrameRing.Create(_ringPath, slotCount, maxWidth, maxHeight);
            WriteInfoManifest();

            // Failure-streak (_consecutiveErrors + LogRateLimited) and the
            // PhaseTimings sink stay owned here; the tail invokes them so a
            // readback error and a render error share one rate-limit counter and
            // one telemetry object.
            _capture = new CaptureCore(_ring, _phaseTimings, LogRateLimited, () => _consecutiveErrors = 0);

            _capture.BuildTargets(renderWidth, renderHeight);
            SetCameras();
            ApplyLayers();
            BuildHullcamFilter();
        }

        // Instantiate the HullcamVDS shader filter that matches this
        // part's configured cameraMode. Read once at attach; mode
        // changes from the operator's right-click Hullcam UI mid-flight
        // are NOT picked up — a vessel reload (or kerbcast re-attach)
        // would. Acceptable for v1; can add a periodic mode-poll later.
        //
        // cameraMode is a float in the Hullcam ConfigNode (0-8, mapped
        // to eCameraMode by value) — converted to enum by direct cast.
        // Mode 0 (Normal) returns a no-op filter; we leave _cameraFilter
        // null in that case so Refresh's blit takes the fast path.
        private void BuildHullcamFilter()
        {
            if (!KerbcastSettings.EnableHullcamEffects) return;
            try
            {
                int modeInt = Mount.FilterMode;
                var mode = (CameraFilter.eCameraMode)modeInt;
                if (mode == CameraFilter.eCameraMode.Normal) return;

                // Night vision: use kerbcast's multiplicative-gain shader
                // instead of HullcamVDS's additive-shift filter. Falls back
                // to the HullcamVDS path below if the bundle is missing.
                if (mode == CameraFilter.eCameraMode.NightVision)
                {
                    _nvMaterial = KerbcastNightVisionFilter.GetMaterial();
                    if (_nvMaterial != null)
                    {
                        UnityEngine.Debug.Log($"[Kerbcast] cam={FlightId} kerbcast NightVision shader active");
                        return;
                    }
                }

                var filter = CameraFilter.CreateFilter(mode);
                if (filter == null) return;
                if (!filter.Activate())
                {
                    UnityEngine.Debug.LogWarning($"[Kerbcast] cam={FlightId} CameraFilter.Activate failed for mode={mode}");
                    return;
                }
                _cameraFilter = filter;
                _filterModeName = mode.ToString();
                if (_hullcamTitleTex == null)
                {
                    _hullcamTitleTex = CameraFilter.LoadTextureFile("dockingdisplay.png");
                    // Hullcam clamps its own dockingDisplay instance in
                    // InitializeAssets; LoadTextureFile leaves the default
                    // Repeat. Match it so the reticle never tiles if a
                    // V-hold roll offsets the title UV outside [0,1].
                    if (_hullcamTitleTex != null)
                        _hullcamTitleTex.wrapMode = TextureWrapMode.Clamp;
                }
                UnityEngine.Debug.Log($"[Kerbcast] cam={FlightId} HullcamVDS filter active: mode={mode}");
            }
            catch (Exception ex)
            {
                UnityEngine.Debug.LogWarning($"[Kerbcast] cam={FlightId} BuildHullcamFilter failed: {ex.Message}");
            }
        }

        /* The filter pass HullcamFilterBlit.Run redirects: Hullcam's
           CameraFilter writes its uniforms and runs its Graphics.Blit via
           the mtShader static, which Run points at this camera's private
           material for exactly these two calls. Parameterised by source
           and destination so Run's one-time orientation probe can push its
           test frame through the same pass. */
        private void RenderFilterPass(RenderTexture src, RenderTexture dst)
        {
            _cameraFilter.RenderTitlePage(true, _hullcamTitleTex);
            _cameraFilter.RenderImageWithFilter(src, dst);
        }

        // The capture->readback blit for this camera type: HullcamVDS filter
        // (NightVision etc), or the plain Blit when no filter is active. Passed
        // to _capture.Publish, which then applies the flip and issues the
        // readback. Cached as _captureBlit so there's no per-frame closure alloc.
        //
        // When a HullcamVDS filter is active it replaces the plain Blit with its
        // own shader pass that post-processes src -> dst in one step; the
        // AsyncGPUReadback path then reads the already-filtered pixels, no extra
        // round-trip needed.
        /* DIAGNOSTIC (black-frames hunt, 2026-08-05). Samples the RT into a tiny
           readback so we can see luminance immediately BEFORE and AFTER the filter
           pass. That is the one measurement that separates "the filter received a
           black frame" from "the filter produced one" — everything else has been
           inference from the far end of the pipeline. Throttled to one probe every
           N frames; ~0 cost between probes. */
        private string _filterModeName;
        private static int s_diagTick;
        private const int DiagEveryFrames = 150;

        private static float ProbeLuminance(RenderTexture rt, out float peak)
        {
            peak = 0f;
            if (rt == null) return -1f;
            const int n = 8;
            RenderTexture tmp = null; Texture2D tex = null;
            var prev = RenderTexture.active;
            try
            {
                tmp = RenderTexture.GetTemporary(n, n, 0, RenderTextureFormat.ARGB32);
                Graphics.Blit(rt, tmp);
                RenderTexture.active = tmp;
                tex = new Texture2D(n, n, TextureFormat.RGBA32, false);
                tex.ReadPixels(new Rect(0, 0, n, n), 0, 0, false);
                tex.Apply(false, false);
                var px = tex.GetPixels32();
                float sum = 0f;
                for (int i = 0; i < px.Length; i++)
                {
                    float m = Mathf.Max(px[i].r, Mathf.Max(px[i].g, px[i].b));
                    sum += m; if (m > peak) peak = m;
                }
                return sum / px.Length;
            }
            catch (Exception) { return -1f; }
            finally
            {
                RenderTexture.active = prev;
                if (tex != null) UnityEngine.Object.Destroy(tex);
                if (tmp != null) RenderTexture.ReleaseTemporary(tmp);
            }
        }

        /* Orientation ground truth, computed rather than eyeballed. The camera
           itself tells us where a known world object MUST land in its frame;
           comparing that against where the bright object actually is in the
           captured pixels settles mirroring per camera and per axis, with no
           reference image and no human judgement. A left-right mirror shows up
           as measured x ~= 1 - expected x, an upside-down frame as
           y ~= 1 - expected y. Sun first (a small, unambiguous bright point);
           the body centre as a fallback when the Sun is behind the camera. */
        private void LogExpectedSunViewport()
        {
            try
            {
                if (_nearCam == null) return;
                var sun = Planetarium.fetch != null ? Planetarium.fetch.Sun : null;
                if (sun == null) return;
                Vector3 vp = _nearCam.WorldToViewportPoint(sun.transform.position);
                string where = vp.z <= 0f ? "BEHIND"
                    : (vp.x < 0f || vp.x > 1f || vp.y < 0f || vp.y > 1f) ? "offscreen" : "in-frame";
                /* The Sun is the cleanest marker but is often behind the lens.
                   The body being orbited is nearly always in view and its
                   centre is just as well-defined a world point, so log both:
                   between them every camera gets a reference it can be judged
                   against without waiting for the orbit to come round. */
                string body = "none";
                var b = FlightGlobals.ActiveVessel != null ? FlightGlobals.ActiveVessel.mainBody : null;
                if (b != null)
                {
                    Vector3 bv = _nearCam.WorldToViewportPoint(b.position);
                    string bw = bv.z <= 0f ? "BEHIND"
                        : (bv.x < 0f || bv.x > 1f || bv.y < 0f || bv.y > 1f) ? "offscreen" : "in-frame";
                    body = $"{b.bodyName}Viewport=({bv.x:F3},{bv.y:F3}) {bw}";
                }
                Debug.Log(
                    $"[Kerbcast][ORIENTDIAG] cam={FlightId} part={Mount.PartName} " +
                    $"filter={(_cameraFilter != null ? _filterModeName : "none")} " +
                    $"sunViewport=({vp.x:F3},{vp.y:F3}) z={vp.z:F0} {where} {body}");
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Kerbcast][ORIENTDIAG] cam={FlightId} failed: {ex.Message}");
            }
        }

        /* Orientation proof marker: a four-quadrant pattern whose correct layout
           is known (TOP-LEFT darkest .. BOTTOM-RIGHT brightest). Substituted for
           the camera's image so it travels the ENTIRE shipped path — this
           camera's real filter material, the real capture blit, the real
           readback flip, the real ring write — and is then classified from the
           ring, which IS the delivered output. Scene content cannot do this
           job: a camera on open sky has no marker, and a dim limb gives no
           measurable point source.

           Quadrants differ in LUMINANCE, not hue, so they survive the
           monochrome filters, and are judged by rank so filter gain is
           irrelevant. One cached texture, one Blit, no per-frame allocation:
           an earlier version took a full-size RenderTexture.GetTemporary per
           camera per frame and took KSP down with it. */
        private static Texture2D s_orientMarker;

        private static Texture2D OrientationMarker()
        {
            if (s_orientMarker != null) return s_orientMarker;
            const int size = 64;
            // Texture2D rows run bottom-up: y >= size/2 is the TOP half.
            var px = new Color32[size * size];
            for (int y = 0; y < size; y++)
                for (int x = 0; x < size; x++)
                {
                    bool top = y >= size / 2, left = x < size / 2;
                    byte v = top ? (left ? (byte)40 : (byte)90)
                                 : (left ? (byte)150 : (byte)230);
                    px[y * size + x] = new Color32(v, v, v, 255);
                }
            s_orientMarker = new Texture2D(size, size, TextureFormat.RGBA32, false);
            s_orientMarker.SetPixels32(px);
            s_orientMarker.Apply(false, false);
            return s_orientMarker;
        }

        private void CaptureBlit(RenderTexture src, RenderTexture dst)
        {
            bool diag = KerbcastSettings.EnableBlitDiagnostics
                && (++s_diagTick % DiagEveryFrames) == 0;
            // Overwrite the just-rendered capture RT in place. One blit, no
            // allocation; the camera has already rendered by the time we run.
            if (KerbcastSettings.EnableOrientationTestPattern && src != null)
                Graphics.Blit(OrientationMarker(), src);
            float srcMean = 0f, srcPeak = 0f;
            if (diag) srcMean = ProbeLuminance(src, out srcPeak);
            if (diag) LogExpectedSunViewport();

            if (_nvMaterial != null)
            {
                Graphics.Blit(src, dst, _nvMaterial);
            }
            else if (_cameraFilter != null)
            {
                /* Run the Hullcam filter pass through THIS camera's private
                   MovieTime material, never the shared static; the mtShader
                   redirect mechanism lives in HullcamFilterBlit (shared source
                   with the headless determinism test in ci/kerbcast-shaders,
                   which proves the output is byte-identical under hostile writes
                   to the shared static).

                   Reticle policy is unchanged from the original fix: title=true
                   with dockingdisplay.png, mirroring MovieTimeFilter's hardcoded
                   in-game state, and the per-class show/hide decision stays with
                   the filter: BWLoResTV, BWHiResTV and NightVision overwrite
                   _TitleTex=noneTX inside their own blit (no reticle); DockingCam,
                   BWFilm, ColorFilm, ColorLoResTV and ColorHiResTV leave the title
                   alone (reticle shown), matching Hullcam's in-game view.

                   On top-left-UV-origin APIs (D3D11, Metal) Run also measures the
                   pass's vertical orientation once and appends a compensating flip
                   when the pass inverts; see the HullcamFilterBlit header. Gate is
                   SystemInfo.graphicsUVStartsAtTop, so the GL/Deck path is
                   untouched. */
                _filterBlit.Run(_filterRenderPass, src, dst);
            }
            else
            {
                Graphics.Blit(src, dst);
            }

            if (diag)
            {
                float dstPeak; float dstMean = ProbeLuminance(dst, out dstPeak);
                string path = _nvMaterial != null ? "nightvision-material"
                    : _cameraFilter != null ? "hullcam-filter" : "plain-blit";
                UnityEngine.Debug.Log(
                    $"[Kerbcast][BLITDIAG] cam={FlightId} path={path} mode={_filterModeName ?? "none"} "
                    + $"src={src?.width}x{src?.height}/{src?.format} dst={dst?.width}x{dst?.height}/{dst?.format} "
                    + $"SRC mean={srcMean:F1} peak={srcPeak:F0} -> DST mean={dstMean:F1} peak={dstPeak:F0}"
                    + (srcPeak > 8f && dstPeak <= 8f ? "  <<< FILTER BLACKENED A NON-BLACK FRAME" : ""));
            }
        }

        /// <summary>
        /// Rebuild the RenderTexture chain at a new size and rebind every
        /// Unity Camera to it. Caller is responsible for staying within
        /// MaxWidth × MaxHeight (the ring slot capacity). Even dimensions
        /// only — H.264 chroma sampling requires that.
        /// </summary>
        public void SetRenderSize(int width, int height)
        {
            if (width <= 0 || height <= 0) return;
            if (width % 2 != 0 || height % 2 != 0) return;
            if (width > MaxWidth || height > MaxHeight) return;
            if (width == RenderWidth && height == RenderHeight) return;

            // Switch to the pooled set for the new size. The old set stays in
            // the pool (never destroyed), so a readback still in flight against
            // it drains safely at its captured dimensions (_pendingW/_pendingH/
            // _pendingScratch) — nothing is orphaned, and there's no realloc.
            _capture.BuildTargets(width, height);
            RenderWidth = width;
            RenderHeight = height;

            if (_nearCam != null) _nearCam.targetTexture = _capture.CaptureRt;
            if (_scaledCam != null) _scaledCam.targetTexture = _capture.CaptureRt;
            if (_galaxyCam != null) _galaxyCam.targetTexture = _capture.CaptureRt;
            if (_farCam != null) _farCam.targetTexture = _capture.CaptureRt;

            Debug.Log($"[Kerbcast] cam={FlightId} render size → {width}×{height}");
        }

        /// <summary>
        /// Update the operator-set ceiling for render size. Adaptive
        /// downscale and the viewer quality clamp can render below this;
        /// never above. Currently only settable at construction; runtime
        /// API for resolution is a future addition.
        /// </summary>
        public void SetOperatorRenderSize(int width, int height)
        {
            OperatorWidth = width;
            OperatorHeight = height;
            // Recompute through the one quality path so any in-effect shed
            // level / viewer clamp scales from the new ceiling.
            ApplyEffectiveQuality();
        }

        private void DumpModelTransforms()
        {
            var sb = new System.Text.StringBuilder();
            var root = Mount.FindModelTransform("model");
            if (root == null) root = Mount.PartTransform;
            WalkTransforms(root, 0, sb);
            Debug.Log($"[Kerbcast] model transforms for {Mount.PartName}:\n{sb}");
        }

        private static void WalkTransforms(Transform t, int depth, System.Text.StringBuilder sb)
        {
            var p = t.localPosition;
            sb.Append(' ', depth * 2)
              .Append(t.name)
              .AppendFormat(" pos=({0:F3},{1:F3},{2:F3})", p.x, p.y, p.z)
              .Append('\n');
            for (int i = 0; i < t.childCount; i++)
                WalkTransforms(t.GetChild(i), depth + 1, sb);
        }

        /* Map-view-only Unity layers that must never reach a capture feed:
           layer 31 = orbit / patched-conic vector lines, layer 24 = MapFX
           node icons (the "planet bloom" flare). KSP OR's layer 31 into the
           PlanetariumCamera's cullingMask whenever map view draws its 3D orbit
           lines, and our scaled layer clones that very camera ("Camera
           ScaledSpace" IS the PlanetariumCamera). A CopyFrom taken while map
           view is active therefore inherits the orbit lines, which then render
           into every subsequent frame. Strip both bits from each clone so the
           feed always shows only the flight scene. Layer 10 (Scaled Scenery)
           is untouched, so scaled planets/atmosphere still render. */
        private const int MapViewLayerMask = (1 << 31) | (1 << 24);

        private static void StripMapViewLayers(Camera cam)
        {
            if (cam != null) cam.cullingMask &= ~MapViewLayerMask;
        }

        /* Layered camera stack. Each layer copies the corresponding KSP
           flight camera so depth-ordering, clearFlags, cullingMask, and
           per-layer rendering tricks all inherit correctly. All layers
           target `_captureRt`; Unity composites by camera.depth (galaxy
           back, scaled next, far-spike next, near front), so a single
           readback against the RT captures the composite frame. */
        private void SetCameras()
        {
            var partTransform = string.IsNullOrEmpty(Mount.CameraTransformName)
                ? Mount.PartTransform
                : Mount.FindModelTransform(Mount.CameraTransformName);
            if (partTransform == null)
            {
                Debug.LogWarning($"[Kerbcast] cam={FlightId} cameraTransformName '{Mount.CameraTransformName}' not found on part {Mount.PartName}");
                return;
            }

            // Visual-mod integrations (TUFX, and Scatterer/EVE/... as they land). The
            // host is the only mod-aware surface; the render code below treats all
            // integrations uniformly. Constructed here so the MSAA format lever is known
            // before the cloned cameras are configured.
            _integrationHost = new IntegrationHost();
            bool integrationsForceNoMsaa = _integrationHost.ForceNoMsaa;
            bool allowMsaa = !integrationsForceNoMsaa;

            // The yaw joint (if any) was resolved by the pan capability at rest
            // pose when the mount was built; read it here to parent the near
            // camera. Null for a non-pan or no-joint camera.
            DumpModelTransforms();
            Transform yawJoint = _pan?.YawJoint;

            // Camera parenting strategy:
            //
            // Any joint (compound yaw+pitch like hc.launchcam, OR yaw-only like
            // DC.TurretCam / TopJoint): parent the near camera RIGIDLY to the
            // joint. The joint carries the pan rotation and the camera inherits
            // it as world-space rotation, so the lens travels WITH the visible
            // head — the head therefore stays behind the lens and never enters
            // frame. Refresh() keeps the camera's localRotation at _baseRotation
            // (no additional camera-level pan) since the joint provides it all.
            //
            // The mount position is re-expressed in the joint's local frame so
            // the lens sits at the correct world position throughout the joint's
            // travel. For a yaw-only joint whose authored cameraPosition is well
            // off the yaw axis (TurretCam's is ~0.5 lateral), parenting at that
            // offset would orbit the lens through a wide arc — the old "rotates
            // about the wrong point" symptom. CameraMountLocal lets such a part
            // pin the lens onto the yaw axis (in joint-local coords) so it
            // rotates in place while still travelling with the head.
            //
            // No joint: parent to partTransform, use cameraPosition/Forward/Up
            // as-is in part space, and Refresh() drives the camera's own
            // localRotation for pan.
            Transform nearParent;
            Vector3 nearLocalPos;
            if (yawJoint != null)
            {
                // Joint present: camera follows the joint; re-express in joint frame.
                if (_pan.CameraMountLocal.HasValue)
                {
                    // Authored mount is already given in the joint's local frame.
                    nearLocalPos = _pan.CameraMountLocal.Value;
                }
                else
                {
                    Vector3 worldPos = partTransform.TransformPoint(Mount.CameraPosition);
                    nearLocalPos = yawJoint.InverseTransformPoint(worldPos);
                }
                Vector3 worldFwd = partTransform.TransformDirection(Mount.CameraForward);
                Vector3 worldUp  = partTransform.TransformDirection(Mount.CameraUp);
                _baseRotation = Quaternion.LookRotation(
                    yawJoint.InverseTransformDirection(worldFwd),
                    yawJoint.InverseTransformDirection(worldUp));
                nearParent = yawJoint;
            }
            else
            {
                // No joint: camera stays on partTransform and rotates in place.
                nearLocalPos = Mount.CameraPosition;
                _baseRotation = Quaternion.LookRotation(Mount.CameraForward, Mount.CameraUp);
                nearParent = partTransform;
            }

            // Near layer — close-up of parts + atmospheric effects.
            var nearGo = new GameObject($"Kerbcast_{FlightId}_Near");
            _nearCam = nearGo.AddComponent<Camera>();
            var sourceNear = FindKspCamera("Camera 00");
            if (sourceNear != null) _nearCam.CopyFrom(sourceNear);
            _nearCam.name = $"Kerbcast_{FlightId}_Near";
            nearGo.transform.parent = nearParent;
            nearGo.transform.localPosition = nearLocalPos;
            nearGo.transform.localRotation = _baseRotation;
            /* Handedness probe. A mirrored image cannot come from our blit chain
               (every flip we apply is vertical) nor from LookRotation, so the
               remaining source is a NEGATIVE-DETERMINANT parent chain — what KSP
               mirror-symmetry placement produces. Log the determinant sign once
               per camera so a flipped feed can be attributed to the mount rather
               than guessed at. Cheap and one-shot; runs at camera setup only. */
            {
                var m = nearGo.transform.localToWorldMatrix;
                float det = m.determinant;
                var ps = nearParent != null ? nearParent.lossyScale : Vector3.one;
                var cs = nearGo.transform.lossyScale;
                Debug.Log(
                    $"[Kerbcast][MOUNTDIAG] cam={FlightId} part={Mount.PartName} " +
                    $"parentScale=({ps.x:F3},{ps.y:F3},{ps.z:F3}) " +
                    $"camScale=({cs.x:F3},{cs.y:F3},{cs.z:F3}) det={det:F4} " +
                    (det < 0f ? "<<< MIRRORED PARENT CHAIN" : "upright"));
            }
            _nearCam.fieldOfView = Fov;
            _nearCam.nearClipPlane = Mount.NearClip;
            _nearCam.targetTexture = _capture.CaptureRt;
            // HDR + MSAA explicit on every layer. CopyFrom only inherits
            // whatever the source KSP camera was last left with, which in
            // practice ships HDR off for the layered triple — atmospheric
            // scattering on Kerbin's horizon has very wide dynamic range
            // and clips ugly-dark without HDR (showed up as a "black hole
            // horizon" in the first multi-camera streaming test). OCISLY's
            // TrackingCamera enables these explicitly for the same reason.
            _nearCam.allowHDR = true;
            _nearCam.allowMSAA = allowMsaa;
            // Offscreen RT cameras shouldn't run Unity's occlusion logic —
            // it's computed against the main viewport's frustum and either
            // wastes cycles or incorrectly culls objects in our cameras'
            // frusta. Disabled on every layer.
            _nearCam.useOcclusionCulling = false;
            // Add kerbcast's FX-only layer so ember ParticleSystems (and any
            // future GameObject-based effects on AtmoFxConstants.Layer) render
            // on kerbcast streams without leaking into the main flight view.
            _nearCam.cullingMask |= AtmoFxConstants.LayerMask;
            nearGo.AddComponent<CanvasHack>();

            // Scaled layer — planet terrain + atmosphere at scaled-space scale.
            var scaledGo = new GameObject($"Kerbcast_{FlightId}_Scaled");
            _scaledCam = scaledGo.AddComponent<Camera>();
            var sourceScaled = FindKspCamera("Camera ScaledSpace");
            if (sourceScaled != null)
            {
                _scaledCam.CopyFrom(sourceScaled);
                scaledGo.transform.parent = sourceScaled.transform;
                var scaledComps = sourceScaled.gameObject.GetComponents<MonoBehaviour>();
                Debug.Log($"[Kerbcast] Camera ScaledSpace components ({scaledComps.Length}): " +
                    string.Join(", ", System.Array.ConvertAll(scaledComps, c => c.GetType().Name)));
            }
            _scaledCam.name = $"Kerbcast_{FlightId}_Scaled";
            scaledGo.transform.localRotation = Quaternion.identity;
            scaledGo.transform.localPosition = Vector3.zero;
            scaledGo.transform.localScale = Vector3.one;
            _scaledCam.fieldOfView = Fov;
            _scaledCam.targetTexture = _capture.CaptureRt;
            _scaledCam.allowHDR = true;
            _scaledCam.allowMSAA = allowMsaa;
            _scaledCam.useOcclusionCulling = false;
            // Deferred lighting fails silently for offscreen RTs on Mesa/OpenGL
            // (surface goes pure black while the atmosphere limb, which uses its
            // own MPB-based lighting, stays bright). Scaled space has exactly one
            // light (scaledSunLight, layer 10 only) so forward costs nothing extra.
            _scaledCam.renderingPath = RenderingPath.Forward;
            var scaledRot = scaledGo.AddComponent<LayerCamRotator>();
            scaledRot.NearCamera = _nearCam;
            scaledRot.UseScaledSpace = true;
            scaledGo.AddComponent<CanvasHack>();

            // Galaxy layer — skybox + distant celestials.
            var galaxyGo = new GameObject($"Kerbcast_{FlightId}_Galaxy");
            _galaxyCam = galaxyGo.AddComponent<Camera>();
            // Pre-CopyFrom fallback: if the source GalaxyCamera lookup
            // fails (vessel-load race, scene weirdness), at least we
            // render a predictable solid-black backdrop instead of
            // whatever Unity defaults Camera to. CopyFrom overwrites
            // these when it succeeds.
            _galaxyCam.clearFlags = CameraClearFlags.SolidColor;
            _galaxyCam.backgroundColor = Color.black;
            var sourceGalaxy = FindKspCamera("GalaxyCamera");
            if (sourceGalaxy != null)
            {
                _galaxyCam.CopyFrom(sourceGalaxy);
                galaxyGo.transform.parent = sourceGalaxy.transform;
            }
            _galaxyCam.name = $"Kerbcast_{FlightId}_Galaxy";
            galaxyGo.transform.position = Vector3.zero;
            galaxyGo.transform.localRotation = Quaternion.identity;
            galaxyGo.transform.localScale = Vector3.one;
            _galaxyCam.fieldOfView = Fov;
            _galaxyCam.targetTexture = _capture.CaptureRt;
            _galaxyCam.allowHDR = true;
            _galaxyCam.allowMSAA = allowMsaa;
            _galaxyCam.useOcclusionCulling = false;
            // Force Forward, same as the scaled clone. With the Deferred mod the
            // game runs deferred and this clone inherits DeferredShading via
            // CopyFrom, but deferred offscreen RTs render pure black on Mesa/
            // OpenGL (the Deck): the galaxy cube is a forward-authored skybox and
            // vanished entirely. DeferredIntegration only force-forwards near/far,
            // so the galaxy clone was the one layer left deferred. The galaxy has
            // no scene lights, so Forward costs nothing.
            _galaxyCam.renderingPath = RenderingPath.Forward;
            var galaxyRot = galaxyGo.AddComponent<LayerCamRotator>();
            galaxyRot.NearCamera = _nearCam;
            galaxyRot.UseScaledSpace = false;
            galaxyGo.AddComponent<CanvasHack>();

            /* Spike: far-local layer, cloned from KSP's "Camera 01". Renders
               the terrain band between the near camera's far clip and the
               scaled-space transition. Parented to the part transform like
               the near camera so it tracks vessel movement. Depth is set
               between the scaled and near values so Unity's compositing
               order is galaxy -> scaled -> far -> near. */
            var sourceFar = FindKspCamera("Camera 01");
            if (sourceFar != null)
            {
                var farGo = new GameObject($"Kerbcast_{FlightId}_Far");
                _farCam = farGo.AddComponent<Camera>();
                _farCam.CopyFrom(sourceFar);
                _farCam.name = $"Kerbcast_{FlightId}_Far";
                farGo.transform.parent = nearParent;
                farGo.transform.localPosition = nearLocalPos;
                farGo.transform.localRotation = _baseRotation;
                _farCam.fieldOfView = Fov;
                _farCam.targetTexture = _capture.CaptureRt;
                _farCam.allowHDR = true;
                _farCam.allowMSAA = allowMsaa;
                _farCam.useOcclusionCulling = false;
                /* Depth: Camera 01 inherits its depth from CopyFrom. Force it
                   between the scaled and near values so the composite is
                   galaxy -> scaled -> far -> near. KSP's typical depths are
                   GalaxyCamera=-1, ScaledSpace=0, Camera 01=1, Camera 00=2.
                   Using sourceFar.depth - 0.5 puts us at ~0.5, between scaled
                   (0) and near (2), which is correct for all typical KSP
                   depth assignments. */
                _farCam.depth = sourceFar.depth - 0.5f;
                _farCam.enabled = false;
                farGo.AddComponent<CanvasHack>();
                Debug.Log($"[Kerbcast] cam={FlightId} far-local camera created: " +
                    $"near={sourceFar.nearClipPlane} far={sourceFar.farClipPlane} " +
                    $"clearFlags={sourceFar.clearFlags} depth={_farCam.depth}");
            }
            else
            {
                Debug.LogWarning($"[Kerbcast] cam={FlightId} 'Camera 01' not found: far layer skipped");
            }

            // Attach every available integration to each cloned layer. The host skips
            // integrations that do not opt into a layer and no-ops the unavailable ones.
            // TUFX's own EnableTUFX setting is honoured inside its IsAvailable probe path.
            _integrationHost.ApplyToLayer(_nearCam, CameraLayers.Near);
            _integrationHost.ApplyToLayer(_scaledCam, CameraLayers.Scaled);
            _integrationHost.ApplyToLayer(_galaxyCam, CameraLayers.Galaxy);
            if (_farCam != null)
                _integrationHost.ApplyToLayer(_farCam, CameraLayers.Far);

            /* Final word on the cull mask: drop the map-view-only layers from
               every clone. Done after CopyFrom and every mask-widening step
               above (the AtmoFx OR, integration masks) so nothing can leave
               orbit lines / map icons in the feed. */
            StripMapViewLayers(_nearCam);
            StripMapViewLayers(_scaledCam);
            StripMapViewLayers(_galaxyCam);
            StripMapViewLayers(_farCam);

            // Pitch + yaw-base joints are resolved (and their rest poses
            // captured) by HullcamPanCapability when the mount is built; the
            // per-frame drive applies them through _pan.Steer.

            /* All cameras are permanently disabled; Unity must not
               auto-render them. Refresh() drives explicit camera.Render()
               calls each tick; disabled cameras still participate in
               LayerCamRotator.OnPreRender (which fires on camera.Render())
               so transform tracking continues to work correctly. The far
               camera's enabled flag is set inside its own construction
               block above. */
            _nearCam.enabled = false;
            _scaledCam.enabled = false;
            _galaxyCam.enabled = false;

            // Build the pluggable atmospheric-FX host for the near camera. The
            // effective layer set folds the master toggle in (off → no effects,
            // a genuine no-op). Each effect owns its own rendering surface.
            _fxHost = new FxHost(_nearCam);
            _fxHost.SetEnabledLayers(EffectiveFxLayers());
            _fxHost.OnVesselChanged(Mount.Vessel);
        }

        /* Master gate folded into the layer set: FX off => no layers => no effects.
           Provider selection: when Firefly is installed and enabled, capture its
           reentry plasma INSTEAD of kerbcast's own (running both double-plasmas), by
           clearing the kerbcast-plasma bits and setting the Firefly bit. */
        private AtmoFxLayers EffectiveFxLayers()
        {
            if (!_enableFx) return AtmoFxLayers.None;
            if (KerbcastSettings.EnableFirefly && FireflyCaptureEffect.IsFireflyAvailable())
                return (_fxLayers & ~AtmoFxLayers.All) | AtmoFxLayers.Firefly;
            return _fxLayers;
        }

        // Build this frame's FX inputs from the vessel's flight state. Effects
        // derive their own intensities from these.
        private FxFrameState BuildFxFrameState()
        {
            var v = Mount.Vessel;
            Vector3 vel = v != null ? (Vector3)v.srf_velocity : Vector3.zero;
            float mach = v != null ? (float)v.mach : 0f;
            float q = v != null ? (float)v.dynamicPressurekPa : 0f;

            // Prefer KSP's published aero direction (_LightDirection0) when
            // meaningful — it's the same vector FXCamera uses internally and
            // is physics-driven from the actual flight state. Falling through
            // to the vessel's srf_velocity if FXCamera isn't publishing
            // anything yet (early in flight init, or in vacuum). This makes
            // every effect (core, bowshock, trail, embers) wind-driven by the
            // game's own aero solver without each shader having to sample
            // globals independently.
            //
            // IMPORTANT SIGN: AerodynamicsFX.cs (line 411 of the decompile)
            // sets `fxCamera.effectDirection = -velocity`, so _LightDirection0
            // is the AIRFLOW direction (the direction the air is blowing,
            // i.e. opposite of the vessel's motion). Our state.VelocityWorld
            // convention is the vessel's velocity direction, so negate.
            Vector3 fxDir = Shader.GetGlobalVector(_LightDirection0Id);
            if (fxDir.sqrMagnitude > 0.01f)
                vel = -fxDir;

            // Debug override beats both: pretend the vessel is moving in this
            // world-space direction so motion-dependent shader paths can be
            // exercised on the pad. Pair with ForceAtmosphericFx.
            if (KerbcastSettings.DebugWindDirection.sqrMagnitude > 0.0001f)
                vel = KerbcastSettings.DebugWindDirection;

            return new FxFrameState(v, _nearCam, vel, mach, q, Time.deltaTime, Time.time);
        }

        // Per-frame inputs for visual-mod integrations that need live flight state.
        // Mirrors BuildFxFrameState's quantities so FX and integrations agree.
        private IntegrationFrameState BuildIntegrationFrameState(CameraLayers layer)
        {
            var v = Mount.Vessel;
            float mach = v != null ? (float)v.mach : 0f;
            float q = v != null ? (float)v.dynamicPressurekPa : 0f;
            double alt = v != null ? v.altitude : 0d;
            return new IntegrationFrameState(v, layer, Time.deltaTime, mach, q, alt);
        }

        // Cached shader ID for FXCamera's published wind direction global.
        private static readonly int _LightDirection0Id = Shader.PropertyToID("_LightDirection0");

        /// <summary>
        /// Turn atmospheric-FX replication on or off at runtime. Re-syncs the
        /// host's effective layer set; takes effect next frame. Called by
        /// PollControlFile on operator flips.
        /// </summary>
        public void SetEnableAtmosphericFx(bool enabled)
        {
            _enableFx = enabled;
            _fxHost?.SetEnabledLayers(EffectiveFxLayers());
        }

        /// <summary>
        /// Rebuild FX per-vessel state (the effects' draw lists) — called by
        /// KerbcastCore on part destruction / vessel modification so stale part
        /// renderers don't linger in an effect's CommandBuffer.
        /// </summary>
        public void MarkFxDirty()
        {
            /* Re-reconcile the layer set first: Firefly may have loaded since the
               last setup, flipping the provider selection. SetEnabledLayers no-ops
               when the set is unchanged. */
            _fxHost?.SetEnabledLayers(EffectiveFxLayers());
            _fxHost?.OnVesselChanged(Mount.Vessel);
        }

        private static Camera FindKspCamera(string name)
        {
            return Camera.allCameras.FirstOrDefault(c => c.name == name);
        }

        public CameraLayers Layers => _layers;
        public CameraLayers OperatorLayers => _operatorLayers;
        /// <summary>Whether atmospheric-FX replication is currently requested
        /// for this camera. Echoed in status JSON so the operator/gonogo can
        /// confirm a control-file flip was received.</summary>
        public bool EnableFx => _enableFx;

        /// <summary>
        /// Apply an operator-driven layer change. Updates the ceiling AND
        /// the effective mask, and clears any in-effect adaptive shedding
        /// (it'll re-apply on the next tick if fps is still below the
        /// shed threshold).
        /// </summary>
        public void SetOperatorLayers(CameraLayers ops)
        {
            if (_operatorLayers == ops && _layers == ops) return;
            _operatorLayers = ops;
            _layers = ops;
            ApplyLayers();
        }

        /// <summary>
        /// Apply an operator-driven (discrete) FoV change. Sets the slew
        /// *target* rather than snapping `Fov` directly — Refresh() animates
        /// the displayed FoV (and the Hullcam module + Unity cameras) toward
        /// the target at `_zoomCap.FovSlewDegPerSec`, so a discrete `set-fov`
        /// now reads as a smooth zoom instead of a hard step. Composes with
        /// the zoom rate: an absolute set-fov jumps the target, then any active
        /// rate continues integrating from there. Silently no-ops for parts
        /// where `SupportsZoom == false`.
        /// </summary>
        public void SetFov(float fov)
        {
            if (!SupportsZoom) return;
            float clamped = Mathf.Clamp(fov, FovMin, FovMax);
            // Compare against the target, not Fov: Fov lags as it slews, so a
            // Fov-based early-out would misfire mid-animation.
            if (Mathf.Abs(clamped - _fovTarget) < 0.01f) return;
            _fovTarget = clamped;
        }

        /// <summary>Operator/part-facing camera name (falls back to the part
        /// title). Snapshot from construction so it is safe after teardown.</summary>
        public string CameraName => _cachedCameraName;
        /// <summary>Part config name (e.g. "DC.TurretCam").</summary>
        public string PartName => _cachedPartName;
        /// <summary>Human-readable part title.</summary>
        public string PartTitle => _cachedPartTitle;

        /// <summary>World-space optical axis (unit forward) of the capture
        /// camera: exactly where the stream points, after pan/aim slew. Lets a
        /// kOS script steer the vessel to hold a target that the mount alone
        /// can't reach. Falls back to the part's forward before the camera is
        /// built.</summary>
        public UnityEngine.Vector3 BoresightWorld =>
            _nearCam != null ? _nearCam.transform.forward : Mount.PartTransform.forward;

        /// <summary>World-space position of the capture camera's lens.</summary>
        public UnityEngine.Vector3 PositionWorld =>
            _nearCam != null ? _nearCam.transform.position : Mount.PartTransform.position;

        /// <summary>
        /// Set the pan slew target (degrees) directly. Clamps to the part's pan
        /// bounds and no-ops when the camera can't pan. Writes only the target;
        /// Refresh() slews the current toward it, so scripted pan animates like
        /// operator pan.
        /// </summary>
        public void SetPanTarget(float yaw, float pitch)
        {
            if (!SupportsPan) return;
            _panYawTarget = Mathf.Clamp(yaw, _pan.YawMin, _pan.YawMax);
            _panPitchTarget = Mathf.Clamp(pitch, _pan.PitchMin, _pan.PitchMax);
        }

        /// <summary>
        /// Aim the camera at a world-space point by inverting the mount-frame
        /// rotation the plugin applies (baseRot * Euler(-pitch, yaw, 0)) and
        /// delegating to <see cref="SetPanTarget"/>. No-op when the camera can't
        /// pan. Pairs with the shipped Kerbcast.PanAim.YawPitch math.
        /// </summary>
        public void AimAt(UnityEngine.Vector3 worldPoint)
        {
            if (!SupportsPan) return;
            var lens = _nearCam != null ? _nearCam.transform : Mount.PartTransform;
            UnityEngine.Vector3 dirWorld = (worldPoint - lens.position).normalized;

            // Resolved yaw joint (null for a no-joint pan camera) + its rest
            // rotation come from the pan capability; the YawInvert flag is read
            // from the same capability so this solve and _pan.Steer stay on one
            // sign convention.
            UnityEngine.Transform yawJoint = _pan.YawJoint;

            if (yawJoint == null)
            {
                // No joint: the lens carries the whole pan as
                // _baseRotation * Euler(-pitch, yaw, 0) in the part frame. Solve in
                // the part frame, which does not rotate with pan, so the angles are
                // absolute and stable.
                UnityEngine.Vector3 local = UnityEngine.Quaternion.Inverse(_baseRotation)
                    * Mount.PartTransform.InverseTransformDirection(dirWorld);
                float y, p;
                Kerbcast.PanAim.YawPitch(new Kerbcast.Vec3(local.x, local.y, local.z), out y, out p);
                SetPanTarget(y, p);
                return;
            }

            // Joint mount: the joint rotates by pan in its parent frame while the
            // lens stays fixed at _baseRotation relative to the joint. Solving
            // against the LIVE joint rotation feeds back — as the joint reaches the
            // target the residual angle collapses to zero, so the target is pulled
            // back to rest and it oscillates (judder). Solve against the joint's
            // REST pose so the angles are absolute.
            UnityEngine.Transform basis = yawJoint.parent != null
                ? yawJoint.parent : Mount.PartTransform;
            UnityEngine.Vector3 t = UnityEngine.Quaternion.Inverse(_pan.YawJointRestRot)
                * basis.InverseTransformDirection(dirWorld);           // target in the joint rest frame
            UnityEngine.Vector3 f0 = _baseRotation * UnityEngine.Vector3.forward;  // lens forward in the joint frame
            // Yaw about the joint's local Y and pitch about local X, each the angle
            // that carries the lens forward onto the target. Exact for yaw-only
            // heads (DC.TurretCam); a close decoupled approximation for compound
            // yaw+pitch heads. YawInvert matches the apply-side sign convention.
            float yaw = Mathf.Atan2(t.x, t.z) * Mathf.Rad2Deg - Mathf.Atan2(f0.x, f0.z) * Mathf.Rad2Deg;
            float pitch = Mathf.Asin(Mathf.Clamp(t.y, -1f, 1f)) * Mathf.Rad2Deg
                        - Mathf.Asin(Mathf.Clamp(f0.y, -1f, 1f)) * Mathf.Rad2Deg;
            if (_pan.YawInvert) yaw = -yaw;
            SetPanTarget(yaw, pitch);
        }

        /* Browser auto-track (issue #6). 0=none, 1=active-vessel, 2=target,
           set from the control block (SetTrackTarget) each poll. None (the
           default) makes Refresh's track step a single bool check with no other
           effect, so the kOS aim path is untouched. */
        private int _trackMode = TrackAim.ModeNone;
        /* Linked track_mode (sidecar-authoritative + eventual-consistency).
           DOWN: the control block carries track_mode + a track_seq the sidecar
           bumps on ANY authoritative change; we apply the control-block
           track_mode ONLY when track_seq moves (edge-trigger), so the sidecar's
           every-flush stale value can't revert a kOS-set mode. Init 0 = matches
           a freshly-created block, so a never-tracked camera never applies.
           UP: a kOS-facade SetTrackMode is optimistic-local (aims at once) and
           bumps _trackReportSeq, which the status writer echoes; the sidecar
           adopts it into its authoritative ControlState on the seq change. We
           bump _trackReportSeq ONLY for a kOS set, NEVER when applying a
           control-block flush — the anti-loop guard. */
        private uint _lastTrackSeq;
        private uint _trackReportSeq;

        /* Last successfully-aimed track pose, recorded whenever the tracked target
           resolves. On target LOSS (destroyed / unresolvable) while still tracking,
           these are re-asserted every frame so POV + gimbal FREEZE at the moment of
           loss rather than snapping back to the pre-tracking rest. _trackHasHeld is
           false until the first successful aim (nothing to freeze before then). */
        private bool _trackHasHeld;
        private float _trackHoldYaw;
        private float _trackHoldPitch;
        private float _trackHoldFov;

        /* Auto-zoom reference pair for TrackAim.FovForDistance: at
           AutoZoomReferenceDistanceM the framing FoV is AutoZoomReferenceFovDeg;
           closer widens, farther narrows (clamped to [FovMin,FovMax]). A heuristic
           tuning constant (no per-part target-size datum), so a tracked vessel that
           recedes stays framed. */
        private const float AutoZoomReferenceDistanceM = 1000f;
        private const float AutoZoomReferenceFovDeg = 20f;

        /// <summary>Apply the authoritative auto-track mode from the control
        /// block (the DOWN path). Called by PollControlFile on a track_seq edge.
        /// Does NOT bump the up-report seq (that is reserved for a kOS set — the
        /// anti-loop guard). Only acted on for a pan+zoom camera.</summary>
        public void SetTrackMode(int mode)
        {
            _trackMode = mode;
            if (mode == TrackAim.ModeNone) _trackHasHeld = false; // fresh next session
            // Route through the pinned policy (identity): the DOWN path must never
            // advance the up-report seq. Explicit so a future edit can't quietly
            // turn this into a feedback loop.
            _trackReportSeq = TrackAim.ReportSeqAfterDownApply(_trackReportSeq);
        }

        /// <summary>Set the auto-track mode from kOS (the UP path). Synchronous
        /// + optimistic-local: applies immediately (the camera aims at once) and
        /// stages an up-report by bumping _trackReportSeq, which the sidecar
        /// adopts as authoritative on its next status poll. GET reflects it at
        /// once. Only acted on for a pan+zoom camera.</summary>
        public void RequestTrackMode(int mode)
        {
            _trackMode = mode;
            if (mode == TrackAim.ModeNone) _trackHasHeld = false; // fresh next session
            _trackReportSeq = TrackAim.ReportSeqAfterKosSet(_trackReportSeq);
        }

        /// <summary>Current applied auto-track mode (0=none/1=active-vessel/
        /// 2=target). The synchronous kOS read.</summary>
        public int GetTrackMode() => _trackMode;

        /// <summary>Monotonic kOS-report seq, echoed in global.status.json so
        /// the sidecar adopts a kOS-set mode exactly once (never bumped by a
        /// control-block apply).</summary>
        public uint TrackReportSeq => _trackReportSeq;

        /* Resolve the current track target's WORLD position from FlightGlobals
           only (no orbit math): the active vessel's CoM, or its target's
           transform. Null when there is no active vessel / no target this
           frame (a no-op tick). */
        private UnityEngine.Vector3? ResolveTrackTarget()
        {
            if (_trackMode == TrackAim.ModeActiveVessel)
            {
                var v = FlightGlobals.ActiveVessel;
                return v != null ? (UnityEngine.Vector3?)v.CoM : null;
            }
            if (_trackMode == TrackAim.ModeTarget)
            {
                var tgt = FlightGlobals.ActiveVessel != null
                    ? FlightGlobals.ActiveVessel.targetObject
                    : null;
                var tr = tgt != null ? tgt.GetTransform() : null;
                return tr != null ? (UnityEngine.Vector3?)tr.position : null;
            }
            return null;
        }

        /// <summary>
        /// Cascade table: (resolution multiplier, layers to drop). Lower
        /// levels are gentler on perception. Resolution reduction wins over
        /// layer dropping because it preserves scene completeness: a blurrier
        /// full image is more useful than a sharp scene with a missing layer.
        /// All layers are kept until the emergency level; only resolution drops
        /// before then. Galaxy in particular is cheap (one skybox cube, no PQS
        /// or atmosphere) and is the operator's star-field / orientation
        /// reference, so shedding it early (as an earlier table did at level 3)
        /// blacked out the background under load for almost no headroom.
        /// </summary>
        private static readonly (float ResScale, CameraLayers Drop)[] ShedTable =
        {
            (1.00f, CameraLayers.None),                                 // 0: full
            (0.75f, CameraLayers.None),                                 // 1: gentle res drop
            (0.50f, CameraLayers.None),                                 // 2: half res
            (0.35f, CameraLayers.None),                                 // 3: deeper res drop, keep all layers
            (0.25f, CameraLayers.None),                                 // 4: quarter res, keep all layers
            /* Emergency last resort only: dropping Far reintroduces the black
               band between the scaled and near handoff, and dropping Galaxy
               blacks out the star-field. Tier placement provisional pending the
               Deck perf baseline (section 8.0). */
            (0.25f, CameraLayers.Galaxy | CameraLayers.Scaled | CameraLayers.Far),  // 5: emergency (last resort; reintroduces far black band)
        };

        public static int MaxShedLevel => ShedTable.Length - 1;

        // The two quality inputs that compose into the effective render
        // size. _shedLevel is owned by the adaptive machinery (KerbcastCore's
        // AdaptiveQualityController via ApplyAutoShed); _viewerLevel by the
        // viewer's quality preset (control block via PollControlFile). They
        // never touch each other; ApplyEffectiveQuality min()s their scales.
        private int _shedLevel;
        private int _viewerLevel;

        /// <summary>Currently-applied viewer quality level (index into
        /// QualityClamp.ViewerScales; 0 = no viewer clamp).</summary>
        public int ViewerLevel => _viewerLevel;

        /// <summary>
        /// Apply an adaptive-controller quality level. Stores the level and
        /// recomputes the effective size/layers; the viewer clamp composes
        /// via min() inside ApplyEffectiveQuality, so a demote always wins
        /// over a viewer target and a promote hands control back to it.
        /// </summary>
        public void ApplyAutoShed(int level)
        {
            if (level < 0) level = 0;
            if (level > MaxShedLevel) level = MaxShedLevel;
            _shedLevel = level;
            ApplyEffectiveQuality();
        }

        /// <summary>
        /// Apply a viewer-requested quality clamp (sidecar control block's
        /// viewer_level; 0 = full / no clamp). Only ever lowers resolution
        /// below the operator ceiling; layers are untouched (those belong
        /// to the operator mask and the shed cascade) and the adaptive
        /// controller's state is never read or written here.
        /// </summary>
        public void SetViewerQualityLevel(int level)
        {
            int clamped = QualityClamp.ClampViewerLevel(level);
            if (_viewerLevel == clamped) return;
            _viewerLevel = clamped;
            Debug.Log($"[Kerbcast] cam={FlightId} viewer quality level → {clamped} "
                + $"(scale {QualityClamp.ViewerScales[clamped]:F2})");
            ApplyEffectiveQuality();
        }

        // THE single resolution-change path. Every quality input (operator
        // ceiling changes, adaptive shed moves, viewer clamp moves) funnels
        // here, so the pooled-RT SetRenderSize mechanism is the only way
        // render dims ever change. effective = min(ceiling, shed, viewer).
        private void ApplyEffectiveQuality()
        {
            var (resScale, drop) = ShedTable[_shedLevel];
            float scale = QualityClamp.EffectiveScale(resScale, _viewerLevel);

            int targetW = QualityClamp.ScaleDimension(OperatorWidth, scale);
            int targetH = QualityClamp.ScaleDimension(OperatorHeight, scale);
            if (targetW != RenderWidth || targetH != RenderHeight)
            {
                SetRenderSize(targetW, targetH);
            }

            // Layer dropping stays purely shed-driven: viewers can lower
            // resolution but never which layers render.
            var targetLayers = _operatorLayers & ~drop;
            if (_layers != targetLayers)
            {
                _layers = targetLayers;
                ApplyLayers();
            }
        }

        // Cached list of scaled-body renderers (one per celestial body that has
        // one). Built once on first scaled render; bodies are fixed for the
        // flight and the camera is recreated on vessel change, so we never
        // refresh it. Replaces a per-frame, per-camera GetComponent sweep over
        // FlightGlobals.Bodies.
        private List<Renderer> ScaledBodyRenderers()
        {
            if (_scaledBodyRenderers != null) return _scaledBodyRenderers;
            _scaledBodyRenderers = new List<Renderer>();
            foreach (var body in FlightGlobals.Bodies)
            {
                var r = body.scaledBody?.GetComponent<Renderer>();
                if (r != null) _scaledBodyRenderers.Add(r);
            }
            return _scaledBodyRenderers;
        }

        private void ApplyLayers()
        {
            // Cameras are permanently disabled (enabled=false) — Unity's
            // auto-render is never used for our offscreen cameras. The
            // layer mask (_layers) is already updated by the caller before
            // ApplyLayers() is invoked; Refresh() consumes it to decide
            // which camera.Render() calls to make this tick. Nothing
            // additional needed here.
        }

        // Sidecar→plugin control channel. The sidecar's data-channel handlers
        // (SetLayers / SetRenderSize / SetFov / SetPan / *-rate) write the full
        // operator-requested state into the <FlightId>.control.bin shared-memory
        // block under a seqlock. The plugin reads it here each frame; the block's
        // monotonic seq is the change detector, so a skip is cheap and a rate=0
        // stop can never be missed.
        private void PollControlFile()
        {
            try
            {
                if (_controlBlock == null)
                {
                    _controlBlock = ControlBlock.Open(_controlPath, out var openRes);
                    if (openRes == ControlBlock.OpenResult.VersionMismatch)
                    {
                        Debug.LogError(
                            $"[Kerbcast] cam={FlightId} control-block layout version mismatch — "
                            + "sidecar and plugin are out of sync; control is disabled until they match");
                    }
                    if (_controlBlock == null) return; // file not ready yet
                }

                // Returns false when nothing has changed since the last applied
                // write / the writer is mid-write / nothing has been written.
                if (!_controlBlock.TryReadChanged(out var snap)) return;

                // Subscriber flag drives the per-layer Camera.enabled state via
                // ApplyLayers. Always present in the block (sidecar always writes
                // it); defaults safe-asleep on a brand-new block.
                if (snap.Subscribed != _subscribed)
                {
                    _subscribed = snap.Subscribed;
                    if (_subscribed)
                    {
                        // Due immediately on resubscribe: a stale interval from
                        // before the gap must not hold the first frame back.
                        _pacing.Reset();
                        // Snap interpolation to target on peer reconnect so the
                        // peer sees the current commanded position immediately
                        // instead of a phantom pan-back from the last rest position.
                        _panYawCurrent = _panYawTarget;
                        _panPitchCurrent = _panPitchTarget;
                        // Mirror the snap for FoV: jump the displayed FoV to its
                        // commanded target (and apply to the cameras + Hullcam GUI)
                        // so a resubscribing peer sees the commanded zoom at once
                        // rather than slewing from a stale value.
                        if (SupportsZoom)
                        {
                            Fov = _fovTarget;
                            Mount.Zoom?.SetFov(Fov);
                            if (_nearCam != null) _nearCam.fieldOfView = Fov;
                            if (_scaledCam != null) _scaledCam.fieldOfView = Fov;
                            if (_galaxyCam != null) _galaxyCam.fieldOfView = Fov;
                            if (_farCam != null) _farCam.fieldOfView = Fov;
                        }
                    }
                    Debug.Log($"[Kerbcast] cam={FlightId} subscribed → {_subscribed}");
                    ApplyLayers();
                }

                /* Requested capture rate. Absent = capture at the primary rate,
                   which is what a predating background capture sidecar writes, so an old sidecar and
                   a new plugin behave exactly as before. */
                _pacing.RequestedFps = snap.CaptureFps;

                if (snap.HasLayers)
                {
                    // layers_mask uses the same bit values as CameraLayers
                    // (Near=1, Scaled=2, Galaxy=4).
                    SetOperatorLayers((CameraLayers)snap.LayersMask);
                    Debug.Log($"[Kerbcast] cam={FlightId} operator layers → {_operatorLayers}");
                }

                // Viewer quality clamp. Absent means auto (level 0, no
                // clamp); SetViewerQualityLevel no-ops when unchanged, so
                // re-published snapshots are free. Applies even when the
                // AdaptiveQuality flag is off: the viewer clamp rides the
                // same ApplyEffectiveQuality path with _shedLevel pinned 0.
                SetViewerQualityLevel(
                    snap.ViewerLevel.HasValue ? (int)snap.ViewerLevel.Value : 0);

                // Auto-resolution: the sidecar writes the effective max-consumer
                // size (already capped at manual SetRenderSize) into Width/Height.
                // Apply it as the runtime operator CEILING; the adaptive-shed and
                // viewer-clamp min() still ride underneath via ApplyEffectiveQuality.
                // Both fields must be present (a size needs both); the even/clamp/
                // <=max guards live in SetOperatorRenderSize -> SetRenderSize, so no
                // duplication here. Changed-check avoids re-applying the same
                // ceiling when an unrelated field triggered this poll.
                if (snap.Width.HasValue && snap.Height.HasValue)
                {
                    int w = (int)snap.Width.Value;
                    int h = (int)snap.Height.Value;
                    if (w != OperatorWidth || h != OperatorHeight)
                    {
                        SetOperatorRenderSize(w, h);
                        Debug.Log($"[Kerbcast] cam={FlightId} operator render size → {w}×{h}");
                    }
                }

                // Absolute FoV is applied only when its seq changes (see
                // _lastFovSeq) so the stale fov re-published on unrelated writes /
                // the zoom-rate-stop write doesn't snap a drifting _fovTarget back.
                long fovSeq = snap.FovSeq;
                if (snap.Fov.HasValue && SupportsZoom && fovSeq != _lastFovSeq)
                {
                    SetFov(snap.Fov.Value);
                }
                _lastFovSeq = fovSeq;
                // Zoom rate. Absent leaves the current rate unchanged; an explicit
                // 0 stops zooming. +rate = zoom IN (FoV decreases).
                if (SupportsZoom && snap.ZoomRate.HasValue)
                {
                    _zoomRate = Mathf.Clamp(snap.ZoomRate.Value, -1f, 1f);
                }

                // Auto-track mode (linked, sidecar-authoritative). Apply the
                // control-block track_mode ONLY when track_seq changes: the
                // sidecar re-publishes the full state every flush, so applying
                // every poll would let its stale track_mode overwrite a kOS-set
                // mode each frame. The edge-trigger (mirroring _lastFovSeq) makes
                // a stale flush idempotent while a genuine authoritative change
                // (browser SetTrackTarget OR the sidecar adopting a kOS report)
                // still lands. Absent bit => none (the sidecar writes full state,
                // so absent means not-tracking). Uses SetTrackMode (the DOWN
                // path) so it does NOT bump the up-report seq.
                if (TrackAim.ShouldApplyDown(snap.TrackSeq, _lastTrackSeq))
                {
                    _lastTrackSeq = snap.TrackSeq;
                    SetTrackMode((int)(snap.TrackMode ?? 0u));
                }

                if (SupportsPan)
                {
                    // Absolute pan is applied only when panSeq changes (covers
                    // both yaw and pitch) for the same reason as fov above.
                    long panSeq = snap.PanSeq;
                    if (panSeq != _lastPanSeq)
                    {
                        if (snap.PanYaw.HasValue)
                            _panYawTarget = Mathf.Clamp(snap.PanYaw.Value, _pan.YawMin, _pan.YawMax);
                        if (snap.PanPitch.HasValue)
                            _panPitchTarget = Mathf.Clamp(snap.PanPitch.Value, _pan.PitchMin, _pan.PitchMax);
                    }
                    _lastPanSeq = panSeq;
                    // Pan rates. Absent leaves the current rate unchanged; an
                    // explicit 0 stops that axis. +yawRate = right, +pitchRate = up.
                    if (snap.PanYawRate.HasValue)
                        _panYawRate = Mathf.Clamp(snap.PanYawRate.Value, -1f, 1f);
                    if (snap.PanPitchRate.HasValue)
                        _panPitchRate = Mathf.Clamp(snap.PanPitchRate.Value, -1f, 1f);
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Kerbcast] cam={FlightId} control block read failed: {ex.Message}");
            }
        }

        // (The control file's hand-rolled JSON parsers were removed when the
        // control channel moved to the binary ControlBlock — see ControlBlock.cs.)

        // Static-per-life-of-camera metadata the sidecar serves via
        // GET /cameras. The plugin owns this file; the sidecar reads it
        // when it discovers the matching ring. Vessel name is technically
        // mutable (rename in flight), but for the v0.3 milestone the
        // capture-time snapshot is sufficient — vessel renames are rare.
        //
        // Identity fields are read from the cached snapshot (populated in
        // the constructor) rather than from Hullcam.part directly so the
        // same code path stays safe when called from Dispose during part
        // destruction (where Hullcam.part may already be null).
        public void WriteInfoManifest()
        {
            WriteManifest("active");
        }

        // Rewrites the info.json with lifecycle="destroyed". Called from
        // Dispose before any cleanup so the sidecar can observe the
        // transition before the ring is closed. Wrapped in try/catch so a
        // write failure never blocks the cleanup path.
        public void WriteDestroyedManifest()
        {
            try
            {
                WriteManifest("destroyed");
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Kerbcast] cam={FlightId} destroyed manifest write failed: {ex.Message}");
            }
        }

        private void WriteManifest(string lifecycle)
        {
            try
            {
                var json = "{\n"
                    + $"  \"lifecycle\": \"{lifecycle}\",\n"
                    + $"  \"kind\": \"part\",\n"
                    + $"  \"flight_id\": {FlightId},\n"
                    + $"  \"part_name\": \"{EscapeJson(_cachedPartName)}\",\n"
                    + $"  \"part_title\": \"{EscapeJson(_cachedPartTitle)}\",\n"
                    + $"  \"camera_name\": \"{EscapeJson(_cachedCameraName)}\",\n"
                    + $"  \"vessel_name\": \"{EscapeJson(_cachedVesselName)}\",\n"
                    + $"  \"supports_zoom\": {(SupportsZoom ? "true" : "false")},\n"
                    + $"  \"fov\": {Fov.ToString(System.Globalization.CultureInfo.InvariantCulture)},\n"
                    + $"  \"fov_min\": {FovMin.ToString(System.Globalization.CultureInfo.InvariantCulture)},\n"
                    + $"  \"fov_max\": {FovMax.ToString(System.Globalization.CultureInfo.InvariantCulture)},\n"
                    + $"  \"supports_pan\": {(SupportsPan ? "true" : "false")},\n"
                    + $"  \"pan_yaw_min\": {PanYawMin.ToString(System.Globalization.CultureInfo.InvariantCulture)},\n"
                    + $"  \"pan_yaw_max\": {PanYawMax.ToString(System.Globalization.CultureInfo.InvariantCulture)},\n"
                    + $"  \"pan_pitch_min\": {PanPitchMin.ToString(System.Globalization.CultureInfo.InvariantCulture)},\n"
                    + $"  \"pan_pitch_max\": {PanPitchMax.ToString(System.Globalization.CultureInfo.InvariantCulture)}\n"
                    + "}\n";
                File.WriteAllText(_infoPath, json);
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Kerbcast] cam={FlightId} info manifest write failed (lifecycle={lifecycle}): {ex.Message}");
            }
        }

        private static string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return string.Empty;
            var sb = new System.Text.StringBuilder(s.Length + 8);
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append($"\\u{(int)c:X4}");
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }

        public void Refresh(bool mayIssueReadback)
        {
            // Read the telemetry gate once per tick so the OFF path makes zero
            // GetTimestamp calls (zero-cost when disabled). BeginTick hands the
            // snapshot to the capture tail and resets its per-tick drain
            // accumulator.
            _telemetry = KerbcastSettings.EnableTelemetry;
            _capture.BeginTick(_telemetry);

            // Control-file poll every frame (~60Hz at 60fps). PollControlFile
            // reads the (tiny, tmpfs-backed) file and compares its contents, so
            // the cost is one small read + a string compare per frame — the work
            // of applying state only runs when the contents actually change. At
            // the previous 20Hz cadence (countdown=3), a released pan-rate command
            // could go unacknowledged for up to 50ms (~1.25° overshoot at 25°/s);
            // at 60Hz pickup latency drops to ~16ms and overshoot to ~0.42°.
            if (--_controlCheckCountdown <= 0)
            {
                _controlCheckCountdown = 1;
                PollControlFile();
            }

            // Browser auto-track (issue #6): resolve the tracked world point and
            // set the pan target BEFORE the slew, so the existing MoveTowards
            // filter animates toward it. Gated on a real mode + a pan+zoom mount;
            // track_mode==none (the default) makes this a single bool check with
            // no other effect, so the kOS aim path is untouched. A browser track
            // overrides a kOS aim on the same camera (this runs in LateUpdate,
            // after kOS's in-cycle aim). AimAt no-ops if the point is unresolved.
            // Auto-zoom rides the SAME gate as the aim: automatic whenever a track
            // mode is set (Jon's call — a tracked vessel that flies away stays
            // framed), no separate control. While tracking, auto-zoom OWNS the zoom
            // (overrides manual, as the aim owns pan); track_mode==none skips the
            // whole block, so the zero-effect-when-off guarantee covers FOV too (no
            // zoom write when not tracking). The aim math (AimAt) and zoom math
            // (TrackAim.FovForDistance) stay distinct — this only CALLS both.
            if (TrackAim.ShouldAim(_trackMode, SupportsPan, SupportsZoom))
            {
                UnityEngine.Vector3? target = ResolveTrackTarget();
                switch (TrackAim.Decide(
                    _trackMode, SupportsPan, SupportsZoom, target.HasValue, _trackHasHeld))
                {
                    case TrackAim.TrackAction.Aim:
                        AimAt(target.Value);
                        // Frame by camera->target distance; SetFov clamps to
                        // [FovMin,FovMax] and slews, so a receding vessel stays
                        // framed smoothly. Reference pair (distance,fov) is a
                        // heuristic tuning constant, not a per-part datum.
                        float distance = (target.Value - PositionWorld).magnitude;
                        SetFov(TrackAim.FovForDistance(
                            distance, FovMin, FovMax,
                            AutoZoomReferenceDistanceM, AutoZoomReferenceFovDeg));
                        // Record the just-aimed pose so a subsequent target loss
                        // freezes here (SetPanTarget/SetFov clamp, so read the
                        // clamped targets back rather than the raw solve).
                        _trackHoldYaw = _panYawTarget;
                        _trackHoldPitch = _panPitchTarget;
                        _trackHoldFov = _fovTarget;
                        _trackHasHeld = true;
                        break;
                    case TrackAim.TrackAction.HoldLast:
                        // Target lost — FREEZE at the last-aimed pose. Re-asserted
                        // every frame so POV + gimbal stay put and no stale
                        // pre-track absolute (from a control poll) can snap them
                        // back. Track mode stays set until the operator clears it.
                        SetPanTarget(_trackHoldYaw, _trackHoldPitch);
                        SetFov(_trackHoldFov);
                        break;
                    // None: nothing to aim or hold (e.g. lost before the first aim).
                }
            }

            // Pan slew runs every tick regardless of subscription state so
            // the physical mesh keeps animating when no peer is watching.
            // The near-cam rotation update is a no-op while cameras are
            // unsubscribed (no Render() call happens), but it keeps the
            // transform consistent for the frame when subscription resumes.
            if (SupportsPan)
            {
                // Velocity integration: advance the pan TARGET by the persistent
                // rate before the slew runs, so the existing MoveTowards (the
                // fast final smoothing filter) tracks the advancing target.
                // Bounds-clamped so a stuck rate parks at the travel limit rather
                // than running away. +yawRate = pan right, +pitchRate = pan up.
                if (_panYawRate != 0f || _panPitchRate != 0f)
                {
                    _panYawTarget = Mathf.Clamp(
                        _panYawTarget + _panYawRate * _pan.PanRateDegPerSec * Time.deltaTime,
                        _pan.YawMin, _pan.YawMax);
                    _panPitchTarget = Mathf.Clamp(
                        _panPitchTarget + _panPitchRate * _pan.PanRateDegPerSec * Time.deltaTime,
                        _pan.PitchMin, _pan.PitchMax);
                }

                float maxDelta = _pan.SlewDegPerSec * Time.deltaTime;
                _panYawCurrent = Mathf.MoveTowards(_panYawCurrent, _panYawTarget, maxDelta);
                _panPitchCurrent = Mathf.MoveTowards(_panPitchCurrent, _panPitchTarget, maxDelta);

                // Near camera (core owns it): a joint carries the pan, so the
                // camera rests at _baseRotation relative to the joint; a no-joint
                // camera carries the full pan itself. Positive pan_yaw = turn
                // right; positive pan_pitch = up (Unity X-rotation is positive-
                // down, hence the negation).
                if (_nearCam != null)
                {
                    if (_pan.YawJoint != null)
                        _nearCam.transform.localRotation = _baseRotation;
                    else
                        _nearCam.transform.localRotation = _baseRotation
                            * Quaternion.Euler(-_panPitchCurrent, _panYawCurrent, 0f);
                }

                // Joint mesh application (compound vs yaw-only, YawInvert, pitch
                // pivot, co-rotating base) lives in the capability so core never
                // sees the flip. No-op for a no-joint camera.
                _pan.Steer(_panYawCurrent, _panPitchCurrent);
            }

            // Zoom: integrate the persistent zoom rate into the FoV target, then
            // slew the displayed FoV toward it. Runs every tick (BEFORE the
            // subscription gate) for the same reason as the pan slew — so a
            // resubscribing peer finds Fov already tracking its commanded target
            // rather than mid-step. +rate = zoom IN, so SUBTRACT from FoV.
            // Bounds-clamped to [FovMin, FovMax] so a stuck rate parks at the
            // limit. This makes BOTH discrete set-fov and set-zoom-rate smooth.
            if (SupportsZoom)
            {
                if (_zoomRate != 0f)
                    _fovTarget = Mathf.Clamp(
                        _fovTarget - _zoomRate * _zoomCap.ZoomRateDegPerSec * Time.deltaTime,
                        FovMin, FovMax);
                if (Mathf.Abs(Fov - _fovTarget) > 0.001f)
                {
                    Fov = Mathf.MoveTowards(Fov, _fovTarget, _zoomCap.FovSlewDegPerSec * Time.deltaTime);
                    // Keep the module's FoV (right-click GUI) in sync with the
                    // actually-displayed FoV — the zoom capability applies it to
                    // the underlying module. Tracks the slewing value, including
                    // rate-driven zoom, so the GUI matches the stream throughout.
                    // No-op when the camera can't zoom (a non-zoom camera never
                    // changes Fov, so this is never reached for one anyway).
                    Mount.Zoom?.SetFov(Fov);
                    if (_nearCam != null) _nearCam.fieldOfView = Fov;
                    if (_scaledCam != null) _scaledCam.fieldOfView = Fov;
                    if (_galaxyCam != null) _galaxyCam.fieldOfView = Fov;
                    if (_farCam != null) _farCam.fieldOfView = Fov;
                }
            }

            // Subscriber-aware skip: when no peer is subscribed, skip all
            // rendering work — no camera.Render() calls, no readback, no
            // ring writes, no encoder work downstream. Pending in-flight
            // readbacks (subscribe→unsubscribe race) still drain on the
            // next path.
            if (!_subscribed)
            {
                _capture.Drain();
                return;
            }

            // Poll: drain a completed readback before issuing a new one. If one
            // is still in flight (not done), skip this tick so the one-in-flight
            // invariant holds — no new readback is issued below.
            if (_capture.ReadbackInFlight && !_capture.ReadbackReady) return;
            _capture.Drain();

            // Capture staggering: KerbcastCore grants only a round-robin subset of
            // cameras a new capture each frame, so they don't all render + read
            // back on the same frame (bounding simultaneous in-flight readbacks).
            // The control poll, pan slew and readback drain above still run every
            // frame; only the render + readback issue below is paced.
            if (!mayIssueReadback) return;

            // Zero this frame's per-phase Last values before recording, so a
            // phase shed this tick reads 0 rather than its last-rendered figure
            // (otherwise the across-camera Last sum overstates cost under
            // adaptive layer shedding). EMA / rolling-max are preserved.
            if (_telemetry) _phaseTimings.BeginFrame();

            try
            {
                // Manual render sequence: galaxy → scaled → far → near.
                // Cameras are permanently disabled (enabled=false) so
                // Unity's auto-render never fires them; we drive each
                // layer explicitly here and gate on the current layer mask
                // (mirroring the old enabled-flag gating).
                //
                // Strip Scatterer's screen-space shadow CommandBuffers off the
                // sun light(s) for the WHOLE composite, restoring after the near
                // render (and in the outer catch, as a safety net). Those buffers
                // are attached to the sun light for the session and would
                // otherwise fire during each clone layer render without their
                // per-camera fade compensator, painting fixed-position, depth-
                // occluded dark bands at planet depth. No-op when Scatterer (or
                // another buffer-attaching mod) is absent.
                ScaledSunLightHelper.StripCompositeShadowsBuffer();

                if (_galaxyCam != null && (_layers & CameraLayers.Galaxy) != 0)
                {
                    long t0 = _telemetry ? System.Diagnostics.Stopwatch.GetTimestamp() : 0;
                    _integrationHost?.PerFrame(_galaxyCam, CameraLayers.Galaxy, BuildIntegrationFrameState(CameraLayers.Galaxy));
                    _galaxyCam.Render();
                    if (_telemetry)
                        _phaseTimings.Record(RenderPhase.Galaxy,
                            (System.Diagnostics.Stopwatch.GetTimestamp() - t0) * _msPerTick);
                }

                // Scaled layer: bracket the whole block (fader override
                // bookkeeping + Render + restore) so the recorded cost matches
                // the main-thread work this layer actually adds per tick.
                long scaledStart = _telemetry ? System.Diagnostics.Stopwatch.GetTimestamp() : 0;
                if (_scaledCam != null && (_layers & CameraLayers.Scaled) != 0)
                {
                    // ScaledSpaceFader disables scaled-body renderers globally
                    // based on the main camera's angular size. Our camera renders
                    // from a different position, so we manage visibility ourselves:
                    // force-enable any renderer that ScaledSpaceFader switched off,
                    // render, then restore. The finally block guarantees restore even
                    // if Render() throws.
                    // ScaledSpaceFader controls scaled-body visibility in two ways:
                    // (1) r.enabled=false when below fadeStart — renderer entirely off.
                    // (2) r.material._FadeAltitude ramping 0→1 in the transition zone
                    //     while r.enabled=true — planet fades in gradually.
                    // Our camera renders from a different position so we bypass both:
                    // force-enable and override _FadeAltitude=1 for any renderer that
                    // ScaledSpaceFader has suppressed. Original state is saved and
                    // restored in the finally block so the main camera's view is
                    // unaffected.
                    _faderOverrides.Clear();
                    var bodyRenderers = ScaledBodyRenderers();
                    for (int bi = 0; bi < bodyRenderers.Count; bi++)
                    {
                        var r = bodyRenderers[bi];
                        if (r == null) continue; // body renderer torn down since cache
                        bool wasEnabled = r.enabled;
                        // Guard the read: some scaled-body materials (e.g. the
                        // sun, mod-added bodies) lack _FadeAltitude. GetFloat on
                        // a missing property logs an error every body, every cam,
                        // every frame — thousands/sec. Default to 1 (no fade).
                        float fade = r.material.HasProperty(_fadeAltitudeId)
                            ? r.material.GetFloat(_fadeAltitudeId)
                            : 1f;
                        if (!wasEnabled || fade < 1f)
                        {
                            _faderOverrides.Add(new FaderState { Renderer = r, WasEnabled = wasEnabled, OriginalFade = fade });
                            if (!wasEnabled) r.enabled = true;
                            r.GetPropertyBlock(_faderMpb);
                            _faderMpb.SetFloat(_fadeAltitudeId, 1f);
                            r.SetPropertyBlock(_faderMpb);
                        }
                    }
                    try
                    {
                        if (_firstPixelCheck)
                        {
                            var ssl = ScaledSunLightHelper.GetScaledSunLight();
                            Debug.Log($"[Kerbcast] pre-scaled-render: " +
                                $"ambient={RenderSettings.ambientLight} ambientMode={RenderSettings.ambientMode} " +
                                $"scaledSunLight={(ssl == null ? "null" : $"enabled={ssl.enabled} intensity={ssl.intensity} color={ssl.color} cullingMask={ssl.cullingMask}")}");
                        }
                        _integrationHost?.PerFrame(_scaledCam, CameraLayers.Scaled, BuildIntegrationFrameState(CameraLayers.Scaled));
                        _scaledCam.Render();
                        if (_firstRender)
                        {
                            _firstRender = false;
                            Debug.Log($"[Kerbcast] cam={FlightId} scaled actualRenderingPath={_scaledCam.actualRenderingPath} (set={_scaledCam.renderingPath})");
                        }
                        if (_firstPixelCheck)
                        {
                            _firstPixelCheck = false;
                            var prev = RenderTexture.active;
                            RenderTexture.active = _capture.CaptureRt;
                            var sample = new Texture2D(1, 1, TextureFormat.RGBA32, false);
                            sample.ReadPixels(new Rect(_capture.CaptureRt.width / 2, _capture.CaptureRt.height / 2, 1, 1), 0, 0);
                            sample.Apply();
                            var px = sample.GetPixel(0, 0);
                            UnityEngine.Object.Destroy(sample);
                            RenderTexture.active = prev;
                            Debug.Log($"[Kerbcast] cam={FlightId} scaled center pixel: r={px.r:F3} g={px.g:F3} b={px.b:F3} a={px.a:F3}");
                        }
                    }
                    finally
                    {
                        foreach (var state in _faderOverrides)
                        {
                            // Restore _FadeAltitude to ScaledSpaceFader's value in the
                            // MPB so the main camera sees the correct fade. Get the
                            // current MPB (which may carry _sunLightDirection etc) and
                            // only replace the one property we overrode. Reuses the
                            // shared scratch block — no per-frame allocation.
                            if (state.Renderer == null) continue;
                            state.Renderer.GetPropertyBlock(_faderMpb);
                            _faderMpb.SetFloat(_fadeAltitudeId, state.OriginalFade);
                            state.Renderer.SetPropertyBlock(_faderMpb);
                            state.Renderer.enabled = state.WasEnabled;
                        }
                    }
                }
                if (_telemetry && _scaledCam != null && (_layers & CameraLayers.Scaled) != 0)
                    _phaseTimings.Record(RenderPhase.Scaled,
                        (System.Diagnostics.Stopwatch.GetTimestamp() - scaledStart) * _msPerTick);

                if (_farCam != null && (_layers & CameraLayers.Far) != 0)
                {
                    long farStart = _telemetry ? System.Diagnostics.Stopwatch.GetTimestamp() : 0;
                    _integrationHost?.PerFrame(_farCam, CameraLayers.Far, BuildIntegrationFrameState(CameraLayers.Far));
                    _farCam.Render();
                    if (_telemetry)
                        _phaseTimings.Record(RenderPhase.Far,
                            (System.Diagnostics.Stopwatch.GetTimestamp() - farStart) * _msPerTick);
                }

                if (_nearCam != null && (_layers & CameraLayers.Near) != 0)
                {
                    // FX effects update materials and (re)attach their command
                    // buffers before the render; the near render then executes
                    // those CBs (e.g. the core sheath at AfterForwardAlpha).
                    // Time the FX build + render + near render together (the
                    // task's "near Render() (+ FX)" phase).
                    long t0 = _telemetry ? System.Diagnostics.Stopwatch.GetTimestamp() : 0;
                    _integrationHost?.PerFrame(_nearCam, CameraLayers.Near, BuildIntegrationFrameState(CameraLayers.Near));
                    _fxHost?.Render(BuildFxFrameState());
                    _nearCam.Render();
                    if (_telemetry)
                        _phaseTimings.Record(RenderPhase.Near,
                            (System.Diagnostics.Stopwatch.GetTimestamp() - t0) * _msPerTick);
                }

                // Composite done: re-attach Scatterer's sun-light shadow buffers
                // so the main flight render this frame gets correct shadows. The
                // outer catch also restores, so a throw mid-composite cannot leave
                // them stripped.
                ScaledSunLightHelper.RestoreCompositeShadowsBuffer();

                // Capture tail: blit _capture.CaptureRt -> ReadbackRt (via this
                // camera's filter/nightvision/plain _captureBlit), apply the
                // vertical-flip correction, issue the readback under the
                // one-in-flight invariant, and record the Blit/Readback phase
                // timings. All of it lives in CaptureCore so a second camera type
                // reuses the exact streaming path. Time.unscaledTime is
                // frame-constant, so reading it here yields the same value the
                // pre-extraction Request site read.
                double captureTsMs = Time.unscaledTime * 1000.0;
                _capture.Publish(captureTsMs, _captureBlit);
            }
            catch (Exception ex)
            {
                _capture.AbortInFlight();
                // Safety net: if a layer Render() threw mid-composite, the normal
                // restore above was skipped. Re-attach here so the main flight
                // render never loses Scatterer's sun-light shadow buffers. No-op
                // if the normal path already restored (the saved list is cleared).
                ScaledSunLightHelper.RestoreCompositeShadowsBuffer();
                LogRateLimited($"capture pipeline threw: {ex.GetType().Name}: {ex.Message}");
            }
        }

        private void LogRateLimited(string message)
        {
            // 1-in-300 frames at 30fps = log at most once per 10s per camera.
            if (_consecutiveErrors == 0 || _consecutiveErrors % 300 == 0)
            {
                Debug.Log($"[Kerbcast] cam={FlightId} {message}");
            }
            _consecutiveErrors++;
        }

        /// <summary>
        /// Standard disposal: tear down cameras and ring, delete all sidecar
        /// files (ring, info, control). Used by RebuildCameraList (vessel change)
        /// and OnDestroy (scene exit) where the part was not destroyed in-flight.
        /// </summary>
        public void Dispose()
        {
            DisposeCore(partDestroyed: false);
        }

        /// <summary>
        /// Destruction-path disposal: writes <c>lifecycle: "destroyed"</c> to
        /// the info.json tombstone BEFORE closing the ring, then deletes the
        /// ring and control files but leaves the info.json for the sidecar to
        /// read. Called by OnPartDestroyed and the LateUpdate defensive sweep.
        /// </summary>
        public void DisposeDestroyed()
        {
            DisposeCore(partDestroyed: true);
        }

        private void DisposeCore(bool partDestroyed)
        {
            // Guard against double-dispose (onPartDestroyed and the LateUpdate
            // defensive sweep can both fire; RebuildCameraList on vessel change
            // is also a caller). Second call is a no-op.
            if (_disposed) return;
            _disposed = true;

            // The Material is owned by the static KerbcastNightVisionFilter cache;
            // only null the ref, not Destroy it.
            _nvMaterial = null;

            if (partDestroyed)
            {
                // Write the destroyed tombstone BEFORE closing the ring so the
                // sidecar can observe the lifecycle transition. Failure here
                // must never block the cleanup path.
                WriteDestroyedManifest();
            }

            if (_cameraFilter != null)
            {
                try { _cameraFilter.Deactivate(); }
                catch (Exception ex) { UnityEngine.Debug.LogWarning($"[Kerbcast] cam={FlightId} CameraFilter.Deactivate failed: {ex.Message}"); }
                _cameraFilter = null;
            }
            _filterBlit.DestroyMaterial();
            // Tear down FX effects (detach their CBs, release materials) before
            // destroying the camera they're attached to.
            _fxHost?.Dispose();
            _fxHost = null;
            // Detach visual-mod integrations before destroying the cameras: this
            // restores any third-party global/singleton state and removes the
            // components/buffers each integration added, mirroring the per-layer
            // ApplyToLayer calls in SetCameras. Destroying the GameObjects also
            // fires each swap component's OnDisable, but calling RemoveFromLayer
            // makes the apply/remove contract explicit rather than implicit.
            if (_integrationHost != null)
            {
                if (_nearCam != null) _integrationHost.RemoveFromLayer(_nearCam, CameraLayers.Near);
                if (_scaledCam != null) _integrationHost.RemoveFromLayer(_scaledCam, CameraLayers.Scaled);
                if (_galaxyCam != null) _integrationHost.RemoveFromLayer(_galaxyCam, CameraLayers.Galaxy);
                if (_farCam != null) _integrationHost.RemoveFromLayer(_farCam, CameraLayers.Far);
                _integrationHost = null;
            }
            if (_nearCam != null) UnityEngine.Object.Destroy(_nearCam.gameObject);
            if (_scaledCam != null) UnityEngine.Object.Destroy(_scaledCam.gameObject);
            if (_galaxyCam != null) UnityEngine.Object.Destroy(_galaxyCam.gameObject);
            if (_farCam != null) UnityEngine.Object.Destroy(_farCam.gameObject);
            // Release the capture tail's pooled render-target sets (its current
            // capture/readback pair are members of one of these, so this covers
            // them). Safe here because the camera is being torn down — no further
            // readbacks will be issued. The ring is owned here, disposed below.
            _capture?.Dispose();

            _ring?.Dispose();
            _controlBlock?.Dispose();
            try
            {
                if (File.Exists(_ringPath)) File.Delete(_ringPath);
                if (partDestroyed)
                {
                    // _infoPath is intentionally NOT deleted on the destruction
                    // path. It serves as the lifecycle tombstone the sidecar
                    // reads to detect that this camera was destroyed. The sidecar
                    // is responsible for cleaning it up after it acknowledges the
                    // transition.
                }
                else
                {
                    // Normal teardown (vessel change, scene exit): delete the
                    // info file so stale entries don't outlive the session.
                    if (File.Exists(_infoPath)) File.Delete(_infoPath);
                }
                if (File.Exists(_controlPath)) File.Delete(_controlPath);
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Kerbcast] cam={FlightId} ring file delete failed: {ex.Message}");
            }
        }
    }

    // OnPreRender hook that aligns the scaled / galaxy layer's transform
    // with the near camera. Ported from OCISLY's TgpCamRotator. Scaled
    // uses ScaledSpace.LocalToScaledSpace so the planet-terrain layer
    // tracks the near camera's world position correctly across the
    // near-space ↔ scaled-space boundary; galaxy doesn't translate
    // (skybox is positionally invariant) — it just inherits rotation.
    internal sealed class LayerCamRotator : MonoBehaviour
    {
        public Camera NearCamera { get; set; }
        public bool UseScaledSpace { get; set; }

        private void OnPreRender()
        {
            if (NearCamera == null || NearCamera.transform == null) return;
            if (UseScaledSpace)
            {
                transform.position = ScaledSpace.LocalToScaledSpace(NearCamera.transform.position);
            }
            transform.rotation = NearCamera.transform.rotation;
        }
    }

    // Defeats Unity's "willRenderCanvases" delegate during the extra
    // cameras' render passes — without this, UI canvases get re-rendered
    // for each of our offscreen cameras, multiplying their cost and
    // sometimes causing visible UI duplication. Ported from OCISLY's
    // CanvasHack; the reflection lookup is once-per-class-load.
    internal sealed class CanvasHack : MonoBehaviour
    {
        private static readonly System.Reflection.FieldInfo CanvasHackField =
            typeof(Canvas).GetField("willRenderCanvases",
                System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);

        private object _saved;

        private void OnPreRender()
        {
            if (CanvasHackField == null) return;
            _saved = CanvasHackField.GetValue(null);
            CanvasHackField.SetValue(null, null);
        }

        private void OnPostRender()
        {
            if (CanvasHackField == null) return;
            CanvasHackField.SetValue(null, _saved);
        }
    }
}
