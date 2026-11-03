// Pure workflow decisions for the capture screen (no React, no browser APIs), so they can be unit
// tested and reused by Day 7 editing/export. LectureCapture.tsx owns state and side effects only.
import type { Turn } from "./meta-asr";
import type { DiagramContext, DiagramResult } from "./diagram";
import type { LessonContext } from "./materials";
import type { ResultSource } from "./session-store";

export type Lesson = { subject: string; grade: string; objective: string; standards: string };
export type ProfileGuidance = { style?: string; classNotes?: string } | null | undefined;

/** Split the key-vocabulary box on commas and new lines. */
export function parseVocabulary(keywords: string): string[] {
  return keywords.split(/[,\n]/).map((k) => k.trim()).filter(Boolean);
}

/** Lesson context sent for image labeling and materials generation. */
export function buildLessonContext(lesson: Lesson, keywords: string, profile: ProfileGuidance): LessonContext {
  return { ...lesson, vocabulary: parseVocabulary(keywords), style: profile?.style, classNotes: profile?.classNotes };
}

/** A deep copy of exactly what a generation used, so later edits never change what it records. */
export function snapshotResultSource(turns: Turn[], durationMs: number, context: LessonContext): ResultSource {
  return {
    turns: turns.map((turn) => ({ ...turn })),
    durationMs,
    context: { ...context, vocabulary: context.vocabulary ? [...context.vocabulary] : undefined },
  };
}

/** Saved results from before sources were recorded: rebuild the source from the saved lecture. */
export function restoredResultSource(
  saved: { turns: Turn[]; durationMs: number; lesson: Lesson; keywords: string; result: unknown; resultSource?: ResultSource | null },
  profile: ProfileGuidance,
): ResultSource | null {
  if (!saved.result) return null;
  return saved.resultSource ?? {
    turns: saved.turns,
    durationMs: saved.durationMs,
    context: buildLessonContext(saved.lesson, saved.keywords, profile),
  };
}

/** Only labeled items shape the materials; an image with nothing to label adds no diagram context. */
export function diagramContextFor(labeled: DiagramResult | null | undefined): DiagramContext | undefined {
  return labeled?.items.length
    ? { summary: labeled.summary, items: labeled.items.map(({ n, label }) => ({ n, label })) }
    : undefined;
}

/** JSON body for /api/generate. The open-weight flag is sent only when selected. */
export function generateRequestBody(source: ResultSource, diagram: DiagramContext | undefined, openWeight: boolean) {
  return { turns: source.turns, context: source.context, diagram, ...(openWeight ? { privacy: true } : {}) };
}

/** Reuse finished transcription chunks only for the identical audio and keywords. */
export function resumableChunks<A, R>(
  kept: { audio: A; keywords: string; results: R } | null,
  audio: A,
  keywords: string[],
): R | undefined {
  return kept?.audio === audio && kept.keywords === keywordKey(keywords) ? kept.results : undefined;
}
export const keywordKey = (keywords: string[]) => keywords.join("\n");

/** Error text when transcription fails, noting any finished sections kept for a retry. */
export function transcriptionErrorMessage(err: unknown, partial?: readonly unknown[]): string {
  let message = isDomError(err, "EncodingError")
    ? "This browser couldn't read that audio file. Try m4a, mp3, or wav."
    : err instanceof Error ? err.message : "Something went wrong.";
  const finished = partial?.filter(Boolean).length ?? 0;
  if (partial && finished > 0) {
    message += ` ${finished} of ${partial.length} sections are already done and kept — select Transcribe lecture to finish the rest.`;
  }
  return message;
}
function isDomError(err: unknown, name: string) {
  return typeof DOMException !== "undefined" && err instanceof DOMException && err.name === name;
}

/** Null when the lecture fits; otherwise the message to show. `format` renders a duration. */
export function lectureTooLongMessage(durationMs: number, maxMinutes: number, format: (ms: number) => string): string | null {
  return durationMs > maxMinutes * 60_000
    ? `Lectures up to ${maxMinutes} minutes are supported; this one is ${format(durationMs)}.`
    : null;
}

export function countWords(turns: Turn[]): number {
  return turns.reduce((n, t) => n + t.text.split(/\s+/).filter(Boolean).length, 0);
}

export type SaveState =
  | { kind: "idle" | "saving" | "saved" }
  | { kind: "error"; message: string }
  | { kind: "warning"; message: string }
  | { kind: "too-large"; maxBytes: number };

/** The save-status banner: which message to show, whether it is a warning, and whether to offer a retry. */
export function saveStatus(session: SaveState, audio: SaveState, audioBytes: number): { message: string; attention: boolean; retry: boolean } {
  const error = session.kind === "error" ? session.message : audio.kind === "error" ? audio.message : null;
  const warning = audio.kind === "warning" ? audio.message : null;
  const saving = session.kind === "saving" || audio.kind === "saving";
  const tooLarge = audio.kind === "too-large" ? audio.maxBytes : null;
  const limitMb = tooLarge === null ? 0 : Math.round(tooLarge / (1024 * 1024));
  const message = error ?? warning ?? (saving
    ? tooLarge !== null
      ? `Saving lecture details… The audio exceeds the ${limitMb} MB browser-save limit and will not survive a refresh.`
      : "Saving this lecture in your browser…"
    : tooLarge !== null
      ? `Lecture details are saved, but this ${(audioBytes / (1024 * 1024)).toFixed(1)} MB audio exceeds the ${limitMb} MB browser-save limit. It will not survive a refresh.`
      : "Saved in this browser.");
  return { message, attention: Boolean(error || warning || tooLarge !== null), retry: error !== null };
}
