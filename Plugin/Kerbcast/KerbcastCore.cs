// KSPAddon entry point. Hooks into the Flight scene, scans the active
// vessel for Hullcam VDS parts, and pumps an AsyncGPUReadback per camera
// each LateUpdate. Each KerbcastCamera owns its own MmapFrameRing keyed
// by KSP's stable Part.flightID; the Rust sidecar discovers rings by
// globbing the kerbcast/ subdirectory under XDG_RUNTIME_DIR.
//
// Lifecycle:
//   - Awake:    spawn AsyncReadbackUpdater (KSP loads mod DLLs after
//               [RuntimeInitializeOnLoadMethod] would fire, so the
//               vendored yangrc updater never auto-attaches).
//               Ensure the rings directory exists, then notify the
//               session-persistent KerbcastSidecarHost (which spawns the
//               sidecar on the FIRST flight of the session and keeps it
//               running across scene changes).
//               Subscribe GameEvents.onPartDestroyed to detect Hullcam
//               part destruction mid-flight.
//   - GameEvents.onVesselChange: rebuild the camera list (which
//               creates/destroys the matching ring files).
//   - GameEvents.onPartDestroyed: write lifecycle:"destroyed" tombstone
//               to the camera's info.json, close the ring, then leave
//               info.json for the sidecar to clean up.
//   - GameEvents.onVesselCrewWasModified: crew-scoped rescan (board /
//               transfer / EVA / re-seat within the same vessel). Clean-
//               removes vacated kerbal cams (Dispose, not a tombstone)
//               and adds newly-seated ones via CrewProvider only.
//   - LateUpdate: defensive null-check sweep before the main Refresh()
//               loop catches cameras whose part/vessel went null without
//               a matching onPartDestroyed event (mod interactions, etc).
//               Also refreshes each tracked camera.
//   - OnDestroy: unsubscribe onPartDestroyed, tear down cameras (each
//               disposes its own ring + deletes its files). The sidecar
//               is NOT stopped: it belongs to KerbcastSidecarHost and
//               survives scene changes (the camera-ring removals are all
//               it observes). It dies on game exit or via the heartbeat
//               orphan watch.

using System;
using System.Collections.Generic;
using System.Linq;
using System.IO;
using UnityEngine;
using Yangrc.OpenGLAsyncReadback;
using Debug = UnityEngine.Debug;

namespace Kerbcast
{
    [KSPAddon(KSPAddon.Startup.Flight, once: false)]
    public sealed class KerbcastCore : MonoBehaviour
    {
        private const int RingSlots = 4;
        private static readonly string RingDir = ResolveRingDir();

        /* Live singleton for the flight scene, set in Awake / cleared in
           OnDestroy. The in-process KerbcastControl facade (used by the
           kOS add-on) resolves cameras through this. */
        public static KerbcastCore Instance { get; private set; }

        // Read-only view of the tracked cameras for the KerbcastControl facade.
        internal System.Collections.Generic.IReadOnlyList<ICamera> Cameras => _cameras;

        /* ~0.5s at 60fps: long enough that a transient scene-change hiccup
           doesn't evict a healthy camera, short enough to stop a genuinely
           broken one from log-spamming for minutes. */
        private const int RefreshQuarantineThreshold = 30;

        private KerbcastSettings _settings;
        private readonly List<ICamera> _cameras = new List<ICamera>();
        private List<ICameraSourceProvider> _providers;
        // Typed reference into _providers for the crew-scoped rescan
        // (OnVesselCrewWasModified must not touch HullcamProvider).
        private CrewProvider _crewProvider;

        // Status file (sidecar ← plugin). Rewritten ~1Hz when anything has
        // changed — KSP fps, shed level, per-camera effective layers / dims.
        // Sidecar reads, diffs, and pushes camera-state-changed +
        // adaptive-shed messages to all peers' control channels.
        private string _statusPath;
        private float _statusCooldown;
        private const float StatusWriteIntervalSeconds = 1.0f;

        /* Control file (sidecar -> plugin). Polled ~1Hz with its own cooldown. */
        private string _controlPath;
        private float _controlCooldown;
        private ulong _lastAppliedControlSeq;

        // Rolling 60-sample FPS window for adaptive layer shedding.
        // ~1s at 60fps, ~2s at 30fps — long enough to ignore single-frame
        // hitches, short enough to react to sustained slow-downs.
        private const int FpsSamples = 60;
        private readonly float[] _fpsWindow = new float[FpsSamples];
        private int _fpsIdx;
        private int _fpsCount; // up to FpsSamples; growing-average until full
        private float _fpsAvg;
        /* Mission-time capture-clock epoch stamped into global.status.json.
           Bumped on a UT discontinuity (scene load / quickload) so a consumer
           flushes and resyncs. See CaptureEpoch. */
        private readonly CaptureEpoch _captureEpoch = new CaptureEpoch();
        // Adaptive-shed decision state machine. The fps thresholds + hysteresis
        // and the anti-flap dwell/back-off all live in ShedController (which is
        // Unity-free and unit-tested). Each LateUpdate we hand it the rolling
        // fps average + the unscaled clock and apply the level it returns.
        // Stagger controller: the lossless temporal-degrade regulator. Holds
        // kerbcast's OWN main-thread cost within a frametime budget by capturing
        // fewer cameras per frame — full resolution + all layers, just less
        // often. Targets kerbcast's cost (not game fps), so it's KSP-independent.
        // kerbcast auto-sheds quality only when AdaptiveQuality is enabled (on by default).
        // Built in Awake from settings; null until then (guarded at call sites).
        private StaggerBudgetController _staggerController;
        // Opt-in quality ladder (AdaptiveQuality=true): demotes resolution/FX
        // layers via KerbcastCamera.ApplyAutoShed once staggering is exhausted,
        // promotes back after sustained headroom. null when the flag is off,
        // which keeps the flag-off path bit-for-bit the pre-flag behaviour
        // (no evaluation, no ApplyAutoShed calls, shedLevel always 0).
        private AdaptiveQualityController _qualityController;

        /* Background-hum rung: the FIRST thing shed under load, before the
           stagger regulator starts starving primaries and long before the
           quality ladder demotes them. Thresholds sit ABOVE the MinKspFps
           physics floor (18 by default) precisely so this reacts first — by the
           time the game is near the floor the hum is already gone.

           A ShedController instance rather than a second anti-flap machine: the
           dwell, the asymmetric fast-attack/slow-release and the adaptive
           restore back-off are exactly the contract this needs, and that
           contract exists because a captured Deck session once flapped 638
           resolution changes. Not worth re-deriving. */
        private ShedController _humShed;
        private int _humShedLevel;
        /// <summary>Hum ceiling computed once per tick. Cached because reading it
        /// must not re-run the shed controller — Evaluate advances dwell state,
        /// so calling it twice a frame would corrupt the anti-flap timing.</summary>
        private float _effectiveHumCeiling;
        /// <summary>Fraction of the operator's BackgroundCaptureFps still
        /// allowed at each hum-shed level. Level 2 is the hum fully off.</summary>
        private static readonly float[] HumCeilingScale = { 1f, 0.5f, 0f };
        // Cameras that actually captured last frame, for the per-camera cost
        // estimate (kerbcastFrameMs / captured).
        private int _lastCapturedCount = 1;
        // Rolling estimate of kerbcast's own main-thread cost per frame (the
        // capture loop's wall-time, EMA-smoothed). Divided by frame time gives
        // the cost-share the stagger controller gates escalation on.
        private double _kerbcastFrameMs;
        private int _staggerBudget;   // last applied capture budget (telemetry)
        private static readonly double _msPerTick =
            1000.0 / System.Diagnostics.Stopwatch.Frequency;

        // The DontDestroyOnLoad GameObject hosting AsyncReadbackUpdater, whose
        // Update() pumps the OpenGL readback plugin (a per-frame render-thread
        // GL.IssuePluginEvent) every frame. Tracked so OnDestroy can tear it
        // down on flight exit — otherwise it keeps pumping in every later scene
        // (space centre, main menu) for the rest of the process, stalling the
        // render thread on any leftover readback tasks until KSP is restarted.
        private GameObject _readbackUpdaterGo;

