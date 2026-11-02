import { MATERIALS_SCHEMA, type Materials } from "./materials";
import type { DiagramContext } from "./diagram";
import type { Turn } from "./meta-asr";

type Schema = { type: string; properties?: Record<string, unknown>; required?: string[]; items?: unknown };
function invalid(path: string): never { throw new Error(`Invalid generated materials: ${path}`); }

/** Use the same structural schema sent to providers; return a clean copy with trimmed strings.
 * Provider-side structured output is not a substitute for validating an untrusted response.
 */
function check(schema: unknown, value: unknown, path: string): unknown {
  const s = schema as Schema;
  switch (s.type) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path);
      const record = value as Record<string, unknown>;
      const properties = s.properties!;
      if (Object.keys(record).some((k) => !Object.hasOwn(properties, k))) invalid(`${path}: unexpected field`);
      return Object.fromEntries(s.required!.map((k) => [k, check(properties[k], record[k], `${path}.${k}`)]));
    }
    case "array":
      if (!Array.isArray(value) || value.length > 100) invalid(path);
      return value.map((v, i) => check(s.items, v, `${path}[${i}]`));
    case "string":
      if (typeof value !== "string" || !value.trim() || value.length > 4000) invalid(path);
      return value.trim();
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) invalid(path);
      return value;
    default: return invalid(`${path}: unknown schema`);
  }
}
const canonical = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
function count(items: unknown[], min: number, max: number, path: string) {
  if (items.length < min || items.length > max) invalid(`${path}: expected ${min}–${max} entries`);
}

export function parseGeneratedJson(text: unknown): unknown {
  if (typeof text !== "string" || text.length > 250_000) invalid("response text");
  const clean = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(clean);
  try { return JSON.parse(fenced ? fenced[1] : clean); }
  catch { return invalid("response JSON"); }
}

/** Both providers pass this before cleanup and again after cleanup/timestamp correction. */
export function validateMaterials(value: unknown, turns: Turn[], diagram?: DiagramContext, final = false): Materials {
  const m = check(MATERIALS_SCHEMA, value, "materials") as Materials;
  const endSec = Math.ceil(Math.max(0, ...turns.map((t) => t.endMs)) / 1000);
  const time = (n: number, path: string) => { if (n < 0 || n > endSec) invalid(path); };
  count(m.guidedNotes.sections, 1, 6, "guidedNotes.sections");
  if (m.guidedNotes.title.length > 200) invalid("guidedNotes.title");
  const answers: string[] = [];
  let previous = 0;
  for (const s of m.guidedNotes.sections) {
    if (s.heading.length > 200) invalid("section heading");
    time(s.startSec, "section timestamp");
    if (s.startSec < previous) invalid("section timestamp order");
    previous = s.startSec;
    count(s.items, 1, 6, "section.items");
    for (const item of s.items) {
      if (item.answer.length > 200) invalid("guided note answer");
      const blanks = item.text.match(/_{3,}/g) ?? [];
      if (blanks.length > 1 || (blanks.length === 1 && blanks[0] !== "_____") || (final && blanks.length !== 1)) {
        invalid("guided note: expected exactly one _____ blank");
      }
      answers.push(canonical(item.answer));
    }
  }
  if (new Set(answers).size !== answers.length) invalid("duplicate guided note answers");
  count(m.guidedNotes.wordBank, 0, 36, "wordBank");
  if (final && m.guidedNotes.wordBank.length &&
      (m.guidedNotes.wordBank.length !== answers.length || new Set(m.guidedNotes.wordBank.map(canonical)).size !== answers.length ||
       m.guidedNotes.wordBank.some((w) => !answers.includes(canonical(w))))) {
    invalid("wordBank answers");
  }
  count(m.quiz, 5, 5, "quiz");
  const quizChoices: string[] = [];
  for (const q of m.quiz) {
    count(q.choices, 4, 4, "quiz choices");
    if (q.answerIndex < 0 || q.answerIndex >= q.choices.length) invalid("quiz answerIndex");
    if (new Set(q.choices.map(canonical)).size !== 4) invalid("duplicate quiz choices");
    quizChoices.push(...q.choices.map(canonical));
  }
  if (new Set(quizChoices).size !== quizChoices.length) invalid("quiz choice reused across questions");
  count(m.exitTicket, 1, 2, "exitTicket");
  count(m.pacingFeedback, 1, 3, "pacingFeedback");
  count(m.contentGaps, 0, 4, "contentGaps");
  for (const gap of m.contentGaps) time(gap.atSec, "content gap timestamp");
  const expected = new Set(diagram?.items.map((i) => i.n) ?? []);
  count(m.diagramNotes, expected.size, expected.size, "diagramNotes");
  const seen = new Set<number>();
  for (const note of m.diagramNotes) {
    if (!expected.has(note.n) || seen.has(note.n)) invalid("diagram note number");
    seen.add(note.n);
  }
  return m;
}
