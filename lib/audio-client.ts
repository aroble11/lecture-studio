// Browser-side audio pipeline: decode any recording/upload to 24 kHz mono, split it into
// ~60 s chunks at quiet moments, send chunks to /api/transcribe in parallel, and merge the
// turns back onto one lecture-wide timeline.

import { ASR } from "./config";

export const SAMPLE_RATE = ASR.sampleRate;

const CHUNK_TARGET_S = 60;
const CHUNK_MIN_S = 45;
/** 75 s of PCM16 = 3.6 MB, under the route's 4 MB cap (Vercel's limit is 4.5 MB). */
const CHUNK_MAX_S = 75;
const FRAME_S = 0.1;
/** Cut inside the quietest run of this many frames (0.5 s). */
const PAUSE_FRAMES = 5;

export type Turn = { startMs: number; endMs: number; text: string };
export type Chunk = { start: number; end: number }; // sample indexes

/** Decode a recording or upload to mono Float32 samples at 24 kHz. */
export async function decodeToMono(blob: Blob): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer();
  // decodeAudioData resamples to the context's rate, so ask for 24 kHz directly.
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    const audio = await ctx.decodeAudioData(bytes);
    if (audio.numberOfChannels === 1) return audio.getChannelData(0);
    const out = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const data = audio.getChannelData(c);
      for (let i = 0; i < data.length; i++) out[i] += data[i];
    }
    const n = audio.numberOfChannels;
    for (let i = 0; i < out.length; i++) out[i] /= n;
    return out;
  } finally {
    void ctx.close();
  }
}

function frameEnergy(samples: Float32Array, start: number, len: number): number {
  let sum = 0;
  const end = Math.min(start + len, samples.length);
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  return sum / Math.max(1, end - start);
}

/** Split into chunks of 45–75 s. Each cut goes in the middle of the quietest half-second
 *  near the 60 s mark, so it lands in a real pause between sentences — not a short gap
 *  between words or digits (a 100 ms window split "8.8.8.8" in an Oct 31 test). */
export function planChunks(samples: Float32Array): Chunk[] {
  const rate = SAMPLE_RATE;
  const frame = Math.round(FRAME_S * rate);
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < samples.length) {
    if (samples.length - start <= CHUNK_MAX_S * rate) {
      chunks.push({ start, end: samples.length });
      break;
    }
    // Energy of each 100 ms frame in the search window, then a sliding sum over PAUSE_FRAMES.
    const first = start + CHUNK_MIN_S * rate;
    const count = Math.floor(((CHUNK_MAX_S - CHUNK_MIN_S) * rate) / frame);
    const energy = Array.from({ length: count }, (_, k) => frameEnergy(samples, first + k * frame, frame));
    const target = start + CHUNK_TARGET_S * rate;
    let best = target;
    let bestScore = Infinity;
    for (let k = 0; k + PAUSE_FRAMES <= count; k++) {
      let sum = 0;
      for (let j = 0; j < PAUSE_FRAMES; j++) sum += energy[k + j];
      const mid = first + k * frame + Math.floor((PAUSE_FRAMES * frame) / 2);
      // Small bias toward the 60 s target so equal pauses don't drift to the edges.
      const score = sum * (1 + 0.25 * (Math.abs(mid - target) / (rate * 15)));
      if (score < bestScore) { bestScore = score; best = mid; }
    }
    chunks.push({ start, end: best });
    start = best;
  }
  return chunks;
}

function toPcm16(samples: Float32Array, chunk: Chunk): ArrayBuffer {
  const out = new Int16Array(chunk.end - chunk.start);
  for (let i = 0; i < out.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[chunk.start + i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

async function transcribeChunk(pcm: ArrayBuffer, keywords: string[], signal?: AbortSignal): Promise<Turn[]> {
  const qs = keywords.map((k) => "kw=" + encodeURIComponent(k)).join("&");
  const deadline = new AbortController();
  const onAbort = () => deadline.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => deadline.abort(new DOMException("Transcription timed out", "TimeoutError")), ASR.clientChunkTimeoutMs);
  try {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`/api/transcribe${qs ? "?" + qs : ""}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: pcm,
        signal: deadline.signal,
      });
      if (res.ok) return ((await res.json()) as { turns: Turn[] }).turns;
      // Client errors won't fix themselves; server/upstream errors get one retry within the same total deadline.
      if (res.status < 500 || attempt >= 2) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Transcription failed (HTTP ${res.status})`);
      }
    }
  } catch (err) {
    if (deadline.signal.reason instanceof DOMException && deadline.signal.reason.name === "TimeoutError") {
      throw new Error("Transcription timed out — try again");
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export type Progress = { done: number; total: number };

/** Transcribe all chunks (up to `concurrency` at once) and return turns on the lecture timeline. */
export async function transcribeLecture(
  samples: Float32Array,
  keywords: string[],
  opts: { concurrency?: number; onProgress?: (p: Progress) => void; signal?: AbortSignal } = {},
): Promise<Turn[]> {
  const chunks = planChunks(samples);
  const results: Turn[][] = new Array(chunks.length);
  let next = 0;
  let done = 0;
  opts.onProgress?.({ done, total: chunks.length });

  const group = new AbortController();
  const onAbort = () => group.abort(opts.signal?.reason);
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });
  let failed = false;
  async function worker() {
    while (!failed && next < chunks.length) {
      const i = next++;
      const chunk = chunks[i];
      const offsetMs = Math.round((chunk.start / SAMPLE_RATE) * 1000);
      try {
        const turns = await transcribeChunk(toPcm16(samples, chunk), keywords, group.signal);
        results[i] = turns.map((t) => ({
          text: tidy(t.text),
          startMs: t.startMs + offsetMs,
          endMs: t.endMs + offsetMs,
        }));
      } catch (err) {
        failed = true; // stop other workers from starting new chunks
        group.abort(err);
        throw err;
      }
      opts.onProgress?.({ done: ++done, total: chunks.length });
    }
  }

  const workers = Math.min(opts.concurrency ?? ASR.concurrency, chunks.length);
  try {
    await Promise.all(Array.from({ length: workers }, worker));
    return results.flat();
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** The ASR sometimes returns a whole turn in lowercase: capitalize the first letter and the
 *  first letter after ". ", "? " or "! ". Leaves "example.com" and "8.8.8.8" alone (no space). */
export function tidy(text: string): string {
  return text
    .trim()
    .replace(/^[a-z]/, (c) => c.toUpperCase())
    .replace(/([.!?]\s+)([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());
}

export function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