        // Round-robins which cameras capture each frame (see ReadbackScheduler),
        // so they don't all issue a GPU render + readback on the same frame.
        private readonly ReadbackScheduler _readbackScheduler = new ReadbackScheduler();
        private bool[] _capturePermit = new bool[0];
        // Staggering is budgeted over the SUBSCRIBED (streaming) cameras only —
        // idle/attached cameras cost nothing and must not consume permits.
        // _subscribedIdx[0.._streamCount) maps a round-robin rank to a full
        // _cameras index; _streamPermit is the rank-indexed permit set.
        private int[] _subscribedIdx = new int[0];
        private bool[] _streamPermit = new bool[0];
        private int _streamCount;

        // Telemetry (Recommendation 1): GC collection-count tracker. Sampled
        // once per LateUpdate when KerbcastSettings.EnableTelemetry is true,
        // surfaced into the status JSON's "telemetry" section and reset each
        // write. Lets us see, with no profiler, whether the ~100ms frametime
        // spikes coincide with a Mono GC. Struct field — no allocation.
        private GcTracker _gcTracker;

        private static string ResolveRingDir()
        {
            // XDG_RUNTIME_DIR is the right home on Steam Deck / Linux —
            // it's a per-user tmpfs that survives the process and is
            // cleaned up at logout. Fall back to /tmp on macOS / when
            // XDG_RUNTIME_DIR isn't set (Mono returns "" not null there).
            // The kerbcast/ subdirectory namespaces our ring files so the
            // sidecar's *.ring glob doesn't pick up stray files.
            var xdg = Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR");
            if (!string.IsNullOrEmpty(xdg) && Directory.Exists(xdg))
            {
                return Path.Combine(xdg, "kerbcast");
            }
            return "/tmp/kerbcast";
        }

        private void Awake()
        {
            Instance = this;
            Debug.Log("[Kerbcast] KerbcastCore.Awake — initialising");

            _settings = KerbcastSettings.Load();
            _crewProvider = new CrewProvider(RingDir, RingSlots, _settings.Width, _settings.Height);
            _providers = new List<ICameraSourceProvider>
            {
                new HullcamProvider(_settings, RingDir, RingSlots),
                _crewProvider,
            };
            _staggerController = BuildStaggerController(_settings);
            /* Only built when the operator permits background capture at all:
               with the ceiling at 0 nothing can ever hum, so there is nothing to
               shed and the ladder keeps exactly its old shape. Thresholds sit
               well above MinKspFps so the hum is gone before the primary
               machinery reacts. Permitting is not enabling — a camera only hums
               once a connected client asks for it. */
            if (_settings.BackgroundCaptureFps > 0f)
            {
                _humShed = new ShedController(
                    maxLevel: 2,
                    shedBelow: new[] { 24f, 20f },
                    restoreAbove: new[] { 28f, 24f });
                Debug.Log($"[Kerbcast] background capture permitted up to {_settings.BackgroundCaptureFps:F1}fps (clients must request it; shed first under load)");
            }
            if (_settings.AdaptiveQuality)
            {
                _qualityController = BuildQualityController(_settings);
                Debug.Log("[Kerbcast] stagger quality ladder enabled (AdaptiveQuality=true)");
            }

            try
            {
                // yangrc's [RuntimeInitializeOnLoadMethod] hook never
                // fires for mod DLLs (KSP loads them post-init), so the
                // updater MonoBehaviour that pumps OpenGLAsyncReadbackRequest
                // never auto-attaches. Spawn it ourselves on a dedicated
                // DontDestroyOnLoad GameObject. OpenGLCore only, mirroring the
                // vendor's own auto-spawn gate: on D3D11/Metal the wrapper
                // uses Unity's native AsyncGPUReadback and the pump's Update
                // P/Invokes a native lib we only ship for Linux, throwing
                // DllNotFoundException every frame.
                if (SystemInfo.graphicsDeviceType == UnityEngine.Rendering.GraphicsDeviceType.OpenGLCore
                    && AsyncReadbackUpdater.instance == null)
                {
                    _readbackUpdaterGo = new GameObject("Kerbcast_AsyncReadbackUpdater");
                    UnityEngine.Object.DontDestroyOnLoad(_readbackUpdaterGo);
                    _readbackUpdaterGo.AddComponent<AsyncReadbackUpdater>();
                    Debug.Log("[Kerbcast] spawned AsyncReadbackUpdater (readback pump)");
                }
            }
            catch (Exception ex)
            {
                Debug.LogError($"[Kerbcast] failed to spawn AsyncReadbackUpdater: {ex}");
            }

            try
            {
                Directory.CreateDirectory(RingDir);
                _statusPath = Path.Combine(RingDir, "global.status.json");
                _controlPath = Path.Combine(RingDir, "global.control.json");
                Debug.Log($"[Kerbcast] rings directory ready at {RingDir} ({RingSlots} slots × {_settings.Width}×{_settings.Height} RGBA per camera)");
            }
            catch (Exception ex)
            {
                Debug.LogError($"[Kerbcast] failed to create rings directory at {RingDir}: {ex}");
                enabled = false;
                return;
            }

            GameEvents.onVesselChange.Add(OnVesselChange);
            GameEvents.onPartDestroyed.Add(OnPartDestroyed);
            GameEvents.onVesselWasModified.Add(OnVesselWasModified);
            GameEvents.onVesselCrewWasModified.Add(OnVesselCrewWasModified);
            /* Mission-time discontinuities: a scene load or a quickload makes
               universal time jump (revert/quickload run backward). Bump the
               capture epoch so a clock consumer flushes rather than waiting on
               a UT that will never arrive. */
            GameEvents.onGameSceneLoadRequested.Add(OnGameSceneLoadRequested);
            GameEvents.onGameStatePostLoad.Add(OnGameStatePostLoad);

            // Defensive: at Awake time the scene's source cameras (Camera 00,
            // ScaledSpace, GalaxyCamera, FXCamera) may already be disabled —
            // e.g. loading a save that was last in IVA, or a save where the
            // previous session's throttle state was preserved by KSP. Sync
            // our _mainCamerasDisabled flag from reality so the first
            // RebuildCameraList correctly does the restore-rebuild-reapply
            // dance and SetCameras sees enabled sources. Without this, the
            // first per-camera SetCameras call would CopyFrom(null) and
            // inherit Unity's default cullingMask (~0 — including the IVA
            // layer 16), producing the "pod interior leak" symptom on the
            // streams.
            _mainCamerasDisabled = AreAnySourceCamerasDisabled();
            if (_mainCamerasDisabled)
                Debug.Log("[Kerbcast] source cameras already disabled at Awake — RebuildCameraList will restore before SetCameras");

            RebuildCameraList(FlightGlobals.ActiveVessel);

            // Throttle state seeded from the per-save Difficulty Setting
            // (which itself seeds from settings.cfg on a fresh save). We
            // poll it every LateUpdate rather than wire to a settings-
            // changed GameEvent because KSP doesn't ship one for
            // CustomParameterNode value changes.
            _throttleDesired = ReadThrottleDesired();
            _throttleEffective = _throttleDesired;
            if (_throttleEffective) ApplyMainScreenThrottle();

            /* The host owns the sidecar process for the whole KSP session;
               this only spawns it on the first flight entry. Scene changes
               are camera churn the running sidecar already understands. */
            KerbcastSidecarHost.NotifyFlightEntered(_settings, RingDir);
        }

        private void OnVesselChange(Vessel v)
        {
            Debug.Log($"[Kerbcast] vessel change: {(v != null ? v.vesselName : "<null>")}");
            // Going EVA fires onVesselChange (control follows the kerbal onto the
            // EVA vessel), but the ship stays loaded and in physics range — like a
            // dock/stage change (onVesselWasModified, additive). Keep the ship's
            // cameras through the EVA switch instead of the scope-and-drop a real
            // craft switch does; a genuine out-of-range unload is still caught by
            // onPartDestroyed + the LateUpdate !IsAlive sweep. See VesselChangePolicy.
            bool goingEva = v != null && v.isEVA;
            RebuildCameraList(v, VesselChangePolicy.DisposeMissingOnVesselChange(goingEva));
        }

