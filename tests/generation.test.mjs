import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

function loader(provider = {}) {
  const cache = new Map();
  const calls = { clients: [], responses: [], responseOptions: [], chats: [], chatOptions: [] };
  const responseQueue = [...(provider.responses ?? [])];
  const chatQueue = [...(provider.chats ?? [])];
  class OpenAI {
    constructor(options) {
      calls.clients.push(options);
      this.responses = { create: async (request, options) => {
        calls.responses.push(request);
        calls.responseOptions.push(options);
        if (!responseQueue.length) throw new Error("Unexpected Responses API call");
        const value = responseQueue.shift();
        if (value instanceof Error) throw value;
        return value;
      } };
      this.chat = { completions: { create: async (request, options) => {
        calls.chats.push(request);
        calls.chatOptions.push(options);
        if (!chatQueue.length) throw new Error("Unexpected Chat Completions call");
        const value = chatQueue.shift();
        if (value instanceof Error) throw value;
        return value;
      } } };
    }
  }
  function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file).exports;
    const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const compiled = { exports: {} };
    cache.set(file, compiled);
    vm.runInNewContext(source, {
      module: compiled, exports: compiled.exports, process: { env: {} }, console, Buffer,
      require(name) {
        if (name === "openai") return { default: OpenAI };
        if (name.startsWith("./") || name.startsWith("../")) {
          const resolved = path.resolve(path.dirname(file), name);
          return load(path.extname(resolved) ? resolved : `${resolved}.ts`);
        }
        throw new Error(`Unexpected dependency: ${name}`);
      },
    });
    return compiled.exports;
  }
  return { load, calls };
}

const turns = [
  { startMs: 0, endMs: 10_000, text: "The Constitution created three branches." },
  { startMs: 30_000, endMs: 50_000, text: "Federalism divides power between levels of government." },
];

function materials({ blank = true, diagram = [] } = {}) {
  return {
    guidedNotes: {
      title: "Government Notes",
      sections: [{
        heading: "Federalism", startSec: 0,
        items: [{
          text: blank ? "_____ divides power between levels of government." : "Federalism divides power between levels of government.",
          answer: "Federalism",
        }],
      }],
      wordBank: [],
    },
    quiz: Array.from({ length: 5 }, (_, i) => ({
      question: `Question ${i + 1}?`,
      choices: [`Correct ${i + 1}`, `Distractor ${i + 1}A`, `Distractor ${i + 1}B`, `Distractor ${i + 1}C`],
      answerIndex: 0,
      explanation: `Correct ${i + 1} follows the transcript.`,
    })),
    exitTicket: [{ question: "How is power divided?", sampleAnswer: "Power is divided between levels." }],
    bellRinger: { prompt: "Name the levels of government.", teacherNote: "Give students three minutes." },
    diagramNotes: diagram,
    pacingFeedback: ["You spent the most time on federalism."],
    contentGaps: [],
  };
}

const json = (value) => JSON.stringify(value);
const response = (value, status = "completed") => ({ status, output_text: typeof value === "string" ? value : json(value) });
const chat = (value, finish_reason = "stop", refusal = null) => ({
  choices: [{ finish_reason, message: { content: typeof value === "string" ? value : json(value), refusal } }],
});

test("strict structural validation accepts a complete materials object and trims strings", () => {
  const { validateMaterials } = loader().load("lib/materials-validation.ts");
  const value = materials();
  value.guidedNotes.title = "  Government Notes  ";
  assert.equal(validateMaterials(value, turns, undefined, true).guidedNotes.title, "Government Notes");
});

test("parser accepts an exact JSON object or one complete JSON fence only", () => {
  const { parseGeneratedJson } = loader().load("lib/materials-validation.ts");
  assert.equal(parseGeneratedJson('{"ok":true}').ok, true);
  assert.equal(parseGeneratedJson('```json\n{"ok":true}\n```').ok, true);
  for (const bad of [null, "prose {\"ok\":true}", "{\"ok\":true} trailing", "```json\n{}\n``` trailing"]) {
    assert.throws(() => parseGeneratedJson(bad), /Invalid generated materials/);
  }
});

