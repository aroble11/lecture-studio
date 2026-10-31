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
  /** Send speed as a multiple of real time. 4x tested clean on Oct 31; unpaced added stutters. */
  speed: 4,
  /** Packet length sent over the socket. */
  packetMs: 80,
  /** Max chunk the API route accepts (Vercel caps request bodies at 4.5 MB). ~83 s of audio. */
  maxChunkBytes: 4_000_000,
  /** Keyword-biasing limits we enforce on input. */
  maxKeywords: 50,
  maxKeywordLength: 80,
} as const;