        // GameEvents.onPartDestroyed fires when a Part's GameObject is
        // destroyed (vessel crash, decoupling + physics-range expire, etc).
        // Walk _cameras and dispose any whose Hullcam belongs to this part.
        // DisposeDestroyed writes lifecycle="destroyed" to the info.json
        // tombstone before closing the ring so the sidecar observes the
        // transition, and leaves the info.json on disk for the sidecar.
        private void OnPartDestroyed(Part part)
        {
            if (part == null) return;
            Vessel affected = null;
            // Iterate backwards so we can remove by index without
            // skipping entries.
            for (int i = _cameras.Count - 1; i >= 0; i--)
            {
                var cam = _cameras[i];
                if (cam.OwnsPart(part))
                {
                    if (affected == null) affected = cam.Vessel;
                    Debug.Log($"[Kerbcast] part destroyed — disposing cam={cam.FlightId} ({part.name})");
                    _cameras.RemoveAt(i);
                    cam.DisposeDestroyed();
                }
            }
            // Rebuild FX draw lists on the surviving cams of the same vessel so
            // the destroyed part's renderers don't linger in their CommandBuffers.
            if (affected != null) MarkFxDirtyForVessel(affected);
        }

        // Decoupling, staging, docking, fairing jettison etc. change a
        // vessel's part set without firing onVesselChange (no pilot switch)
        // or onPartDestroyed for our tracked parts. Pick up any newly-joined
        // parts (e.g. a docking partner's cameras) immediately rather than
        // waiting for an incidental later vessel switch — additive only, see
        // RebuildCameraList's disposeMissing doc comment for why staged-off
        // debris must not be torn down here. Also rebuild the FX draw lists
        // so they match the current parts.
        private void OnVesselWasModified(Vessel v)
        {
            if (v == null) return;
            RebuildCameraList(v, disposeMissing: false);
            MarkFxDirtyForVessel(v);
        }

        // Board / transfer / EVA / re-seat: a kerbal camera's liveness (seat
        // membership) can change WITHOUT onVesselChange or onVesselWasModified
        // firing (same vessel, no part-set change). Crew-scoped only: part
        // cameras are handled by their own events, so HullcamProvider is never
        // touched here.
        //
        // Clean-remove first: a seat vacate is a normal state change, not a
        // destruction, so Dispose() (no tombstone), not DisposeDestroyed().
        // Then add-pass: newly-seated kerbals via CrewProvider only.
        private void OnVesselCrewWasModified(Vessel v)
        {
            if (v == null) return;

            for (int i = _cameras.Count - 1; i >= 0; i--)
            {
                if (_cameras[i] is KerbalFaceCamera kfc && !kfc.IsAlive)
                {
                    Debug.Log($"[Kerbcast] crew modified, vacated cam={kfc.FlightId}");
                    _cameras.RemoveAt(i);
                    kfc.Dispose();
                }
            }

            if (_crewProvider == null) return;
            var existing = new HashSet<uint>(_cameras.Select(c => c.FlightId));
            foreach (var cam in _crewProvider.Enumerate(v, existing))
            {
                _cameras.Add(cam);
            }
        }

        /* Scene load / quickload: universal time is about to jump, so mark a
           capture-clock discontinuity. The `scene`/`node` args are unused;
           any fire of these events is a resync point. */
        private void OnGameSceneLoadRequested(GameScenes scene) => _captureEpoch.Bump();

        private void OnGameStatePostLoad(ConfigNode node) => _captureEpoch.Bump();

        private void MarkFxDirtyForVessel(Vessel v)
        {
            foreach (var cam in _cameras)
                if (cam.Vessel == v) cam.MarkFxDirty();
        }

        // disposeMissing=true (onVesselChange — an actual pilot switch): scope
        // the camera list to `vessel`, tearing down anything not on it. This
        // is the documented "leaving a vessel drops its cameras" behavior.
        //
        // EXCEPTION for kerbal-face feed continuity: a KerbalFaceCamera whose
        // kerbal is still live (IsAlive) is PRESERVED (kept in _cameras, not
        // disposed+recreated), so a seat<->EVA switch — which fires
        // onVesselChange as control follows the kerbal onto/off the EVA vessel —
        // keeps the same ring/info/control + subscription instead of dropping
        // the feed. Liveness alone is the rule, matching OnVesselCrewWasModified
        // and the LateUpdate defensive sweep (both dispose kerbal cams purely on
        // !IsAlive), so an operator watching a kerbal keeps that feed even when
        // the player switches to a different vessel. A truly-gone kerbal reports
        // IsAlive==false (ResolveLocation scans all loaded vessels) and is still
        // disposed here; if a kept kerbal later vanishes without a vessel change,
        // the LateUpdate sweep disposes it on !IsAlive. Every part camera is
        // disposed exactly as before: part-camera behaviour is unchanged (a part
        // camera is never kept here — the `is KerbalFaceCamera` guard excludes
        // it — so it is disposed and rebuilt below just like today).
        //
        // disposeMissing=false (onVesselWasModified — dock/stage without a
        // pilot switch): additive only. A part leaving `vessel` via staging
        // is still physically out there on debris and should only stop
        // streaming when it's actually destroyed (physics range /
        // onPartDestroyed), not because this vessel's membership changed —
        // so nothing already tracked gets touched, and only cameras for
        // newly-appeared parts (e.g. a docking partner's) get added.
        private void RebuildCameraList(Vessel vessel, bool disposeMissing = true)
        {
            if (disposeMissing)
            {
                for (int i = _cameras.Count - 1; i >= 0; i--)
                {
                    var cam = _cameras[i];
                    bool keep = cam is KerbalFaceCamera && cam.IsAlive;
                    if (keep) continue;
                    cam.Dispose();
                    _cameras.RemoveAt(i);
                }
            }

            if (vessel == null) return;

            // If main-screen throttling is currently active, the KSP source
            // cameras (Camera 00, Camera ScaledSpace, GalaxyCamera) are
            // disabled. KerbcastCamera.SetCameras() locates them via
            // Camera.allCameras which only enumerates ENABLED cameras —
            // so SetCameras() would skip CopyFrom and our per-camera
            // Unity Camera components would inherit Unity's defaults
            // (cullingMask = ~0, no source-transform parenting). That
            // produces the "command pod interior + black sky" symptom
            // operators have seen on flight-scene reload / quickload,
            // when onVesselChange fires AFTER Awake's initial
            // ApplyMainScreenThrottle and re-runs SetCameras against the
            // now-disabled sources.
            //
            // Temporarily restore the source cameras so SetCameras sees
            // a fully-initialised render stack, then re-apply the
            // throttle once the rebuild is complete. The restore/apply
            // pair captures whatever state KSP currently considers
            // canonical (e.g. cullingMask updates from other mods,
            // post-IVA-exit state), not whatever stale snapshot we last
            // disabled from.
            bool wasThrottled = _mainCamerasDisabled;
            if (wasThrottled)
            {
                Debug.Log("[Kerbcast] rebuild: temporarily restoring main screen so SetCameras sees enabled source cameras");
                RestoreMainScreen();
            }

            var existing = new HashSet<uint>(_cameras.Select(c => c.FlightId));
            foreach (var provider in _providers)
            {
                foreach (var cam in provider.Enumerate(vessel, existing))
                {
                    _cameras.Add(cam);
                    existing.Add(cam.FlightId);
                }
            }
            Debug.Log($"[Kerbcast] tracking {_cameras.Count} Hullcam VDS camera(s)");

            // Freshly built cameras start at the operator-configured quality;
            // if the opt-in ladder is currently demoted, bring them in line so
            // a vessel switch can't silently restore a load we just shed.
            if (_qualityController != null && _qualityController.Level > 0)
            {
                for (int i = 0; i < _cameras.Count; i++)
                    _cameras[i].ApplyAutoShed(_qualityController.Level);
            }

            // Re-apply the throttle we restored above. ReadThrottleDesired
            // is the source of truth — honour the operator's current
            // setting in case they toggled it during the rebuild window.
            if (wasThrottled && ReadThrottleDesired())
            {
                Debug.Log("[Kerbcast] rebuild: re-applying main screen throttle");
                ApplyMainScreenThrottle();
            }
        }