test("validator rejects malformed, incomplete, oversized, or ambiguous materials", () => {
  const { validateMaterials } = loader().load("lib/materials-validation.ts");
  const cases = [
    (m) => { delete m.bellRinger; },
    (m) => { m.extra = true; },
    (m) => { m.guidedNotes.sections = []; },
    (m) => { m.guidedNotes.sections[0].items[0].text = "_____ and _____"; },
    (m) => { m.guidedNotes.sections[0].items[0].answer = " "; },
    (m) => { m.guidedNotes.sections[0].startSec = 51; },
    (m) => { m.quiz.length = 4; },
    (m) => { m.quiz[0].choices.length = 3; },
    (m) => { m.quiz[0].answerIndex = 4; },
    (m) => { m.quiz[0].choices[1] = m.quiz[0].choices[0].toUpperCase(); },
    (m) => { m.exitTicket = []; },
    (m) => { m.pacingFeedback = []; },
    (m) => { m.bellRinger.prompt = "x".repeat(4001); },
  ];
  for (const mutate of cases) {
    const value = materials();
    mutate(value);
    assert.throws(() => validateMaterials(value, turns, undefined, true), /Invalid generated materials/);
  }
});

test("a choice may repeat across different quiz questions", () => {
  const { validateMaterials } = loader().load("lib/materials-validation.ts");
  const value = materials();
  value.quiz[1].choices[1] = value.quiz[0].choices[1];
  assert.doesNotThrow(() => validateMaterials(value, turns, undefined, true));
});

const longTurns = [...turns, { startMs: 60_000, endMs: 90_000, text: "Checks and balances limit each branch." }];
function noteItem(answer, text = `_____ is a key idea about ${answer.toLowerCase()}.`) {
  return { text, answer };
}

test("repair trims surplus entries, fixes timestamps and blanks, and drops unusable items without content in its log", () => {
  const { repairMaterials, validateMaterials } = loader().load("lib/materials-validation.ts");
  const value = materials({ diagram: [{ n: 1, note: "The nucleus stores DNA." }, { n: 9, note: "Unexpected." }, { n: 1, note: "Duplicate." }] });
  const diagram = { summary: "A cell", items: [{ n: 1, label: "Nucleus" }] };
  value.guidedNotes.sections = [
    { heading: "Late", startSec: 500, items: [noteItem("Federalism", "______ divides power.")] },
    { heading: "Early", startSec: 10, items: [
      noteItem("Federalism"),
      noteItem("Branches", "_____ and _____ are both blanks."),
      noteItem("Checks"),
    ] },
    { heading: "Only duplicates", startSec: 60, items: [noteItem("checks")] },
  ];
  value.quiz.push({ ...value.quiz[0], question: "Sixth?" });
  value.exitTicket = [1, 2, 3].map((n) => ({ question: `Q${n}?`, sampleAnswer: `A${n}.` }));
  value.pacingFeedback = ["a", "b", "c", "d"];
  value.contentGaps = [1, 2, 3, 4, 5].map((n) => ({ concept: `C${n}`, atSec: n === 1 ? 999 : n, issue: "Missing.", suggestion: "Add it." }));

  const { materials: repaired, repairs } = repairMaterials(value, longTurns, diagram);
  const sections = repaired.guidedNotes.sections;
  assert.deepEqual(sections.map((s) => s.heading), ["Late", "Early"]);
  assert.deepEqual(sections.map((s) => s.startSec), [90, 90]);
  assert.equal(sections[0].items[0].text, "_____ divides power.");
  assert.deepEqual(sections[1].items.map((i) => i.answer), ["Checks"]);
  assert.equal(repaired.quiz.length, 5);
  assert.equal(repaired.exitTicket.length, 2);
  assert.equal(repaired.pacingFeedback.length, 3);
  assert.equal(repaired.contentGaps.length, 4);
  assert.equal(repaired.contentGaps[0].atSec, 90);
  assert.deepEqual(repaired.diagramNotes.map((n) => n.n), [1]);
  assert.doesNotThrow(() => validateMaterials(repaired, longTurns, diagram));
  for (const rule of ["section timestamp clamped", "section timestamp reordered", "blank standardized",
    "note item with several blanks dropped", "duplicate note answer dropped", "empty note section dropped",
    "surplus quiz questions trimmed", "surplus exit tickets trimmed", "surplus pacing feedback trimmed",
    "surplus content gaps trimmed", "content gap timestamp clamped", "unexpected diagram note dropped"]) {
    assert.equal(repairs.includes(rule), true, rule);
  }
  assert.doesNotMatch(repairs.join(" "), /Federalism|Checks|nucleus/i);
});

