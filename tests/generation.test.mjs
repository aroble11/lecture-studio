import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

function loader(provider = {}) {
  const cache = new Map();
  const calls = { clients: [], responses: [], chats: [] };
  const responseQueue = [...(provider.responses ?? [])];
  const chatQueue = [...(provider.chats ?? [])];
  class OpenAI {
    constructor(options) {
      calls.clients.push(options);
      this.responses = { create: async (request) => {
        calls.responses.push(request);
        if (!responseQueue.length) throw new Error("Unexpected Responses API call");
        const value = responseQueue.shift();
        if (value instanceof Error) throw value;
        return value;
      } };
      this.chat = { completions: { create: async (request) => {
        calls.chats.push(request);
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
    (m) => { m.quiz[1].choices[1] = m.quiz[0].choices[1]; },
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
  const result = await generateMaterials(turns, {}, { apiKey: "test" });
  assert.equal(calls.responses.length, 1);
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

test("Privacy Mode retries the same provider after invalid output and accepts a complete JSON fence", async () => {
  const { load, calls } = loader({ chats: [chat({}), chat(`\`\`\`json\n${json(materials())}\n\`\`\``)] });
  const result = await load("lib/generate.ts").generatePrivately(turns, {}, { apiKey: "test" });
  assert.equal(calls.chats.length, 2);
  assert.equal(calls.responses.length, 0);
  assert.equal(result.privacy, true);
});

test("Privacy Mode rejects truncated, filtered, refused, or absent choices", async () => {
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
