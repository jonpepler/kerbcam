/* Kerbal face camera. Implements ICamera so KerbcastCore's capture loop
   tracks it uniformly, allocates a per-camera mmap ring and writes an
   info.json manifest. When a peer subscribes (via the shared-memory control
   block) it renders KSP's IVA portrait camera into a square ring frame
   (min(512, tier width, tier height) per side, so sub-512 tiers still fit)
   each tick through the shared CaptureCore tail. Liveness is resolved from
   the roster name each call; the ProtoCrewMember/Part refs are
   never assumed live, and the IVA avatar (KerbalRef) is re-resolved every
   tick rather than cached. */

using System;
using System.IO;
using System.Reflection;
using UnityEngine;

namespace Kerbcast
{
    internal sealed class KerbalFaceCamera : ICamera
    {
        public uint FlightId { get; }

        private readonly ProtoCrewMember _pcm;
        /* Current owning part: the seat part while seated, the EVA part while on
           EVA. Re-resolved every tick by kerbal NAME (never a cached KerbalEVA
           /seat ref) so Vessel/OwnsPart stay correct across a seat<->EVA switch and
           the feed never tears down. */
        private Part _occupiedPart;
        /* Stable identity key: the roster name (unique + stable across seat<->EVA).
           The wire-id and all liveness/ownership matching derive from it, NOT from
           persistentID, which KSP reassigns on EVA. */
        private readonly string _kerbalName;
        // Identity snapshot at construction, mirroring KerbcastCamera: the
        // manifest writers stay safe even when the part is dying by teardown.
        private readonly string _cachedCameraName;
        private readonly string _cachedVesselName;

        private readonly MmapFrameRing _ring;
        private readonly string _ringPath;
        private readonly string _infoPath;
        private readonly string _controlPath;
        private bool _disposed;

        // Largest square the face will ever render/encode: min(512, tier width,
        // tier height), rounded even. The RING is allocated at THIS max, so a live
        // shrink or grow within [MinSide, _maxSide] is an RT-pool switch only — no
        // ring re-create, no sidecar re-attach. (Below-512 tiers, e.g. low at
        // 640x360, cap at the tier so we never exceed the ring's slot capacity.)
        private readonly int _maxSide;
        // Current square render side. Starts at _maxSide (full) and auto-resolution
        // shrinks it toward the max consumer display size (squared). EnsureCapture
        // builds the capture targets at this side.
        private int _renderSide;
        // Floor for auto-resolution so a face never encodes an unreadable thumbnail.
        private const int MinSide = 64;

        // Shared-memory control block written by the sidecar. Opened lazily
        // once the file appears (mirrors KerbcastCamera). Kerbal cameras only
        // read the subscription flag: no pan/zoom/layers.
        private ControlBlock _controlBlock;
        private bool _subscribed;

        /* Where the kerbal currently is. Resolved live each tick from
           _kerbalName; drives which portrait stack Refresh renders and the
           crew_location the manifest reports. */
        private enum CrewLocation { None, Seat, Eva }

        /* Last crew_location written to the info.json manifest ("seat" / "eva").
           The manifest is re-written on a transition so the sidecar (which
           re-reads it per rescan) reflects the switch on the same ring. Starts
           "seat" to match the ctor's first WriteInfoManifest. */
        private string _crewLocation = "seat";

        // Reusable capture tail: pooled capture/readback RT pair + in-flight
        // readback bookkeeping + ring write. Built lazily on first subscribe at
        // _renderSide, reused across ticks, disposed at teardown. Shared impl with
        // KerbcastCamera so the streaming path stays single-source.
        private CaptureCore _capture;
        private readonly PhaseTimings _phaseTimings = new PhaseTimings();
        private int _consecutiveErrors;

        // KSP nulls Canvas.willRenderCanvases (static private) around a manual
        // portrait Camera.Render so a re-entrant canvas render can't fire
        // mid-render; mirror that here. FieldInfo cached once for the process.
        private static readonly FieldInfo _willRenderCanvasesField =
            typeof(Canvas).GetField("willRenderCanvases", BindingFlags.Static | BindingFlags.NonPublic);

