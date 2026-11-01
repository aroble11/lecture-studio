// Server-only: turns a timestamped transcript + lesson context into classroom materials with
// Muse Wonder (falls back to Muse Spark on failure). Needs META_API_KEY — never import from client code.
import OpenAI from "openai";
import { GENERATION, MODELS, PRIVACY } from "./config";
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
In student-facing materials (guidedNotes, quiz, exitTicket, bellRinger, diagramNotes), every sentence must state a fact from the lecture on its own. Never refer to "the lesson", "the teacher", "the lecture", "the event" or "this topic" there.

guidedNotes: student fill-in-the-blank notes that follow the lecture in order.
- 1 to 6 sections, each with a short heading. startSec = the [m:ss] timestamp of the transcript line where that section's topic is first discussed, converted to seconds. Sections must be in time order.
- 2 to 6 items per section. Each item is one sentence containing exactly one blank written as "${BLANK}"; "answer" is the key term or fact that fills it.
- Blank only content words a student must learn: key vocabulary, names, dates, causes, effects. Never blank a common word when a key term is available.
- Every answer must be different.
- wordBank: when the teacher profile asks for a word bank or similar language support, list every answer exactly as written, in alphabetical order; otherwise [].
quiz: exactly 5 multiple-choice check-for-understanding questions, 4 choices each (answerIndex is 0-based).
- Exactly one choice is correct. Every other choice must be clearly wrong according to the lecture — never a choice that is also true. Check each distractor against the transcript.
- Do not reuse a choice across questions. Distractors should be plausible to a student who missed the lesson.
- "explanation" says in one sentence why the answer is right.
exitTicket: 1 or 2 short-answer questions that check the lesson objective, each with a brief sampleAnswer.
bellRinger: a 3-5 minute warm-up for the NEXT class that has students recall or apply today's lesson. "teacherNote" says in one sentence how to run it.
diagramNotes: only when a reference image with numbered labeled items is given — one entry per item (n = its number),
a one-sentence student-facing note on that item: connect it to what the lecture taught when the lecture covers it,
otherwise say briefly what it shows. Return [] when no reference image is given.
When a teacher profile is given, follow its style and class notes (reading level, tone, supports such as word banks or sentence starters) wherever they don't conflict with the rules here.
When a reference image is given, you may also use its labeled terms in the guided notes and quiz where the lecture covers them.

