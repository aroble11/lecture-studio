// POST /api/label
// Body (JSON): { image: "data:image/jpeg;base64,...", context?: { subject, grade, objective, vocabulary[] } }
// Returns a DiagramResult (lib/diagram.ts): Wonder names the objects worth labeling, SAM 3.1 boxes each one.
import { LABELING } from "@/lib/config";
import { analyzeImage } from "@/lib/label";
import { paidProcessingUnavailable } from "@/lib/paid-processing";
import { withUsageBudget } from "@/lib/usage-budget";
import { readBoundedJson } from "@/lib/request-body";
import { hasMediaType, object, validateContext, inputErrorResponse } from "@/lib/input-validation";
import { validateImage } from "@/lib/image-validation";

// Wonder (~8 s) + parallel SAM requests (~2 s); leave room for a fallback retry.
export const maxDuration = 60;

export async function POST(request: Request) {
  const paused = paidProcessingUnavailable();
  if (paused) return paused;

  const apiKey = process.env.META_API_KEY;
  if (!apiKey) return Response.json({ error: "Server is missing META_API_KEY" }, { status: 500 });

  if (!hasMediaType(request, "application/json")) return Response.json({ error: "Send application/json" }, { status: 415 });
  const parsed = await readBoundedJson<unknown>(request, LABELING.maxBodyBytes);
  if (!parsed.ok) return parsed.response;
  let image: string;
  let context: ReturnType<typeof validateContext>;
  try {
    const body = object(parsed.value, "Request body");
    context = validateContext(body.context);
    image = await validateImage(body.image);
  } catch (error) { return inputErrorResponse(error); }

  return withUsageBudget("label", async () => {
    try {
      const result = await analyzeImage(image, context, { apiKey, baseURL: process.env.META_API_BASE_URL });
      return Response.json(result);
    } catch (err) {
      console.error("[label]", err);
      return Response.json({ error: "Analyzing the image failed — try again" }, { status: 502 });
    }
  });
}
