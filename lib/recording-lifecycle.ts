// Browser-safe recording limits and cleanup helpers. Kept separate so boundary behavior is testable.

export const RECORDING_LIMITS = {
  durationMs: 90 * 60_000,
  /** Stop slightly early so timer/event delay cannot create audio over the processing limit. */
  stopLeadMs: 1_000,
  bytes: 300 * 1024 * 1024,
  audioBitsPerSecond: 128_000,
} as const;

export type RecordingLimitReason = "duration" | "size";

export function recordingLimitReason(elapsedMs: number, bytes: number): RecordingLimitReason | null {
  if (elapsedMs >= RECORDING_LIMITS.durationMs - RECORDING_LIMITS.stopLeadMs) return "duration";
  if (bytes >= RECORDING_LIMITS.bytes) return "size";
  return null;
}

export function recordingLimitMessage(reason: RecordingLimitReason): string {
  return reason === "duration"
    ? "Recording stopped automatically at the 90-minute limit."
    : "Recording stopped automatically at the 300 MB limit.";
}

export function stopMediaStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export function stopMediaRecorder(recorder: MediaRecorder | null): void {
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

/** Prefer a bounded bitrate, but let browsers that reject that option choose their native default. */
export function createCompatibleMediaRecorder(
  stream: MediaStream,
  create: (options?: MediaRecorderOptions) => MediaRecorder = (options) => new MediaRecorder(stream, options),
): MediaRecorder {
  try { return create({ audioBitsPerSecond: RECORDING_LIMITS.audioBitsPerSecond }); }
  catch { return create(); }
}