test("repair never invents missing content: short quizzes and missing diagram notes stay invalid", () => {
  const { repairMaterials, validateMaterials } = loader().load("lib/materials-validation.ts");
  const diagram = { summary: "A cell", items: [{ n: 1, label: "Nucleus" }, { n: 2, label: "Membrane" }] };
  const shortQuiz = materials({ diagram: [{ n: 1, note: "One." }, { n: 2, note: "Two." }] });
  shortQuiz.quiz.length = 4;
  assert.throws(() => validateMaterials(repairMaterials(shortQuiz, turns, diagram).materials, turns, diagram), /quiz/);
  const missingNote = materials({ diagram: [{ n: 1, note: "One." }] });
  assert.throws(() => validateMaterials(repairMaterials(missingNote, turns, diagram).materials, turns, diagram), /diagramNotes/);
  const noUsableNotes = materials();
  noUsableNotes.guidedNotes.sections[0].items[0].text = "_____ and _____";
  assert.throws(() => validateMaterials(repairMaterials(noUsableNotes, turns).materials, turns), /guidedNotes.sections/);
  assert.throws(() => repairMaterials({ ...materials(), extra: true }, turns), /unexpected field/);
});

test("repairable output is accepted on the first call without spending the fallback", async () => {
  const value = materials();
  value.guidedNotes.sections[0].items.push(noteItem("federalism"), noteItem("Separation of powers", "Power is split three ways."));
  value.quiz[1].choices[1] = value.quiz[0].choices[1];
  const { load, calls } = loader({ responses: [response(value)] });
  const result = await load("lib/generate.ts").generateMaterials(turns, {}, { apiKey: "test" });
  assert.equal(calls.responses.length, 1);
  assert.deepEqual([...result.materials.guidedNotes.sections[0].items.map((i) => i.answer)], ["Federalism"]);
});

async function withCapturedLogs(run) {
  const lines = [];
  const original = { warn: console.warn, info: console.info };
  console.warn = (...args) => lines.push(args.map(String).join(" "));
  console.info = (...args) => lines.push(args.map(String).join(" "));
  try { await run(); } finally { Object.assign(console, original); }
  return lines;
}

test("a rejected attempt tells the retry which rule failed and logs only the rule", async () => {
  const bad = materials();
  bad.quiz.length = 4;
  const { load, calls } = loader({ responses: [response(bad), response(materials())] });
  const lines = await withCapturedLogs(() => load("lib/generate.ts").generateMaterials(turns, {}, { apiKey: "test" }));
  assert.equal(calls.responses.length, 2);
  assert.doesNotMatch(calls.responses[0].input, /previous attempt/);
  assert.match(calls.responses[1].input, /previous attempt was rejected by validation \(quiz: expected 5–5 entries\)/);
  assert.match(calls.responses[1].input, /Transcript:/);
  const log = lines.join("\n");
  assert.match(log, /invalid output \(quiz: expected 5–5 entries\)/);
  assert.doesNotMatch(log, /Constitution|Federalism|Question 1/);
});

test("open-weight retries also receive the failed rule", async () => {
  const bad = materials();
  bad.exitTicket = [];
  const { load, calls } = loader({ chats: [chat(bad), chat(materials())] });
  await withCapturedLogs(() => load("lib/generate.ts").generatePrivately(turns, {}, { apiKey: "test" }));
  assert.equal(calls.chats.length, 2);
  assert.match(calls.chats[1].messages[1].content, /rejected by validation \(exitTicket: expected 1–2 entries\)/);
});

test("network failures are retried without validation feedback", async () => {
  const { load, calls } = loader({ responses: [new Error("socket hang up"), response(materials())] });
  await withCapturedLogs(() => load("lib/generate.ts").generateMaterials(turns, {}, { apiKey: "test" }));
  assert.equal(calls.responses.length, 2);
  assert.doesNotMatch(calls.responses[1].input, /previous attempt/);
});