        // LateUpdate drives explicit camera.Render() calls via each
        // KerbcastCamera.Refresh(). Our offscreen cameras are permanently
        // disabled (enabled=false) so they never fire during Unity's normal
        // render pass — we own the render timing entirely.
        private void LateUpdate()
        {
            UpdateFpsAverage();

            // Telemetry: sample the GC collection counters once per frame and
            // fold this frame's wall-clock duration into the interval stats, so
            // a frametime spike that coincides with a gen-0/1/2 collection is
            // recorded as GC-caused. CollectionCount is a cheap field read; gated
            // so it's a single bool check when telemetry is off.
            if (KerbcastSettings.EnableTelemetry)
            {
                _gcTracker.Sample(
                    GC.CollectionCount(0), GC.CollectionCount(1), GC.CollectionCount(2),
                    Time.unscaledDeltaTime);
            }
            // Build the subscribed (streaming) set first — staggering is
            // budgeted over it, not over all attached cameras. Filled here so
            // both UpdateDegradeLevel (the controller) and the capture loop below
            // use the same count this frame. Subscription state is from the
            // previous frame's control poll (set inside Refresh); one-frame lag,
            // consistent with the cost EMA.
            {
                int n = _cameras.Count;
                if (_subscribedIdx.Length < n) _subscribedIdx = new int[n];
                _streamCount = 0;
                /* The set is the cameras ELIGIBLE to capture this tick, not
                   simply the subscribed ones. A camera humming in the background
                   is subscribed but only becomes eligible once its interval has
                   elapsed, so it draws stagger permits in proportion to its rate
                   instead of competing head-on with the feed being watched. With
                   the hum off (the default) every subscribed camera is eligible
                   every tick and this is exactly the old set. */
                float primaryFps = _settings.MaxCaptureFps;
                _effectiveHumCeiling = EffectiveHumCeiling();
                float humCeiling = _effectiveHumCeiling;
                float now = Time.unscaledTime;
                for (int i = 0; i < n; i++)
                {
                    var cam = _cameras[i];
                    if (!cam.Subscribed) continue;
                    float eff = cam.EffectiveCaptureFps(primaryFps, humCeiling);
                    if (!cam.CaptureDue(now, eff, primaryFps)) continue;
                    _subscribedIdx[_streamCount++] = i;
                }
            }

            // Regulate the capture budget from kerbcast's own frame cost (lossless
            // temporal degrade — fewer streaming cameras captured per frame).
            // Quality stays untouched unless AdaptiveQuality is enabled (on by default).
            UpdateDegradeLevel();

            // Reconcile the per-save Difficulty Setting against our
            // effective state. KSP has no settings-changed event for
            // CustomParameterNode, so we poll. The read is cheap (one
            // dictionary lookup) and only does work when the value
            // actually moved.
            bool desired = ReadThrottleDesired();
            if (desired != _throttleEffective)
            {
                _throttleDesired = desired;
                if (desired) ApplyMainScreenThrottle();
                else RestoreMainScreen();
            }

            // If the main screen is throttled but FXCamera arrived after we
            // applied the throttle (its singleton initialises during flight-scene
            // setup, so the first ApplyMainScreenThrottle call may have seen a
            // null Instance), suppress it now.
            if (_throttleEffective && !_fxCamSuppressed)
                TrySuppressFxCamera();

            // Defensive: scan for cameras whose Hullcam part has gone null
            // (e.g. a destruction event we missed, or a KSP internal teardown
            // that doesn't fire onPartDestroyed). DisposeDestroyed + remove them
            // so the orphaned Unity Camera GameObjects and ring files are cleaned
            // up even if the event path failed. Iterate backwards to allow
            // removal by index.
            for (int i = _cameras.Count - 1; i >= 0; i--)
            {
                var cam = _cameras[i];
                if (!cam.IsAlive)
                {
                    Debug.LogWarning($"[Kerbcast] defensive sweep: cam={cam.FlightId} has null part/vessel — disposing (missed destruction event?)");
                    _cameras.RemoveAt(i);
                    cam.DisposeDestroyed();
                }
            }

            // Stagger captures round-robin so the cameras don't all render +
            // read back on the same frame. Budget = how many may capture this
            // frame to sustain MaxCaptureFps at the current game fps (_fpsAvg);
            // below MaxCaptureFps it grants all of them.
            int camCount = _cameras.Count;
            if (_capturePermit.Length < camCount) _capturePermit = new bool[camCount];
            if (_subscribedIdx.Length < camCount) _subscribedIdx = new int[camCount];
            if (_streamPermit.Length < camCount) _streamPermit = new bool[camCount];

            // Staggering is budgeted over the SUBSCRIBED set only. Idle cameras
            // cost nothing (Refresh early-outs on !_subscribed) and must not eat
            // permits — otherwise the few cameras actually streaming would be
            // staggered as if among all attached. (_streamCount was filled before
            // UpdateDegradeLevel so the controller saw the same count.)
            int budget = _streamCount; // safe default if controller not built
            if (_streamCount > 0)
            {
                int rateBudget = ReadbackScheduler.Budget(_streamCount, _settings.MaxCaptureFps, _fpsAvg);
                int staggerBudget = _staggerController != null ? _staggerController.Budget : _streamCount;
                budget = Math.Min(rateBudget, staggerBudget);
                _readbackScheduler.NextTick(_streamCount, budget, _streamPermit);
            }
            _staggerBudget = budget;

            // Map the rank-indexed stream permits back onto the full camera list;
            // idle cameras get no permit (they skip render anyway, but this keeps
            // _lastCapturedCount honest).
            for (int i = 0; i < camCount; i++) _capturePermit[i] = false;
            {
                /* Stamp the grant, not the eligibility: a hum camera that was due
                   but lost the round-robin keeps its old timestamp and stays due,
                   so a busy tick delays it rather than silently skipping a whole
                   interval. */
                float now = Time.unscaledTime;
                for (int rank = 0; rank < _streamCount; rank++)
                {
                    if (!_streamPermit[rank]) continue;
                    int idx = _subscribedIdx[rank];
                    _capturePermit[idx] = true;
                    _cameras[idx].MarkCaptureGranted(now);
                }
            }

            // Measure kerbcast's own main-thread cost this frame (the capture loop
            // wall-time), EMA-smoothed, + how many cameras actually captured —
            // together they give the per-camera cost the controller regulates.
            int captured = 0;
            for (int i = 0; i < camCount; i++) if (_capturePermit[i]) captured++;
            _lastCapturedCount = captured > 0 ? captured : 1;
            long capStart = System.Diagnostics.Stopwatch.GetTimestamp();
            /* Backwards so a quarantine removal doesn't shift the
               permit-to-camera index alignment of cameras not yet visited. */
            for (int i = camCount - 1; i >= 0; i--)
            {
                var cam = _cameras[i];
                try
                {
                    cam.Refresh(_capturePermit[i]);
                    cam.RefreshFailureStreak = 0;
                }
                catch (Exception ex)
                {
                    /* Isolate per-camera failures: one camera throwing must
                       not abort the other cameras' captures or the control
                       logic below. A sustained streak means the camera is
                       broken beyond self-recovery (it would otherwise spam
                       the log every frame forever) — dispose it like a
                       missed-destruction part. */
                    cam.RefreshFailureStreak++;
                    if (cam.RefreshFailureStreak == 1)
                        Debug.LogError($"[Kerbcast] cam={cam.FlightId} Refresh threw: {ex}");
                    if (cam.RefreshFailureStreak >= RefreshQuarantineThreshold)
                    {
                        Debug.LogError($"[Kerbcast] cam={cam.FlightId} quarantined after {cam.RefreshFailureStreak} consecutive Refresh failures");
                        _cameras.RemoveAt(i);
                        try { cam.DisposeDestroyed(); }
                        catch (Exception dex) { Debug.LogError($"[Kerbcast] cam={cam.FlightId} quarantine dispose threw: {dex}"); }
                    }
                }
            }
            double capMs = (System.Diagnostics.Stopwatch.GetTimestamp() - capStart) * _msPerTick;
            _kerbcastFrameMs = _kerbcastFrameMs <= 0.0 ? capMs : _kerbcastFrameMs * 0.8 + capMs * 0.2;

            MaybeApplyGlobalControl();
            MaybeWriteStatusFile();
        }