        public KerbalFaceCamera(
            ProtoCrewMember pcm,
            Part occupiedPart,
            string ringDir,
            int ringSlots,
            int width,
            int height)
        {
            _pcm = pcm;
            _occupiedPart = occupiedPart;
            _kerbalName = pcm.name;
            FlightId = CameraId.KerbalWireId(_kerbalName);
            // Prefer displayName, fall back to the roster name: a kerbal sourced
            // fresh from the EVA part can have an empty displayName, which left the
            // EVA POV camera unlabelled. The roster name is the same lineage as the
            // wire-id, so the label always matches the FlightId identity.
            _cachedCameraName = CameraId.KerbalCameraName(pcm.displayName, _kerbalName);
            var vessel = occupiedPart != null ? occupiedPart.vessel : null;
            _cachedVesselName = vessel != null
                ? (vessel.GetDisplayName() ?? vessel.vesselName ?? "<unknown>")
                : "<unknown>";

            _ringPath = Path.Combine(ringDir, $"{FlightId}.ring");
            _infoPath = Path.Combine(ringDir, $"{FlightId}.info.json");
            _controlPath = Path.Combine(ringDir, $"{FlightId}.control.bin");
            _maxSide = MakeEven(Math.Min(512, Math.Min(width, height)));
            _renderSide = _maxSide;
            // Ring allocated at the SQUARE MAX so live auto-resolution stays
            // RT-pool-only. Each slot's header carries the actual content side, so
            // the sidecar (self-describing ring open) encodes at the current side.
            _ring = MmapFrameRing.Create(_ringPath, ringSlots, _maxSide, _maxSide);
            // A kerbal discovered already on EVA (CrewProvider's EVA sweep) must
            // stamp its FIRST manifest "eva", not the default "seat" — otherwise an
            // EVA cam that is never subscribed reports "seat" in /cameras until the
            // first subscribe re-resolves it.
            if (vessel != null && vessel.isEVA) _crewLocation = "eva";
            WriteInfoManifest();
        }

        // Re-read live off the owning part; guard null so a torn-down part
        // reports no vessel rather than throwing.
        public Vessel Vessel => _occupiedPart != null ? _occupiedPart.vessel : null;

        // Alive == a live instance of this kerbal exists EITHER seated OR on EVA.
        // Going EVA must NOT kill the feed (that was the seat-only gap bug), so
        // liveness is keyed on the stable roster name across both states
        // (persistentID is reassigned on EVA and can't be used).
        // ResolveLocation also refreshes _occupiedPart to the current part so
        // Vessel/OwnsPart stay correct here even between Refresh ticks.
        public bool IsAlive => ResolveLocation(out _, out _) != CrewLocation.None;

        // Peer-driven capture gate, backed by the control block's subscription
        // flag. Idle (unsubscribed) kerbal cameras do no render/readback work.
        public bool Subscribed => _subscribed;

        /* Background-background capture pacing, same seam and same shared logic as part
           cameras: a crew face nobody is displaying at size still ticks over so
           switching to it doesn't cold-start. */
        private CapturePacing _pacing;
        public float EffectiveCaptureFps(float primaryFps, float backgroundCeilingFps)
            => _pacing.Effective(primaryFps, backgroundCeilingFps);
        public bool CaptureDue(float now, float effectiveFps)
            => _pacing.Due(now, effectiveFps);
        public float CaptureOverdue(float now, float effectiveFps)
            => _pacing.Overdue(now, effectiveFps);
        public void MarkCaptureGranted(float now, float effectiveFps)
            => _pacing.MarkGranted(now, effectiveFps);

        public int RefreshFailureStreak { get; set; }

        public bool OwnsPart(Part part) => part == _occupiedPart;

        public void MarkFxDirty() { /* no FX on a kerbal camera */ }

