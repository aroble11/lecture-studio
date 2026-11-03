import { MATERIALS_SCHEMA, type Materials } from "./materials";
import type { DiagramContext } from "./diagram";
import type { Turn } from "./meta-asr";

type Schema = { type: string; properties?: Record<string, unknown>; required?: string[]; items?: unknown };

/** Generated output broke a rule. `rule` names the rule or field path only — never content — so it
 * is safe to log and to send back to the model as retry feedback. */
export class InvalidMaterialsError extends Error {
  rule: string;
  constructor(rule: string) {
    super(`Invalid generated materials: ${rule}`);
    this.name = "InvalidMaterialsError";
    this.rule = rule;
  }
}
function invalid(path: string): never { throw new InvalidMaterialsError(path); }
const BLANK = "_____";

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

/** Fix recoverable deviations instead of discarding a whole paid generation. Structure, types and
 * text bounds stay strict (checked first). This only trims surplus entries, clamps and orders
 * timestamps, standardizes blanks, and drops individual note items or diagram notes that cannot be
 * used; anything still wrong is left for validateMaterials to reject. Returns the repairs made as
 * rule names (never content) so callers can log how often each happens. */
export function repairMaterials(value: unknown, turns: Turn[], diagram?: DiagramContext): { materials: Materials; repairs: string[] } {
  const m = check(MATERIALS_SCHEMA, value, "materials") as Materials;
  const repairs: string[] = [];
  const note = (rule: string) => { if (!repairs.includes(rule)) repairs.push(rule); };
  const trim = <T>(items: T[], max: number, rule: string): T[] => {
    if (items.length <= max) return items;
    note(rule);
    return items.slice(0, max);
  };
  const endSec = Math.ceil(Math.max(0, ...turns.map((t) => t.endMs)) / 1000);
  const clamp = (n: number, rule: string) => {
    const fixed = Math.min(endSec, Math.max(0, n));
    if (fixed !== n) note(rule);
    return fixed;
  };

  const answers = new Set<string>();
  let previous = 0;
  for (const s of m.guidedNotes.sections) {
    s.startSec = clamp(s.startSec, "section timestamp clamped");
    if (s.startSec < previous) { s.startSec = previous; note("section timestamp reordered"); }
    previous = s.startSec;
    s.items = trim(s.items.filter((item) => {
      const blanks = item.text.match(/_{3,}/g) ?? [];
      if (blanks.length > 1) { note("note item with several blanks dropped"); return false; }
      if (blanks.length === 1 && blanks[0] !== BLANK) { item.text = item.text.replace(/_{3,}/, BLANK); note("blank standardized"); }
      const key = canonical(item.answer);
      if (answers.has(key)) { note("duplicate note answer dropped"); return false; }
      answers.add(key);
      return true;
    }), 6, "surplus note items trimmed");
  }
  const sections = m.guidedNotes.sections.filter((s) => s.items.length);
  if (sections.length !== m.guidedNotes.sections.length) note("empty note section dropped");
  m.guidedNotes.sections = trim(sections, 6, "surplus note sections trimmed");
  m.guidedNotes.wordBank = trim(m.guidedNotes.wordBank, 36, "surplus word bank entries trimmed");
  m.quiz = trim(m.quiz, 5, "surplus quiz questions trimmed");
  m.exitTicket = trim(m.exitTicket, 2, "surplus exit tickets trimmed");
  m.pacingFeedback = trim(m.pacingFeedback, 3, "surplus pacing feedback trimmed");
  m.contentGaps = trim(m.contentGaps, 4, "surplus content gaps trimmed");
  for (const gap of m.contentGaps) gap.atSec = clamp(gap.atSec, "content gap timestamp clamped");

  const expected = new Set(diagram?.items.map((i) => i.n) ?? []);
  const kept = new Set<number>();
  const notes = m.diagramNotes.filter((n) => expected.has(n.n) && !kept.has(n.n) && kept.add(n.n));
  if (notes.length !== m.diagramNotes.length) note("unexpected diagram note dropped");
  m.diagramNotes = notes;
  return { materials: m, repairs };
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
  // A choice may repeat across questions (for example "True" or a year); only within one question is it ambiguous.
  for (const q of m.quiz) {
    count(q.choices, 4, 4, "quiz choices");
    if (q.answerIndex < 0 || q.answerIndex >= q.choices.length) invalid("quiz answerIndex");
    if (new Set(q.choices.map(canonical)).size !== 4) invalid("duplicate quiz choices");
  }
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
