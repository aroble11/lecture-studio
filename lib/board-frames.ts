// Whiteboard moments: skim a class video locally, score how much writing is on the board, and suggest the
// fullest board before each erase plus the final board. Nothing here calls a provider; only the frames the
// teacher keeps are later sent for labeling.
import { prepareImage, type PreparedImage } from "./image-client";

export type PatchOptions = { block?: number; brightMin?: number; boardShare?: number; darkBy?: number; minInk?: number };

/** Patch states: -1 hidden (person, wall, furniture), 0 clean board, 1 board with writing. */
export const HIDDEN = -1, CLEAN = 0, WRITTEN = 1;

/**
 * Split a frame into square patches. A patch counts as board only when it is mostly bright; within it, pixels
 * clearly darker than the board are marker. Anything else (a person in a patterned shirt, the wall) is hidden.
 */
export function patchStates(rgba: ArrayLike<number>, width: number, height: number, options: PatchOptions = {}): Int8Array {
  const { minInk = 3 } = options;
  return Int8Array.from(patchInk(rgba, width, height, options), (dark) => (dark < 0 ? HIDDEN : dark >= minInk ? WRITTEN : CLEAN));
}

/** Marker pixels in each patch (-1 when the patch isn't board). */
export function patchInk(rgba: ArrayLike<number>, width: number, height: number, { block = 16, brightMin = 150, boardShare = 0.75, darkBy = 30 }: PatchOptions = {}): Int16Array {
  const cols = Math.floor(width / block), rows = Math.floor(height / block);
  const states = new Int16Array(cols * rows);
  const gray = (x: number, y: number) => { const i = (y * width + x) * 4; return 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]; };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let bright = 0, brightSum = 0;
      for (let y = r * block; y < (r + 1) * block; y++) for (let x = c * block; x < (c + 1) * block; x++) {
        const g = gray(x, y);
        if (g >= brightMin) { bright++; brightSum += g; }
      }
      if (bright < boardShare * block * block) { states[r * cols + c] = -1; continue; }
      const cutoff = brightSum / bright - darkBy;
      let dark = 0;
      for (let y = r * block; y < (r + 1) * block; y++) for (let x = c * block; x < (c + 1) * block; x++) if (gray(x, y) < cutoff) dark++;
      states[r * cols + c] = dark;
    }
  }
  return states;
}

export type BoardFrame = { timeMs: number; states: Int8Array };
export type BoardMomentOptions = { max?: number; eraseShare?: number; minFullness?: number; minGapMs?: number };

/**
 * Suggest one moment per board: the fullest board just before each erase, plus the final board.
 *
 * The board has a memory: a hidden patch (someone in front of it) keeps its last seen state, so standing in front
 * of the board isn't an erase. An erase is a step where a large share (`eraseShare`) of the remembered writing is
 * seen clean again; ordinary flicker stays well below that. Within each board, among frames holding at least 85% of
 * its writing, the one showing the most board wins. Boards with little writing (`minFullness` of the fullest
 * board) are skipped, moments closer than `minGapMs` keep the fuller one, and at most `max` are returned.
 */
export function pickBoardMoments(frames: BoardFrame[], options: BoardMomentOptions = {}): number[] {
  return pickBoards(frames, options).map((m) => m.timeMs);
}

/** A suggested moment and when its board began (just after the previous erase). */
export type BoardPick = { timeMs: number; sinceMs: number };

