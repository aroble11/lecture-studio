// Single place for Meta model IDs and pipeline settings.
// Never use "-contributor" model variants (Meta may train on that content).

export const MODELS = {
  /** Materials generation — first choice (preview). */
  generation: "muse-wonder-1.0",
  /** Materials generation — tested fallback. */
  generationFallback: "muse-spark-1.3",
  /** Realtime speech-to-text (WebSocket only). */
  transcribe: "muse-voice-transcribe-1.0",
  /** Segmentation via the Responses API. */
  segmentation: "sam-3.1",
} as const;

/** Privacy Mode: materials generation on an open-weight model via partner inference (never falls back to Meta's API).
 *  Oct 31 test (test-baseten.mjs): chat, json_schema response_format, prompt-only JSON and image input all worked, 3–6 s. */
export const PRIVACY = {
  baseURL: "https://inference.baseten.co/v1",
  /** Baseten's slug (the "-1026" suffix in older notes is wrong). */
  model: "meta-models/muse-spark-open",
  label: "Muse Spark Open (open weights, Baseten)",
  maxOutputTokens: 16_000,
  /** Oct 31: default effort took 87 s on a 32 s lecture (Wonder at medium: ~22 s). Trying "low". */
  effort: "low" as "minimal" | "low" | "medium" | "high",
} as const;

export const META_ASR_URL = "wss://api.meta.ai/v1/asr/realtime";

export const ASR = {
  /** PCM16 mono 24 kHz — the only format the realtime ASR takes besides 16 kHz. */
  sampleRate: 24_000,
  /** Send speed as a multiple of real time. Oct 31 tests: 2x clean in 5/5 runs; 4x stuttered
   *  ("left left", "an an") or merged turns in 2/3 runs; unpaced stuttered. */
  speed: 2,
  /** Chunks transcribed at once from the browser. 6 parallel sessions tested OK on Oct 31. */
  concurrency: 6,
  /** Packet length sent over the socket. */
  packetMs: 80,
  /** Max chunk the API route accepts (Vercel caps request bodies at 4.5 MB). ~83 s of audio. */
  maxChunkBytes: 4_000_000,
  /** Keyword-biasing limits we enforce on input. */
  maxKeywords: 50,
  maxKeywordLength: 80,
} as const;

export const GENERATION = {
  /** Reasoning effort for materials generation. Wonder rejects "none". Oct 31: "low" took ~4.5 s on a toy prompt. */
  effort: "medium" as "minimal" | "low" | "medium" | "high",
  /** Output cap — full materials for a long lecture run a few thousand tokens plus reasoning. */
  maxOutputTokens: 16_000,
  /** Largest transcript body the route accepts (a 90-min lecture is ~100 KB of JSON). */
  maxBodyBytes: 1_000_000,
} as const;

export const LABELING = {
  /** Wonder effort for naming objects in a reference image. Oct 31: "low" took ~7.5 s on a worksheet. */
  effort: "low" as "minimal" | "low" | "medium" | "high",
  maxOutputTokens: 4_000,
  /** Most objects to label in one image (one SAM request each, sent in parallel). */
  maxItems: 6,
  /** Drop SAM boxes below this confidence. */
  minScore: 0.5,
  /** The browser shrinks images so the longest side is at most this many pixels. */
  maxImageSide: 1600,
  /** Largest image the route accepts as a base64 data URL (Vercel caps request bodies at 4.5 MB). */
  maxBodyBytes: 4_000_000,
} as const;