        // Warning overlay shown to the operator while the main flight
        // render is disabled. Centred on the (blanked) viewport so it
        // doesn't compete with the altimeter / navball / staging /
        // right-click panels at the top + sides. Tells them where to
        // look to undo, including the active hotkey if one is bound.
        private void OnGUI()
        {
            if (!_throttleEffective) return;

            // Lazy style so we pay the GUIStyle alloc once, not per
            // OnGUI frame.
            if (_throttleWarnStyle == null)
            {
                _throttleWarnStyle = new GUIStyle(GUI.skin.box)
                {
                    fontSize = 14,
                    alignment = TextAnchor.MiddleCenter,
                    wordWrap = true,
                    padding = new RectOffset(12, 12, 10, 10),
                    normal = { textColor = new Color(1f, 0.85f, 0.3f) },
                };
            }

            string msg =
                "Main flight camera disabled by kerbcast to free GPU for camera streams. " +
                "Go to Pause > Difficulty Settings > Kerbcast to restore.";

            const float w = 560f;
            const float h = 80f;
            float x = (Screen.width - w) * 0.5f;
            float y = (Screen.height - h) * 0.5f;
            GUI.Box(new Rect(x, y, w, h), msg, _throttleWarnStyle);
        }

        // -- throttle plumbing --

        private bool _throttleDesired;
        private bool _throttleEffective;
        private bool _mainCamerasDisabled;
        // Tracks whether we have successfully disabled FXCamera's camera
        // component as part of a throttle. ApplyMainScreenThrottle sets this
        // only when FXCamera.Instance is available at call time; LateUpdate
        // retries every frame until it succeeds, so a late-initialising
        // FXCamera doesn't escape suppression.
        private bool _fxCamSuppressed;
        private GUIStyle _throttleWarnStyle;

        // Read the operator-set Difficulty value, with a fallback to
        // the settings.cfg seed when no save is active (shouldn't
        // happen in flight scene but defensive — Awake order is
        // sometimes weird across mod combinations).
        private bool ReadThrottleDesired()
        {
            try
            {
                var game = HighLogic.CurrentGame;
                if (game?.Parameters != null)
                {
                    var node = game.Parameters.CustomParams<KerbcastGameParameters>();
                    if (node != null) return node.ThrottleMainScreen;
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Kerbcast] CustomParams read failed: {ex.Message}");
            }
            return KerbcastSettings.SeedThrottleMainScreen;
        }

        // Hotkey toggles BOTH the live state AND the per-save value
        // (so the change persists if the operator saves now). Lets the
        // hotkey behave intuitively — "press it, it stays toggled
        // until I press it again or change the Difficulty Setting".
        // KSP ships FlightCamera.EnableCamera() / DisableCamera() as
        // its first-class on/off for the layered main view; calling
        // DisableCamera here is the same code path KSP itself uses on
        // scene transitions, so we're not fighting the engine. We
        // additionally disable Camera ScaledSpace + GalaxyCamera so
        // no layer of the main composite renders. The ScaledCamera
        // and GalaxyCamera MonoBehaviours keep running their
        // transform-tracking LateUpdate logic independently of the
        // Camera component's enabled flag, so our per-Hullcam cameras
        // (which are parented to those transforms) still get correct
        // positions every frame.
        private void TrySuppressFxCamera()
        {
            if (FXCamera.Instance == null) return;
            // Keep FXCamera alive when atmospheric FX is on — our plasma shader
            // samples its globals (_FXDepthMap, _LightDirection0, _FXColor) and
            // they only refresh while FXCamera renders. The "wind without ship"
            // artifact in the main view is moot during throttle because the
            // operator is watching kerbcast streams, not the main view.
            if (_settings.EnableAtmosphericFx) return;
            var fxCam = FXCamera.Instance.GetComponent<Camera>();
            if (fxCam == null) return;
            fxCam.enabled = false;
            _fxCamSuppressed = true;
            Debug.Log("[Kerbcast] FXCamera suppressed (late-init, throttle already active)");
        }

        private void ApplyMainScreenThrottle()
        {
            if (_mainCamerasDisabled) { _throttleEffective = true; return; }
            try
            {
                if (FlightCamera.fetch != null)
                {
                    FlightCamera.fetch.DisableCamera(disableAudioListener: false);
                }
                var scaled = FindKspCameraByName("Camera ScaledSpace");
                if (scaled != null) scaled.enabled = false;
                var galaxy = FindKspCameraByName("GalaxyCamera");
                if (galaxy != null) galaxy.enabled = false;
                // FXCamera is a separate singleton MonoBehaviour with its
                // own Camera component (NOT in FlightCamera.cameras array)
                // that renders aero/re-entry FX via a velocity-based shader.
                // Without disabling it the operator sees "wind effects + ship
                // silhouette" in the *main view* while throttled — but when
                // EnableAtmosphericFx is on, kerbcast's plasma shader samples
                // FXCamera's globals (_FXDepthMap, _LightDirection0, _FXColor)
                // and needs them refreshed, so we deliberately leave FXCamera
                // alive in that case. The main-view artifact doesn't matter
                // because the operator is watching kerbcast streams, not the
                // main view, while throttled.
                if (FXCamera.Instance != null && !_settings.EnableAtmosphericFx)
                {
                    var fxCam = FXCamera.Instance.GetComponent<Camera>();
                    if (fxCam != null)
                    {
                        fxCam.enabled = false;
                        _fxCamSuppressed = true;
                    }
                }
                // If FXCamera.Instance was null here, _fxCamSuppressed stays
                // false. LateUpdate will retry every frame via
                // TrySuppressFxCamera() until it succeeds.
                _mainCamerasDisabled = true;
                _throttleEffective = true;
                Debug.Log("[Kerbcast] main flight render disabled (ThrottleMainScreen=true)");
                LogAllCameras("throttle-applied");
            }
            catch (Exception ex)
            {
                Debug.LogError($"[Kerbcast] ApplyMainScreenThrottle failed: {ex}");
            }
        }

        private void RestoreMainScreen()
        {
            if (!_mainCamerasDisabled) { _throttleEffective = false; return; }
            try
            {
                if (FlightCamera.fetch != null)
                {
                    FlightCamera.fetch.EnableCamera();
                }
                var scaled = FindKspCameraByName("Camera ScaledSpace");
                if (scaled != null) scaled.enabled = true;
                var galaxy = FindKspCameraByName("GalaxyCamera");
                if (galaxy != null) galaxy.enabled = true;
                if (FXCamera.Instance != null)
                {
                    var fxCam = FXCamera.Instance.GetComponent<Camera>();
                    if (fxCam != null) fxCam.enabled = true;
                }
                _mainCamerasDisabled = false;
                _throttleEffective = false;
                _fxCamSuppressed = false;
                Debug.Log("[Kerbcast] main flight render restored (ThrottleMainScreen=false)");
            }
            catch (Exception ex)
            {
                Debug.LogError($"[Kerbcast] RestoreMainScreen failed: {ex}");
            }
        }

        // Diagnostic: log every active Camera in the scene with its
        // current enabled state. Lets us spot additional render
        // surfaces we should consider disabling on throttle — KSP +
        // mods can add cameras we don't know about ahead of time
        // (Scatterer, EVE, TUFX, FX setups, etc).
        private static void LogAllCameras(string tag)
        {
            try
            {
                var names = new System.Text.StringBuilder();
                foreach (var c in Camera.allCameras)
                {
                    names.Append(c.enabled ? "+" : "-");
                    names.Append(c.name);
                    names.Append(' ');
                }
                Debug.Log($"[Kerbcast] cameras-snapshot ({tag}): {names}");
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Kerbcast] LogAllCameras failed: {ex.Message}");
            }
        }

