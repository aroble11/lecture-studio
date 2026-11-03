// Browser-only: keeps the current lecture session in IndexedDB so a page refresh doesn't lose work.
// IndexedDB (not localStorage) because the audio Blob and image data URL can be several MB.
// Storage failures are returned to the UI so it never claims unsaved work is safe.
import type { Turn } from "./audio-client";
import type { DiagramResult } from "./diagram";
import type { PreparedImage } from "./image-client";
import type { GenerateResult, LessonContext } from "./materials";

/** Audio larger than this isn't saved (the transcript still is). */
export const MAX_SAVED_AUDIO_BYTES = 100 * 1024 * 1024;

export type SavedAudio = { blob: Blob; label: string; /** Missing on legacy saves. */ revision?: string };
export type ResultSource = { turns: Turn[]; durationMs: number; context: LessonContext };
/** A whiteboard frame the teacher kept from a class video. `diagram` is null until labeling finishes (or if it failed). */
export type BoardMoment = { timeMs: number; image: PreparedImage; diagram: DiagramResult | null };
/** Most whiteboard moments a lecture keeps (each is one labeling request). */
export const MAX_BOARD_MOMENTS = 4;

export type SavedSession = {
  version: 1;
  /** Stored under its own key (see saveAudio) and attached by loadSession. */
  audio?: SavedAudio | null;
  /** The audio record that belongs to this session. Missing on legacy saves. */
  audioRevision?: string | null;
  keywords: string;
  lesson: { subject: string; grade: string; objective: string; standards: string };
  turns: Turn[];
  durationMs: number;
  refImage: (PreparedImage & { name: string }) | null;
  diagram: DiagramResult | null;
  result: GenerateResult | null;
  /** Exact transcript and lesson inputs used to produce result. Older saves may lack it. */
  resultSource?: ResultSource | null;
  resultDiagram: { image: string; result: DiagramResult } | null;
  /** Open-weight generation toggle (legacy property name retained for compatibility). */
  privacy?: boolean;
  /** Whiteboard moments kept from a class video. Missing on older saves. */
  boardMoments?: BoardMoment[];
};

const DB = "lecture-studio";
const STORE = "session";
const KEY = "current";
const AUDIO_KEY = "audio";
const MAX_DURATION_MS = 90 * 60_000;
const MAX_TRANSCRIPT_CHARS = 120_000;

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} is invalid`);
  return value as Record<string, unknown>;
}
function string(value: unknown, field: string, max: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.length > max) throw new Error(`${field} is invalid`);
  return value;
}
function number(value: unknown, field: string, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}
function array(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${field} is invalid`);
  return value;
}

function cleanTurns(value: unknown, field = "turns"): Turn[] {
  let previous = -1;
  let total = 0;
  return array(value, field, 10_000).map((entry, i) => {
    const turn = record(entry, `${field}[${i}]`);
    const startMs = number(turn.startMs, `${field}[${i}].startMs`, 0, MAX_DURATION_MS);
    const endMs = number(turn.endMs, `${field}[${i}].endMs`, startMs, MAX_DURATION_MS);
    if (startMs < previous) throw new Error(`${field} is not ordered`);
    previous = startMs;
    const text = string(turn.text, `${field}[${i}].text`, 12_000)!;
    if (!text.trim()) throw new Error(`${field}[${i}].text is empty`);
    total += text.length;
    if (total > MAX_TRANSCRIPT_CHARS) throw new Error(`${field} is too large`);
    return { startMs, endMs, text };
  });
}

function cleanContext(value: unknown, field: string): LessonContext {
  const context = record(value, field);
  const vocabulary = context.vocabulary === undefined ? undefined : array(context.vocabulary, `${field}.vocabulary`, 50)
    .map((term, i) => string(term, `${field}.vocabulary[${i}]`, 80)!);
  return {
    subject: string(context.subject, `${field}.subject`, 100, true), grade: string(context.grade, `${field}.grade`, 50, true),
    objective: string(context.objective, `${field}.objective`, 500, true), standards: string(context.standards, `${field}.standards`, 500, true),
    style: string(context.style, `${field}.style`, 600, true), classNotes: string(context.classNotes, `${field}.classNotes`, 600, true), vocabulary,
  };
}