Teacher-facing feedback (write to the teacher as "you"; be specific, kind, and brief):
pacingFeedback: 1 to 3 short observations about time use, based on the [m:ss] timestamps — which topics got the most and least time,
and any key idea that was rushed (covered in a few seconds) or ran long. Name the topic and its time. Do not comment on speaking speed.
contentGaps: concepts mentioned but not explained enough for students at this grade — a term used without a definition,
a claim without a cause, effect or example, or a key vocabulary word or part of the lesson objective that was never taught.
The transcript is machine-made: a number, name or phrase that breaks off mid-way is a transcription glitch, not a gap — never report it.
0 to 4 entries, most important first. atSec = the [m:ss] timestamp of the line where the concept comes up, in seconds.
issue = one sentence on what is missing; suggestion = one sentence on what to add next time. Return [] when every concept was explained.`;

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
  const profile = [
    ["Teaching style", ctx.style],
    ["About the class", ctx.classNotes],
  ]
    .filter(([, v]) => v && String(v).trim())
    .map(([k, v]) => `${k}: ${String(v).trim()}`);
  const transcript = turns.map((t) => `[${clock(t.startMs)}] ${t.text}`).join("\n");
  const image = diagram?.items.length
    ? `Reference image: ${diagram.summary}\nLabeled items:\n${diagram.items.map((d) => `${d.n}. ${d.label}`).join("\n")}\n\n`
    : "";
  return `${lines.length ? `Lesson context:\n${lines.join("\n")}\n\n` : ""}${profile.length ? `Teacher profile:\n${profile.join("\n")}\n\n` : ""}${image}Transcript:\n${transcript}`;
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
      if (it.text.includes(BLANK)) {
        // "the Federalist _____" + answer "Federalist Papers" → "the _____" (the answer already holds those words)
        const words = it.answer.trim().split(/\s+/);
        for (let k = words.length - 1; k >= 1; k--) {
          const lead = words.slice(0, k).join(" ");
          const before = `${lead} ${BLANK}`;
          const at = it.text.toLowerCase().indexOf(before.toLowerCase());
          if (at >= 0 && (at === 0 || /\s/.test(it.text[at - 1]))) {
            it.text = it.text.slice(0, at) + BLANK + it.text.slice(at + before.length);
            break;
          }
        }
        continue;
      }
      const i = it.text.toLowerCase().indexOf(it.answer.toLowerCase());
      it.text = i >= 0 ? it.text.slice(0, i) + BLANK + it.text.slice(i + it.answer.length) : `${it.text} ${BLANK}`;
    }
  }
  m.guidedNotes.sections = m.guidedNotes.sections.filter((s) => s.items.length > 0);
  // Keep the word bank honest: exactly the answers that are still in the notes, no extras.
  if (m.guidedNotes.wordBank?.length) {
    const answers = m.guidedNotes.sections.flatMap((s) => s.items.map((it) => it.answer.trim()));
    m.guidedNotes.wordBank = [...new Set(answers)].sort((a, b) => a.localeCompare(b));
  } else {
    m.guidedNotes.wordBank = [];
  }

  m.quiz = m.quiz
    .filter((q) => q.choices.length >= 2 && q.answerIndex >= 0 && q.answerIndex < q.choices.length)
    .slice(0, 5)
    .map((q) => {
      const correct = q.choices[q.answerIndex];
      const choices = shuffle([...q.choices]);
      return { ...q, choices, answerIndex: choices.indexOf(correct) };
    });
  m.exitTicket = m.exitTicket.slice(0, 2);
  m.pacingFeedback = (m.pacingFeedback ?? []).map((f) => f.trim()).filter(Boolean).slice(0, 3);
  m.contentGaps = (m.contentGaps ?? [])
    .filter((g) => g.concept?.trim() && g.issue?.trim())
    .slice(0, 4)
    .map((g) => ({ ...g, atSec: Math.max(0, Math.round(g.atSec || 0)) }));

  const valid = new Set(diagram?.items.map((d) => d.n) ?? []);
  const seen = new Set<number>();
  m.diagramNotes = (m.diagramNotes ?? []).filter((d) => {
    if (!valid.has(d.n) || seen.has(d.n) || !d.note?.trim()) return false;
    seen.add(d.n);
    return true;
  });
  return m;
}

/** Throws when cleanup left a tab empty, so the caller falls back instead of showing a blank tab. */
function assertComplete(model: string, raw: Materials, m: Materials) {
  const problems: string[] = [];
  if (m.guidedNotes.sections.length === 0) problems.push("no guided-notes sections");
  if (m.quiz.length < 3) problems.push(`only ${m.quiz.length} quiz questions`);
  if (m.exitTicket.length === 0) problems.push("no exit ticket");
  if (!m.bellRinger?.prompt?.trim()) problems.push("no bell ringer");
  if (!problems.length) return;
  const rawShape = {
    sections: raw.guidedNotes?.sections?.length ?? 0,
    items: raw.guidedNotes?.sections?.map((s) => s.items?.length ?? 0),
    emptyAnswers: raw.guidedNotes?.sections?.flatMap((s) => s.items ?? []).filter((it) => !it.answer?.trim()).length,
    quiz: raw.quiz?.length ?? 0,
  };
  console.warn(`[generate] ${model} incomplete: ${problems.join(", ")}; raw shape ${JSON.stringify(rawShape)}`);
  throw new Error(`${model} returned incomplete materials (${problems.join(", ")})`);
}

async function callModel(client: OpenAI, model: string, input: string, diagram?: DiagramContext): Promise<Materials> {
  const res = await client.responses.create({
    model,
    reasoning: { effort: GENERATION.effort },
    max_output_tokens: GENERATION.maxOutputTokens,
    instructions: INSTRUCTIONS,
    input,
    text: { format: { type: "json_schema", name: "materials", strict: true, schema: MATERIALS_SCHEMA } },
  });
  if (res.status !== "completed") throw new Error(`${model} returned status ${res.status}`);
  const raw = JSON.parse(res.output_text) as Materials;
  const materials = normalize(structuredClone(raw), diagram);
  assertComplete(model, raw, materials);
  return materials;
}

/** Privacy Mode call: Chat Completions on Baseten. Docs say Spark Open lacks structured outputs, but json_schema
 *  worked in testing — parse defensively anyway (strip prose/code fences around the object). */
async function callOpenModel(client: OpenAI, input: string, diagram?: DiagramContext): Promise<Materials> {
  const res = await client.chat.completions.create({
    model: PRIVACY.model,
    max_tokens: PRIVACY.maxOutputTokens,
    reasoning_effort: PRIVACY.effort,
    messages: [
      {
        role: "system",
        content: `${INSTRUCTIONS}\n\nReply with only one JSON object that matches this JSON Schema — no prose, no code fences:\n${JSON.stringify(MATERIALS_SCHEMA)}`,
      },
      { role: "user", content: input },
    ],
    response_format: { type: "json_schema", json_schema: { name: "materials", strict: true, schema: MATERIALS_SCHEMA } },
  });
  const choice = res.choices[0];
  if (choice?.finish_reason === "length") throw new Error(`${PRIVACY.model} ran out of output tokens`);
  const text = choice?.message.content ?? "";
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`${PRIVACY.model} returned no JSON`);
  const raw = JSON.parse(text.slice(start, end + 1)) as Materials;
  // Schema isn't guaranteed here — make the shape safe for normalize() before trusting it.
  raw.guidedNotes ??= { title: "", sections: [], wordBank: [] };
  raw.guidedNotes.sections = Array.isArray(raw.guidedNotes.sections) ? raw.guidedNotes.sections : [];
  for (const s of raw.guidedNotes.sections) s.items = Array.isArray(s.items) ? s.items.filter((it) => typeof it?.text === "string" && typeof it?.answer === "string") : [];
  raw.quiz = (Array.isArray(raw.quiz) ? raw.quiz : []).filter((q) => Array.isArray(q?.choices) && Number.isInteger(q?.answerIndex));
  raw.exitTicket = Array.isArray(raw.exitTicket) ? raw.exitTicket : [];
  const materials = normalize(structuredClone(raw), diagram);
  assertComplete(PRIVACY.model, raw, materials);
  return materials;
}

/** Privacy Mode: the transcript goes only to the open-weight model. One retry on the same model, never Meta's API. */
export async function generatePrivately(
  turns: Turn[],
  ctx: LessonContext,
  opts: { apiKey: string; diagram?: DiagramContext },
): Promise<GenerateResult> {
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: PRIVACY.baseURL });
  const input = buildInput(turns, ctx, opts.diagram);
  const t0 = Date.now();
  let materials: Materials;
  try {
    materials = await callOpenModel(client, input, opts.diagram);
  } catch (err) {
    console.warn(`[generate] ${PRIVACY.model} failed, retrying once (Privacy Mode — no Meta fallback):`, err);
    materials = await callOpenModel(client, input, opts.diagram);
  }
  return { materials, model: PRIVACY.label, seconds: Math.round((Date.now() - t0) / 100) / 10, privacy: true };
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
    materials = await callModel(client, model, input, opts.diagram);
  } catch (err) {
    console.warn(`[generate] ${model} failed, falling back to ${MODELS.generationFallback}:`, err);
    model = MODELS.generationFallback;
    materials = await callModel(client, model, input, opts.diagram);
  }
  return { materials, model, seconds: Math.round((Date.now() - t0) / 100) / 10 };
}
