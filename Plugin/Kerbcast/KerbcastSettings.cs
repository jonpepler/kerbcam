// settings.cfg loader, OCISLY-style. Mirrors the shape used by
// OfCourseIStillLoveYou's own settings.cfg: a single top-level
// `Settings { ... }` node parsed via KSP's ConfigNode API. All fields
// are optional; missing ones fall back to the defaults below.
//
// Two files are consulted, both optional, layered key by key:
//   GameData/Kerbcast/settings.cfg             shipped defaults; the release
//                                             zip overwrites it on every
//                                             update
//   GameData/Kerbcast/PluginData/settings.cfg  user overrides; never in the
//                                             zip, so it survives updates
// Keys in the user file win over the shipped file; keys absent from both
// keep the compiled-in defaults below.
//
// Top-level fields:
//   BindAddress       host the sidecar's HTTP signalling endpoint binds
//                     to. 127.0.0.1 = localhost only (the default). A LAN
//                     IP or 0.0.0.0 exposes the feeds to other devices,
//                     with no authentication, so only on a trusted network.
//   Port              sidecar HTTP signalling port (default 8088).
//   MaxQuality        quality tier ceiling: low (640x360), sd (1024x576,
//                     default), hd (1280x720), fullhd (1920x1080). The
//                     adaptive ladder degrades below this tier under load
//                     and promotes back up to it, never above it.
//   Width / Height    explicit capture dimensions per Hullcam (16:9, even
//                     numbers). When present, override the tier for that
//                     field; absent, the tier table sets them.
//
// Per-camera override nodes (zero or more `Camera { ... }` blocks):
//   PartName          internal KSP part name (e.g. "navCam1"), case-sensitive.
//   Layers            comma-separated subset of NEAR, FAR, SCALED, GALAXY (or ALL).
//                     Sets the initial layer mask for the camera on attach;
//                     operator can still override at runtime via POST
//                     /cameras/{id}/layers.
//   EnableAtmosphericFx  per-camera override (true/false) for atmospheric FX
//                     replication. Overrides the top-level default either
//                     direction; operator can flip it at runtime via the
//                     control block's enableAtmosphericFx.
//
// Per-camera Width / Height overrides aren't supported yet: the sidecar
// still opens all rings at the global max dims. Plumbing variable dims
// through MmapRingConfig is a follow-up.
//
//   EnableHullcamLinuxShaderSwap  (Linux only, default true) when true,
//                     kerbcast Harmony-patches CameraFilter.LoadBundle to
//                     load our rebuilt shaders.linux bundle from
//                     GameData/Kerbcast/HullcamShaders/ instead of
//                     HullcamVDS's broken upstream bundle. Set to false
//                     to disable the swap and test against upstream's
//                     bundle directly.
//
//   AutoSpawnSidecar  whether the plugin Process.Starts the bundled sidecar
//                     binary on Awake (default true). Undocumented in the
//                     shipped settings.cfg; it exists as a dev escape hatch
//                     so `cargo run` can own the sidecar process during
//                     sidecar development. Set false in your install's
//                     settings.cfg in that case.

using System.Collections.Generic;
using System.IO;
using UnityEngine;

namespace Kerbcast
{
    internal sealed class KerbcastSettings
    {
        public string BindAddress { get; private set; } = "127.0.0.1";
        public int Port { get; private set; } = 8088;
        public int Width { get; private set; } = 1024;
        public int Height { get; private set; } = 576;
        /* MaxQuality is the primary resolution+bitrate knob. Explicit Width/
           Height/BitrateBps keys in either settings file override it; absent
           explicit keys, dims+bitrate come from the tier table in QualityTiers.
           No MaxQuality key + no explicit dims: Sd → (1024,576,0) = prior default.
           Backward-compatible: an existing file with Width=1024 Height=576 resolves
           identically (explicit == tier). MaxQuality = Hd with no explicit dims →
           (1280,720,6_000_000). */
        public QualityTier MaxQuality { get; private set; } = QualityTier.Sd;
        public bool AutoSpawnSidecar { get; private set; } = true;

