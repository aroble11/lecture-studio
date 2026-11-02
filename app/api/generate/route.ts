// POST /api/generate
// Body (JSON): { turns: [{ startMs, endMs, text }], context?: { subject, grade, objective, standards, vocabulary[] },
//               diagram?: { summary, items: [{ n, label }] }, privacy?: true }
// privacy: true → Privacy Mode: Muse Spark Open on Baseten only (needs BASETEN_API_KEY), never Meta's hosted models.
// Returns: { materials, model, seconds, privacy? } — see lib/materials.ts.
import { GENERATION } from "@/lib/config";
import { generateMaterials, generatePrivately } from "@/lib/generate";
import { paidProcessingUnavailable } from "@/lib/paid-processing";
import { withUsageBudget } from "@/lib/usage-budget";
import type { DiagramContext } from "@/lib/diagram";
import type { LessonContext } from "@/lib/materials";
import type { Turn } from "@/lib/meta-asr";

// Generation at medium effort can take a minute or more on a long lecture (Hobby allows 300 s).
export const maxDuration = 300;

const text = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);

export async function POST(request: Request) {
  const paused = paidProcessingUnavailable();
  if (paused) return paused;

  const apiKey = process.env.META_API_KEY;
  if (!apiKey) return Response.json({ error: "Server is missing META_API_KEY" }, { status: 500 });

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > GENERATION.maxBodyBytes) {
    return Response.json({ error: "Transcript too large" }, { status: 413 });
  }

  let body: {
    turns?: unknown;
    context?: Record<string, unknown>;
    diagram?: { summary?: unknown; items?: unknown };
    privacy?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send JSON" }, { status: 400 });
  }

  const turns: Turn[] = (Array.isArray(body.turns) ? body.turns : [])
    .filter((t): t is Turn => typeof t?.text === "string" && t.text.trim() !== "" && Number.isFinite(t.startMs))
    .map((t) => ({ startMs: t.startMs, endMs: Number.isFinite(t.endMs) ? t.endMs : t.startMs, text: t.text.trim() }));
  if (turns.length === 0) return Response.json({ error: "Transcript is empty" }, { status: 400 });

  const c = body.context ?? {};
  const context: LessonContext = {
    subject: text(c.subject, 100),
    grade: text(c.grade, 50),
    objective: text(c.objective),
    standards: text(c.standards),
    vocabulary: Array.isArray(c.vocabulary)
      ? c.vocabulary.map((v) => text(v, 80)).filter((v): v is string => !!v).slice(0, 50)
      : undefined,
    style: text(c.style, 600),
    classNotes: text(c.classNotes, 600),
  };

  const d = body.diagram;
  const items = (Array.isArray(d?.items) ? d.items : [])
    .filter((i): i is { n: number; label: string } => Number.isInteger(i?.n) && typeof i?.label === "string")
    .slice(0, 12)
    .map((i) => ({ n: i.n, label: i.label.trim().slice(0, 80) }));
  const diagram: DiagramContext | undefined = items.length
    ? { summary: text(d?.summary, 300) ?? "", items }
    : undefined;

  if (body.privacy === true && !process.env.BASETEN_API_KEY) {
    return Response.json({ error: "Privacy Mode isn't set up on this server" }, { status: 503 });
  }
  return withUsageBudget("generate", async () => {
    try {
      if (body.privacy === true) {
        const basetenKey = process.env.BASETEN_API_KEY;
        if (!basetenKey) return Response.json({ error: "Privacy Mode isn't set up on this server" }, { status: 503 });
        return Response.json(await generatePrivately(turns, context, { apiKey: basetenKey, diagram }));
      }
      const result = await generateMaterials(turns, context, {
        apiKey,
        baseURL: process.env.META_API_BASE_URL,
        diagram,
      });
      return Response.json(result);
    } catch (err) {
      console.error("[generate]", err);
      return Response.json({ error: "Generating materials failed — try again" }, { status: 502 });
    }
  });
}
