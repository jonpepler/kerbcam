namespace Kerbcast
{
    /* The camera surface KerbcastCore drives uniformly across sources
       (Hullcam part cameras, kerbal face cameras). Rich per-camera
       diagnostics used only by the status-file writer stay on
       KerbcastCamera and are reached via a type check there. */
    internal interface ICamera
    {
        uint FlightId { get; }
        Vessel Vessel { get; }
        bool IsAlive { get; }
        bool Subscribed { get; }
        /* Capture-rate pacing. The core asks each subscribed camera what rate it
           should run at and whether it is due this tick, then staggers only the
           cameras that are, and tells the ones it granted at what rate. This is
           where the rate cap lives; see CapturePacing for why it cannot live in
           the stagger budget. */
        float EffectiveCaptureFps(float primaryFps, float backgroundCeilingFps);
        bool CaptureDue(float now, float effectiveFps);
        float CaptureOverdue(float now, float effectiveFps);
        void MarkCaptureGranted(float now, float effectiveFps);
        int RefreshFailureStreak { get; set; }
        bool OwnsPart(Part part);
        void MarkFxDirty();
        void Refresh(bool mayIssueReadback);
        void ApplyAutoShed(int level);
        void WriteInfoManifest();
        void Dispose();
        void DisposeDestroyed();
    }
}