        // Target H.264 bitrate forwarded to the sidecar at launch, in bits
        // per second. 0 (the default) means auto: the flag is not forwarded
        // at all and the sidecar derives its own default from the selected
        // encoder backend (hardware encoders default higher than the
        // software fallback). Set explicitly to trade bandwidth for image
        // quality. Applies to every stream; only read at sidecar launch.
        public int BitrateBps { get; private set; } = 0;
        /* Adaptive QUALITY ladder (resolution + FX-layer cascade,
           see KerbcastCamera.ShedTable) driven by AdaptiveQualityController.
           Default true: kerbcast demotes quality once staggering is exhausted
           and promotes it back, slowly, after sustained headroom. It never
           promotes above the MaxQuality ceiling configured in settings.cfg
           (explicit Width/Height still cap it the same way). Set false to
           revert to temporal-only degrade (capture staggering, no resolution
           or layer changes). */
        public bool AdaptiveQuality { get; private set; } = true;

        // Per-camera capture-rate CEILING (stream target). Cameras are
        // round-robined so they don't all render + read back on the same frame,
        // and each captures at MOST this rate rather than the full game fps. Set
        // >= your game fps cap to disable the rate cap (the frame budget below
        // still applies).
        public float MaxCaptureFps { get; private set; } = 30f;

        // CEILING for background capture: how fast a SUBSCRIBED camera that
        // nothing is displaying at size may keep capturing, so switching to it
        // promotes an already-flowing stream instead of cold-starting from black.
        //
        // This is a cap, NOT a switch. Nothing captures in the background unless a connected client
        // asks for it (SetBackgroundCaptureFps), so the default costs a plain
        // viewer nothing while still letting a client that wants background capture have it
        // with no config edit. Set 0 to forbid background capture outright
        // however loudly a client asks; raise it toward MaxCaptureFps on a
        // machine with headroom.
        //
        // Cost scales with the rate, not the resolution: a camera is four
        // camera.Render() calls dominated by culling + draw calls, which barely
        // care about pixel count but scale directly with how often you run them.
        // Effective rate is min(what clients asked for, this), and background capture is
        // shed BEFORE any primary-stream degradation as the game approaches
        // MinKspFps.
        public float BackgroundCaptureFps { get; private set; } = 2f;

        // Stagger budget CEILING: the most main-thread time (ms/frame) kerbcast
        // will spend on its own render + readback. When it would exceed this,
        // kerbcast captures FEWER cameras per frame (each updates less often, but
        // at full resolution + all layers, a LOSSLESS temporal degrade). Targets
        // kerbcast's OWN cost, so it's independent of how slow the game is for
        // other reasons (a heavy vessel won't make it starve the feeds). Default
        // 24 ms (≈6–7 cameras at the Deck's ~3.5 ms/camera, landing ~25 fps with
        // 8 streaming, comfortably above the MinKspFps floor while using the
        // headroom a lower budget would leave idle). Set 0 to remove the ms cap
        // entirely, making MinKspFps the control target ("capture everything down
        // to that fps floor"). kerbcast never drops quality to hit this unless
        // AdaptiveQuality (opt-in, above) is enabled.
        public float MaxKerbcastFrameBudgetMs { get; private set; } = 24f;

        // Physics-floor safety (one-way). If game fps drops below this, kerbcast
        // staggers HARDER than the budget above to keep KSP above its time-
        // dilation threshold, below which game-time slows (physics can't keep
        // real-time) AND the stream itself goes slow-motion + low-cadence. Only
        // ever tightens / gates restore, so it can't set up a headroom-chasing
        // oscillation. Default 18 fps (just above typical time dilation). Set 0
        // to disable the floor (kerbcast then bounds only by MaxKerbcastFrameBudgetMs).
        public float MinKspFps { get; private set; } = 18f;

        // Master toggle for kerbcast's own atmospheric FX (a pluggable overlay
        // see atmospheric_fx_parked.md for why the stock-FX replication was
        // abandoned). Default ON since v0.7.0; set false (or per-camera) to
        // disable.
        public bool EnableAtmosphericFx { get; private set; } = true;

        // Which FX layers are active when the master is on, individually
        // toggleable. settings.cfg token list: CORE, BOWSHOCK, TRAIL, EMBERS
        // (or ALL). Defaults to all four; bowshock now uses an oblate dome
        // (replaces the polygonal cone), embers are a geom-shader extrusion
        // off windward surfaces (replaces ParticleSystem), trail and
        // bowshock both adapt position+size from a per-frame windward
        // profile so they correctly track vessel orientation.
        public AtmoFxLayers AtmosphericFxLayers { get; private set; } = AtmoFxLayers.All;

