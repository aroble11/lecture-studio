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

const RECORDING_LABEL_PREFIX = "Recording (";

/** Label for a recording made on the site; it carries the date so a saved copy's file name does too. */
export function recordingLabel(at: Date): string {
  const day = at.toLocaleDateString([], { month: "short", day: "numeric" });
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${RECORDING_LABEL_PREFIX}${day}, ${time})`;
}

/** True for audio recorded on the site (uploads and the sample already exist as files elsewhere). */
export function isSiteRecording(label: string): boolean {
  return label.startsWith(RECORDING_LABEL_PREFIX);
}

/** Extension that matches what the browser recorded (Chrome/Edge/Firefox: WebM or Ogg; Safari: MP4 audio). */
export function recordingExtension(mimeType: string): string {
  const type = mimeType.split(";")[0].trim().toLowerCase();
  if (type.endsWith("/ogg")) return "ogg";
  if (type.endsWith("/mp4") || type.endsWith("/aac") || type.endsWith("/x-m4a")) return "m4a";
  if (type.endsWith("/wav") || type.endsWith("/wave")) return "wav";
  if (type.endsWith("/mpeg")) return "mp3";
  return "webm";
}

/** A file name that is safe on Windows, macOS, and phones, e.g. "Lecture recording (Nov 3, 2-05 PM).webm". */
export function recordingFileName(label: string, mimeType: string): string {
  const detail = isSiteRecording(label) ? label.slice(RECORDING_LABEL_PREFIX.length - 1) : "";
  const base = `Lecture recording ${detail}`
    .replace(/:/g, "-")
    .replace(/[\\/*?"<>|\u0000-\u001f  ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${base}.${recordingExtension(mimeType)}`;
}

/**
 * Recorded time that leaves out pauses, so the timer and the 90-minute limit count only what was captured.
 * `runningSince` is null while paused.
 */
export type RecordingClock = { activeMs: number; runningSince: number | null };

export function startRecordingClock(now: number): RecordingClock {
  return { activeMs: 0, runningSince: now };
}

export function pauseRecordingClock(clock: RecordingClock, now: number): RecordingClock {
  return clock.runningSince === null ? clock : { activeMs: recordedMs(clock, now), runningSince: null };
}

export function resumeRecordingClock(clock: RecordingClock, now: number): RecordingClock {
  return clock.runningSince === null ? { ...clock, runningSince: now } : clock;
}

export function recordedMs(clock: RecordingClock, now: number): number {
  return clock.activeMs + (clock.runningSince === null ? 0 : Math.max(0, now - clock.runningSince));
}

/** Older browsers may lack pause(); the Pause button is hidden there rather than failing. */
export function canPauseRecorder(recorder: MediaRecorder | null): boolean {
  return Boolean(recorder && typeof recorder.pause === "function" && typeof recorder.resume === "function");
}
