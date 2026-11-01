// Browser-only: keeps the current lecture session in IndexedDB so a page refresh doesn't lose work.
// IndexedDB (not localStorage) because the audio Blob and image data URL can be several MB.
// Every call swallows errors: private windows or blocked storage just mean nothing is saved.
import type { Turn } from "./audio-client";
import type { DiagramResult } from "./diagram";
import type { PreparedImage } from "./image-client";
import type { GenerateResult } from "./materials";

/** Audio larger than this isn't saved (the transcript still is). */
const MAX_SAVED_AUDIO_BYTES = 100 * 1024 * 1024;

export type SavedAudio = { blob: Blob; label: string };

export type SavedSession = {
  version: 1;
  /** Stored under its own key (see saveAudio) and attached by loadSession. */
  audio?: SavedAudio | null;
  keywords: string;
  lesson: { subject: string; grade: string; objective: string; standards: string };
  turns: Turn[];
  durationMs: number;
  refImage: (PreparedImage & { name: string }) | null;
  diagram: DiagramResult | null;
  result: GenerateResult | null;
  resultDiagram: { image: string; result: DiagramResult } | null;
  /** Privacy Mode toggle (added Oct 31; older saves lack it). */
  privacy?: boolean;
};

const DB = "lecture-studio";
const STORE = "session";
const KEY = "current";
const AUDIO_KEY = "audio";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(op: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  try {
    const db = await open();
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(req.result as T); };
      // During an error event tx.error is still null — the cause is on the request.
      tx.onerror = tx.onabort = () => { db.close(); reject(req.error ?? tx.error ?? new Error("transaction aborted")); };
    });
  } catch (err) {
    console.warn(`[session-store] ${op} failed:`, err instanceof Error ? `${err.name}: ${err.message}` : err);
    return undefined;
  }
}

export async function loadSession(): Promise<SavedSession | null> {
  const s = await run<SavedSession>("load", "readonly", (store) => store.get(KEY));
  if (!s || s.version !== 1) return null;
  // Older saves kept the audio inside the session record.
  const stored = (await run<SavedAudio>("load audio", "readonly", (store) => store.get(AUDIO_KEY))) ?? s.audio ?? null;
  let audio: SavedAudio | null = null;
  if (stored) {
    try {
      // Copy into memory: Chrome can't re-store a Blob that is still backed by an IndexedDB file ("UnknownError").
      audio = { label: stored.label, blob: new Blob([await stored.blob.arrayBuffer()], { type: stored.blob.type }) };
    } catch (err) {
      console.warn("[session-store] saved audio unreadable:", err);
    }
  }
  return { ...s, audio };
}

/** Session without the audio — small, so it's fine to save after every change. */
export async function saveSession(s: SavedSession): Promise<void> {
  await run("save", "readwrite", (store) => store.put({ ...s, audio: undefined }, KEY));
}

/** Audio is saved only when it changes (it can be tens of MB). */
export async function saveAudio(a: SavedAudio | null): Promise<void> {
  if (a && a.blob.size <= MAX_SAVED_AUDIO_BYTES) await run("save audio", "readwrite", (store) => store.put(a, AUDIO_KEY));
  else await run("clear audio", "readwrite", (store) => store.delete(AUDIO_KEY));
}

export async function clearSession(): Promise<void> {
  await run("clear", "readwrite", (store) => store.delete(KEY));
  await run("clear audio", "readwrite", (store) => store.delete(AUDIO_KEY));
}
