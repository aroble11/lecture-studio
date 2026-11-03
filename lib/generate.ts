// Server-only: turns a timestamped transcript + lesson context into classroom materials with
// Muse Wonder (falls back to Muse Spark on failure). Needs META_API_KEY — never import from client code.
import OpenAI from "openai";
import { GENERATION, MODELS, PRIVACY } from "./config";
import type { DiagramContext } from "./diagram";
import type { Turn } from "./meta-asr";
import { MATERIALS_SCHEMA, type GenerateResult, type LessonContext, type Materials } from "./materials";
import { InvalidMaterialsError, parseGeneratedJson, repairMaterials, validateMaterials } from "./materials-validation";

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
- 1 to 6 items per section. Each item is one sentence containing exactly one blank written as "${BLANK}"; "answer" is the key term or fact that fills it.
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

function findWholePhrase(text: string, phrase: string) {
  const haystack = text.toLocaleLowerCase();
  const needle = phrase.toLocaleLowerCase();
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    const before = at === 0 ? "" : text[at - 1];
    const after = at + phrase.length >= text.length ? "" : text[at + phrase.length];
    if ((!before || !/[\p{L}\p{N}]/u.test(before)) && (!after || !/[\p{L}\p{N}]/u.test(after))) return at;
    at = haystack.indexOf(needle, at + 1);
  }
  return -1;
}

/** Cleanup only after the untrusted provider response passes validation. */
function normalize(m: Materials, repairs: string[]): Materials {
  for (const s of m.guidedNotes.sections) {
    s.items = s.items.filter((it) => {
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
        return true;
      }
      const i = findWholePhrase(it.text, it.answer);
      if (i < 0) {
        // Ungrounded: the answer is not in its sentence, so no blank can be made. Drop just this item.
        if (!repairs.includes("ungrounded note item dropped")) repairs.push("ungrounded note item dropped");
        return false;
      }
      it.text = it.text.slice(0, i) + BLANK + it.text.slice(i + it.answer.length);
      return true;
    });
  }
  m.guidedNotes.sections = m.guidedNotes.sections.filter((s) => s.items.length);
  if (!m.guidedNotes.sections.length) throw new InvalidMaterialsError("guided note answer is absent from its sentence");
  // Keep the word bank honest: exactly the answers that are still in the notes, no extras.
  if (m.guidedNotes.wordBank.length) {
    const answers = m.guidedNotes.sections.flatMap((s) => s.items.map((it) => it.answer.trim()));
    m.guidedNotes.wordBank = [...answers].sort((a, b) => a.localeCompare(b));
  } else {
    m.guidedNotes.wordBank = [];
  }

  m.quiz = m.quiz.map((q) => {
      const correct = q.choices[q.answerIndex];
      const choices = shuffle([...q.choices]);
      return { ...q, choices, answerIndex: choices.indexOf(correct) };
    });
  return m;
}

/** Models sometimes stamp every section 0:00 (Spark Open at low effort did). Check each section against the
 *  transcript: it can't start before the first line that contains one of its answers. Keeps time order. */
function fixSectionTimes(m: Materials, turns: Turn[]) {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const lines = turns.map((t) => ({ sec: Math.floor(t.startMs / 1000), text: ` ${norm(t.text)} ` }));
  let prev = 0;
  for (const s of m.guidedNotes.sections) {
    const hits = s.items
      .map((it) => norm(it.answer))
      .filter(Boolean)
      .map((a) => lines.find((l) => l.text.includes(` ${a} `))?.sec)
      .filter((sec): sec is number => sec !== undefined);
    const earliest = hits.length ? Math.min(...hits) : undefined;
    // Trust the model unless its time is earlier than where the section's content first appears.
    if (earliest !== undefined && earliest > s.startSec) s.startSec = earliest;
    s.startSec = Math.max(prev, s.startSec);
    prev = s.startSec;
  }
}

function finish(raw: unknown, turns: Turn[], diagram: DiagramContext | undefined, model: string): Materials {
  const { materials: repaired, repairs } = repairMaterials(raw, turns, diagram);
  const materials = normalize(validateMaterials(repaired, turns, diagram), repairs);
  fixSectionTimes(materials, turns);
  const final = validateMaterials(materials, turns, diagram, true);
  // Rule names only, never content: shows how often each repair is needed.
  if (repairs.length) console.info(`[generate] ${model} output repaired: ${repairs.join("; ")}`);
  return final;
}

