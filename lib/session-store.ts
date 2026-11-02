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
};

const DB = "lecture-studio";
const STORE = "session";
const KEY = "current";
const AUDIO_KEY = "audio";

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
  const loaded = await run<SavedSession>("load", "readonly", (store) => store.get(KEY));
  if (!loaded.ok) return loaded;
  const s = loaded.value;
  if (!s || s.version !== 1) return { ok: true, value: null };
  if (s.audioRevision === null) return { ok: true, value: { ...s, audio: null } };
  // Older saves kept the audio inside the session record.
  const audioLoad = await run<SavedAudio>("load audio", "readonly", (store) => store.get(AUDIO_KEY));
  if (!audioLoad.ok) return { ok: true, value: { ...s, audio: null }, warning: "The lecture loaded, but its saved audio could not be read." };
  const stored = audioLoad.value ?? s.audio ?? null;
  if (s.audioRevision && stored?.revision !== s.audioRevision) {
    return { ok: true, value: { ...s, audio: null }, warning: "The saved audio did not match this lecture and was not restored." };
  }
  let audio: SavedAudio | null = null;
  if (stored) {
    try {
      // Copy into memory: Chrome can't re-store a Blob that is still backed by an IndexedDB file ("UnknownError").
      audio = { label: stored.label, revision: stored.revision, blob: new Blob([await stored.blob.arrayBuffer()], { type: stored.blob.type }) };
    } catch (err) {
      console.warn("[session-store] saved audio unreadable:", err);
      return { ok: true, value: { ...s, audio: null }, warning: "The lecture loaded, but its saved audio was unreadable." };
    }
  }
  return { ok: true, value: { ...s, audio } };
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