export function pickBoards(frames: BoardFrame[], { max = 6, eraseShare = 0.3, minFullness = 0.4, minGapMs = 20_000 }: BoardMomentOptions = {}): BoardPick[] {
  if (!frames.length) return [];
  const patches = frames[0].states.length;
  const minErased = Math.max(4, Math.round(patches * 0.01));
  const memory = new Int8Array(patches).fill(CLEAN);
  let written = 0;

  type Point = { timeMs: number; written: number; visible: number };
  const boards: Point[][] = [[]];
  for (const { timeMs, states } of frames) {
    const before = written;
    let erased = 0, hidden = 0;
    for (let i = 0; i < patches; i++) {
      const now = states[i];
      if (now === HIDDEN) { hidden++; continue; }
      if (memory[i] === WRITTEN && now === CLEAN) { erased++; written--; }
      if (memory[i] !== WRITTEN && now === WRITTEN) written++;
      memory[i] = now;
    }
    if (erased >= minErased && erased >= before * eraseShare) boards.push([]);
    boards[boards.length - 1].push({ timeMs, written, visible: 1 - hidden / patches });
  }

  const fullest = Math.max(...boards.flat().map((p) => p.written));
  if (!(fullest > 0)) return [];
  const candidates = boards.filter((b) => b.length).map((board) => {
    const peak = Math.max(...board.map((p) => p.written));
    // Any frame holding 85% of the board's writing qualifies; the clearest view wins (later on a near-tie).
    const near = board.filter((p) => p.written >= peak * 0.85);
    const chosen = near.reduce((a, b) => (b.visible > a.visible + 0.02 || (b.visible >= a.visible - 0.02 && b.written >= a.written) ? b : a));
    return { timeMs: chosen.timeMs, sinceMs: board[0].timeMs, written: peak };
  }).filter((c) => c.written >= fullest * minFullness);

  const spaced: typeof candidates = [];
  for (const c of candidates) {
    const last = spaced.at(-1);
    if (last && c.timeMs - last.timeMs < minGapMs) {
      if (c.written > last.written) spaced[spaced.length - 1] = { ...c, sinceMs: Math.min(c.sinceMs, last.sinceMs) };
    } else {
      spaced.push(c);
    }
  }
  return spaced.sort((a, b) => b.written - a.written).slice(0, max).sort((a, b) => a.timeMs - b.timeMs).map(({ timeMs, sinceMs }) => ({ timeMs, sinceMs }));
}

// ---------- Lifting a drawing off the board ----------

/** The scan (640 px, 16-px patches) and the lift (1280 px, 32-px patches) share one patch grid. */
export const SCAN_WIDTH = 640, SCAN_BLOCK = 16, LIFT_WIDTH = 1280, LIFT_BLOCK = 32;

/** Frames used to see around a person, nearest first: back to when this board began (at most 30 s), and only a
 * moment ahead, because the board may be erased next. */
export function liftTimes(timeMs: number, durationMs: number, sinceMs = timeMs - 30_000): number[] {
  const offsets = [0, 1_000, -1_500, 2_500, -3_000, -4_500, -6_000, -8_000, -10_000, -12_500, -15_000, -18_000, -22_000, -26_000, -30_000];
  const earliest = Math.max(0, sinceMs, timeMs - 30_000);
  return offsets.map((o) => timeMs + o).filter((t) => t >= earliest && t <= durationMs - 50);
}

/**
 * Where the top edge of the board sits (the strongest dark-to-bright step going down the upper half, median of
 * eight column bands). Cameras with automatic framing zoom and pan as the teacher moves; frames whose edge has
 * moved don't line up and must not be combined.
 */
export function boardEdgeRow(rgba: ArrayLike<number>, width: number, height: number): number {
  const rows: number[] = [];
  for (let band = 0; band < 8; band++) {
    const x0 = Math.round(width * (0.1 + band * 0.1)), x1 = x0 + Math.round(width * 0.1);
    const mean: number[] = [];
    for (let y = 0; y < height / 2; y++) {
      let sum = 0;
      for (let x = x0; x < x1; x++) { const i = (y * width + x) * 4; sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]; }
      mean.push(sum / (x1 - x0));
    }
    let best = 0, at = 0;
    for (let y = 2; y < mean.length; y++) { const step = mean[y] - mean[y - 2]; if (step > best) { best = step; at = y; } }
    rows.push(at);
  }
  return rows.sort((a, b) => a - b)[4];
}

