// Browser-only: reads the sound track out of a large MP4/MOV class video without loading the video into memory.
// The index ("moov" box) is located directly, handed to mp4box to learn where each audio frame sits,
// and only bounded windows of the file are read. WebCodecs decodes the audio; the video never leaves the computer.
import { SAMPLE_RATE, toMonoAtRate } from "./audio-client";

export const MAX_VIDEO_BYTES = 8 * 1024 ** 3;
const READ_WINDOW_BYTES = 8 * 1024 * 1024;
const RESAMPLE_BLOCK_SECONDS = 10;

export type VideoAudioProblem = "unsupported-browser" | "unsupported-format" | "no-audio" | "decode-failed";

const MESSAGES: Record<VideoAudioProblem, string> = {
  "unsupported-browser": "This browser can't read the sound from video files. Try the latest Chrome or Edge, or upload just the audio.",
  "unsupported-format": "Lecture Studio can read MP4 and MOV videos. Try saving the video as MP4, or upload just the audio.",
  "no-audio": "This video has no sound track to transcribe.",
  "decode-failed": "The sound in this video couldn't be read. Try saving it as MP4, or upload just the audio.",
};

export class VideoAudioError extends Error {
  constructor(readonly problem: VideoAudioProblem, detail?: string) {
    super(MESSAGES[problem]);
    this.name = "VideoAudioError";
    if (detail) this.cause = detail;
  }
}

/** Video files are routed here; everything else keeps the existing Web Audio decode. */
export function isVideoFile(file: { type: string; name?: string }): boolean {
  return file.type.startsWith("video/") || /\.(?:mp4|m4v|mov)$/i.test(file.name ?? "");
}

export type TopLevelBox = { type: string; offset: number; size: number };
type ReadAt = (offset: number, length: number) => Promise<Uint8Array>;

/** Walk the file's top-level ISO-BMFF boxes by reading only their 8–16-byte headers. */
export async function scanTopLevelBoxes(fileSize: number, readAt: ReadAt, maxBoxes = 10_000): Promise<TopLevelBox[]> {
  const boxes: TopLevelBox[] = [];
  let offset = 0;
  while (offset + 8 <= fileSize && boxes.length < maxBoxes) {
    const header = await readAt(offset, Math.min(16, fileSize - offset));
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    let size = view.getUint32(0);
    const type = String.fromCharCode(header[4], header[5], header[6], header[7]);
    if (size === 1) {
      if (header.byteLength < 16) throw new VideoAudioError("unsupported-format", "truncated large box");
      size = Number(view.getBigUint64(8));
    } else if (size === 0) {
      size = fileSize - offset; // box runs to the end of the file
    }
    if (size < 8 || size > fileSize - offset || !/^[\x20-\x7e]{4}$/.test(type)) {
      throw new VideoAudioError("unsupported-format", `bad box at ${offset}`);
    }
    boxes.push({ type, offset, size });
    offset += size;
  }
  return boxes;
}

export type SampleRange = { offset: number; size: number };

/** Group file-ordered samples into bounded contiguous reads (one sample larger than the window gets its own read). */
export function planReadWindows<T extends SampleRange>(samples: T[], maxBytes = READ_WINDOW_BYTES): { start: number; end: number; samples: T[] }[] {
  const windows: { start: number; end: number; samples: T[] }[] = [];
  let current: { start: number; end: number; samples: T[] } | null = null;
  for (const sample of samples) {
    const end = sample.offset + sample.size;
    if (current && sample.offset >= current.start && end - current.start <= maxBytes) {
      current.end = Math.max(current.end, end);
      current.samples.push(sample);
    } else {
      current = { start: sample.offset, end, samples: [sample] };
      windows.push(current);
    }
  }
  return windows;
}

type DescriptorLike = { findDescriptor?: (tag: number) => DescriptorLike | undefined; data?: Uint8Array };
type SampleEntryLike = { esds?: { esd?: DescriptorLike }; wave?: { esds?: { esd?: DescriptorLike } } };

/** AAC needs its AudioSpecificConfig (ES descriptor → decoder config → decoder-specific info). */
function aacDescription(entry: SampleEntryLike | undefined): Uint8Array | undefined {
  const esd = entry?.esds?.esd ?? entry?.wave?.esds?.esd;
  return esd?.findDescriptor?.(4)?.findDescriptor?.(5)?.data;
}

export type VideoAudioOptions = {
  signal?: AbortSignal;
  /** 0–1 share of the audio data read so far. */
  onProgress?: (fraction: number) => void;
};