function cleanImage(value: unknown, field: string): PreparedImage & { name: string } {
  const image = record(value, field);
  const dataUrl = string(image.dataUrl, `${field}.dataUrl`, 4_000_000)!;
  if (!/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/]+=*$/i.test(dataUrl)) throw new Error(`${field}.dataUrl is invalid`);
  return { dataUrl, width: number(image.width, `${field}.width`, 1, 1600, true), height: number(image.height, `${field}.height`, 1, 1600, true), name: string(image.name, `${field}.name`, 300)! };
}

function cleanBoardMoments(value: unknown): BoardMoment[] {
  let previous = -1;
  return array(value, "boardMoments", MAX_BOARD_MOMENTS).map((entry, i) => {
    const moment = record(entry, `boardMoments[${i}]`);
    const timeMs = number(moment.timeMs, `boardMoments[${i}].timeMs`, 0, MAX_DURATION_MS);
    if (timeMs <= previous) throw new Error("boardMoments is not ordered");
    previous = timeMs;
    const { name: _name, ...image } = cleanImage({ ...record(moment.image, `boardMoments[${i}].image`), name: "board" }, `boardMoments[${i}].image`);
    void _name;
    return { timeMs, image, diagram: moment.diagram === null || moment.diagram === undefined ? null : cleanDiagram(moment.diagram, `boardMoments[${i}].diagram`) };
  });
}

function cleanDiagram(value: unknown, field: string): DiagramResult {
  const diagram = record(value, field);
  if (diagram.kind !== "objects" && diagram.kind !== "mostly_text") throw new Error(`${field}.kind is invalid`);
  const seen = new Set<number>();
  const items = array(diagram.items, `${field}.items`, 6).map((entry, i) => {
    const item = record(entry, `${field}.items[${i}]`);
    const n = number(item.n, `${field}.items[${i}].n`, 1, 6, true);
    if (seen.has(n)) throw new Error(`${field}.items has duplicate numbers`);
    seen.add(n);
    const box = record(item.box, `${field}.items[${i}].box`);
    const x1 = number(box.x1, `${field}.items[${i}].box.x1`, 0, 1000);
    const y1 = number(box.y1, `${field}.items[${i}].box.y1`, 0, 1000);
    return {
      n, label: string(item.label, `${field}.items[${i}].label`, 80)!, phrase: string(item.phrase, `${field}.items[${i}].phrase`, 200)!,
      box: { x1, y1, x2: number(box.x2, `${field}.items[${i}].box.x2`, x1, 1000), y2: number(box.y2, `${field}.items[${i}].box.y2`, y1, 1000) },
      score: number(item.score, `${field}.items[${i}].score`, 0, 1),
    };
  });
  return { kind: diagram.kind, summary: string(diagram.summary, `${field}.summary`, 300)!, items, model: string(diagram.model, `${field}.model`, 200)!, seconds: number(diagram.seconds, `${field}.seconds`, 0, 3600) };
}