        // Poll the subscription flag off the control block. Opens the block
        // lazily (the sidecar creates the file); subscription-only, ignoring the
        // pan/zoom/layer fields a kerbal camera doesn't have.
        private void PollSubscription()
        {
            try
            {
                if (_controlBlock == null)
                {
                    _controlBlock = ControlBlock.Open(_controlPath, out var openRes);
                    if (openRes == ControlBlock.OpenResult.VersionMismatch)
                    {
                        Debug.LogError(
                            $"[Kerbcast] kerbal cam={FlightId} control-block layout version mismatch: "
                            + "sidecar and plugin are out of sync; capture disabled until they match");
                    }
                    if (_controlBlock == null) return; // file not ready yet
                }

                if (!_controlBlock.TryReadChanged(out var snap)) return;
                if (snap.Subscribed != _subscribed)
                {
                    _subscribed = snap.Subscribed;
                    // Due immediately on resubscribe: a stale interval from
                    // before the gap must not hold the first frame back.
                    if (_subscribed) _pacing.Reset();
                    Debug.Log($"[Kerbcast] kerbal cam={FlightId} subscribed → {_subscribed}");
                }
                _pacing.RequestedFps = snap.CaptureFps;

                // Auto-resolution: the sidecar writes the effective max-consumer
                // size into Width/Height (both present-flag gated). A face is
                // square, so fit it to the smaller reported side, rounded even and
                // clamped to [MinSide, _maxSide]. SetRenderSize no-ops when unchanged
                // (re-published snapshots are free).
                if (snap.Width.HasValue && snap.Height.HasValue)
                {
                    int even = MakeEven((int)Math.Min(snap.Width.Value, snap.Height.Value));
                    int lo = Math.Min(MinSide, _maxSide);
                    int side = Math.Max(lo, Math.Min(_maxSide, even));
                    SetRenderSize(side);
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Kerbcast] kerbal cam={FlightId} control block read failed: {ex.Message}");
            }
        }

        // Lazily build the capture tail on first subscribe, and reconcile the
        // render side when auto-resolution changed it. Filterless: a plain Blit
        // passed to Publish, minimal failure/reset callbacks (kerbal cameras have
        // no telemetry columns of their own). _renderSide is always <= _maxSide
        // (the ring's slot capacity), so capture never exceeds it on any tier.
        // All BuildTargets calls funnel through here, which runs inside Refresh's
        // try/catch, so a RenderTexture.Create() throw is caught.
        private CaptureCore EnsureCapture()
        {
            if (_capture == null)
            {
                // Build into a local and only assign the field once BuildTargets
                // succeeds: a throw there (e.g. RenderTexture.Create() failing)
                // must leave _capture null so the next tick retries construction,
                // rather than latching a half-initialized capture tail.
                var capture = new CaptureCore(_ring, _phaseTimings, LogRateLimited, () => _consecutiveErrors = 0);
                capture.BuildTargets(_renderSide, _renderSide);
                _capture = capture;
            }
            else if (_capture.CaptureRt == null || _capture.CaptureRt.width != _renderSide)
            {
                // Auto-resolution moved the side: switch the pooled RT set. O(1)
                // for a size seen before, one alloc for a new one — never destroys,
                // so an in-flight readback drains safely at its captured dims.
                _capture.BuildTargets(_renderSide, _renderSide);
            }
            return _capture;
        }

        // Square resize onto the shared CaptureCore path — the facecam mirror of
        // KerbcastCamera.SetRenderSize with w==h. Records the requested side; the
        // pooled-RT switch happens in EnsureCapture (inside Refresh's try, so a
        // BuildTargets throw is caught). Even (H.264 chroma) and within
        // (0, _maxSide]; faces have no layers/zoom/pan, so there is no
        // ApplyEffectiveQuality machinery.
        public void SetRenderSize(int side)
        {
            if (side <= 0 || side % 2 != 0 || side > _maxSide || side == _renderSide) return;
            _renderSide = side;
            Debug.Log($"[Kerbcast] kerbal cam={FlightId} render side → {side}");
        }

        private static int MakeEven(int v) => v & ~1; // round down to even

        private void LogRateLimited(string message)
        {
            // 1-in-300 frames at 30fps = at most one log per 10s per camera.
            if (_consecutiveErrors == 0 || _consecutiveErrors % 300 == 0)
                Debug.Log($"[Kerbcast] kerbal cam={FlightId} {message}");
            _consecutiveErrors++;
        }