        // Probe whether ANY of the four main source cameras KSP uses for
        // its in-flight composite (Camera 00, Camera ScaledSpace,
        // GalaxyCamera, FXCamera) are currently disabled. Returns true
        // even if only one is. Used at Awake to sync our
        // _mainCamerasDisabled flag from reality before the first
        // RebuildCameraList — needed for load-from-IVA-save / similar
        // paths where KSP brings the scene up with some cams off.
        //
        // Uses Object.FindObjectsOfType<Camera> rather than
        // Camera.allCameras because the latter only enumerates ENABLED
        // cameras — useless for detecting disabled ones.
        private static bool AreAnySourceCamerasDisabled()
        {
            bool anyDisabled = false;
            try
            {
                var all = UnityEngine.Object.FindObjectsOfType<Camera>();
                foreach (var c in all)
                {
                    if (c == null) continue;
                    if (c.name == "Camera 00"
                        || c.name == "Camera ScaledSpace"
                        || c.name == "GalaxyCamera"
                        || c.name == "FXCamera")
                    {
                        if (!c.enabled)
                        {
                            Debug.Log($"[Kerbcast] AreAnySourceCamerasDisabled: '{c.name}' is disabled");
                            anyDisabled = true;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Kerbcast] AreAnySourceCamerasDisabled probe failed: {ex.Message}");
            }
            return anyDisabled;
        }

        // Camera.allCameras snapshots every active Camera, so this is
        // cheap. KerbcastCamera.SetCameras() uses the same pattern via
        // FindKspCamera; duplicated here because we run earlier than
        // the per-camera setup and don't want the cross-class call.
        private static Camera FindKspCameraByName(string name)
        {
            foreach (var c in Camera.allCameras)
            {
                if (c.name == name) return c;
            }
            return null;
        }

        // ~1 Hz status write. Each write carries the full per-camera
        // snapshot + global KSP fps + shed level. The sidecar reads,
        // diffs against a cached copy, and pushes camera-state-changed
        // and adaptive-shed messages over each peer's data channel.
        private void MaybeWriteStatusFile()
        {
            if (_statusPath == null) return;
            _statusCooldown -= Time.unscaledDeltaTime;
            if (_statusCooldown > 0f) return;
            _statusCooldown = StatusWriteIntervalSeconds;

            try
            {
                var sb = new System.Text.StringBuilder(256 + _cameras.Count * 256);
                sb.Append("{\n");
                sb.Append($"  \"kspFps\": {_fpsAvg:F2},\n");
                // shedLevel: 0 unless the opt-in AdaptiveQuality ladder is
                // active (the controller is null when the flag is off, so the
                // flag-off output stays byte-identical to the pre-flag plugin).
                sb.Append($"  \"shedLevel\": {(_qualityController != null ? _qualityController.Level : 0)},\n");
                sb.Append($"  \"throttleMainScreen\": {(_throttleEffective ? "true" : "false")},\n");
                /* Background-hum ceiling actually in force: the operator's
                   setting after the hum shed rung. The sidecar reads this to
                   know what rate to ask undisplayed cameras for — the plugin
                   stays the single authority on the number, the sidecar only
                   knows which cameras nobody is displaying. 0 = hum off, which
                   is the default and makes this whole path inert. */
                sb.Append($"  \"backgroundCaptureFps\": {_effectiveHumCeiling.ToString("F2", System.Globalization.CultureInfo.InvariantCulture)},\n");
                /* Mission-time capture clock: KSP universal time (seconds) and
                   the current time-warp multiplier at write time, plus the
                   discontinuity epoch. Round-trip ("R") + InvariantCulture so
                   the double/float never localises to a comma. */
                sb.Append($"  \"captureUt\": {Planetarium.GetUniversalTime().ToString("R", System.Globalization.CultureInfo.InvariantCulture)},\n");
                sb.Append($"  \"captureEpoch\": {_captureEpoch.Value},\n");
                sb.Append($"  \"timeWarpRate\": {TimeWarp.CurrentRate.ToString("R", System.Globalization.CultureInfo.InvariantCulture)},\n");
                // Stagger telemetry — watch the budget regulator converge + tune
                // MaxKerbcastFrameBudgetMs / MinKspFps. staggerBudget: cameras
                // permitted to capture this tick. kerbcastFrameMs: EMA of kerbcast's
                // own per-frame main-thread cost (the regulated quantity).
                sb.Append($"  \"staggerBudget\": {_staggerBudget},\n");
                sb.Append($"  \"kerbcastFrameMs\": {_kerbcastFrameMs.ToString("F2", System.Globalization.CultureInfo.InvariantCulture)},\n");
                sb.Append("  \"cameras\": [\n");
                // Diagnostic fields are KerbcastCamera-specific; kerbal cameras
                // contribute no diagnostics this stage. Filter first so the
                // trailing-comma logic below keys on the filtered count, not
                // the raw index — otherwise a skipped camera landing last
                // leaves a dangling comma on the entry before it.
                var streaming = _cameras.OfType<KerbcastCamera>().ToList();
                for (int i = 0; i < streaming.Count; i++)
                {
                    var kc = streaming[i];
                    sb.Append("    {\n");
                    sb.Append($"      \"flightId\": {kc.FlightId},\n");
                    sb.Append($"      \"renderWidth\": {kc.RenderWidth},\n");
                    sb.Append($"      \"renderHeight\": {kc.RenderHeight},\n");
                    sb.Append($"      \"operatorWidth\": {kc.OperatorWidth},\n");
                    sb.Append($"      \"operatorHeight\": {kc.OperatorHeight},\n");
                    sb.Append($"      \"layers\": {LayersToJson(kc.Layers)},\n");
                    sb.Append($"      \"operatorLayers\": {LayersToJson(kc.OperatorLayers)},\n");
                    sb.Append($"      \"enableAtmosphericFx\": {(kc.EnableFx ? "true" : "false")},\n");
                    sb.Append($"      \"fov\": {kc.Fov.ToString(System.Globalization.CultureInfo.InvariantCulture)},\n");
                    sb.Append($"      \"panYaw\": {kc.PanYaw.ToString(System.Globalization.CultureInfo.InvariantCulture)},\n");
                    sb.Append($"      \"panPitch\": {kc.PanPitch.ToString(System.Globalization.CultureInfo.InvariantCulture)},\n");
                    // Auto-track echo UP: the plugin's CURRENT applied mode + a
                    // monotonic seq bumped ONLY on a kOS-facade set. The sidecar
                    // adopts the mode into its authoritative ControlState when the
                    // seq advances (linked track_mode: kOS proposes, sidecar
                    // converges), never re-adopting a control-block-applied change.
                    sb.Append($"      \"trackMode\": {kc.GetTrackMode()},\n");
                    sb.Append($"      \"trackReportSeq\": {kc.TrackReportSeq}\n");
                    sb.Append(i == streaming.Count - 1 ? "    }\n" : "    },\n");
                }
                sb.Append("  ]");

                // Telemetry section (Recommendation 1). Per-phase render cost
                // (summed across cameras = total main-thread cost per tick; max
                // across cameras' rolling-max = the spike peak), the GC interval
                // deltas + spike correlation, degrade level, and camera count.
                // Only emitted when EnableTelemetry; the array above closes with
                // no trailing comma, so we add one only when extending the object.
                if (KerbcastSettings.EnableTelemetry)
                {
                    AppendTelemetry(sb);
                }
                sb.Append("\n}\n");

                if (KerbcastSettings.EnableTelemetry)
                {
                    // Roll the interval stats over now that they've been written:
                    // clear the GC interval accumulators and each camera's
                    // rolling-max, so the next write reflects the next ~1s window.
                    _gcTracker.ResetInterval();
                    for (int i = 0; i < _cameras.Count; i++)
                        if (_cameras[i] is KerbcastCamera kc) kc.PhaseTimings.ResetMax();
                }

                // Atomic write: drop into .tmp + rename so the sidecar
                // never reads a half-written file.
                var tmp = _statusPath + ".tmp";
                File.WriteAllText(tmp, sb.ToString());
                if (File.Exists(_statusPath)) File.Delete(_statusPath);
                File.Move(tmp, _statusPath);
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Kerbcast] status file write failed: {ex.Message}");
            }
        }

        /*
         * Poll global.control.json written by the sidecar. On a new seq,
         * apply the requested throttle state: write the per-save difficulty
         * param so it persists, then drive the existing apply/restore methods.
         * Uses its own _controlCooldown counter (~1Hz, independent of status writes).
         */
        private void MaybeApplyGlobalControl()
        {
            if (_controlPath == null) return;
            _controlCooldown -= Time.unscaledDeltaTime;
            if (_controlCooldown > 0f) return;
            _controlCooldown = StatusWriteIntervalSeconds;
            try
            {
                if (!File.Exists(_controlPath)) return;
                var json = File.ReadAllText(_controlPath);
                if (!TryParseGlobalControl(json, out ulong seq, out bool throttle)) return;
                if (seq <= _lastAppliedControlSeq) return;
                _lastAppliedControlSeq = seq;
                /* Set the per-save difficulty param so it persists on save. */
                try
                {
                    var game = HighLogic.CurrentGame;
                    if (game?.Parameters != null)
                    {
                        var param = game.Parameters.CustomParams<KerbcastGameParameters>();
                        if (param != null) param.ThrottleMainScreen = throttle;
                    }
                }
                catch (Exception ex)
                {
                    Debug.LogWarning($"[Kerbcast] global control: param write failed: {ex.Message}");
                }
                /* Drive the live throttle state immediately (same as the reconcile). */
                _throttleDesired = throttle;
                if (throttle) ApplyMainScreenThrottle();
                else RestoreMainScreen();
                Debug.Log($"[Kerbcast] global control: throttleMainScreen={throttle} (seq={seq})");
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Kerbcast] global control read failed: {ex.Message}");
            }
        }