function cleanMaterials(value: unknown, field: string, turns: Turn[], diagram: DiagramResult | null): GenerateResult["materials"] {
  const materials = record(value, field);
  const guided = record(materials.guidedNotes, `${field}.guidedNotes`);
  const textArray = (input: unknown, path: string, max: number) => array(input, path, max).map((entry, i) => string(entry, `${path}[${i}]`, 4000)!);
  const sections = array(guided.sections, `${field}.guidedNotes.sections`, 6).map((entry, i) => {
    const section = record(entry, `${field}.guidedNotes.sections[${i}]`);
    const items = array(section.items, `${field}.guidedNotes.sections[${i}].items`, 6).map((item, j) => {
      const note = record(item, `${field}.guidedNotes.sections[${i}].items[${j}]`);
      return { text: string(note.text, `${field}.guidedNotes.sections[${i}].items[${j}].text`, 4000)!, answer: string(note.answer, `${field}.guidedNotes.sections[${i}].items[${j}].answer`, 200)! };
    });
    if (!items.length) throw new Error(`${field}.guidedNotes.sections[${i}].items is empty`);
    return { heading: string(section.heading, `${field}.guidedNotes.sections[${i}].heading`, 200)!, startSec: number(section.startSec, `${field}.guidedNotes.sections[${i}].startSec`, 0, MAX_DURATION_MS / 1000, true), items };
  });
  if (!sections.length) throw new Error(`${field}.guidedNotes.sections is empty`);
  const quiz = array(materials.quiz, `${field}.quiz`, 5).map((entry, i) => {
    const q = record(entry, `${field}.quiz[${i}]`);
    const choices = textArray(q.choices, `${field}.quiz[${i}].choices`, 4);
    if (choices.length !== 4) throw new Error(`${field}.quiz[${i}].choices is invalid`);
    return { question: string(q.question, `${field}.quiz[${i}].question`, 4000)!, choices, answerIndex: number(q.answerIndex, `${field}.quiz[${i}].answerIndex`, 0, 3, true), explanation: string(q.explanation, `${field}.quiz[${i}].explanation`, 4000)! };
  });
  if (quiz.length !== 5) throw new Error(`${field}.quiz is invalid`);
  const exitTicket = array(materials.exitTicket, `${field}.exitTicket`, 2).map((entry, i) => {
    const ticket = record(entry, `${field}.exitTicket[${i}]`);
    return { question: string(ticket.question, `${field}.exitTicket[${i}].question`, 4000)!, sampleAnswer: string(ticket.sampleAnswer, `${field}.exitTicket[${i}].sampleAnswer`, 4000)! };
  });
  if (!exitTicket.length) throw new Error(`${field}.exitTicket is empty`);
  const bell = record(materials.bellRinger, `${field}.bellRinger`);
  const diagramNotes = array(materials.diagramNotes, `${field}.diagramNotes`, 6).map((entry, i) => {
    const note = record(entry, `${field}.diagramNotes[${i}]`);
    return { n: number(note.n, `${field}.diagramNotes[${i}].n`, 1, 6, true), note: string(note.note, `${field}.diagramNotes[${i}].note`, 4000)! };
  });
  const expected = new Set(diagram?.items.map((item) => item.n) ?? []);
  if (diagramNotes.length !== expected.size || diagramNotes.some((note) => !expected.has(note.n))) throw new Error(`${field}.diagramNotes is invalid`);
  const endSec = Math.ceil(Math.max(0, ...turns.map((turn) => turn.endMs)) / 1000);
  const contentGaps = array(materials.contentGaps, `${field}.contentGaps`, 4).map((entry, i) => {
    const gap = record(entry, `${field}.contentGaps[${i}]`);
    return { concept: string(gap.concept, `${field}.contentGaps[${i}].concept`, 4000)!, atSec: number(gap.atSec, `${field}.contentGaps[${i}].atSec`, 0, endSec, true), issue: string(gap.issue, `${field}.contentGaps[${i}].issue`, 4000)!, suggestion: string(gap.suggestion, `${field}.contentGaps[${i}].suggestion`, 4000)! };
  });
  return {
    guidedNotes: { title: string(guided.title, `${field}.guidedNotes.title`, 200)!, sections, wordBank: textArray(guided.wordBank, `${field}.guidedNotes.wordBank`, 36) },
    quiz, exitTicket,
    bellRinger: { prompt: string(bell.prompt, `${field}.bellRinger.prompt`, 4000)!, teacherNote: string(bell.teacherNote, `${field}.bellRinger.teacherNote`, 4000)! },
    diagramNotes, pacingFeedback: textArray(materials.pacingFeedback, `${field}.pacingFeedback`, 3), contentGaps,
  };
}

function cleanResult(value: unknown, field: string, turns: Turn[], diagram: DiagramResult | null): GenerateResult {
  const result = record(value, field);
  if (result.privacy !== undefined && typeof result.privacy !== "boolean") throw new Error(`${field}.privacy is invalid`);
  return { materials: cleanMaterials(result.materials, `${field}.materials`, turns, diagram), model: string(result.model, `${field}.model`, 200)!, seconds: number(result.seconds, `${field}.seconds`, 0, 3600), privacy: result.privacy === true };
}