        /* Live-resolve where this kerbal is right now, keyed on the stable roster
           name. Never caches the KerbalEVA / seat / Kerbal refs. Updates
           _occupiedPart to the current owning part as a side effect so
           Vessel/OwnsPart/liveness track a seat<->EVA switch. Order is chosen for
           the steady-state cost of the per-frame IsAlive sweep: the seated
           fast-path (last-known part still holds us) is O(1) and tried first, then
           the EVA loop (definitive: a one-part EVA vessel whose sole crew is us),
           then a full loaded-vessel scan for a re-seat into a different part. The
           fast-path's !isEVA guard means a kerbal who left the seat (part no longer
           holds it, or the part's vessel is now the EVA vessel) still falls through
           to the EVA/full paths, so the reorder can't mis-report a state. */
        private CrewLocation ResolveLocation(out Part part, out KerbalEVA eva)
        {
            eva = null;
            part = null;
            var loaded = FlightGlobals.VesselsLoaded;
            if (loaded == null) return CrewLocation.None;

            // Seated fast path (O(1) steady state): still crew of the last-known
            // part, and that part isn't an EVA vessel (a kerbal on EVA is handled by
            // the EVA loop below, never claimed as seated here).
            if (_occupiedPart != null && _occupiedPart.vessel != null
                && !_occupiedPart.vessel.isEVA && PartHoldsSelf(_occupiedPart))
            {
                part = _occupiedPart;
                return CrewLocation.Seat;
            }

            // EVA: KerbalEVA's own crew[0] is this kerbal.
            for (int i = 0; i < loaded.Count; i++)
            {
                var v = loaded[i];
                if (v == null || !v.isEVA) continue;
                var ev = v.evaController;
                if (ev == null || ev.part == null) continue;
                var crew = ev.part.protoModuleCrew;
                if (crew.Count > 0 && crew[0] != null && crew[0].name == _kerbalName)
                {
                    eva = ev;
                    part = ev.part;
                    _occupiedPart = part;
                    return CrewLocation.Eva;
                }
            }

            // Seated full scan: re-seated into a different (loaded) part.
            for (int i = 0; i < loaded.Count; i++)
            {
                var v = loaded[i];
                if (v == null || v.isEVA) continue;
                var parts = v.parts;
                for (int p = 0; p < parts.Count; p++)
                {
                    if (PartHoldsSelf(parts[p]))
                    {
                        part = parts[p];
                        _occupiedPart = part;
                        return CrewLocation.Seat;
                    }
                }
            }

            return CrewLocation.None;
        }

        private bool PartHoldsSelf(Part p)
        {
            if (p == null) return false;
            var crew = p.protoModuleCrew;
            for (int c = 0; c < crew.Count; c++)
                if (crew[c] != null && crew[c].name == _kerbalName) return true;
            return false;
        }

        // Re-write the info.json with the current crew_location on a transition,
        // so the sidecar (which re-reads the manifest per rescan) reflects the
        // seat<->EVA switch on the SAME ring. No-op when unchanged or transient.
        private void UpdateCrewLocationManifest(CrewLocation loc)
        {
            string s = loc == CrewLocation.Eva ? "eva"
                     : loc == CrewLocation.Seat ? "seat"
                     : null;
            if (s == null || s == _crewLocation) return;
            _crewLocation = s;
            WriteInfoManifest();
            Debug.Log($"[Kerbcast] kerbal cam={FlightId} crew_location → {s}");
        }

        // Render the seated IVA portrait into target, mirroring KSP's crew-tray
        // path: prefer the seat's portrait camera (RenderDontRestore), fall back
        // to the kerbal's own cam. Returns false when the avatar isn't spawned
        // (portrait not visible) — no frame this tick, but NOT death.
        private bool RenderSeat(RenderTexture target)
        {
            var k = _pcm.KerbalRef;
            if (k == null) return false;
            bool usedSeatCam = _pcm.seat != null && _pcm.seat.portraitCamera != null;
            var cam = usedSeatCam ? _pcm.seat.portraitCamera : k.kerbalCam;
            if (cam == null) return false;

            var prevTarget = cam.targetTexture;
            cam.targetTexture = target;
            try
            {
                if (usedSeatCam) cam.RenderDontRestore();
                else cam.Render();
            }
            finally
            {
                cam.targetTexture = prevTarget;
            }
            return true;
        }

