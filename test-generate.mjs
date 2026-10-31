// Day 4 test: does the generation model return schema-valid JSON?
// Usage: node --env-file=.env.local test-generate.mjs [--model=muse-spark-1.3] [--effort=low]
import OpenAI from "openai";

const arg = (name, def) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? def;
const model = arg("model", "muse-wonder-1.0");
const effort = arg("effort", "low");

const client = new OpenAI({
  apiKey: process.env.META_API_KEY,
  baseURL: process.env.META_API_BASE_URL ?? "https://api.meta.ai/v1",
});

const transcript = `[0:00] Today we're looking at why the Articles of Confederation failed.
[0:08] Congress couldn't tax, so it couldn't pay soldiers or its war debts.
[0:15] In 1786 farmers in Massachusetts led by Daniel Shays rebelled over debts and taxes.
[0:24] Shays' Rebellion scared leaders into calling the Constitutional Convention in 1787.`;

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["exitTicket", "quiz"],
  properties: {
    exitTicket: { type: "string" },
    quiz: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "choices", "answerIndex"],
        properties: {
          question: { type: "string" },
          choices: { type: "array", items: { type: "string" } },
          answerIndex: { type: "integer" },
        },
      },
    },
  },
};

const t0 = Date.now();
try {
  const res = await client.responses.create({
    model,
    reasoning: { effort },
    max_output_tokens: 4000,
    instructions: "You write classroom materials for a high-school teacher from their lecture transcript.",
    input: `Transcript:\n${transcript}\n\nWrite one exit-ticket question and a 2-question multiple-choice quiz.`,
    text: { format: { type: "json_schema", name: "materials", strict: true, schema } },
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`model=${res.model} status=${res.status} time=${secs}s`);
  console.log("usage:", JSON.stringify(res.usage));
  const parsed = JSON.parse(res.output_text);
  console.log("✅ valid JSON:\n" + JSON.stringify(parsed, null, 2));
} catch (err) {
  console.error(`❌ ${model} failed after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.error(err?.status, err?.message ?? err);
}