/** Log line for a failed attempt: the broken rule for invalid output, never generated content. */
function failureReason(err: unknown): string {
  if (err instanceof InvalidMaterialsError) return `invalid output (${err.rule})`;
  return err instanceof Error ? err.message : "unknown error";
}

/** Retry input: when output broke a rule, tell the next attempt which one. */
function withFeedback(input: string, err: unknown): string {
  if (!(err instanceof InvalidMaterialsError)) return input;
  return `${input}\n\nA previous attempt was rejected by validation (${err.rule}). Follow every rule in the instructions and return one complete JSON object.`;
}

async function callModel(client: OpenAI, model: string, input: string, turns: Turn[], signal?: AbortSignal, diagram?: DiagramContext): Promise<Materials> {
  const res = await client.responses.create({
    model,
    reasoning: { effort: GENERATION.effort },
    max_output_tokens: GENERATION.maxOutputTokens,
    instructions: INSTRUCTIONS,
    input,
    text: { format: { type: "json_schema", name: "materials", strict: true, schema: MATERIALS_SCHEMA } },
  }, { signal });
  if (res.status !== "completed") throw new Error(`${model} returned status ${res.status}`);
  return finish(parseGeneratedJson(res.output_text), turns, diagram, model);
}

/** Open-weight generation call: Chat Completions on Baseten. Accept only a complete JSON object or one complete JSON fence. */
async function callOpenModel(client: OpenAI, input: string, turns: Turn[], signal?: AbortSignal, diagram?: DiagramContext): Promise<Materials> {
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
  }, { signal });
  const choice = res.choices[0];
  if (!choice || choice.finish_reason !== "stop") {
    throw new Error(`${PRIVACY.model} returned finish reason ${choice?.finish_reason ?? "missing"}`);
  }
  if (choice.message.refusal) throw new Error(`${PRIVACY.model} refused the request`);
  return finish(parseGeneratedJson(choice.message.content), turns, diagram, PRIVACY.model);
}

/** Open-weight generation: one retry on the same model, never Meta's generation API. */
export async function generatePrivately(
  turns: Turn[],
  ctx: LessonContext,
  opts: { apiKey: string; diagram?: DiagramContext; signal?: AbortSignal },
): Promise<GenerateResult> {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: PRIVACY.baseURL,
    maxRetries: 0,
    timeout: GENERATION.providerTimeoutMs,
  });
  const input = buildInput(turns, ctx, opts.diagram);
  const t0 = Date.now();
  let materials: Materials;
  try {
    materials = await callOpenModel(client, input, turns, opts.signal, opts.diagram);
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    console.warn(`[generate] ${PRIVACY.model} failed: ${failureReason(err)}; retrying once (open-weight generation — no Meta fallback)`);
    materials = await callOpenModel(client, withFeedback(input, err), turns, opts.signal, opts.diagram);
  }
  return { materials, model: PRIVACY.label, seconds: Math.round((Date.now() - t0) / 100) / 10, privacy: true };
}

export async function generateMaterials(
  turns: Turn[],
  ctx: LessonContext,
  opts: { apiKey: string; baseURL?: string; diagram?: DiagramContext; signal?: AbortSignal },
): Promise<GenerateResult> {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL ?? "https://api.meta.ai/v1",
    maxRetries: 0,
    timeout: GENERATION.providerTimeoutMs,
  });
  const input = buildInput(turns, ctx, opts.diagram);
  const t0 = Date.now();
  let model: string = MODELS.generation;
  let materials: Materials;
  try {
    materials = await callModel(client, model, input, turns, opts.signal, opts.diagram);
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    console.warn(`[generate] ${model} failed: ${failureReason(err)}; falling back to ${MODELS.generationFallback}`);
    model = MODELS.generationFallback;
    materials = await callModel(client, model, withFeedback(input, err), turns, opts.signal, opts.diagram);
  }
  return { materials, model, seconds: Math.round((Date.now() - t0) / 100) / 10 };
}