        // Render KSP's EVA portrait stack into target. KerbalEVA composites five
        // cameras into its AvatarTexture (skybox / atmos / far / near / portrait);
        // we drive the same set, in KSP's own order (kerbalAvatarUpdateCycle), into
        // our capture RT instead. Each cam's target is restored so the game's own
        // portrait render is undisturbed. Returns false if the portrait camera is
        // absent. We drive Render() ourselves, so this does not depend on the
        // EVA_SHOW_PORTRAIT coroutine running.
        private bool RenderEva(KerbalEVA eva, RenderTexture target)
        {
            if (eva == null || eva.kerbalPortraitCamera == null) return false;
            RenderLayer(eva.kerbalCamSkyBox, target);
            RenderLayer(eva.kerbalCamAtmos, target);
            RenderLayer(eva.kerbalCam01, target);
            RenderLayer(eva.kerbalCam00, target);
            RenderLayer(eva.kerbalPortraitCamera, target);
            return true;
        }

        private static void RenderLayer(Camera cam, RenderTexture target)
        {
            if (cam == null) return;
            var prev = cam.targetTexture;
            cam.targetTexture = target;
            try { cam.Render(); }
            finally { cam.targetTexture = prev; }
        }

        public void Refresh(bool mayIssueReadback)
        {
            // Always drain a completed readback first, even while unsubscribed,
            // so a subscribe→unsubscribe race still lands its final frame.
            _capture?.Drain();

            PollSubscription();
            if (!_subscribed) return;

            // CaptureCore.Publish sets its in-flight flag BEFORE issuing the
            // AsyncGPUReadback request, which can throw (Deck/Mesa GPU-readback
            // quirks). Wrap the whole capture attempt so a throw anywhere in
            // here (including EnsureCapture's BuildTargets) aborts the in-flight
            // flag instead of leaving it stuck true, which would otherwise make
            // every later Refresh return early at the ReadbackInFlight guard
            // forever, silently freezing this camera. Mirrors KerbcastCamera.
            try
            {
                var capture = EnsureCapture();
                if (!mayIssueReadback) return;

                // One-in-flight invariant: CaptureCore.Publish assumes at most one
                // readback outstanding. If the previous one hasn't completed, skip
                // issuing another this tick (it drains via the Drain above).
                if (capture.ReadbackInFlight) return;

                // Where is the kerbal this tick? Never caches the resolved refs.
                var loc = ResolveLocation(out _, out var eva);
                UpdateCrewLocationManifest(loc);
                // None = mid-transition (seat vacated, EVA part not spawned yet, or
                // vice-versa): no frame this tick, but the feed stays alive.
                if (loc == CrewLocation.None) return;

                // Null Canvas.willRenderCanvases around the manual render(s) (KSP's
                // own portrait path does this), restoring it in finally. Wraps both
                // backends; the seated path's render/restore is otherwise identical
                // to before.
                object canvasCb = null;
                bool nulledCanvas = false;
                if (_willRenderCanvasesField != null)
                {
                    canvasCb = _willRenderCanvasesField.GetValue(null);
                    _willRenderCanvasesField.SetValue(null, null);
                    nulledCanvas = true;
                }
                bool rendered;
                try
                {
                    rendered = loc == CrewLocation.Eva
                        ? RenderEva(eva, capture.CaptureRt)
                        : RenderSeat(capture.CaptureRt);
                }
                finally
                {
                    if (nulledCanvas) _willRenderCanvasesField.SetValue(null, canvasCb);
                }
                if (!rendered) return;

                // Plain blit (no Hullcam filter); CaptureCore applies the flip and
                // issues the readback under the one-in-flight invariant.
                capture.Publish(Time.unscaledTime * 1000.0, (c, r) => Graphics.Blit(c, r));
            }
            catch (Exception ex)
            {
                _capture?.AbortInFlight();
                LogRateLimited($"capture pipeline threw: {ex.GetType().Name}: {ex.Message}");
            }
        }

        public void ApplyAutoShed(int level) { /* no adaptive quality this stage */ }

