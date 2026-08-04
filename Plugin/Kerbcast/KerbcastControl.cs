using System.Collections.Generic;
using UnityEngine;

namespace Kerbcast
{
    /* Immutable per-camera snapshot handed to the kOS add-on. Plain data +
       the owning Part; no kOS types (Kerbcast.dll must not link kOS). */
    public sealed class KerbcastCameraView
    {
        public uint FlightId;
        public uint PartFlightId;
        public string CameraName;
        public string PartName;
        public string PartTitle;
        public bool SupportsZoom;
        public bool SupportsPan;
        public float Fov, FovMin, FovMax;
        public float PanYaw, PanPitch;
        public float PanYawMin, PanYawMax, PanPitchMin, PanPitchMax;
        // World-space optical axis (unit forward) of the capture camera.
        public float BoresightX, BoresightY, BoresightZ;
        // Lens position relative to the vessel CoM, in Unity world axes — the
        // same frame kOS uses for TARGET:POSITION, so a script can do
        // (TARGET:POSITION - cam:POSITION) directly.
        public float PositionX, PositionY, PositionZ;
        // Current auto-track mode (0=none/1=active-vessel/2=target).
        public int TrackMode;
        public global::Part Part;
    }

    /* In-process control seam the KerbcastKos add-on calls. Resolves cameras
       through the live KerbcastCore and applies FOV/pan; the plugin already
       feeds resulting state back to the sidecar via global.status.json. */
    public static class KerbcastControl
    {
        public static bool IsActive => KerbcastCore.Instance != null;

        /* Whether the video sidecar process is currently alive. False out of
           flight (no host yet) and false once the process dies, which is the
           state where every feed goes black while the mod still looks healthy. */
        public static bool SidecarAlive => KerbcastSidecarHost.Instance?.SidecarRunning ?? false;

        public static IReadOnlyList<KerbcastCameraView> CamerasFor(global::Vessel vessel)
        {
            var result = new List<KerbcastCameraView>();
            var cams = KerbcastCore.Instance?.Cameras;
            if (cams == null || vessel == null) return result;
            for (int i = 0; i < cams.Count; i++)
            {
                // Kerbal cameras aren't exposed to kOS this stage.
                if (cams[i] is KerbcastCamera c && c.Vessel == vessel)
                    result.Add(ToView(c));
            }
            return result;
        }

        public static KerbcastCameraView ViewOf(uint flightId)
        {
            var c = Find(flightId);
            return c == null ? null : ToView(c);
        }

        public static bool SetFov(uint flightId, float fov)
        {
            var c = Find(flightId); if (c == null) return false; c.SetFov(fov); return true;
        }

        public static bool SetPan(uint flightId, float yaw, float pitch)
        {
            var c = Find(flightId); if (c == null) return false; c.SetPanTarget(yaw, pitch); return true;
        }

        /* aimPoint is a kOS-frame vector (ship-relative, e.g. TARGET:POSITION),
           matching what KerbcastCameraView.Position reports. Convert to a Unity
           world point via the vessel CoM before handing it to the camera, whose
           AimAt works in world space. */
        public static bool AimAt(uint flightId, Vector3 aimPoint)
        {
            var c = Find(flightId); if (c == null) return false;
            var vessel = c.Mount.Vessel;
            Vector3 worldPoint = vessel != null ? (Vector3)vessel.CoM + aimPoint : aimPoint;
            c.AimAt(worldPoint);
            return true;
        }

        /* Auto-track (issue #6) as a SYNCHRONOUS kOS function: set/get the
           camera's track mode in-process, immediate, no sidecar round-trip.
           Set is optimistic-local (the camera aims at once) and stages an
           up-report the sidecar adopts as authoritative (so every browser
           reflects it); get returns the applied value now. Only pan+zoom
           cameras honour a set (mirrors the browser gate); a non-pan+zoom or
           unknown camera returns none (0) from get and false from set.
           mode: 0=none, 1=active-vessel, 2=target. */
        public static bool SetTrackMode(uint flightId, int mode)
        {
            var c = Find(flightId);
            if (c == null || !(c.SupportsPan && c.SupportsZoom)) return false;
            c.RequestTrackMode(mode);
            return true;
        }

        public static int GetTrackMode(uint flightId)
        {
            var c = Find(flightId);
            return c != null ? c.GetTrackMode() : 0;
        }

        static KerbcastCamera Find(uint flightId)
        {
            var cams = KerbcastCore.Instance?.Cameras;
            if (cams == null) return null;
            for (int i = 0; i < cams.Count; i++)
                if (cams[i] is KerbcastCamera kc && kc.FlightId == flightId) return kc;
            return null;
        }

        static KerbcastCameraView ToView(KerbcastCamera c)
        {
            Vector3 fwd = c.BoresightWorld;
            // Lens position relative to the vessel CoM (falls back to raw world
            // if the vessel is gone), matching kOS's ship-relative frame.
            Vector3 pos = c.PositionWorld;
            var vessel = c.Mount.Vessel;
            if (vessel != null) pos -= vessel.CoM;
            var part = c.Mount.OwningPart;
            return new KerbcastCameraView
            {
                FlightId = c.FlightId,
                PartFlightId = part != null ? part.flightID : 0u,
                CameraName = c.CameraName, PartName = c.PartName, PartTitle = c.PartTitle,
                SupportsZoom = c.SupportsZoom, SupportsPan = c.SupportsPan,
                Fov = c.Fov, FovMin = c.FovMin, FovMax = c.FovMax,
                PanYaw = c.PanYaw, PanPitch = c.PanPitch,
                PanYawMin = c.PanYawMin, PanYawMax = c.PanYawMax,
                PanPitchMin = c.PanPitchMin, PanPitchMax = c.PanPitchMax,
                BoresightX = fwd.x, BoresightY = fwd.y, BoresightZ = fwd.z,
                PositionX = pos.x, PositionY = pos.y, PositionZ = pos.z,
                TrackMode = c.GetTrackMode(),
                Part = part,
            };
        }
    }
}
