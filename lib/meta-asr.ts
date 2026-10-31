// Server-only: streams PCM audio to Meta Muse Voice Transcribe over its realtime WebSocket
// and returns the transcript as turns with start/end times. Never import from client code —
// it needs META_API_KEY.
import { ASR, META_ASR_URL, MODELS } from "./config";

export type Turn = {
  /** Start of speech, ms from the start of this audio chunk. */
  startMs: number;
  /** End of speech, ms from the start of this audio chunk. */
  endMs: number;
  text: string;
};

export type TranscribeResult = {
  turns: Turn[];
  /** Length of the audio sent, in ms. */
  audioMs: number;
  sessionId: string;
};

type TurnState = { startMs: number; endMs?: number; partial?: string; final?: string };

export async function transcribePcm(
  pcm: Uint8Array,
  opts: { apiKey: string; keywords?: string[]; speed?: number },
): Promise<TranscribeResult> {
  const speed = opts.speed ?? ASR.speed;
  const bytesPerMs = (ASR.sampleRate * 2) / 1000;
  const audioMs = Math.round(pcm.length / bytesPerMs);
  const packetBytes = ASR.packetMs * bytesPerMs;
  // Sending takes audioMs / speed; allow generous slack for the handshake and final events.
  const timeoutMs = audioMs / speed + 30_000;

  return new Promise<TranscribeResult>((resolve, reject) => {
    const ws = new WebSocket(META_ASR_URL);
    ws.binaryType = "arraybuffer";

    const turns = new Map<string, TurnState>();
    let activeTurn: string | null = null;
    let sessionId = "";
    let endSent = false;
    let settled = false;

    const timer = setTimeout(() => fail(new Error(`ASR timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);

    function fail(err: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      reject(err);
    }

    function succeed() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out: Turn[] = [...turns.values()]
        .map((t) => ({
          startMs: t.startMs,
          endMs: t.endMs ?? audioMs,
          text: (t.final ?? t.partial ?? "").trim(),
        }))
        .filter((t) => t.text.length > 0)
        .sort((a, b) => a.startMs - b.startMs);
      resolve({ turns: out, audioMs, sessionId });
    }

    async function sendAudio() {
      const start = Date.now();
      for (let i = 0, n = 0; i < pcm.length; i += packetBytes, n++) {
        if (settled || ws.readyState !== WebSocket.OPEN) return;
        const wait = start + (n * ASR.packetMs) / speed - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        ws.send(pcm.subarray(i, i + packetBytes));
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "endStream" }));
        endSent = true;
      }
    }

    ws.onopen = () => {
      const handshake: Record<string, unknown> = {
        mode: "ENDPOINTING",
        authorization: { accessToken: `Bearer ${opts.apiKey}` },
        audioEncoding: "PCM_24KHZ",
        model: MODELS.transcribe,
        partialMode: "CUMULATIVE",
        emitAudioProgress: false,
        languageBias: ["English"],
      };
      if (opts.keywords?.length) handshake.keywords = opts.keywords;
      ws.send(JSON.stringify(handshake));
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(ev.data); } catch { return fail(new Error("ASR sent invalid JSON")); }

      if (!sessionId) {
        if (msg.type === "error" || typeof msg.sessionId !== "string") {
          return fail(new Error(`ASR handshake rejected: ${ev.data.slice(0, 300)}`));
        }
        sessionId = msg.sessionId;
        sendAudio().catch((e) => fail(e instanceof Error ? e : new Error(String(e))));
        return;
      }

      const at = typeof msg.audioProcessedMs === "number" ? msg.audioProcessedMs : 0;
      const id = msg.turnId === undefined || msg.turnId === null ? null : String(msg.turnId);

      switch (msg.type) {
        case "speechStart":
          if (id) { turns.set(id, { ...turns.get(id), startMs: at }); activeTurn = id; }
          break;
        case "transcript": {
          const tid = id ?? activeTurn;
          if (tid && typeof msg.transcript === "string") {
            const t = turns.get(tid) ?? { startMs: at };
            t.partial = msg.transcript;
            turns.set(tid, t);
          }
          break;
        }
        case "speechEnd":
          if (id) {
            const t = turns.get(id) ?? { startMs: at };
            t.endMs = at;
            turns.set(id, t);
            if (activeTurn === id) activeTurn = null;
          }
          break;
        case "speechComplete":
          if (id && typeof msg.transcript === "string") {
            const t = turns.get(id) ?? { startMs: at };
            t.final = msg.transcript;
            t.endMs ??= at;
            turns.set(id, t);
          }
          break;
        case "error":
          return fail(new Error(`ASR error: ${ev.data.slice(0, 300)}`));
      }
    };

    ws.onerror = () => {
      // A close event follows; give it a moment, then fail if nothing settled.
      setTimeout(() => fail(new Error("ASR WebSocket error")), 1000);
    };

    ws.onclose = (ev: CloseEvent) => {
      if (endSent && ev.code === 1000) succeed();
      else fail(new Error(`ASR closed early (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`));
    };
  });
}
