// Server-only: turns a timestamped transcript + lesson context into classroom materials with
// Muse Wonder (falls back to Muse Spark on failure). Needs META_API_KEY — never import from client code.
import OpenAI from "openai";
import { GENERATION, MODELS } from "./config";
import type { DiagramContext } from "./diagram";
import type { Turn } from "./meta-asr";
import { MATERIALS_SCHEMA, type GenerateResult, type LessonContext, type Materials } from "./materials";

export const BLANK = "_____";

const INSTRUCTIONS = `You turn a teacher's recorded lecture into ready-to-use classroom materials.
The teacher recorded alone; the transcript is machine-made, so ignore filler words and obvious mis-hearings.
Use only content the teacher actually taught. Do not add facts the lecture did not cover.
Write for the grade level given; if none is given, infer it from the lecture.
Cover every topic in the transcript, even ones outside the stated subject.
Scale to the lecture: a short lecture gets fewer sections and items. Never pad to reach a count.
Every sentence must state a fact from the lecture on its own. Never refer to "the lesson", "the teacher", "the lecture", "the event" or "this topic".

guidedNotes: student fill-in-the-blank notes that follow the lecture in order.
- 1 to 6 sections, each with a short heading. startSec = the [m:ss] timestamp of the transcript line where that section's topic is first discussed, converted to seconds. Sections must be in time order.
- 2 to 6 items per section. Each item is one sentence containing exactly one blank written as "${BLANK}"; "answer" is the key term or fact that fills it.
- Blank only content words a student must learn: key vocabulary, names, dates, causes, effects. Never blank a common word when a key term is available.
- Every answer must be different.
quiz: exactly 5 multiple-choice check-for-understanding questions, 4 choices each (answerIndex is 0-based).
- Exactly one choice is correct. Every other choice must be clearly wrong according to the lecture — never a choice that is also true. Check each distractor against the transcript.
- Do not reuse a choice across questions. Distractors should be plausible to a student who missed the lesson.
- "explanation" says in one sentence why the answer is right.
exitTicket: 1 or 2 short-answer questions that check the lesson objective, each with a brief sampleAnswer.
bellRinger: a 3-5 minute warm-up for the NEXT class that has students recall or apply today's lesson. "teacherNote" says in one sentence how to run it.
diagramNotes: only when a reference image with numbered labeled items is given — one entry per item (n = its number),
a one-sentence student-facing note on that item: connect it to what the lecture taught when the lecture covers it,
otherwise say briefly what it shows. Return [] when no reference image is given.
When a reference image is given, you may also use its labeled terms in the guided notes and quiz where the lecture covers them.`;

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function buildInput(turns: Turn[], ctx: LessonContext, diagram?: DiagramContext) {
  const lines = [
    ["Subject", ctx.subject],
    ["Grade", ctx.grade],
    ["Lesson objective", ctx.objective],
    ["Standards", ctx.standards],
    ["Key vocabulary", ctx.vocabulary?.join(", ")],
  ]
    .filter(([, v]) => v && String(v).trim())
    .map(([k, v]) => `${k}: ${String(v).trim()}`);
  const transcript = turns.map((t) => `[${clock(t.startMs)}] ${t.text}`).join("\n");
  const image = diagram?.items.length
    ? `Reference image: ${diagram.summary}\nLabeled items:\n${diagram.items.map((d) => `${d.n}. ${d.label}`).join("\n")}\n\n`
    : "";
  return `${lines.length ? `Lesson context:\n${lines.join("\n")}\n\n` : ""}${image}Transcript:\n${transcript}`;
}

function shuffle<T>(a: T[]) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Light cleanup so the UI can trust the shape: blanks present, answers valid, choices shuffled. */
function normalize(m: Materials, diagram?: DiagramContext): Materials {
  for (const s of m.guidedNotes.sections) {
    s.startSec = Math.max(0, Math.round(s.startSec || 0));
    s.items = s.items.filter((it) => it.text.trim() && it.answer.trim());
    for (const it of s.items) {
      if (it.text.includes(BLANK)) continue;
      const i = it.text.toLowerCase().indexOf(it.answer.toLowerCase());
      it.text = i >= 0 ? it.text.slice(0, i) + BLANK + it.text.slice(i + it.answer.length) : `${it.text} ${BLANK}`;
    }
  }
  m.guidedNotes.sections = m.guidedNotes.sections.filter((s) => s.items.length > 0);

  m.quiz = m.quiz
    .filter((q) => q.choices.length >= 2 && q.answerIndex >= 0 && q.answerIndex < q.choices.length)
    .slice(0, 5)
    .map((q) => {
      const correct = q.choices[q.answerIndex];
      const choices = shuffle([...q.choices]);
      return { ...q, choices, answerIndex: choices.indexOf(correct) };
    });
  m.exitTicket = m.exitTicket.slice(0, 2);

  const valid = new Set(diagram?.items.map((d) => d.n) ?? []);
  const seen = new Set<number>();
  m.diagramNotes = (m.diagramNotes ?? []).filter((d) => {
    if (!valid.has(d.n) || seen.has(d.n) || !d.note?.trim()) return false;
    seen.add(d.n);
    return true;
  });
  return m;
}

async function callModel(client: OpenAI, model: string, input: string): Promise<Materials> {
  const res = await client.responses.create({
    model,
    reasoning: { effort: GENERATION.effort },
    max_output_tokens: GENERATION.maxOutputTokens,
    instructions: INSTRUCTIONS,
    input,
    text: { format: { type: "json_schema", name: "materials", strict: true, schema: MATERIALS_SCHEMA } },
  });
  if (res.status !== "completed") throw new Error(`${model} returned status ${res.status}`);
  return JSON.parse(res.output_text) as Materials;
}

export async function generateMaterials(
  turns: Turn[],
  ctx: LessonContext,
  opts: { apiKey: string; baseURL?: string; diagram?: DiagramContext },
): Promise<GenerateResult> {
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL ?? "https://api.meta.ai/v1" });
  const input = buildInput(turns, ctx, opts.diagram);
  const t0 = Date.now();
  let model: string = MODELS.generation;
  let materials: Materials;
  try {
    materials = await callModel(client, model, input);
  } catch (err) {
    console.warn(`[generate] ${model} failed, falling back to ${MODELS.generationFallback}:`, err);
    model = MODELS.generationFallback;
    materials = await callModel(client, model, input);
  }
  return { materials: normalize(materials, opts.diagram), model, seconds: Math.round((Date.now() - t0) / 100) / 10 };
}