/** Half-size grayscale copy used for alignment checks. */
export function halfGray(rgba: ArrayLike<number>, width: number, height: number): Float32Array {
  const w = Math.floor(width / 2), h = Math.floor(height / 2);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const i = ((2 * y + dy) * width + 2 * x + dx) * 4;
      sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    }
    out[y * w + x] = sum / 4;
  }
  return out;
}

/**
 * The (dx, dy) shift, within ±`range` pixels, that best lines `b` up with `a` (both half-size grayscale), compared
 * only where `valid` marks board seen in both frames. (0, 0) means the camera didn't move.
 */
export function bestShift(a: Float32Array, b: Float32Array, width: number, height: number, valid: Uint8Array, range = 6): { dx: number; dy: number } {
  let best = { dx: 0, dy: 0 }, bestCost = Infinity;
  for (let dy = -range; dy <= range; dy++) for (let dx = -range; dx <= range; dx++) {
    let cost = 0, n = 0;
    for (let y = range; y < height - range; y++) for (let x = range; x < width - range; x++) {
      const i = y * width + x;
      if (!valid[i]) continue;
      cost += Math.abs(a[i] - b[(y + dy) * width + x + dx]);
      n++;
    }
    if (n && cost / n < bestCost - 1e-6) { bestCost = cost / n; best = { dx, dy }; }
  }
  return best;
}

/** Treat patches next to a person as hidden too, so the edge of a sleeve or hair is never mistaken for marker. */
export function growHidden(states: Int8Array, cols: number, rows: number): Int8Array {
  const out = Int8Array.from(states);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (states[r * cols + c] !== HIDDEN) continue;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) out[rr * cols + cc] = HIDDEN;
    }
  }
  return out;
}

/**
 * Patch rectangle (inclusive, with a one-patch margin) around the main drawing. Writing patches must have been
 * seen clean at some point (`everClean`), which leaves out the board's frame and tray.
 */
export function writingBounds(states: Int8Array, cols: number, rows: number, everClean?: Uint8Array | null): { c0: number; r0: number; c1: number; r1: number } | null {
  const isWriting = (i: number) => states[i] === WRITTEN && (!everClean || everClean[i] === 1);
  // Group writing into clusters (patches up to two apart belong together), then keep the main drawing:
  // the largest cluster plus any cluster at least a quarter its size. Lone patches and far-off signs drop out.
  const cluster = new Int32Array(cols * rows).fill(-1);
  const sizes: number[] = [];
  for (let start = 0; start < cols * rows; start++) {
    if (!isWriting(start) || cluster[start] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    const stack = [start];
    cluster[start] = id;
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      const r = Math.floor(i / cols), c = i % cols;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        const rr = r + dr, cc = c + dc, j = rr * cols + cc;
        if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && cluster[j] < 0 && isWriting(j)) { cluster[j] = id; stack.push(j); }
      }
    }
    sizes.push(size);
  }
  const largest = Math.max(0, ...sizes);
  if (largest < 3) return null;
  let c0 = cols, r0 = rows, c1 = -1, r1 = -1;
  for (let i = 0; i < cols * rows; i++) {
    if (cluster[i] < 0 || sizes[cluster[i]] < largest / 4) continue;
    const r = Math.floor(i / cols), c = i % cols;
    c0 = Math.min(c0, c); r0 = Math.min(r0, r); c1 = Math.max(c1, c); r1 = Math.max(r1, r);
  }
  return { c0: Math.max(0, c0 - 1), r0: Math.max(0, r0 - 1), c1: Math.min(cols - 1, c1 + 1), r1: Math.min(rows - 1, r1 + 1) };
}

/**
 * Marker on clean white: each pixel is compared with the board's own brightness around it (which also removes
 * glare from lights), faint differences become white, and real strokes keep their color, darkened for print.
 * Patches never seen (always hidden) come out white.
 */
