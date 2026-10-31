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