        /*
         * Parse {"throttleMainScreen": bool, "seq": number} written by the
         * sidecar. Uses Regex to avoid a JSON library dependency. The sidecar
         * controls the format exactly so the pattern is stable.
         */
        private static bool TryParseGlobalControl(string json, out ulong seq, out bool throttle)
        {
            seq = 0;
            throttle = false;
            if (string.IsNullOrEmpty(json)) return false;
            var seqMatch = System.Text.RegularExpressions.Regex.Match(json, "\"seq\"\\s*:\\s*(\\d+)");
            if (!seqMatch.Success) return false;
            if (!ulong.TryParse(seqMatch.Groups[1].Value, out seq)) return false;
            var throttleMatch = System.Text.RegularExpressions.Regex.Match(json, "\"throttleMainScreen\"\\s*:\\s*(true|false)");
            if (!throttleMatch.Success) return false;
            throttle = throttleMatch.Groups[1].Value == "true";
            return true;
        }

        // Builds the "telemetry" object appended to the status JSON when
        // EnableTelemetry is set. Phase costs are aggregated across cameras:
        // `ms` is the SUM of each camera's last per-phase value (the total
        // main-thread cost of that phase this tick across all cameras — the
        // galaxy:scaled:near ratio that answers "which layer dominates"), and
        // `maxMs` is the MAX of each camera's rolling-max for the interval (the
        // worst single-camera spike, reset each write). GC + degrade + camera
        // count are global. Allocation here is fine — 1Hz, on the blessed status
        // write path. Caller has just closed the cameras array; we open with a
        // comma so the telemetry object extends the same JSON object.
        private void AppendTelemetry(System.Text.StringBuilder sb)
        {
            var ci = System.Globalization.CultureInfo.InvariantCulture;
            sb.Append(",\n  \"telemetry\": {\n");
            sb.Append($"    \"cameraCount\": {_cameras.Count},\n");
            sb.Append($"    \"staggerBudget\": {_staggerBudget},\n");

            sb.Append("    \"phasesMs\": {\n");
            AppendPhase(sb, "galaxy", RenderPhase.Galaxy, ci, first: true);
            AppendPhase(sb, "scaled", RenderPhase.Scaled, ci, first: false);
            AppendPhase(sb, "far", RenderPhase.Far, ci, first: false);
            AppendPhase(sb, "near", RenderPhase.Near, ci, first: false);
            AppendPhase(sb, "blit", RenderPhase.Blit, ci, first: false);
            AppendPhase(sb, "readback", RenderPhase.Readback, ci, first: false);
            sb.Append("\n    },\n");

            sb.Append("    \"gc\": {\n");
            sb.Append($"      \"gen0\": {_gcTracker.IntervalGen0},\n");
            sb.Append($"      \"gen1\": {_gcTracker.IntervalGen1},\n");
            sb.Append($"      \"gen2\": {_gcTracker.IntervalGen2},\n");
            sb.Append($"      \"worstFrameMs\": {_gcTracker.WorstFrameMs.ToString("F2", ci)},\n");
            sb.Append($"      \"worstGcFrameMs\": {_gcTracker.WorstGcFrameMs.ToString("F2", ci)},\n");
            sb.Append($"      \"worstFrameWasGc\": {(_gcTracker.WorstFrameWasGc ? "true" : "false")},\n");
            // Best-effort Mono heap gauge — may read 0 in a non-development
            // player. Informational only; lead with the collection counts above,
            // which are reliable.
            sb.Append($"      \"monoHeapBytes\": {UnityEngine.Profiling.Profiler.GetMonoUsedSizeLong()}\n");
            sb.Append("    }\n");

            sb.Append("  }");
        }

        // One phase row: { "ms": <sum-of-last>, "emaMs": <sum-of-ema>, "maxMs":
        // <max-of-rolling-max> }, all aggregated across cameras. `ms` is the
        // latest tick's total main-thread cost, `emaMs` the smoothed central
        // tendency, `maxMs` the interval's worst single-camera spike. `first`
        // controls the leading comma so the JSON object stays well-formed.
        private void AppendPhase(System.Text.StringBuilder sb, string name,
            RenderPhase phase, System.Globalization.CultureInfo ci, bool first)
        {
            double sumLast = 0.0;
            double sumEma = 0.0;
            double maxMax = 0.0;
            for (int i = 0; i < _cameras.Count; i++)
            {
                // Diagnostic-only; kerbal cameras contribute no phase timings this stage.
                if (!(_cameras[i] is KerbcastCamera kc)) continue;
                var pt = kc.PhaseTimings;
                sumLast += pt.Last(phase);
                sumEma += pt.Ema(phase);
                double m = pt.Max(phase);
                if (m > maxMax) maxMax = m;
            }
            if (!first) sb.Append(",\n");
            sb.Append($"      \"{name}\": {{ \"ms\": {sumLast.ToString("F3", ci)}, \"emaMs\": {sumEma.ToString("F3", ci)}, \"maxMs\": {maxMax.ToString("F3", ci)} }}");
        }

        private static string LayersToJson(CameraLayers layers)
        {
            var parts = new List<string>(3);
            if ((layers & CameraLayers.Near) != 0) parts.Add("\"NEAR\"");
            if ((layers & CameraLayers.Far) != 0) parts.Add("\"FAR\"");
            if ((layers & CameraLayers.Scaled) != 0) parts.Add("\"SCALED\"");
            if ((layers & CameraLayers.Galaxy) != 0) parts.Add("\"GALAXY\"");
            return "[" + string.Join(", ", parts.ToArray()) + "]";
        }

        private void UpdateFpsAverage()
        {
            float dt = Time.unscaledDeltaTime;
            if (dt < 0.0001f) return;
            _fpsWindow[_fpsIdx] = 1f / dt;
            _fpsIdx = (_fpsIdx + 1) % FpsSamples;
            if (_fpsCount < FpsSamples) _fpsCount++;

            float sum = 0f;
            for (int i = 0; i < _fpsCount; i++) sum += _fpsWindow[i];
            _fpsAvg = sum / _fpsCount;
        }