export function cleanBoard(rgba: Uint8ClampedArray, width: number, height: number, block: number, states: Int8Array, { brightMin = 150, minDiff = 22, gain = 2.4 } = {}): Uint8ClampedArray<ArrayBuffer> {
  const cols = Math.floor(width / block), rows = Math.floor(height / block);
  const bg = new Float32Array(cols * rows * 3).fill(-1);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (states[r * cols + c] === HIDDEN) continue;
    let n = 0, sr = 0, sg = 0, sb = 0;
    for (let y = r * block; y < (r + 1) * block; y++) for (let x = c * block; x < (c + 1) * block; x++) {
      const i = (y * width + x) * 4;
      if (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2] >= brightMin) { n++; sr += rgba[i]; sg += rgba[i + 1]; sb += rgba[i + 2]; }
    }
    if (n) bg.set([sr / n, sg / n, sb / n], (r * cols + c) * 3);
  }
  const bgAt = (c: number, r: number, k: number) => {
    const cc = Math.min(cols - 1, Math.max(0, c)), rr = Math.min(rows - 1, Math.max(0, r));
    return bg[(rr * cols + cc) * 3 + k];
  };
  const out = new Uint8ClampedArray(rgba.length);
  for (let y = 0; y < height; y++) {
    const fy = (y - block / 2) / block, r0 = Math.floor(fy), ty = fy - r0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const c = Math.min(cols - 1, Math.floor(x / block)), r = Math.min(rows - 1, Math.floor(y / block));
      out[i + 3] = 255;
      if (states[r * cols + c] === HIDDEN || bg[(r * cols + c) * 3] < 0) { out[i] = out[i + 1] = out[i + 2] = 255; continue; }
      const fx = (x - block / 2) / block, c0 = Math.floor(fx), tx = fx - c0;
      const local = [0, 1, 2].map((k) => {
        const corners = [bgAt(c0, r0, k), bgAt(c0 + 1, r0, k), bgAt(c0, r0 + 1, k), bgAt(c0 + 1, r0 + 1, k)];
        const own = bg[(r * cols + c) * 3 + k];
        const [a, b2, d, e] = corners.map((v) => (v < 0 ? own : v));
        return (a * (1 - tx) + b2 * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
      });
      const diff = 0.299 * (local[0] - rgba[i]) + 0.587 * (local[1] - rgba[i + 1]) + 0.114 * (local[2] - rgba[i + 2]);
      if (diff < minDiff) { out[i] = out[i + 1] = out[i + 2] = 255; continue; }
      for (let k = 0; k < 3; k++) out[i + k] = 255 - Math.min(255, Math.max(0, (local[k] - rgba[i + k]) * gain));
    }
  }
  return out;
}

/** Snapshot spacing: every 5 s, or wider for long videos so a skim takes ~600 seeks at most. */
export function sampleSpacingMs(durationMs: number): number {
  return Math.max(5_000, Math.ceil(durationMs / 600 / 1000) * 1000);
}

/** The guided-notes section a moment belongs to: the last section that starts at or before it. */
export function sectionIndexForTime(sections: { startSec: number }[], timeMs: number): number {
  let index = -1;
  sections.forEach((s, i) => { if (s.startSec * 1000 <= timeMs + 1) index = i; });
  return Math.max(0, index);
}

// ---------- Browser-only: video seeking and frame capture ----------

export class BoardVideoError extends Error {}

type OpenVideo = { video: HTMLVideoElement; close: () => void };

async function openVideo(file: Blob): Promise<OpenVideo> {
  const video = document.createElement("video");
  const url = URL.createObjectURL(file);
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  const close = () => { video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new BoardVideoError("The video took too long to open.")), 15_000);
      video.onloadeddata = () => { clearTimeout(timer); resolve(); };
      video.onerror = () => { clearTimeout(timer); reject(new BoardVideoError("This browser can't show the picture in this video.")); };
    });
    if (!video.videoWidth || !video.videoHeight) throw new BoardVideoError("This browser can't show the picture in this video.");
    return { video, close };
  } catch (err) {
    close();
    throw err;
  }
}

