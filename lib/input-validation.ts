import type { LessonContext } from "@/lib/materials";
import type { DiagramContext } from "@/lib/diagram";
import type { Turn } from "@/lib/meta-asr";
import { ASR } from "@/lib/config";

export class InputError extends Error {}
export function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError(`${field} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new InputError(`${field} must be text`);
  if (value.length > max) throw new InputError(`${field} must be at most ${max} characters`);
  const clean = value.trim();
  if (required && !clean) throw new InputError(`${field} must not be empty`);
  return clean || undefined;
}
function vocabulary(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > ASR.maxKeywords) throw new InputError(`${field} must contain at most ${ASR.maxKeywords} terms`);
  return [...new Set(value.map((v, i) => text(v, `${field}[${i}]`, ASR.maxKeywordLength, true)!))];
}
export function validateContext(value: unknown): LessonContext {
  if (value === undefined) return {};
  const c = object(value, "context");
  // Construct a fresh object: unknown properties never enter provider prompts.
  return {
    subject: text(c.subject, "context.subject", 100), grade: text(c.grade, "context.grade", 50),
    objective: text(c.objective, "context.objective", 500), standards: text(c.standards, "context.standards", 500),
    style: text(c.style, "context.style", 600), classNotes: text(c.classNotes, "context.classNotes", 600),
    vocabulary: vocabulary(c.vocabulary, "context.vocabulary"),
  };
}
export const TRANSCRIPT_LIMITS = { turns: 10_000, turnChars: 12_000, totalChars: 120_000, durationMs: 90 * 60_000 } as const;
export function validateGeneration(value: unknown): { turns: Turn[]; context: LessonContext; diagram?: DiagramContext; privacy: boolean } {
  const b = object(value, "Request body");
  if (!Array.isArray(b.turns) || b.turns.length === 0 || b.turns.length > TRANSCRIPT_LIMITS.turns) {
    throw new InputError(`turns must contain 1–${TRANSCRIPT_LIMITS.turns} transcript entries`);
  }
  let previous = -1;
  let total = 0;
  const turns = b.turns.map((entry, i): Turn => {
    const t = object(entry, `turns[${i}]`);
    const start = t.startMs, end = t.endMs;
    if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) ||
        start < 0 || end < start || end > TRANSCRIPT_LIMITS.durationMs || start < previous) {
      throw new InputError(`turns[${i}] needs finite, ordered startMs/endMs within 90 minutes; turns must be in start-time order`);
    }
    previous = start;
    const clean = text(t.text, `turns[${i}].text`, TRANSCRIPT_LIMITS.turnChars, true)!;
    total += clean.length;
    if (total > TRANSCRIPT_LIMITS.totalChars) throw new InputError(`Transcript must be at most ${TRANSCRIPT_LIMITS.totalChars} characters`);
    return { startMs: start, endMs: end, text: clean };
  });
  if (b.privacy !== undefined && typeof b.privacy !== "boolean") throw new InputError("privacy must be true or false");
  let diagram: DiagramContext | undefined;
  if (b.diagram !== undefined) {
    const d = object(b.diagram, "diagram");
    if (!Array.isArray(d.items) || d.items.length === 0 || d.items.length > 12) throw new InputError("diagram.items must contain 1–12 labels");
    const seen = new Set<number>();
    const items = d.items.map((entry, i) => {
      const it = object(entry, `diagram.items[${i}]`);
      const n = it.n;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 12 || seen.has(n)) {
        throw new InputError("Diagram numbers must be unique integers from 1 to 12");
      }
      seen.add(n);
      return { n, label: text(it.label, `diagram.items[${i}].label`, 80, true)! };
    });
    diagram = { summary: text(d.summary, "diagram.summary", 300) ?? "", items };
  }
  return { turns, context: validateContext(b.context), diagram, privacy: b.privacy === true };
}
export function validateKeywords(url: string): string[] {
  return vocabulary(new URL(url).searchParams.getAll("kw"), "keywords") ?? [];
}
export function inputErrorResponse(error: unknown): Response {
  if (!(error instanceof InputError)) throw error;
  return Response.json({ error: error.message }, { status: 400, headers: { "Cache-Control": "no-store" } });
}
export function hasMediaType(request: Request, expected: string): boolean {
  return request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === expected;
}