        // Apply Hullcam VDS's per-part shader filters (NightVision green
        // grain, MovieTime film effect, CRT/TV scanlines, etc; 9 modes
        // total). Each cam reads its hullcam.cameraMode field at attach
        // and instantiates the matching HullcamVDS.CameraFilter; the
        // existing capture-RT → readback-RT blit becomes a
        // RenderImageWithFilter call. Default true so kerbcast streams
        // show the same visual effects as Hullcam's own in-game UI.
        // Set false to skip the filter pass (pure unfiltered composite).
        public static bool EnableHullcamEffects { get; private set; } = true;

        // Diagnostic: sample capture-RT luminance immediately before and after the
        // filter pass and log both, so a blackened frame can be attributed to the
        // filter rather than inferred from the far end of the pipeline. Throttled;
        // off by default.
        public static bool EnableBlitDiagnostics { get; private set; } = false;

        /* Replace each camera's image with a known four-quadrant marker so the
           SHIPPED chain (filter, capture blit, readback flip, ring write) can be
           judged from the delivered frame: upright means TOP-LEFT darkest and
           BOTTOM-RIGHT brightest. Diagnostic only — every feed becomes the test
           pattern while this is on. */
        public static bool EnableOrientationTestPattern { get; private set; } = false;

        // Run TUFX post-processing on each layered kerbcast camera when TUFX
        // is installed. Without it, atmospheric scattering on Kerbin's horizon
        // has too wide a dynamic range to display correctly even with
        // allowHDR=true: the bright sky clips and the rest crushes dark
        // ("dark Kerbin / black hole horizon"). Default true; silently no-ops
        // when TUFX is not installed. Static so KerbcastCamera can read it.
        public static bool EnableTUFX { get; private set; } = true;

        // Enable EVE cloud/atmosphere/city-lights/celestial-shadow replication
        // onto kerbcast's cloned cameras. Default true; no effect if EVE is not
        // installed.
        public static bool EnableEVE { get; private set; } = true;

        // Enable Scatterer atmosphere, sky, scattering and ocean capture onto
        // kerbcast's cloned cameras (per-clone singleton camera swap). Default
        // true; no effect if Scatterer is not installed. Forces MSAA off on the
        // capture cameras when active.
        public static bool EnableScatterer { get; private set; } = true;

        // Re-run ParallaxContinued's scatter evaluate and draw for the kerbcast
        // near terrain camera so surface scatters (rocks, grass) appear on the
        // stream. Default true; no effect if ParallaxContinued is not installed.
        public static bool EnableParallax { get; private set; } = true;

        // Add Deferred's ForwardRenderingCompatibility component to kerbcast's
        // deferred near/far clones so they render correctly instead of black.
        // Default true; no effect if the Deferred mod is not installed.
        public static bool EnableDeferred { get; private set; } = true;

        // When the Firefly reentry mod is installed, capture its plasma onto the
        // kerbcast near camera INSTEAD of kerbcast's own reentry FX (never both).
        // Default true; set false to keep kerbcast's own reentry effects even when
        // Firefly is installed. No effect if Firefly isn't installed.
        public static bool EnableFirefly { get; private set; } = true;

        // When true (default), kerbcast Harmony-patches HullcamVDS's
        // CameraFilter.LoadBundle to substitute our rebuilt shaders.linux.
        // Linux-only; set false to test against upstream's broken bundle.
        // Static so HullcamShaderBundleSwap (Instantly-scoped, no settings
        // instance) can read it without a back-ref.
        public static bool EnableHullcamLinuxShaderSwap { get; private set; } = true;

        // Debug: when true, log additional per-camera diagnostics
        // useful for investigating render-mask / cullingMask issues
        // (atmospheric FX missing from streams, layer mismatches
        // after vessel changes, etc). Off by default; log spam in
        // KSP.log otherwise. Static so KerbcastCamera can read it
        // without needing a back-ref to the settings instance.
        public static bool DebugCameraLogging { get; private set; } = false;

        // Low-overhead in-plugin performance telemetry (Recommendation 1 from
        // the profiling study). When true, KerbcastCamera.Refresh times each
        // render phase (galaxy / scaled / near / blit / readback) with
        // Stopwatch.GetTimestamp (allocation-free) and KerbcastCore samples the
        // GC collection counters every frame; both are surfaced into a
        // "telemetry" section of global.status.json each ~1Hz write. Lets us
        // measure on the Deck (with no profiler attach) whether the residual
        // ~100ms frametime spikes are Mono GC (a deltaTime spike that coincides
        // with a gen-0/1/2 collection is the proof) and read the per-layer
        // render-cost ratio. Default false so the feature is genuinely zero-cost
        // when off (Refresh reads the flag once and skips every GetTimestamp
        // call). Static so KerbcastCamera reads it without a settings back-ref.
        public static bool EnableTelemetry { get; private set; } = false;