function seek(video: HTMLVideoElement, timeMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { cleanup(); reject(new BoardVideoError("The video stopped responding while skimming.")); }, 10_000);
    const done = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(signal?.reason); };
    const cleanup = () => { clearTimeout(timer); video.removeEventListener("seeked", done); signal?.removeEventListener("abort", abort); };
    video.addEventListener("seeked", done, { once: true });
    signal?.addEventListener("abort", abort, { once: true });
    video.currentTime = Math.min(timeMs / 1000, Math.max(0, video.duration - 0.05));
  });
}

/** Skim the whole video locally and suggest whiteboard moments (times in ms). */
export async function suggestBoardMoments(file: Blob, { signal, onProgress }: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}): Promise<{ durationMs: number; moments: BoardPick[]; everClean: Uint8Array }> {
  const { video, close } = await openVideo(file);
  try {
    const durationMs = video.duration * 1000;
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new BoardVideoError("This video's length couldn't be read.");
    const width = SCAN_WIDTH; // thin marker strokes survive at this size
    const height = Math.max(2, Math.round((video.videoHeight / video.videoWidth) * width));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    if (!g) throw new BoardVideoError("This browser can't process video frames.");
    const step = sampleSpacingMs(durationMs);
    const frames: { timeMs: number; states: Int8Array }[] = [];
    for (let t = Math.min(1_000, durationMs / 2); t < durationMs; t += step) {
      await seek(video, t, signal);
      g.drawImage(video, 0, 0, width, height);
      frames.push({ timeMs: t, states: patchStates(g.getImageData(0, 0, width, height).data, width, height, { block: SCAN_BLOCK }) });
      onProgress?.(Math.min(1, t / durationMs));
    }
    // Patches seen clean at least once are board that can hold writing (not its frame or tray).
    const everClean = new Uint8Array(frames[0]?.states.length ?? 0);
    for (const { states } of frames) states.forEach((v, i) => { if (v === CLEAN) everClean[i] = 1; });
    return { durationMs, moments: pickBoards(frames), everClean };
  } finally {
    close();
  }
}

export type LiftedMoment = { timeMs: number; image: PreparedImage; original?: PreparedImage; lifted: boolean };

/**
 * Lift the drawing at each time: combine nearby frames so a person in front of the board is replaced by what
 * was behind them, crop to the writing, and clean it to marker on white. If no writing can be found, the plain
 * frame is returned instead (`lifted: false`).
 */
