// POST /api/generate
// Body (JSON): { turns: [{ startMs, endMs, text }], context?: { subject, grade, objective, standards, vocabulary[] },
//               diagram?: { summary, items: [{ n, label }] }, privacy?: true }
// privacy: true → Privacy Mode: Muse Spark Open on Baseten only (needs BASETEN_API_KEY), never Meta's hosted models.
// Returns: { materials, model, seconds, privacy? } — see lib/materials.ts.
import { GENERATION } from "@/lib/config";
import { generateMaterials, generatePrivately } from "@/lib/generate";
import { paidProcessingUnavailable } from "@/lib/paid-processing";
import { withUsageBudget } from "@/lib/usage-budget";
import { readBoundedJson } from "@/lib/request-body";
import { hasMediaType, validateGeneration, inputErrorResponse } from "@/lib/input-validation";

// Generation at medium effort can take a minute or more on a long lecture (Hobby allows 300 s).
export const maxDuration = 300;

export async function POST(request: Request) {
  const paused = paidProcessingUnavailable();
  if (paused) return paused;

  const apiKey = process.env.META_API_KEY;
  if (!apiKey) return Response.json({ error: "Server is missing META_API_KEY" }, { status: 500 });

  if (!hasMediaType(request, "application/json")) return Response.json({ error: "Send application/json" }, { status: 415 });
  const parsed = await readBoundedJson<unknown>(request, GENERATION.maxBodyBytes);
  if (!parsed.ok) return parsed.response;
  let input: ReturnType<typeof validateGeneration>;
  try { input = validateGeneration(parsed.value); }
  catch (error) { return inputErrorResponse(error); }
  const { turns, context, diagram, privacy } = input;

  if (privacy && !process.env.BASETEN_API_KEY) {
    return Response.json({ error: "Privacy Mode isn't set up on this server" }, { status: 503 });
  }
  return withUsageBudget("generate", async () => {
    try {
      if (privacy) {
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