        // Debug: force atmospheric-FX intensity to full regardless of mach /
        // dynamic pressure, so the effect renders even on the pad. Used to
        // verify the FX *renders* independent of the flight-state gating. Off
        // by default; leave off for normal play.
        public static bool ForceAtmosphericFx { get; private set; } = false;

        // Debug: override the vessel's surface velocity (world space) used to
        // drive FX direction: wind-aligned streaks, bowshock placement, trail
        // orientation, ember drift. Zero (default) → real srf_velocity. Pair
        // with ForceAtmosphericFx to test motion-dependent shader behaviour on
        // the pad without flying. Magnitude should be > 1 so velocity-gates in
        // effects don't trip. settings.cfg syntax: `DebugWindDirection = 100, 0, 0`.
        public static Vector3 DebugWindDirection { get; private set; } = Vector3.zero;

        // Default for the per-save ThrottleMainScreen Difficulty Setting
        // when a save is loaded for the first time. After that the
        // value stored in the save file wins; settings.cfg changes
        // don't retroactively override existing saves. Read by
        // KerbcastGameParameters's constructor.
        public static bool SeedThrottleMainScreen { get; private set; } = false;

        public string HttpBind => $"{BindAddress}:{Port}";

        // True if the bind address only accepts connections from this machine,
        // so exposing the feeds to the LAN warrants a warning when it isn't.
        private static bool IsLoopback(string addr)
        {
            if (string.IsNullOrEmpty(addr)) return true;
            addr = addr.Trim();
            return addr == "127.0.0.1" || addr == "localhost" || addr == "::1";
        }

        // Per-PartName initial layer mask (e.g. "navCam1" → NEAR only).
        // Cameras whose PartName isn't here default to CameraLayers.All.
        private readonly Dictionary<string, CameraLayers> _initialLayers =
            new Dictionary<string, CameraLayers>();
        // Per-PartName render-size overrides. Each entry is (width, height);
        // cameras without an override use the global Width × Height.
        private readonly Dictionary<string, (int, int)> _renderSize =
            new Dictionary<string, (int, int)>();
        // Per-PartName atmospheric-FX override. Present only when a Camera
        // node sets EnableAtmosphericFx; absent cameras use the global default.
        private readonly Dictionary<string, bool> _atmosphericFx =
            new Dictionary<string, bool>();
        // Per-PartName FX-layer override. Present only when a Camera node sets
        // AtmosphericFxLayers; absent cameras use the global default.
        private readonly Dictionary<string, AtmoFxLayers> _atmosphericFxLayers =
            new Dictionary<string, AtmoFxLayers>();

        /// <summary>
        /// Initial layer mask for a part. Falls back to All if no override
        /// applies. Operator can still change layers at runtime via the
        /// sidecar's /layers endpoint; this only sets the value on attach.
        /// </summary>
        public CameraLayers GetInitialLayers(string partName)
        {
            if (!string.IsNullOrEmpty(partName) && _initialLayers.TryGetValue(partName, out var layers))
            {
                return layers;
            }
            return CameraLayers.All;
        }

        /// <summary>
        /// Per-PartName render-size override, if any. Returns the global
        /// Width × Height when no override is configured.
        /// </summary>
        public (int width, int height) GetRenderSize(string partName)
        {
            if (!string.IsNullOrEmpty(partName) && _renderSize.TryGetValue(partName, out var dims))
            {
                return dims;
            }
            return (Width, Height);
        }

        /// <summary>
        /// Whether a part's near camera should replicate atmospheric FX.
        /// A per-PartName override (either direction) wins over the global
        /// EnableAtmosphericFx default. Operator can still flip it at runtime
        /// via the control file's enableAtmosphericFx field.
        /// </summary>
        public bool GetEnableAtmosphericFx(string partName)
        {
            if (!string.IsNullOrEmpty(partName) && _atmosphericFx.TryGetValue(partName, out var v))
            {
                return v;
            }
            return EnableAtmosphericFx;
        }

