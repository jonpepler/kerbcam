// Persistent owner of the sidecar process. Lives on a DontDestroyOnLoad
// GameObject created lazily by the first flight-scene KerbcastCore.Awake
// of the session, and survives every scene change after that. The
// sidecar therefore runs ONCE per KSP game session: scene changes are
// pure camera-list churn (ring files come and go, the sidecar's rescan
// already handles both), WebRTC peers stay connected, and the encoder
// probes once.
//
// Spawn/kill points:
//   - spawn: first flight entry of the session (or relaunch after a
//     crash, with bounded backoff, driven from Update in ANY scene).
//   - kill:  OnApplicationQuit / OnDestroy only. Expected exits log at
//     INFO; only genuine crashes WARN.
//
// Orphan protection: Update touches <ringDir>/global.heartbeat ~1Hz for
// the whole session. If KSP dies without OnApplicationQuit (hard crash,
// SIGKILL), the heartbeat goes stale and the sidecar self-exits (see
// sidecar/src/heartbeat.rs). Written even when AutoSpawnSidecar=false
// so manually-launched sidecars get the same protection.
//
// Process-level settings (bind address, port, max dims, bitrate) are
// captured from the first flight's settings load and apply once per
// game launch; editing settings.cfg mid-session logs a hint that a KSP
// restart is needed for those fields.

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace Kerbcast
{
    internal sealed class KerbcastSidecarHost : MonoBehaviour
    {
        private const int SidecarMaxRestarts = 5;
        private const float SidecarRestartDelaySeconds = 5f;
        private const float SidecarHealthyUptimeSeconds = 60f;
        private const float HeartbeatIntervalSeconds = 1.0f;
        private const string HeartbeatFileName = "global.heartbeat";
        private const string InFlightFileName = "global.inflight";

        public static KerbcastSidecarHost Instance { get; private set; }

        private KerbcastSettings _settings;
        private string _ringDir;
        private string _heartbeatPath;
        private float _heartbeatCooldown;
        private bool _heartbeatWarned;
        private string _inFlightPath;
        private bool _inFlightWarned;
        private SidecarLifecycle _lifecycle;
        private Process _sidecar;

        /* Exited fires on a threadpool thread; Update consumes the flags on
           the main thread. _expectedExit is set BEFORE Kill so the handler
           can classify the exit without touching the lifecycle machine. */
        private volatile bool _sidecarExited;
        private volatile bool _expectedExit;
        private volatile int _lastExitCode;

        /* Cheap process-alive probe for the public facade. HasExited throws
           once the handle is detached, so a throw reports dead rather than
           propagating into the caller's frame. */
        public bool SidecarRunning
        {
            get
            {
                var p = _sidecar;
                if (p == null) return false;
                try { return !p.HasExited; }
                catch (Exception) { return false; }
            }
        }

        /// <summary>
        /// Create the host on first call, then notify it of a flight-scene
        /// entry. Called from every KerbcastCore.Awake; only the first call
        /// of the session spawns the process.
        /// </summary>
        public static void NotifyFlightEntered(KerbcastSettings settings, string ringDir)
        {
            if (Instance == null)
            {
                var go = new GameObject("KerbcastSidecarHost");
                UnityEngine.Object.DontDestroyOnLoad(go);
                Instance = go.AddComponent<KerbcastSidecarHost>();
                Instance.Init(settings, ringDir);
            }
            Instance.OnFlightEntered(settings);
        }

        private void Init(KerbcastSettings settings, string ringDir)
        {
            _settings = settings;
            _ringDir = ringDir;
            _heartbeatPath = Path.Combine(ringDir, HeartbeatFileName);
            _inFlightPath = Path.Combine(ringDir, InFlightFileName);
            _lifecycle = new SidecarLifecycle(
                settings.AutoSpawnSidecar,
                SidecarMaxRestarts,
                SidecarRestartDelaySeconds,
                SidecarHealthyUptimeSeconds);
            WriteHeartbeat();
            WriteInFlight();
            Debug.Log("[Kerbcast] sidecar host created (persists for the KSP session)");
        }

        private void OnFlightEntered(KerbcastSettings freshSettings)
        {
            WarnIfProcessSettingsChanged(freshSettings);
            var action = _lifecycle.OnFlightEntered();
            if (action == SidecarAction.Spawn) TryStartSidecar();
        }

        /* Process-level flags are baked into the running sidecar's CLI; a
           mid-session settings.cfg edit to them silently doing nothing is
           the one regression risk of the once-per-session lifecycle, so
           call it out explicitly. Camera-level settings still apply on
           every flight entry via KerbcastCore. */
        private void WarnIfProcessSettingsChanged(KerbcastSettings fresh)
        {
            if (fresh == null || _settings == null || ReferenceEquals(fresh, _settings)) return;
            if (fresh.HttpBind != _settings.HttpBind
                || fresh.Width != _settings.Width
                || fresh.Height != _settings.Height
                || fresh.BitrateBps != _settings.BitrateBps
                || fresh.AutoSpawnSidecar != _settings.AutoSpawnSidecar)
            {
                Debug.LogWarning(
                    "[Kerbcast] process-level settings (bind/port, Width/Height, BitrateBps, "
                    + "AutoSpawnSidecar) changed since the sidecar was launched; they apply "
                    + "on the next KSP start. Camera-level settings apply now.");
            }
        }

        private void Update()
        {
            float dt = Time.unscaledDeltaTime;

            _heartbeatCooldown -= dt;
            if (_heartbeatCooldown <= 0f)
            {
                _heartbeatCooldown = HeartbeatIntervalSeconds;
                WriteHeartbeat();
                WriteInFlight();
            }

            if (_sidecarExited)
            {
                _sidecarExited = false;
                DisposeProcessHandle();
                var verdict = _lifecycle.OnCrashed();
                if (verdict.GaveUp)
                {
                    Debug.LogError($"[Kerbcast] sidecar crashed {verdict.MaxAttempts} times; giving up until the next flight scene");
                }
                else if (verdict.Attempt > 0)
                {
                    Debug.LogWarning(
                        $"[Kerbcast] sidecar exited unexpectedly (code {_lastExitCode}); "
                        + $"restarting in {verdict.RestartDelaySeconds:0}s "
                        + $"(attempt {verdict.Attempt}/{verdict.MaxAttempts})");
                }
            }

            if (_lifecycle.Tick(dt) == SidecarAction.Spawn) TryStartSidecar();
        }

        /* The plugin-side half of the orphan protection. Tiny write to a
           tmpfs path; the sidecar only checks mtime. Warn once, not per
           second, if the dir somehow went away. */
        private void WriteHeartbeat()
        {
            try
            {
                File.WriteAllText(_heartbeatPath, DateTime.UtcNow.Ticks.ToString());
            }
            catch (Exception ex)
            {
                if (_heartbeatWarned) return;
                _heartbeatWarned = true;
                Debug.LogWarning($"[Kerbcast] heartbeat write failed (orphan protection degraded): {ex.Message}");
            }
        }

        /* Report whether KSP is in a flight scene so the sidecar can tell
           browsers to show the out-of-flight standby instead of a wall of
           SIGNAL LOST. Warn once, not per second, if the write fails. */
        private void WriteInFlight()
        {
            try
            {
                InFlightSignal.Write(_inFlightPath, HighLogic.LoadedSceneIsFlight);
            }
            catch (Exception ex)
            {
                if (_inFlightWarned) return;
                _inFlightWarned = true;
                Debug.LogWarning($"[Kerbcast] in-flight write failed: {ex.Message}");
            }
        }

        private void OnApplicationQuit()
        {
            ShutDown();
        }

        /* Defence in depth: DontDestroyOnLoad objects get OnDestroy at app
           teardown too, and if something destroys the host mid-game we kill
           the process rather than orphan it (a later flight entry recreates
           both). ShutDown is idempotent via the lifecycle's quitting flag. */
        private void OnDestroy()
        {
            ShutDown();
            if (Instance == this) Instance = null;
        }

        private void ShutDown()
        {
            if (_lifecycle == null || _lifecycle.Quitting) return;
            var action = _lifecycle.OnGameQuit();
            if (action == SidecarAction.Kill) StopSidecar();
            try
            {
                if (_heartbeatPath != null && File.Exists(_heartbeatPath))
                    File.Delete(_heartbeatPath);
            }
            catch (Exception)
            {
                /* Best-effort; a leftover heartbeat is overwritten next launch. */
            }
            try
            {
                if (_inFlightPath != null && File.Exists(_inFlightPath))
                    File.Delete(_inFlightPath);
            }
            catch (Exception)
            {
                /* Best-effort; a leftover file is overwritten next launch. */
            }
        }

        // Spawn the bundled sidecar binary if one is shipped alongside the
        // plugin. Missing or non-executable binary is logged at warn but
        // isn't fatal: the operator can still launch the sidecar manually
        // from another shell, which is how kerbcast was originally built and
        // remains the dev workflow.
        private void TryStartSidecar()
        {
            try
            {
                if (_sidecar != null && !_sidecar.HasExited)
                {
                    _lifecycle.OnSpawned();
                    return;
                }

                var binPath = ResolveSidecarBinary();
                if (binPath == null)
                {
                    Debug.LogWarning("[Kerbcast] no bundled sidecar binary found; launch ~/personal/kerbcast/sidecar manually if you need streaming");
                    _lifecycle.OnSpawnFailed();
                    return;
                }

                EnsureExecutable(binPath);

                // CLI flags forwarded from settings.cfg. The sidecar
                // accepts every value we care about as a long-form arg,
                // so there's no config file to keep in sync on the
                // sidecar side.
                var args =
                    $"--shm-dir \"{_ringDir}\" " +
                    $"--http-bind {_settings.HttpBind} " +
                    $"--max-width {_settings.Width} " +
                    $"--max-height {_settings.Height}";

                // Explicit bitrate only when the operator configured one.
                // BitrateBps = 0 (the default) means auto: omit the flag so
                // the sidecar derives its default from the encoder backend
                // it selects (hardware backends default higher than the
                // software fallback).
                if (_settings.BitrateBps > 0)
                {
                    args += $" --bitrate-bps {_settings.BitrateBps}";
                }

                var psi = new ProcessStartInfo
                {
                    FileName = binPath,
                    Arguments = args,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                };

                // Self-contained sidecar deployment (Linux only): CI bundles
                // the ffmpeg shared libs (libavutil/libavcodec/etc) the binary
                // links against into a sibling lib/ directory, because SteamOS
                // doesn't ship those .so files. Prepend lib/ to
                // LD_LIBRARY_PATH so the dynamic linker finds the bundled
                // copies before falling back to the system path (for libva
                // + its GPU-driver shims, which we intentionally do NOT
                // bundle: those have to match the host's Mesa stack).
                //
                // Gated on Directory.Exists, which is the cross-platform
                // guard: macOS/Windows sidecars are software-encode (OpenH264,
                // no exotic native deps) and ship no lib/ dir, so this block is
                // skipped there; the OS loader finds anything beside the
                // binary on its own. The dev workflow (manual launch, no
                // bundled lib dir) stays harmless for the same reason.
                //
                // EnvironmentVariables is the cross-platform setter on
                // .NET48/Mono despite the MSDN page tagging it Windows-only.
                var libDir = Path.Combine(Path.GetDirectoryName(binPath) ?? string.Empty, "lib");
                if (Directory.Exists(libDir))
                {
                    var existing = Environment.GetEnvironmentVariable("LD_LIBRARY_PATH");
                    psi.EnvironmentVariables["LD_LIBRARY_PATH"] =
                        string.IsNullOrEmpty(existing) ? libDir : libDir + ":" + existing;
                    Debug.Log($"[Kerbcast] LD_LIBRARY_PATH prepend: {libDir}");
                }

                _sidecar = new Process { StartInfo = psi, EnableRaisingEvents = true };
                _sidecar.OutputDataReceived += (sender, e) =>
                {
                    if (!string.IsNullOrEmpty(e.Data)) Debug.Log($"[Kerbcast.sidecar] {e.Data}");
                };
                _sidecar.ErrorDataReceived += (sender, e) =>
                {
                    if (!string.IsNullOrEmpty(e.Data)) Debug.Log($"[Kerbcast.sidecar] {e.Data}");
                };
                _sidecar.Exited += (sender, e) =>
                {
                    /* sender, not _sidecar: a restart may have replaced the
                       field by the time this fires. ExitCode can throw if the
                       handle is already disposed. */
                    int code;
                    try { code = ((Process)sender).ExitCode; }
                    catch (Exception) { code = -1; }
                    if (_expectedExit)
                    {
                        Debug.Log($"[Kerbcast] sidecar stopped (game exit, code {code})");
                        return;
                    }
                    _lastExitCode = code;
                    _sidecarExited = true;
                };

                /* Before Start(): an instant-crash could fire Exited ahead of
                   a reset placed after it, losing the exit. */
                _sidecarExited = false;
                _expectedExit = false;
                _sidecar.Start();
                _sidecar.BeginOutputReadLine();
                _sidecar.BeginErrorReadLine();
                _lifecycle.OnSpawned();
                Debug.Log($"[Kerbcast] sidecar started pid={_sidecar.Id} from {binPath} (runs until game exit)");
            }
            catch (Exception ex)
            {
                Debug.LogError($"[Kerbcast] failed to start sidecar: {ex}");
                _sidecar = null;
                _lifecycle.OnSpawnFailed();
            }
        }

        private void StopSidecar()
        {
            if (_sidecar == null) return;
            try
            {
                if (!_sidecar.HasExited)
                {
                    _expectedExit = true;
                    _sidecar.Kill();
                    _sidecar.WaitForExit(2000);
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Kerbcast] sidecar stop threw: {ex.Message}");
            }
            finally
            {
                DisposeProcessHandle();
            }
        }

        private void DisposeProcessHandle()
        {
            if (_sidecar == null) return;
            try { _sidecar.Dispose(); }
            catch (Exception) { /* already gone */ }
            _sidecar = null;
        }

        private static string ResolveSidecarBinary()
        {
            /* Per-OS bundle layout under GameData/Kerbcast/Sidecar/<rid>/:
               the release workflow (.github/workflows/release.yml) builds one
               sidecar per supported runtime and lays each out in its own rid
               subdir. Casing matters: the Deck's filesystem is case-sensitive
               and the workflow packages into "Sidecar" (capital S). Keep the
               rid set + binary name in lockstep with release.yml's assemble
               job. KSPUtil.ApplicationRootPath is the KSP install root. */
            var rid = SidecarRid();
            if (rid == null) return null;
            var binName = Application.platform == RuntimePlatform.WindowsPlayer
                ? "kerbcast-sidecar.exe"
                : "kerbcast-sidecar";

            var bundled = Path.Combine(
                KSPUtil.ApplicationRootPath,
                "GameData", "Kerbcast", "Sidecar", rid, binName);
            if (File.Exists(bundled)) return bundled;

            /* Legacy flat Linux layout (pre-per-rid releases and the
               feature-branch Deck-deploy flow, which stage straight into
               Sidecar/). Keep resolving it so older bundles and manually
               staged artifacts still launch. */
            if (rid == "linux-x64")
            {
                var legacy = Path.Combine(
                    KSPUtil.ApplicationRootPath,
                    "GameData", "Kerbcast", "Sidecar", "kerbcast-sidecar");
                if (File.Exists(legacy)) return legacy;
            }
            return null;
        }

        /* Map the running KSP player to the sidecar runtime-identifier subdir
           that release.yml ships. macOS is arm64-only (matches the documented
           Apple-Silicon target); KSP runs x86_64 under Rosetta but the
           separately-spawned sidecar runs native arm64. Intel-mac (osx-x64) is
           a deferred tier-2 TODO. Unknown platforms return null so TryStartSidecar
           logs the manual-launch hint rather than guessing a path. */
        private static string SidecarRid()
        {
            switch (Application.platform)
            {
                case RuntimePlatform.LinuxPlayer:
                    return "linux-x64";
                case RuntimePlatform.OSXPlayer:
                    return "osx-arm64";
                case RuntimePlatform.WindowsPlayer:
                    return "win-x64";
                default:
                    return null;
            }
        }

        /* CKAN installs files without preserving the Unix executable bit (its
           install spec has no permission directive and it sets no file mode on
           extraction), so a sidecar dropped in by CKAN lands non-executable and
           ProcessStartInfo can't launch it. The release zip keeps the bit for
           SpaceDock/manual installs, but chmod is idempotent and cheap, so just
           (re)assert 0755 on Linux/macOS before every launch. No-op on Windows.
           Non-fatal: the binary may already be executable, so let Process.Start
           surface any real problem rather than aborting here. */
        private static void EnsureExecutable(string path)
        {
            if (Application.platform == RuntimePlatform.WindowsPlayer) return;
            try
            {
                const uint mode0755 = 0x1ED; /* octal 0755 */
                if (Chmod(path, mode0755) != 0)
                    Debug.LogWarning($"[Kerbcast] chmod 0755 on sidecar returned errno {Marshal.GetLastWin32Error()}: {path}");
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Kerbcast] could not chmod sidecar ({path}): {ex.Message}");
            }
        }

        [DllImport("libc", SetLastError = true, EntryPoint = "chmod")]
        private static extern int Chmod(string path, uint mode);
    }
}