function cleanSavedAudio(value: unknown): SavedAudio {
  const audio = record(value, "audio");
  if (!(audio.blob instanceof Blob)) throw new Error("audio.blob is invalid");
  return {
    blob: audio.blob,
    label: string(audio.label, "audio.label", 300)!,
    revision: string(audio.revision, "audio.revision", 128, true),
  };
}

/** Treat browser persistence as untrusted input. Valid core lecture data is migrated; damaged optional artifacts are dropped. */
export function validateSavedSession(value: unknown): { session: SavedSession; warning?: string } {
  const source = record(value, "saved session");
  if (source.version !== 1) throw new Error("saved session version is unsupported");
  const lessonValue = record(source.lesson, "lesson");
  const turns = cleanTurns(source.turns);
  const lastEnd = Math.max(0, ...turns.map((turn) => turn.endMs));
  const durationMs = Math.max(lastEnd, number(source.durationMs, "durationMs", 0, MAX_DURATION_MS));
  const warnings: string[] = [];
  const optional = <T>(name: string, input: unknown, clean: (v: unknown) => T): T | null => {
    if (input === undefined || input === null) return null;
    try { return clean(input); } catch { warnings.push(name); return null; }
  };
  const refImage = optional("reference image", source.refImage, (v) => cleanImage(v, "refImage"));
  const diagram = refImage ? optional("image labels", source.diagram, (v) => cleanDiagram(v, "diagram")) : null;
  const resultDiagram = optional("generated-material image", source.resultDiagram, (v) => {
    const saved = record(v, "resultDiagram");
    const image = string(saved.image, "resultDiagram.image", 4_000_000)!;
    if (!/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/]+=*$/i.test(image)) throw new Error("resultDiagram.image is invalid");
    return { image, result: cleanDiagram(saved.result, "resultDiagram.result") };
  });
  const result = optional("generated materials", source.result, (v) => cleanResult(v, "result", turns, resultDiagram?.result ?? diagram));
  const resultSource = result ? optional("material source snapshot", source.resultSource, (v) => {
    const saved = record(v, "resultSource");
    const sourceTurns = cleanTurns(saved.turns, "resultSource.turns");
    const sourceLastEnd = Math.max(0, ...sourceTurns.map((turn) => turn.endMs));
    return { turns: sourceTurns, durationMs: Math.max(sourceLastEnd, number(saved.durationMs, "resultSource.durationMs", 0, MAX_DURATION_MS)), context: cleanContext(saved.context, "resultSource.context") };
  }) : null;
  const audioRevision = source.audioRevision === undefined || source.audioRevision === null ? source.audioRevision as undefined | null : string(source.audioRevision, "audioRevision", 128)!;
  const audio = optional("legacy audio", source.audio, cleanSavedAudio);
  if (source.privacy !== undefined && typeof source.privacy !== "boolean") warnings.push("privacy preference");
  const boardMoments = optional("whiteboard moments", source.boardMoments, cleanBoardMoments) ?? [];
  return {
    session: {
      version: 1, audio, audioRevision, keywords: string(source.keywords, "keywords", 4_100)!,
      lesson: { subject: string(lessonValue.subject, "lesson.subject", 100)!, grade: string(lessonValue.grade, "lesson.grade", 50)!, objective: string(lessonValue.objective, "lesson.objective", 500)!, standards: string(lessonValue.standards, "lesson.standards", 500)! },
      turns, durationMs, refImage, diagram, result, resultSource, resultDiagram: result ? resultDiagram : null, privacy: source.privacy === true, boardMoments,
    },
    warning: warnings.length ? `The lecture was restored, but invalid saved ${warnings.join(", ")} ${warnings.length === 1 ? "was" : "were"} removed.` : undefined,
  };
}

export type StorageResult<T> = { ok: true; value: T } | { ok: false; error: string };
export type LoadSessionResult = StorageResult<SavedSession | null> & { warning?: string };
export type SaveAudioResult =
  | { ok: true }
  | { ok: false; reason: "too-large"; maxBytes: number }
  | { ok: false; reason: "error"; error: string };

