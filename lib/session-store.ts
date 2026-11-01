// Browser-only: keeps the current lecture session in IndexedDB so a page refresh doesn't lose work.
// IndexedDB (not localStorage) because the audio Blob and image data URL can be several MB.
// Every call swallows errors: private windows or blocked storage just mean nothing is saved.
import type { Turn } from "./audio-client";
import type { DiagramResult } from "./diagram";
import type { PreparedImage } from "./image-client";
import type { GenerateResult } from "./materials";

/** Audio larger than this isn't saved (the transcript still is). */
const MAX_SAVED_AUDIO_BYTES = 100 * 1024 * 1024;

export type SavedSession = {
  version: 1;
  audio: { blob: Blob; label: string } | null;
  keywords: string;
  lesson: { subject: string; grade: string; objective: string; standards: string };
  turns: Turn[];
  durationMs: number;
  refImage: (PreparedImage & { name: string }) | null;
  diagram: DiagramResult | null;
  result: GenerateResult | null;
  resultDiagram: { image: string; result: DiagramResult } | null;
};

const DB = "lecture-studio";
const STORE = "session";
const KEY = "current";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  try {
    const db = await open();
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(req.result as T); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    });
  } catch (err) {
    console.warn("[session-store]", err);
    return undefined;
  }
}

export async function loadSession(): Promise<SavedSession | null> {
  const s = await run<SavedSession>("readonly", (store) => store.get(KEY));
  return s && s.version === 1 ? s : null;
}

export async function saveSession(s: SavedSession): Promise<void> {
  const audio = s.audio && s.audio.blob.size <= MAX_SAVED_AUDIO_BYTES ? s.audio : null;
  await run("readwrite", (store) => store.put({ ...s, audio }, KEY));
}

export async function clearSession(): Promise<void> {
  await run("readwrite", (store) => store.delete(KEY));
}