        /// <summary>
        /// Which FX layers a part's camera should run. Per-PartName override
        /// wins over the global AtmosphericFxLayers default.
        /// </summary>
        public AtmoFxLayers GetAtmosphericFxLayers(string partName)
        {
            if (!string.IsNullOrEmpty(partName) && _atmosphericFxLayers.TryGetValue(partName, out var v))
            {
                return v;
            }
            return AtmosphericFxLayers;
        }

        public static KerbcastSettings Load()
        {
            var settings = new KerbcastSettings();
            var defaultsPath = Path.Combine(
                KSPUtil.ApplicationRootPath,
                "GameData", "Kerbcast", "settings.cfg");
            // User override file. Lives under PluginData/ because the release
            // zip never contains that directory, so the file survives the
            // documented "delete GameData/Kerbcast/ and re-extract" update flow
            // (and CKAN-managed upgrades). PluginData/ is also exempt from
            // ModuleManager's config scanning, which makes it the KSP-idiomatic
            // home for files the loader shouldn't touch.
            var userPath = Path.Combine(
                KSPUtil.ApplicationRootPath,
                "GameData", "Kerbcast", "PluginData", "settings.cfg");

            var defaultsNode = LoadSettingsNode(defaultsPath);
            var userNode = LoadSettingsNode(userPath);

            if (defaultsNode == null && userNode == null)
            {
                Debug.Log($"[Kerbcast] no settings.cfg at {defaultsPath} or {userPath}; using built-in defaults ({settings.HttpBind}, {settings.Width}×{settings.Height})");
                return settings;
            }

            // Layered load: shipped defaults first, then the user file over
            // the top. The Apply* helpers keep the current value when a key is
            // absent, so a partial user file only changes the keys it names.
            // Scalars from both files apply before any Camera nodes so the
            // per-camera Width/Height caps see the final global dims.
            if (defaultsNode != null) ApplyScalars(settings, defaultsNode);
            if (userNode != null) ApplyScalars(settings, userNode);

            /* Resolve MaxQuality tier into dims+bitrate, then let any explicit
               Width/Height/BitrateBps keys in either file override the tier's
               values. HasValue checks both layers so explicit keys survive
               regardless of which file they appear in. */
            bool wExplicit = (defaultsNode != null && defaultsNode.HasValue("Width"))
                          || (userNode != null && userNode.HasValue("Width"));
            bool hExplicit = (defaultsNode != null && defaultsNode.HasValue("Height"))
                          || (userNode != null && userNode.HasValue("Height"));
            bool bExplicit = (defaultsNode != null && defaultsNode.HasValue("BitrateBps"))
                          || (userNode != null && userNode.HasValue("BitrateBps"));
            var (rw, rh, rb) = QualityTiers.Resolve(
                settings.MaxQuality,
                wExplicit ? settings.Width : (int?)null,
                hExplicit ? settings.Height : (int?)null,
                bExplicit ? settings.BitrateBps : (int?)null);
            settings.Width = rw;
            settings.Height = rh;
            settings.BitrateBps = rb;

            if (defaultsNode != null) ApplyCameraNodes(settings, defaultsNode);
            if (userNode != null) ApplyCameraNodes(settings, userNode);

            var sources = defaultsNode == null
                ? $"user overrides only ({userPath})"
                : userNode == null
                    ? defaultsPath
                    : $"{defaultsPath} + user overrides ({userPath})";
            var camCount = settings._initialLayers.Count;
            Debug.Log($"[Kerbcast] settings loaded from {sources}: bind={settings.HttpBind} tier={settings.MaxQuality} dims={settings.Width}x{settings.Height} autoSpawn={settings.AutoSpawnSidecar} cameraOverrides={camCount}");
            if (!IsLoopback(settings.BindAddress))
            {
                Debug.LogWarning($"[Kerbcast] BindAddress={settings.BindAddress} is not loopback. The camera feeds and the signalling endpoint have no authentication and are reachable by anyone on the network. Only do this on a network you trust.");
            }
            return settings;
        }

        // Loads the top-level Settings node from a cfg file. Missing file is
        // fine (returns null silently; the user file usually doesn't exist).
        // A file that exists but has no Settings node warns and is skipped.
        private static ConfigNode LoadSettingsNode(string path)
        {
            if (!File.Exists(path)) return null;
            var root = ConfigNode.Load(path);
            var node = root?.GetNode("Settings");
            if (node == null)
            {
                Debug.LogWarning($"[Kerbcast] settings file at {path} is missing a 'Settings' node; skipping it");
            }
            return node;
        }

