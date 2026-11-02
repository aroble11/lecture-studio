// Server-only: Muse Wonder looks at a reference image and names the concrete objects worth labeling,
// with a rough location for each; SAM 3.1 then finds each object precisely (one request per object,
// in parallel) and we keep the SAM box that best matches Wonder's rough location.
// Needs META_API_KEY — never import from client code.
import OpenAI from "openai";
import { LABELING, MODELS } from "./config";
import type { Box, DiagramItem, DiagramResult } from "./diagram";
import type { LessonContext } from "./materials";

const int = { type: "integer" } as const;
const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "summary", "objects"],
  properties: {
    kind: { type: "string", enum: ["objects", "mostly_text"] },
    summary: { type: "string" },
    objects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["phrase", "label", "approxBox"],
        properties: {
          phrase: { type: "string" },
          label: { type: "string" },
          approxBox: {
            type: "object",
            additionalProperties: false,
            required: ["x1", "y1", "x2", "y2"],
            properties: { x1: int, y1: int, x2: int, y2: int },
          },
        },
      },
    },
  },
};

const INSTRUCTIONS = `You help a teacher turn a reference image into a "label the diagram" activity.
An object detector will search the image for each "phrase" you give. It only finds concrete, visible things
named by a short noun (1-3 words, singular, e.g. "skull", "necklace", "keyboard", "heart"). It cannot find
text, handwriting, tables, layout regions, or abstract ideas.
Return up to ${LABELING.maxItems} distinct objects that are clearly visible and worth labeling for students,
favoring ones that fit the lesson. Each item is ONE object (if a picture shows a shirt and shorts, pick the main
one or list them as separate items). "label" is the term students should write (can be more specific than the
phrase). Do not list the same thing twice.
"approxBox" is your rough location of that one object, in coordinates normalized 0-1000
(x1,y1 = top-left, x2,y2 = bottom-right; 0,0 is the image's top-left corner, 1000,1000 its bottom-right).
The detector may find several matches for a phrase; your box decides which one is meant.
Set kind to "mostly_text" (and objects to []) if the image is mainly writing with no drawn or photographed objects.
"summary" is one sentence describing the image.`;

type Plan = {
  kind: "objects" | "mostly_text";
  summary: string;
  objects: { phrase: string; label: string; approxBox: Box }[];
};

function contextText(ctx: LessonContext) {
  const lines = [
    ["Subject", ctx.subject],
    ["Grade", ctx.grade],
    ["Lesson objective", ctx.objective],
    ["Key vocabulary", ctx.vocabulary?.join(", ")],
  ]
    .filter(([, v]) => v && String(v).trim())
    .map(([k, v]) => `${k}: ${String(v).trim()}`);
  return lines.length ? `Lesson context:\n${lines.join("\n")}` : "No lesson context given.";
}

async function planLabels(client: OpenAI, model: string, image: string, ctx: LessonContext, signal?: AbortSignal): Promise<Plan> {
  const res = await client.responses.create({
    model,
    reasoning: { effort: LABELING.effort },
    max_output_tokens: LABELING.maxOutputTokens,
    instructions: INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: image, detail: "auto" },
          { type: "input_text", text: contextText(ctx) },
        ],
      },
    ],
    text: { format: { type: "json_schema", name: "labels", strict: true, schema: PLAN_SCHEMA } },
  }, { timeout: LABELING.planTimeoutMs, signal });
  if (res.status !== "completed") throw new Error(`${model} returned status ${res.status}`);
  return JSON.parse(res.output_text) as Plan;
}

/** SAM output is one text line of tokens: `<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..;c=..|><|mask;...|>,1<|box;...`. */
function parseBoxes(text: string): { box: Box; score: number }[] {
  const out: { box: Box; score: number }[] = [];
  for (const m of text.matchAll(/<\|box;([^|>]*)\|>/g)) {
    const f: Record<string, number> = {};
    for (const kv of m[1].split(";")) {
      const [k, v] = kv.split("=");
      if (k && v !== undefined) f[k] = Number(v);
    }
    if (![f.x1, f.y1, f.x2, f.y2, f.w, f.h].every(Number.isFinite) || !f.w || !f.h) continue;
    out.push({
      box: { x1: (f.x1 / f.w) * 1000, y1: (f.y1 / f.h) * 1000, x2: (f.x2 / f.w) * 1000, y2: (f.y2 / f.h) * 1000 },
      score: Number.isFinite(f.c) ? f.c : 1,
    });
  }
  return out;
}