test("validator requires every expected diagram note exactly once", () => {
  const { validateMaterials } = loader().load("lib/materials-validation.ts");
  const diagram = { summary: "A cell", items: [{ n: 1, label: "Nucleus" }, { n: 2, label: "Membrane" }] };
  assert.doesNotThrow(() => validateMaterials(materials({ diagram: [{ n: 1, note: "The nucleus stores DNA." }, { n: 2, note: "The membrane controls entry." }] }), turns, diagram, true));
  assert.throws(() => validateMaterials(materials({ diagram: [{ n: 1, note: "The nucleus stores DNA." }] }), turns, diagram, true));
  assert.throws(() => validateMaterials(materials({ diagram: [{ n: 1, note: "One." }, { n: 3, note: "Three." }] }), turns, diagram, true));
});

test("word banks must contain every note answer exactly once after cleanup", () => {
  const { validateMaterials } = loader().load("lib/materials-validation.ts");
  const value = materials();
  value.guidedNotes.wordBank = ["Federalism"];
  assert.doesNotThrow(() => validateMaterials(value, turns, undefined, true));
  value.guidedNotes.wordBank = ["Federalism", "Federalism"];
  assert.throws(() => validateMaterials(value, turns, undefined, true));
});

test("primary generation repairs a grounded missing blank, fixes its timestamp, and preserves the correct answer while shuffling", async () => {
  const source = materials({ blank: false });
  const correct = source.quiz[0].choices[source.quiz[0].answerIndex];
  const { load, calls } = loader({ responses: [response(source)] });
  const { generateMaterials } = load("lib/generate.ts");
  const controller = new AbortController();
  const result = await generateMaterials(turns, {}, { apiKey: "test", signal: controller.signal });
  assert.equal(calls.responses.length, 1);
  assert.equal(calls.clients[0].maxRetries, 0);
  assert.equal(calls.clients[0].timeout, 135_000);
  assert.equal(calls.responseOptions[0].signal, controller.signal);
  assert.equal(result.materials.guidedNotes.sections[0].items[0].text, "_____ divides power between levels of government.");
  assert.equal(result.materials.guidedNotes.sections[0].startSec, 30);
  assert.equal(result.materials.quiz[0].choices[result.materials.quiz[0].answerIndex], correct);
});

test("an ungrounded missing blank fails validation and triggers the fallback model", async () => {
  const bad = materials({ blank: false });
  bad.guidedNotes.sections[0].items[0].answer = "Separation of powers";
  const { load, calls } = loader({ responses: [response(bad), response(materials())] });
  const result = await load("lib/generate.ts").generateMaterials(turns, {}, { apiKey: "test" });
  assert.equal(calls.responses.length, 2);
  assert.notEqual(calls.responses[0].model, calls.responses[1].model);
  assert.equal(result.model, calls.responses[1].model);
});

test("malformed output from both standard models rejects instead of reaching the UI", async () => {
  const { load } = loader({ responses: [response({}), response("not json")] });
  await assert.rejects(() => load("lib/generate.ts").generateMaterials(turns, {}, { apiKey: "test" }), /Invalid generated materials/);
});

test("an aborted standard generation does not spend its fallback attempt", async () => {
  const controller = new AbortController();
  controller.abort();
  const { load, calls } = loader({ responses: [new Error("cancelled"), response(materials())] });
  await assert.rejects(() => load("lib/generate.ts").generateMaterials(turns, {}, {
    apiKey: "test", signal: controller.signal,
  }), /cancelled/);
  assert.equal(calls.responses.length, 1);
});

test("open-weight generation retries the same provider after invalid output and accepts a complete JSON fence", async () => {
  const { load, calls } = loader({ chats: [chat({}), chat(`\`\`\`json\n${json(materials())}\n\`\`\``)] });
  const result = await load("lib/generate.ts").generatePrivately(turns, {}, { apiKey: "test" });
  assert.equal(calls.chats.length, 2);
  assert.equal(calls.responses.length, 0);
  assert.equal(calls.clients[0].maxRetries, 0);
  assert.equal(calls.clients[0].timeout, 135_000);
  assert.equal(result.privacy, true);
});

test("open-weight generation rejects truncated, filtered, refused, or absent choices", async () => {
  for (const bad of [
    { choices: [] },
    chat(materials(), "length"),
    chat(materials(), "content_filter"),
    chat(materials(), "stop", "refused"),
  ]) {
    const { load } = loader({ chats: [bad, bad] });
    await assert.rejects(() => load("lib/generate.ts").generatePrivately(turns, {}, { apiKey: "test" }));
  }
});
