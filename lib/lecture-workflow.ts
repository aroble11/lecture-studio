// Pure workflow decisions for the capture screen (no React, no browser APIs), so they can be unit
// tested and reused by Day 7 editing/export. LectureCapture.tsx owns state and side effects only.
import type { Turn } from "./meta-asr";
import type { DiagramContext, DiagramItem, DiagramResult } from "./diagram";
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

// ---------- Teacher edits ----------

/** Longest single transcript segment and longest label, matching what saved lectures accept. */
export const MAX_SEGMENT_CHARS = 12_000;
export const MAX_LABEL_CHARS = 80;

/**
 * Apply edited segment text to a transcript. Text is tidied (spaces collapsed, trimmed, length-capped); a
 * segment edited to nothing is removed, but at least one segment always stays. Timestamps never change.
 */
export function applyTranscriptEdits(turns: Turn[], drafts: string[]): Turn[] {
  const edited = turns.map((turn, i) => ({
    ...turn,
    text: (drafts[i] ?? turn.text).replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim().slice(0, MAX_SEGMENT_CHARS),
  }));
  const kept = edited.filter((turn) => turn.text);
  return kept.length ? kept : edited.slice(0, 1).map((turn, i) => ({ ...turn, text: turns[i].text }));
}

/** True when two transcripts say the same thing at the same times. */
export function sameTranscript(a: readonly Turn[], b: readonly Turn[]): boolean {
  return a.length === b.length && a.every((turn, i) => turn.text === b[i].text && turn.startMs === b[i].startMs && turn.endMs === b[i].endMs);
}

/** Materials are out of date when the transcript they were made from has since been edited. */
export function materialsOutdated(turns: readonly Turn[], source: { turns: readonly Turn[] } | null | undefined): boolean {
  return Boolean(source) && !sameTranscript(turns, source!.turns);
}

/**
 * Move a numbered marker so it sits at (x, y) on the picture (0–1000 coordinates). The marker is drawn at the
 * top-left of the item's box, so the box moves with it, keeping its size and staying on the picture.
 */
export function moveDiagramItem(item: DiagramItem, x: number, y: number): DiagramItem {
  const w = Math.max(0, item.box.x2 - item.box.x1), h = Math.max(0, item.box.y2 - item.box.y1);
  const x1 = Math.round(Math.min(1000 - w, Math.max(0, x)));
  const y1 = Math.round(Math.min(1000 - h, Math.max(0, y)));
  return { ...item, box: { x1, y1, x2: x1 + w, y2: y1 + h } };
}

/** Rename one numbered item. Blank names are ignored (the old name stays); names are trimmed and length-capped. */
export function renameDiagramItem(items: DiagramItem[], n: number, label: string): DiagramItem[] {
  const clean = label.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_CHARS);
  return clean ? items.map((item) => (item.n === n ? { ...item, label: clean } : item)) : items;
}

/** Most numbered labels a picture can have (saved lectures accept numbers 1–6). */
export const MAX_DIAGRAM_ITEMS = 6;

/**
 * Add a numbered label in the middle of the picture for the teacher to drag and name. Numbers stay 1..k, so the
 * new label takes the next number. A full picture is returned unchanged.
 */
export function addDiagramItem(items: DiagramItem[]): DiagramItem[] {
  if (items.length >= MAX_DIAGRAM_ITEMS) return items;
  const n = items.length + 1;
  // Step each new marker down and right a little so several added at once don't stack on one spot.
  const offset = (n - 1) * 30;
  const x1 = Math.min(940, 440 + offset), y1 = Math.min(940, 380 + offset);
  return [...items, { n, label: `Label ${n}`, phrase: "", box: { x1, y1, x2: x1 + 60, y2: y1 + 60 }, score: 1 }];
}

/** Remove one numbered label and renumber the rest 1..k in their current order. The last label is never removed. */
export function removeDiagramItem(items: DiagramItem[], n: number): DiagramItem[] {
  if (items.length <= 1 || !items.some((item) => item.n === n)) return items;
  return [...items].sort((a, b) => a.n - b.n).filter((item) => item.n !== n).map((item, i) => ({ ...item, n: i + 1 }));
}

// ---------- The three steps: which one shows, and what the progress list says about each ----------

export type StepNumber = 1 | 2 | 3;
/** What exists so far: a lecture (recording, upload, or sample audio), a transcript, finished materials. */
export type StepProgress = { hasLecture: boolean; hasTranscript: boolean; hasMaterials: boolean };
export type StepState = "current" | "done" | "open" | "locked";

/** Highest step that can be opened: step 2 needs a lecture (or a transcript), step 3 needs a transcript. */
export function lastOpenStep(p: StepProgress): StepNumber {
  return p.hasTranscript ? 3 : p.hasLecture ? 2 : 1;
}

/** Where a teacher should land when nothing was chosen: materials if made, else the lesson step once a lecture exists. */
export function suggestedStep(p: StepProgress): StepNumber {
  return p.hasMaterials && p.hasTranscript ? 3 : p.hasLecture || p.hasTranscript ? 2 : 1;
}

/** The step on screen: the teacher's choice when it is open, else the furthest open step (never a locked one). */
export function visibleStep(chosen: StepNumber | null, p: StepProgress): StepNumber {
  const last = lastOpenStep(p);
  return Math.min(chosen ?? suggestedStep(p), last) as StepNumber;
}

export function stepIsComplete(n: StepNumber, p: StepProgress): boolean {
  return n === 1 ? p.hasLecture || p.hasTranscript : n === 2 ? p.hasTranscript : p.hasMaterials;
}

/** How the progress list labels a step: the one on screen, a finished one, one ready to open, or one not open yet. */
export function stepState(n: StepNumber, shown: StepNumber, p: StepProgress): StepState {
  if (n === shown) return "current";
  if (stepIsComplete(n, p)) return "done";
  return n <= lastOpenStep(p) ? "open" : "locked";
}