        private static void ApplyScalars(KerbcastSettings settings, ConfigNode node)
        {
            ApplyString(node, "BindAddress", v => settings.BindAddress = v);
            ApplyInt(node, "Port", v => settings.Port = v);
            ApplyString(node, "MaxQuality", v =>
            {
                if (QualityTiers.TryParse(v, out var t))
                    settings.MaxQuality = t;
                else
                    Debug.LogWarning($"[Kerbcast] settings.cfg: unknown MaxQuality '{v}'; valid: low, sd, hd, fullhd");
            });
            ApplyInt(node, "Width", v => settings.Width = v);
            ApplyInt(node, "Height", v => settings.Height = v);
            ApplyInt(node, "BitrateBps", v => settings.BitrateBps = v);
            ApplyBool(node, "AdaptiveQuality", v => settings.AdaptiveQuality = v);
            ApplyBool(node, "AutoSpawnSidecar", v => settings.AutoSpawnSidecar = v);
            ApplyFloat(node, "MaxCaptureFps", v => settings.MaxCaptureFps = v);
            ApplyFloat(node, "BackgroundCaptureFps", v => settings.BackgroundCaptureFps = v);
            ApplyFloat(node, "MaxKerbcastFrameBudgetMs", v => settings.MaxKerbcastFrameBudgetMs = v);
            ApplyFloat(node, "MinKspFps", v => settings.MinKspFps = v);
            ApplyBool(node, "EnableAtmosphericFx", v => settings.EnableAtmosphericFx = v);
            ApplyString(node, "AtmosphericFxLayers", v => settings.AtmosphericFxLayers = ParseAtmoFxLayers(v));
            ApplyBool(node, "EnableHullcamEffects", v => EnableHullcamEffects = v);
            ApplyBool(node, "EnableBlitDiagnostics", v => EnableBlitDiagnostics = v);
            ApplyBool(node, "EnableOrientationTestPattern", v => EnableOrientationTestPattern = v);
            ApplyBool(node, "EnableTUFX", v => EnableTUFX = v);
            ApplyBool(node, "EnableEVE", v => EnableEVE = v);
            ApplyBool(node, "EnableScatterer", v => EnableScatterer = v);
            ApplyBool(node, "EnableParallax", v => EnableParallax = v);
            ApplyBool(node, "EnableDeferred", v => EnableDeferred = v);
            ApplyBool(node, "EnableFirefly", v => EnableFirefly = v);
            ApplyBool(node, "EnableHullcamLinuxShaderSwap", v => EnableHullcamLinuxShaderSwap = v);
            ApplyBool(node, "DebugCameraLogging", v => DebugCameraLogging = v);
            ApplyBool(node, "EnableTelemetry", v => EnableTelemetry = v);
            ApplyBool(node, "ForceAtmosphericFx", v => ForceAtmosphericFx = v);
            ApplyVector3(node, "DebugWindDirection", v => DebugWindDirection = v);
            // Static slots so KerbcastGameParameters (constructed by
            // KSP before our plugin instance loads) can pick up the
            // seed values. Settings.cfg is the source of truth for
            // first-time-on-this-save defaults.
            ApplyBool(node, "ThrottleMainScreen", v => SeedThrottleMainScreen = v);
        }