async function segment(client: OpenAI, image: string, phrase: string, signal?: AbortSignal) {
  const res = await client.responses.create({
    model: MODELS.segmentation,
    input: [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: image, detail: "auto" },
          { type: "input_text", text: phrase },
        ],
      },
    ],
    metadata: { include_confidence: "true", mask_encoding: "one_bit" },
  }, { timeout: LABELING.segmentTimeoutMs, signal });
  return parseBoxes(res.output_text ?? "").filter((d) => d.score >= LABELING.minScore);
}

const area = (r: Box) => Math.max(0, r.x2 - r.x1) * Math.max(0, r.y2 - r.y1);
function iou(a: Box, b: Box) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  return inter / (area(a) + area(b) - inter || 1);
}
const dist = (a: Box, b: Box) => Math.hypot((a.x1 + a.x2 - b.x1 - b.x2) / 2, (a.y1 + a.y2 - b.y1 - b.y2) / 2);

/** The SAM match that overlaps Wonder's rough box most (closest center breaks ties, e.g. no overlap). */
function pick(found: { box: Box; score: number }[], approx: Box) {
  return [...found].sort((p, q) => iou(q.box, approx) - iou(p.box, approx) || dist(p.box, approx) - dist(q.box, approx))[0];
}

const clampBox = (b: Box): Box => {
  const c = (v: number) => Math.min(1000, Math.max(0, Math.round(v)));
  return { x1: c(Math.min(b.x1, b.x2)), y1: c(Math.min(b.y1, b.y2)), x2: c(Math.max(b.x1, b.x2)), y2: c(Math.max(b.y1, b.y2)) };
};

/** Number items in reading order: rows top to bottom, then left to right within a row. */
function readingOrder<T extends { box: Box }>(items: T[]): T[] {
  const cy = (b: Box) => (b.y1 + b.y2) / 2;
  const sorted = [...items].sort((a, b) => cy(a.box) - cy(b.box));
  const rows: T[][] = [];
  for (const it of sorted) {
    const row = rows.at(-1);
    const h = it.box.y2 - it.box.y1;
    if (row && Math.abs(cy(it.box) - cy(row[0].box)) < Math.max(40, h / 2)) row.push(it);
    else rows.push([it]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.box.x1 - b.box.x1));
}

export async function analyzeImage(
  image: string,
  ctx: LessonContext,
  opts: { apiKey: string; baseURL?: string; signal?: AbortSignal },
): Promise<DiagramResult> {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL ?? "https://api.meta.ai/v1",
    maxRetries: 0,
    timeout: LABELING.planTimeoutMs,
  });
  const t0 = Date.now();

  let model: string = MODELS.generation;
  let plan: Plan;
  try {
    plan = await planLabels(client, model, image, ctx, opts.signal);
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    console.warn(`[label] ${model} failed, falling back to ${MODELS.generationFallback}:`, err);
    model = MODELS.generationFallback;
    plan = await planLabels(client, model, image, ctx, opts.signal);
  }

  const objects = plan.kind === "objects" ? plan.objects.slice(0, LABELING.maxItems) : [];
  const found = await Promise.all(
    objects.map(async (o) => {
      const phrase = o.phrase.trim().slice(0, 60);
      const label = o.label.trim().slice(0, 80);
      if (!phrase || !label) return null;
      try {
        const matches = await segment(client, image, phrase, opts.signal);
        const best = matches.length ? pick(matches, clampBox(o.approxBox)) : null;
        return best ? { label, phrase, box: clampBox(best.box), score: Math.round(best.score * 100) / 100 } : null;
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        console.warn(`[label] SAM failed for "${phrase}":`, err);
        return null;
      }
    }),
  );

  // Drop items that landed on the same object as an earlier one.
  const kept: Omit<DiagramItem, "n">[] = [];
  for (const f of found) if (f && !kept.some((k) => iou(k.box, f.box) > 0.8)) kept.push(f);

  const items: DiagramItem[] = readingOrder(kept).map((it, i) => ({ n: i + 1, ...it }));
  return {
    kind: plan.kind,
    summary: plan.summary.trim(),
    items,
    model,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
  };
}
