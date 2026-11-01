// POST /api/label
// Body (JSON): { image: "data:image/jpeg;base64,...", context?: { subject, grade, objective, vocabulary[] } }
// Returns a DiagramResult (lib/diagram.ts): Wonder names the objects worth labeling, SAM 3.1 boxes each one.
import { LABELING } from "@/lib/config";
import { analyzeImage } from "@/lib/label";
import type { LessonContext } from "@/lib/materials";

// Wonder (~8 s) + parallel SAM requests (~2 s); leave room for a fallback retry.
export const maxDuration = 60;

const text = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);

export async function POST(request: Request) {
  const apiKey = process.env.META_API_KEY;
  if (!apiKey) return Response.json({ error: "Server is missing META_API_KEY" }, { status: 500 });

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > LABELING.maxBodyBytes) return Response.json({ error: "Image too large" }, { status: 413 });

  let body: { image?: unknown; context?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send JSON" }, { status: 400 });
  }

  const image = typeof body.image === "string" ? body.image : "";
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) {
    return Response.json({ error: "Send a JPEG, PNG, or WebP image" }, { status: 400 });
  }
  if (image.length > LABELING.maxBodyBytes) return Response.json({ error: "Image too large" }, { status: 413 });

  const c = body.context ?? {};
  const context: LessonContext = {
    subject: text(c.subject, 100),
    grade: text(c.grade, 50),
    objective: text(c.objective),
    vocabulary: Array.isArray(c.vocabulary)
      ? c.vocabulary.map((v) => text(v, 80)).filter((v): v is string => !!v).slice(0, 50)
      : undefined,
  };

  try {
    const result = await analyzeImage(image, context, { apiKey, baseURL: process.env.META_API_BASE_URL });
    return Response.json(result);
  } catch (err) {
    console.error("[label]", err);
    return Response.json({ error: "Analyzing the image failed — try again" }, { status: 502 });
  }
}