        // Per-tick: regulate the capture budget to hold kerbcast's own per-frame
        // main-thread cost within MaxKerbcastFrameBudgetMs (lossless temporal
        // degrade — fewer cameras per frame, full quality each), tightening
        // further if game fps falls below the MinKspFps physics floor. Quality
        // is untouched unless AdaptiveQuality is enabled (on by default), in which case the
        // quality ladder below runs AFTER the stagger decision, off the same
        // signals: demote only once staggering is exhausted, promote only
        // after sustained headroom.
        // Skips until the fps window has filled — early post-load frames noisy.
        /// <summary>
        /// The background-capture ceiling actually in force this tick: the
        /// operator's setting reduced by the hum shed rung. Zero once the rung
        /// is fully shed, which makes every hum camera ineligible, shrinks the
        /// eligible set back to the primaries, and so relieves the pressure
        /// BEFORE the stagger regulator or the quality ladder touch a feed
        /// anyone is watching.
        /// </summary>
        private float EffectiveHumCeiling()
        {
            if (_humShed == null) return 0f; // hum disabled: nothing to allow
            /* Skip until the fps window has filled, same guard the other
               controllers use — early post-load frames are too noisy to act on,
               and acting on them would shed a hum that was never in trouble. */
            if (_fpsCount < FpsSamples) return _settings.BackgroundCaptureFps;
            _humShedLevel = _humShed.Evaluate(_fpsAvg, Time.unscaledTime);
            int idx = _humShedLevel;
            if (idx < 0) idx = 0;
            if (idx >= HumCeilingScale.Length) idx = HumCeilingScale.Length - 1;
            return _settings.BackgroundCaptureFps * HumCeilingScale[idx];
        }

        private void UpdateDegradeLevel()
        {
            if (_fpsCount < FpsSamples) return;
            if (_staggerController == null) return;
            // Per-camera cost = this frame's measured kerbcast cost ÷ the cameras
            // that actually captured (budget-independent ≈ constant). Unscaled
            // time so dwell tracks wall-clock, not in-game time (timewarp).
            double msPerCam = _kerbcastFrameMs / (_lastCapturedCount > 0 ? _lastCapturedCount : 1);
            int before = _staggerController.Budget;
            // Budgeted over the SUBSCRIBED set (_streamCount), not all attached.
            // _fpsAvg feeds the one-way physics-floor safety (MinKspFps).
            int budget = _staggerController.Evaluate(
                _kerbcastFrameMs, msPerCam, _streamCount, _fpsAvg, Time.unscaledTime);
            if (budget != before)
                Debug.Log($"[Kerbcast] stagger budget={budget}/{_streamCount} streaming "
                    + $"(kerbcast {_kerbcastFrameMs:F1}ms, {msPerCam:F1}ms/cam, KSP {_fpsAvg:F0}fps, "
                    + $"max {_settings.MaxKerbcastFrameBudgetMs:F0}ms, floor {_settings.MinKspFps:F0}fps) "
                    + $"[{_staggerController.LastChangeReason}]");

            // Opt-in quality ladder, fed the stagger controller's own signals.
            // The budget passed is the stagger budget BEFORE the MaxCaptureFps
            // rate cap: the cap is user config, not load, and must not block a
            // promote. null when AdaptiveQuality=false (nothing evaluated).
            if (_qualityController != null)
            {
                int qBefore = _qualityController.Level;
                int qLevel = _qualityController.Evaluate(
                    _kerbcastFrameMs, budget, _streamCount, _fpsAvg, Time.unscaledTime);
                if (qLevel != qBefore)
                {
                    Debug.Log($"[Kerbcast] stagger quality level={qLevel}/{KerbcastCamera.MaxShedLevel} "
                        + $"({_qualityController.LastChangeReason}; kerbcast {_kerbcastFrameMs:F1}ms, "
                        + $"KSP {_fpsAvg:F0}fps, budget {budget}/{_streamCount}, "
                        + $"max {_settings.MaxKerbcastFrameBudgetMs:F0}ms, floor {_settings.MinKspFps:F0}fps)");
                    for (int i = 0; i < _cameras.Count; i++)
                        _cameras[i].ApplyAutoShed(qLevel);
                }
            }
        }

        // Build the stagger budget regulator from settings. MaxKerbcastFrameBudgetMs
        // <= 0 means "no ms cap" — a huge budget so cost never triggers a cut
        // (capture then bounded only by MaxCaptureFps + the MinKspFps floor).
        private static StaggerBudgetController BuildStaggerController(KerbcastSettings s)
        {
            double budgetMs = s.MaxKerbcastFrameBudgetMs > 0f ? s.MaxKerbcastFrameBudgetMs : 1e6;
            return new StaggerBudgetController(
                budgetMs,
                initialBudget: 1,
                minKspFps: s.MinKspFps);
        }

        // Build the opt-in quality ladder from the same targets as the stagger
        // regulator (the two share the ms budget and the fps floor, so demote
        // engages exactly where staggering runs out of room). Level 0 is the
        // configured Width/Height/layers; the ladder never goes above it.
        private static AdaptiveQualityController BuildQualityController(KerbcastSettings s)
        {
            double budgetMs = s.MaxKerbcastFrameBudgetMs > 0f ? s.MaxKerbcastFrameBudgetMs : 1e6;
            return new AdaptiveQualityController(
                enabled: true,
                maxLevel: KerbcastCamera.MaxShedLevel,
                budgetMs: budgetMs,
                minKspFps: s.MinKspFps);
        }

        private void OnDestroy()
        {
            if (Instance == this) Instance = null;

            // ALWAYS restore the main flight cameras on scene exit so a
            // revert / quit-to-KSC / quit-to-main-menu doesn't leave KSP
            // with a dead viewport. This is unconditional even if the
            // operator never enabled throttle this session — a no-op in
            // that case.
            RestoreMainScreen();

            GameEvents.onVesselChange.Remove(OnVesselChange);
            GameEvents.onPartDestroyed.Remove(OnPartDestroyed);
            GameEvents.onVesselWasModified.Remove(OnVesselWasModified);
            GameEvents.onVesselCrewWasModified.Remove(OnVesselCrewWasModified);
            GameEvents.onGameSceneLoadRequested.Remove(OnGameSceneLoadRequested);
            GameEvents.onGameStatePostLoad.Remove(OnGameStatePostLoad);
            foreach (var cam in _cameras) cam.Dispose();
            _cameras.Clear();
            /* Deliberately NOT stopping the sidecar: KerbcastSidecarHost owns
               the process for the whole KSP session. The ring-file deletions
               above are all the sidecar needs to drain its camera list. */

            // Tear down the readback pump now that the cameras (and their
            // readback requests) are gone. Leaving it alive would keep firing a
            // per-frame render-thread plugin event in every later scene — the
            // root of the "spikes persist on the main menu / only a KSP restart
            // recovers" symptom.
            //
            // We MUST null AsyncReadbackUpdater.instance ourselves. The previous
            // code relied on Unity's destroyed-object fake-null making
            // `instance == null` true on the next Flight Awake — but empirically
            // it did NOT respawn after an exit-to-KSC round trip (the static held
            // a stale reference, the Awake guard saw "not null", the pump never
            // came back, and async readbacks wedged until a full KSP restart).
            // Destroy() is deferred, so the static stays set across the scene
            // transition; clear it synchronously here so the next Awake's
            // `instance == null` guard reliably re-spawns a fresh pump. (The
            // vendored AsyncReadbackUpdater now also nulls it in its own
            // OnDestroy, as defence-in-depth.)
            if (_readbackUpdaterGo != null)
            {
                UnityEngine.Object.Destroy(_readbackUpdaterGo);
                _readbackUpdaterGo = null;
                AsyncReadbackUpdater.instance = null;
                Debug.Log("[Kerbcast] tore down AsyncReadbackUpdater (readback pump) on scene exit");
            }

            // Clean up status file so a stale snapshot doesn't survive
            // into the next launch.
            try
            {
                if (_statusPath != null && File.Exists(_statusPath))
                    File.Delete(_statusPath);
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Kerbcast] status file delete failed: {ex.Message}");
            }
        }
    }
}
