/* The capture path's final orientation correction, factored out of
   CaptureCore so the headless orientation proof in ci/kerbcast-shaders
   compiles the SAME source file via the Assets/Editor symlink pattern
   (like Fx/Core and HullcamBlit). CaptureCore itself cannot be symlinked:
   it pulls in the AsyncGPUReadback shim, which the CI Unity project does
   not have.

   Why this exists as a seam at all: the shipped capture chain applies TWO
   independently-gated vertical flips — HullcamFilterBlit's probe-driven one
   (top-left-origin APIs only) and this one (bottom-left-origin APIs only) —
   and only FILTERED cameras traverse the first. The CI proof covered the
   blit branches and stopped, so a mismatch between the two gates could ship
   a mirrored or inverted feed with the test still green. Anything that
   decides final orientation belongs in here, where the proof can reach it. */

using UnityEngine;

namespace Kerbcast
{
    internal static class CaptureOrientation
    {
        /// <summary>
        /// Whether the capture path must mirror V after the capture blit.
        /// On bottom-left-origin graphics APIs (OpenGL, the Deck)
        /// AsyncGPUReadback returns the frame vertically inverted relative to
        /// KSP's top-down screen pipeline. Top-left-origin APIs (D3D11, Metal)
        /// read upright; HullcamFilterBlit handles its own top-left flip case.
        /// </summary>
        internal static bool NeedsReadbackFlip => !SystemInfo.graphicsUVStartsAtTop;

        /// <summary>
        /// Apply the readback flip in place, via a temporary, when the platform
        /// needs it. No-op otherwise, so every capture path can call it
        /// unconditionally.
        /// </summary>
        internal static void ApplyReadbackFlip(RenderTexture rt)
        {
            if (rt == null || !NeedsReadbackFlip) return;
            var tmp = RenderTexture.GetTemporary(rt.descriptor);
            Graphics.Blit(rt, tmp, new Vector2(1f, -1f), new Vector2(0f, 1f));
            Graphics.Blit(tmp, rt);
            RenderTexture.ReleaseTemporary(tmp);
        }
    }
}