/** Mono 24 kHz samples from the first sound track of an MP4/MOV file. */
export async function extractVideoAudio(file: Blob, { signal, onProgress }: VideoAudioOptions = {}): Promise<Float32Array> {
  if (typeof AudioDecoder === "undefined" || typeof EncodedAudioChunk === "undefined") throw new VideoAudioError("unsupported-browser");
  const readAt: ReadAt = async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  const aborted = () => { if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError"); };

  const boxes = await scanTopLevelBoxes(file.size, readAt);
  if (boxes.some((box) => box.type === "moof")) throw new VideoAudioError("unsupported-format", "fragmented MP4");
  const moov = boxes.find((box) => box.type === "moov");
  const ftyp = boxes.find((box) => box.type === "ftyp");
  if (!moov) throw new VideoAudioError("unsupported-format", "no moov box");
  aborted();

  // Hand mp4box only the file-type and index boxes; sample offsets inside the index are absolute file positions.
  const parts = [ftyp, moov].filter((box): box is TopLevelBox => Boolean(box));
  const index = new Uint8Array(parts.reduce((sum, box) => sum + box.size, 0));
  let at = 0;
  for (const box of parts) { index.set(await readAt(box.offset, box.size), at); at += box.size; }

  const { createFile, MP4BoxBuffer } = await import("mp4box");
  const mp4 = createFile();
  let parseError: string | null = null;
  mp4.onError = (_module, message) => { parseError = message; };
  // mp4box logs harmless notices (e.g. unknown camera tags such as '©xyz') with console.error and has no
  // setting to silence them; drop just those during this one synchronous parse.
  const consoleError = console.error;
  console.error = (...args: unknown[]) => { if (args[1] !== "[BoxParser]") consoleError(...args); };
  try {
    mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(index.buffer, 0));
    mp4.flush();
  } finally {
    console.error = consoleError;
  }
  const info = mp4.getInfo();
  if (parseError || !info?.tracks) throw new VideoAudioError("unsupported-format", parseError ?? "unreadable index");
  const track = info.tracks.find((t) => t.type === "audio" || t.audio);
  if (!track?.audio) throw new VideoAudioError("no-audio");
  const trak = mp4.getTrackById(track.id);
  const samples = (trak.samples ?? []).filter((s) => s.size > 0).sort((a, b) => a.offset - b.offset);
  if (!samples.length) throw new VideoAudioError("no-audio");

  const sourceRate = track.audio.sample_rate;
  const entry = trak.mdia?.minf?.stbl?.stsd?.entries?.[0] as SampleEntryLike | undefined;
  const config: AudioDecoderConfig = {
    codec: track.codec,
    sampleRate: sourceRate,
    numberOfChannels: track.audio.channel_count,
    description: track.codec.startsWith("mp4a") ? aacDescription(entry) : undefined,
  };
  const support = await AudioDecoder.isConfigSupported(config).catch(() => null);
  if (!support?.supported) throw new VideoAudioError(track.codec.startsWith("mp4a") ? "unsupported-browser" : "unsupported-format", `codec ${track.codec}`);

  // Decoded audio is mixed to mono at the source rate, then resampled to 24 kHz in ~10 s blocks to bound memory.
  const durationSec = samples.reduce((sum, s) => sum + s.duration, 0) / track.timescale;
  const output = new Float32Array(Math.ceil((durationSec + 1) * SAMPLE_RATE));
  let written = 0;
  const blockLength = Math.round(sourceRate * RESAMPLE_BLOCK_SECONDS);
  let pending = new Float32Array(blockLength);
  let pendingLength = 0;
  const flushPending = () => {
    if (!pendingLength) return;
    const resampled = toMonoAtRate([pending.subarray(0, pendingLength)], sourceRate);
    const room = Math.min(resampled.length, output.length - written);
    output.set(resampled.subarray(0, room), written);
    written += room;
    pendingLength = 0;
    pending = new Float32Array(blockLength);
  };
  let decodeError: unknown = null;
  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        const frames = data.numberOfFrames;
        const mono = new Float32Array(frames);
        const plane = new Float32Array(frames);
        for (let channel = 0; channel < data.numberOfChannels; channel++) {
          data.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
          for (let i = 0; i < frames; i++) mono[i] += plane[i] / data.numberOfChannels;
        }
        let from = 0;
        while (from < frames) {
          const take = Math.min(frames - from, blockLength - pendingLength);
          pending.set(mono.subarray(from, from + take), pendingLength);
          pendingLength += take;
          from += take;
          if (pendingLength === blockLength) flushPending();
        }
      } catch (err) {
        decodeError = err;
      } finally {
        data.close();
      }
    },
    error: (err) => { decodeError = err; },
  });

  try {
    decoder.configure(config);
    const windows = planReadWindows(samples);
    const totalBytes = windows.reduce((sum, w) => sum + (w.end - w.start), 0);
    let readBytes = 0;
    for (const window of windows) {
      aborted();
      const bytes = await readAt(window.start, window.end - window.start);
      for (const sample of window.samples) {
        decoder.decode(new EncodedAudioChunk({
          type: "key",
          timestamp: Math.round((sample.cts * 1_000_000) / track.timescale),
          duration: Math.round((sample.duration * 1_000_000) / track.timescale),
          data: bytes.subarray(sample.offset - window.start, sample.offset - window.start + sample.size),
        }));
      }
      await decoder.flush(); // backpressure: at most one window of audio is queued at a time
      if (decodeError) throw new VideoAudioError("decode-failed", String(decodeError));
      readBytes += window.end - window.start;
      onProgress?.(readBytes / totalBytes);
    }
    flushPending();
    if (decodeError) throw new VideoAudioError("decode-failed", String(decodeError));
    return output.subarray(0, written);
  } finally {
    if (decoder.state !== "closed") decoder.close();
  }
}