function errorMessage(err: unknown) {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(op: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<StorageResult<T | undefined>> {
  try {
    const db = await open();
    const value = await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(req.result as T); };
      // During an error event tx.error is still null — the cause is on the request.
      tx.onerror = tx.onabort = () => { db.close(); reject(req.error ?? tx.error ?? new Error("transaction aborted")); };
    });
    return { ok: true, value };
  } catch (err) {
    const error = errorMessage(err);
    console.warn(`[session-store] ${op} failed:`, error);
    return { ok: false, error };
  }
}

export async function loadSession(): Promise<LoadSessionResult> {
  const loaded = await run<unknown>("load", "readonly", (store) => store.get(KEY));
  if (!loaded.ok) return loaded;
  if (!loaded.value) return { ok: true, value: null };
  let validated: ReturnType<typeof validateSavedSession>;
  try { validated = validateSavedSession(loaded.value); }
  catch (err) {
    console.warn("[session-store] saved session rejected:", errorMessage(err));
    return { ok: false, error: "Saved lecture data is invalid. Retry save to replace it, or clear this site's browser data." };
  }
  const s = validated.session;
  const sessionWarning = validated.warning;
  if (s.audioRevision === null) return { ok: true, value: { ...s, audio: null }, warning: sessionWarning };
  // Older saves kept the audio inside the session record.
  const audioLoad = await run<SavedAudio>("load audio", "readonly", (store) => store.get(AUDIO_KEY));
  if (!audioLoad.ok) return { ok: true, value: { ...s, audio: null }, warning: sessionWarning ?? "The lecture loaded, but its saved audio could not be read." };
  const stored = audioLoad.value ?? s.audio ?? null;
  if (s.audioRevision && stored?.revision !== s.audioRevision) {
    return { ok: true, value: { ...s, audio: null }, warning: sessionWarning ?? "The saved audio did not match this lecture and was not restored." };
  }
  let audio: SavedAudio | null = null;
  if (stored) {
    try {
      // Copy into memory: Chrome can't re-store a Blob that is still backed by an IndexedDB file ("UnknownError").
      cleanSavedAudio(stored);
      audio = { label: stored.label, revision: stored.revision, blob: new Blob([await stored.blob.arrayBuffer()], { type: stored.blob.type }) };
    } catch (err) {
      console.warn("[session-store] saved audio unreadable:", err);
      return { ok: true, value: { ...s, audio: null }, warning: "The lecture loaded, but its saved audio was unreadable." };
    }
  }
  return { ok: true, value: { ...s, audio }, warning: sessionWarning };
}

/** Session without the audio — small, so it's fine to save after every change. */
export async function saveSession(s: SavedSession): Promise<StorageResult<undefined>> {
  const result = await run("save", "readwrite", (store) => store.put({ ...s, audio: undefined }, KEY));
  return result.ok ? { ok: true, value: undefined } : result;
}

/** Audio is saved only when it changes (it can be tens of MB). */
export async function saveAudio(a: SavedAudio | null): Promise<SaveAudioResult> {
  if (a && a.blob.size > MAX_SAVED_AUDIO_BYTES) {
    const cleared = await run("clear oversized audio", "readwrite", (store) => store.delete(AUDIO_KEY));
    if (!cleared.ok) return { ok: false, reason: "error", error: cleared.error };
    return { ok: false, reason: "too-large", maxBytes: MAX_SAVED_AUDIO_BYTES };
  }
  const result = await run(a ? "save audio" : "clear audio", "readwrite", (store) => a ? store.put(a, AUDIO_KEY) : store.delete(AUDIO_KEY));
  return result.ok ? { ok: true } : { ok: false, reason: "error", error: result.error };
}

export async function clearSession(): Promise<StorageResult<undefined>> {
  const session = await run("clear", "readwrite", (store) => store.delete(KEY));
  const audio = await run("clear audio", "readwrite", (store) => store.delete(AUDIO_KEY));
  if (!session.ok) return session;
  if (!audio.ok) return audio;
  return { ok: true, value: undefined };
}