export async function liftMoments(file: Blob, moments: { timeMs: number; sinceMs?: number }[], everClean?: Uint8Array | null, signal?: AbortSignal): Promise<LiftedMoment[]> {
  const { video, close } = await openVideo(file);
  try {
    const width = LIFT_WIDTH;
    const height = Math.round((video.videoHeight / video.videoWidth) * width);
    const cols = Math.floor(width / LIFT_BLOCK), rows = Math.floor(height / LIFT_BLOCK);
    const mask = everClean && everClean.length === cols * rows && everClean.some((v) => v === 1) ? everClean : null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    if (!g) throw new BoardVideoError("This browser can't process video frames.");
    const results: LiftedMoment[] = [];
    for (const { timeMs, sinceMs } of moments) {
      const composite = new Uint8ClampedArray(width * height * 4);
      const best = new Int16Array(cols * rows).fill(-1); // most marker seen in each patch so far
      let firstFrame: ImageData | null = null;
      let edge = 0;
      let firstGray: Float32Array | null = null;
      let firstInk: Int16Array | null = null;
      for (const t of liftTimes(timeMs, video.duration * 1000, sinceMs)) {
        await seek(video, t, signal);
        g.drawImage(video, 0, 0, width, height);
        const frame = g.getImageData(0, 0, width, height);
        const ink = patchInk(frame.data, width, height, { block: LIFT_BLOCK });
        if (!firstFrame || !firstGray || !firstInk) {
          firstFrame = frame;
          edge = boardEdgeRow(frame.data, width, height);
          firstGray = halfGray(frame.data, width, height);
          firstInk = ink;
        } else {
          // Cameras with automatic framing zoom and pan as the teacher moves; a frame that doesn't line up exactly
          // with the chosen moment would double the writing, so it is skipped.
          if (Math.abs(boardEdgeRow(frame.data, width, height) - edge) > 2) continue;
          const hw = Math.floor(width / 2), hh = Math.floor(height / 2), hb = LIFT_BLOCK / 2;
          const valid = new Uint8Array(hw * hh);
          for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) {
            const p = Math.min(rows - 1, Math.floor(y / hb)) * cols + Math.min(cols - 1, Math.floor(x / hb));
            valid[y * hw + x] = firstInk[p] > 0 && ink[p] > 0 ? 1 : 0; // board with marker in both frames
          }
          const shift = bestShift(firstGray, halfGray(frame.data, width, height), hw, hh, valid);
          if (shift.dx !== 0 || shift.dy !== 0) continue;
        }
        const hidden = growHidden(Int8Array.from(ink, (d) => (d < 0 ? HIDDEN : CLEAN)), cols, rows);
        for (let i = 0; i < ink.length; i++) {
          // Near the moment, an arm or phone partly in front hides some marker, so the clearest view holds the most.
          // Older frames may show an earlier board, so they only fill patches not seen yet.
          const near = Math.abs(t - timeMs) <= 3_000;
          if (hidden[i] === HIDDEN || (near ? ink[i] <= best[i] : best[i] >= 0)) continue;
          const r = Math.floor(i / cols), c = i % cols;
          for (let y = r * LIFT_BLOCK; y < (r + 1) * LIFT_BLOCK; y++) {
            const start = (y * width + c * LIFT_BLOCK) * 4;
            composite.set(frame.data.subarray(start, start + LIFT_BLOCK * 4), start);
          }
          best[i] = ink[i];
        }
      }
      const seen = Int8Array.from(best, (d) => (d < 0 ? HIDDEN : d >= 12 ? WRITTEN : CLEAN));
      const bounds = writingBounds(seen, cols, rows, mask);
      if (!bounds || !firstFrame) {
        if (firstFrame) g.putImageData(firstFrame, 0, 0);
        results.push({ timeMs, image: await prepareImage(await canvasBlob(canvas)), lifted: false });
        continue;
      }
      const cropW = (bounds.c1 - bounds.c0 + 1) * LIFT_BLOCK;
      const cropH = (bounds.r1 - bounds.r0 + 1) * LIFT_BLOCK;
      const cropToBlob = (frame: Uint8ClampedArray<ArrayBuffer>) => {
        g.putImageData(new ImageData(frame, width, height), 0, 0);
        const crop = document.createElement("canvas");
        crop.width = cropW;
        crop.height = cropH;
        crop.getContext("2d")?.drawImage(canvas, bounds.c0 * LIFT_BLOCK, bounds.r0 * LIFT_BLOCK, cropW, cropH, 0, 0, cropW, cropH);
        return canvasBlob(crop);
      };
      // Original: the lifted-and-cropped frame without the whitening, so faint strokes the cleanup would drop
      // are kept. prepareImage flattens the unseen (transparent) patches onto white, like the cleaned crop.
      const original = await prepareImage(await cropToBlob(composite));
      const cleaned = cleanBoard(composite, width, height, LIFT_BLOCK, seen);
      const image = await prepareImage(await cropToBlob(cleaned));
      results.push({ timeMs, image, original, lifted: true });
    }
    return results;
  } finally {
    close();
  }
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new BoardVideoError("A video frame couldn't be captured."))), "image/png"));
}