        // Per-camera Camera{} blocks. Called once per settings file; a user
        // file's Camera node for the same PartName overrides the defaults
        // file's key by key, same as the scalars.
        private static void ApplyCameraNodes(KerbcastSettings settings, ConfigNode node)
        {
            foreach (var camNode in node.GetNodes("Camera"))
            {
                var partName = camNode.GetValue("PartName")?.Trim();
                if (string.IsNullOrEmpty(partName))
                {
                    Debug.LogWarning("[Kerbcast] settings.cfg: Camera node missing PartName, skipping");
                    continue;
                }
                var layersRaw = camNode.GetValue("Layers");
                if (!string.IsNullOrEmpty(layersRaw))
                {
                    settings._initialLayers[partName] = ParseLayers(layersRaw);
                }
                var fxRaw = camNode.GetValue("EnableAtmosphericFx");
                if (!string.IsNullOrEmpty(fxRaw))
                {
                    if (bool.TryParse(fxRaw.Trim(), out bool fxVal))
                        settings._atmosphericFx[partName] = fxVal;
                    else
                        Debug.LogWarning($"[Kerbcast] settings.cfg: Camera '{partName}' EnableAtmosphericFx='{fxRaw}' is not a bool; ignoring");
                }
                var fxLayersRaw = camNode.GetValue("AtmosphericFxLayers");
                if (!string.IsNullOrEmpty(fxLayersRaw))
                {
                    settings._atmosphericFxLayers[partName] = ParseAtmoFxLayers(fxLayersRaw);
                }
                // Per-camera Width/Height overrides must be even (H.264
                // chroma sampling) and <= the global Width/Height (the
                // ring's allocated capacity). Either field defaults to the
                // global value if omitted.
                int? w = TryParseIntField(camNode, "Width");
                int? h = TryParseIntField(camNode, "Height");
                if (w.HasValue || h.HasValue)
                {
                    int width = w ?? settings.Width;
                    int height = h ?? settings.Height;
                    width -= width & 1;
                    height -= height & 1;
                    if (width > settings.Width || height > settings.Height)
                    {
                        Debug.LogWarning($"[Kerbcast] settings.cfg: Camera '{partName}' size {width}x{height} exceeds global max {settings.Width}x{settings.Height}; capping");
                        if (width > settings.Width) width = settings.Width;
                        if (height > settings.Height) height = settings.Height;
                    }
                    settings._renderSize[partName] = (width, height);
                }
            }
        }

        // Parse the AtmosphericFxLayers token list (CORE, BOWSHOCK, TRAIL,
        // EMBERS, ALL). An empty/all-invalid list means "no FX layers", which
        // is a legitimate operator choice (master on but every layer off), so
        // unlike ParseLayers we return None rather than falling back to All.
        private static AtmoFxLayers ParseAtmoFxLayers(string raw)
        {
            var mask = AtmoFxLayers.None;
            foreach (var tok in raw.Split(','))
            {
                var t = tok.Trim();
                if (t.Equals("CORE", System.StringComparison.OrdinalIgnoreCase)) mask |= AtmoFxLayers.Core;
                else if (t.Equals("BOWSHOCK", System.StringComparison.OrdinalIgnoreCase)) mask |= AtmoFxLayers.Bowshock;
                else if (t.Equals("TRAIL", System.StringComparison.OrdinalIgnoreCase)) mask |= AtmoFxLayers.Trail;
                else if (t.Equals("EMBERS", System.StringComparison.OrdinalIgnoreCase)) mask |= AtmoFxLayers.Embers;
                else if (t.Equals("ALL", System.StringComparison.OrdinalIgnoreCase)) mask |= AtmoFxLayers.All;
                else if (!string.IsNullOrEmpty(t))
                    Debug.LogWarning($"[Kerbcast] settings.cfg: unknown FX layer '{t}', skipping");
            }
            return mask;
        }

        private static CameraLayers ParseLayers(string raw)
        {
            return SettingsLayer.ParseCameraLayers(raw, Debug.LogWarning);
        }

        // Thin ConfigNode adapters over the Unity-free SettingsLayer helpers
        // (unit-tested in Plugin/SettingsLayer.Tests). Absent keys keep the
        // current value, which is what makes the defaults + user-file
        // layering in Load() work; parse failures warn and keep the current
        // value; floats parse with InvariantCulture.
        private static void Warn(string msg) => Debug.LogWarning(msg);

        private static int? TryParseIntField(ConfigNode node, string key)
            => SettingsLayer.TryParseInt(node.GetValue, key, Warn);

        private static void ApplyString(ConfigNode node, string key, System.Action<string> set)
            => SettingsLayer.ApplyString(node.GetValue, key, set);

        private static void ApplyInt(ConfigNode node, string key, System.Action<int> set)
            => SettingsLayer.ApplyInt(node.GetValue, key, set, Warn);

        private static void ApplyBool(ConfigNode node, string key, System.Action<bool> set)
            => SettingsLayer.ApplyBool(node.GetValue, key, set, Warn);

        private static void ApplyFloat(ConfigNode node, string key, System.Action<float> set)
            => SettingsLayer.ApplyFloat(node.GetValue, key, set, Warn);

        // Parses three comma-separated floats: `x, y, z`.
        private static void ApplyVector3(ConfigNode node, string key, System.Action<Vector3> set)
            => SettingsLayer.ApplyFloat3(node.GetValue, key, (x, y, z) => set(new Vector3(x, y, z)), Warn);
    }
}
