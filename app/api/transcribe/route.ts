// POST /api/transcribe?kw=term&kw=term
// Body: raw PCM16 mono 24 kHz audio (Content-Type: application/octet-stream), one chunk (≤ ~80 s).
// Returns: { turns: [{ startMs, endMs, text }], audioMs, sessionId } — times relative to the chunk.
import { ASR } from "@/lib/config";
import { transcribePcm } from "@/lib/meta-asr";
import { paidProcessingUnavailable } from "@/lib/paid-processing";
import { withUsageBudget } from "@/lib/usage-budget";

// One ~60 s chunk at 2x takes ~30 s (max 75 s chunk ≈ 40 s); leave headroom for slow handshakes.
export const maxDuration = 120;

export async function POST(request: Request) {
  const paused = paidProcessingUnavailable();
  if (paused) return paused;

  const apiKey = process.env.META_API_KEY;
  if (!apiKey) return Response.json({ error: "Server is missing META_API_KEY" }, { status: 500 });

  if (!request.headers.get("content-type")?.startsWith("application/octet-stream")) {
    return Response.json({ error: "Send raw PCM16 audio as application/octet-stream" }, { status: 415 });
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > ASR.maxChunkBytes) {
    return Response.json({ error: `Chunk too large (max ${ASR.maxChunkBytes} bytes)` }, { status: 413 });
  }

  const pcm = new Uint8Array(await request.arrayBuffer());
  if (pcm.length === 0) return Response.json({ error: "Empty audio" }, { status: 400 });
  if (pcm.length > ASR.maxChunkBytes) {
    return Response.json({ error: `Chunk too large (max ${ASR.maxChunkBytes} bytes)` }, { status: 413 });
  }
  if (pcm.length % 2 !== 0) return Response.json({ error: "PCM16 length must be even" }, { status: 400 });

  const keywords = [
    ...new Set(
      new URL(request.url).searchParams
        .getAll("kw")
        .map((k) => k.trim())
        .filter((k) => k.length > 0 && k.length <= ASR.maxKeywordLength),
    ),
  ].slice(0, ASR.maxKeywords);

  return withUsageBudget("transcribe", async () => {
    try {
      const result = await transcribePcm(pcm, { apiKey, keywords });
      return Response.json(result);
    } catch (err) {
      console.error("[transcribe]", err);
      return Response.json({ error: "Transcription failed — try again" }, { status: 502 });
    }
  });
}