        // Same hand-rolled JSON shape as KerbcastCamera's active manifest, with
        // kerbal-specific fields. part_name/part_title empty, all fov/pan
        // numerics 0, supports_* false; adds kind, kerbal_persistent_id and
        // crew_location so the sidecar can distinguish a face camera. The stable
        // correlation key is flight_id (name-derived); camera_name carries the
        // human name. kerbal_persistent_id is informational raw persistentID and
        // is NOT stable across seat<->EVA (KSP reassigns it) — don't correlate on it.
        public void WriteInfoManifest()
        {
            WriteManifest("active");
        }

        private void WriteManifest(string lifecycle)
        {
            try
            {
                var inv = System.Globalization.CultureInfo.InvariantCulture;
                var json = "{\n"
                    + $"  \"lifecycle\": \"{lifecycle}\",\n"
                    + "  \"kind\": \"kerbal\",\n"
                    + $"  \"flight_id\": {FlightId.ToString(inv)},\n"
                    + "  \"part_name\": \"\",\n"
                    + "  \"part_title\": \"\",\n"
                    + $"  \"camera_name\": \"{EscapeJson(_cachedCameraName)}\",\n"
                    + $"  \"vessel_name\": \"{EscapeJson(_cachedVesselName)}\",\n"
                    + "  \"supports_zoom\": false,\n"
                    + "  \"fov\": 0,\n"
                    + "  \"fov_min\": 0,\n"
                    + "  \"fov_max\": 0,\n"
                    + "  \"supports_pan\": false,\n"
                    + "  \"pan_yaw_min\": 0,\n"
                    + "  \"pan_yaw_max\": 0,\n"
                    + "  \"pan_pitch_min\": 0,\n"
                    + "  \"pan_pitch_max\": 0,\n"
                    + $"  \"kerbal_persistent_id\": {_pcm.persistentID.ToString(inv)},\n"
                    + $"  \"crew_location\": \"{_crewLocation}\"\n"
                    + "}\n";
                // Atomic write: drop into .tmp + rename so the sidecar never reads a
                // half-written file. Matters now that UpdateCrewLocationManifest
                // rewrites this live during streaming while the sidecar re-reads it
                // each rescan (mirrors KerbcastCore's status write + InFlightSignal).
                var tmp = _infoPath + ".tmp";
                File.WriteAllText(tmp, json);
                if (File.Exists(_infoPath)) File.Delete(_infoPath);
                File.Move(tmp, _infoPath);
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Kerbcast] kerbal cam={FlightId} info manifest write failed (lifecycle={lifecycle}): {ex.Message}");
            }
        }

        // Duplicated from KerbcastCamera (its copy is private); tiny + no shared
        // helper file yet.
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

        // Normal teardown (vessel change, scene exit, crew left seat): close the
        // ring and delete both ring + info files.
        public void Dispose()
        {
            DisposeCore(destroyed: false);
        }

        // Destruction-path teardown: write a lifecycle="destroyed" tombstone
        // BEFORE closing the ring so the sidecar can observe the transition,
        // then delete the ring but leave the info.json for the sidecar to read.
        public void DisposeDestroyed()
        {
            DisposeCore(destroyed: true);
        }

        private void DisposeCore(bool destroyed)
        {
            if (_disposed) return;
            _disposed = true;

            if (destroyed)
            {
                // Failure here must never block the cleanup path.
                try { WriteManifest("destroyed"); }
                catch (Exception ex) { Debug.LogWarning($"[Kerbcast] kerbal cam={FlightId} destroyed manifest write failed: {ex.Message}"); }
            }

            // Release the capture tail's pooled RTs before the ring: the camera
            // is torn down so no further readbacks issue.
            _capture?.Dispose();
            _ring?.Dispose();
            _controlBlock?.Dispose();
            try
            {
                if (File.Exists(_ringPath)) File.Delete(_ringPath);
                // On the destruction path the info.json is intentionally kept as
                // the tombstone the sidecar reads; the sidecar cleans it up.
                if (!destroyed && File.Exists(_infoPath)) File.Delete(_infoPath);
                if (File.Exists(_controlPath)) File.Delete(_controlPath);
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Kerbcast] kerbal cam={FlightId} ring file delete failed: {ex.Message}");
            }
        }
    }
}
