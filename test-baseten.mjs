// Muse Spark Open on Baseten — checks before building Privacy Mode:
//   node --env-file=.env.local test-baseten.mjs [--model=<slug>] [--image=test-images/pons_test.png]
// 1) lists Muse models  2) plain chat  3) json_schema response_format (docs: not supported)
// 4) JSON by prompt only  5) image input as a base64 data URL
import { readFileSync } from "node:fs";
import OpenAI from "openai";

const key = process.env.BASETEN_API_KEY;
if (!key) { console.error("BASETEN_API_KEY missing from .env.local"); process.exit(1); }
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const client = new OpenAI({ apiKey: key, baseURL: "https://inference.baseten.co/v1" });

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    console.log(`\n✅ ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)\n${out}`);
    return true;
  } catch (e) {
    console.log(`\n❌ ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)\n   ${e.status ?? ""} ${e.message?.slice(0, 400)}`);
    return false;
  }
}
const usage = (r) => `   usage: ${JSON.stringify(r.usage)}`;

let model = arg("model");
await step("List models", async () => {
  const all = [];
  for await (const m of client.models.list()) all.push(m.id);
  const muse = all.filter((id) => /muse|meta/i.test(id));
  model ??= muse.find((id) => /spark-open/i.test(id));
  return `   ${all.length} models; Meta/Muse: ${muse.join(", ") || "(none)"}\n   using: ${model}`;
});
if (!model) { console.error("\nNo Muse Spark Open slug found — pass --model=<slug>"); process.exit(1); }

await step("Plain chat", async () => {
  const r = await client.chat.completions.create({
    model, max_tokens: 2000,
    messages: [{ role: "user", content: "In one sentence: why did Shays' Rebellion worry the founders?" }],
  });
  return `   ${r.choices[0].message.content?.trim()}\n${usage(r)}`;
});

const schema = {
  type: "object", additionalProperties: false, required: ["question", "choices", "answerIndex"],
  properties: { question: { type: "string" }, choices: { type: "array", items: { type: "string" } }, answerIndex: { type: "integer" } },
};
const quizPrompt = "Write one 4-choice quiz question about the Articles of Confederation's inability to collect taxes.";

await step("json_schema response_format", async () => {
  const r = await client.chat.completions.create({
    model, max_tokens: 2000,
    messages: [{ role: "user", content: quizPrompt }],
    response_format: { type: "json_schema", json_schema: { name: "quiz", strict: true, schema } },
  });
  const text = r.choices[0].message.content ?? "";
  return `   parsed: ${JSON.stringify(JSON.parse(text))}\n${usage(r)}`;
});

await step("JSON by prompt only", async () => {
  const r = await client.chat.completions.create({
    model, max_tokens: 2000,
    messages: [
      { role: "system", content: `Reply with only a JSON object matching this JSON Schema — no prose, no code fences:\n${JSON.stringify(schema)}` },
      { role: "user", content: quizPrompt },
    ],
  });
  const text = r.choices[0].message.content ?? "";
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return `   raw starts: ${JSON.stringify(text.slice(0, 80))}\n   parsed: ${JSON.stringify(JSON.parse(json))}\n${usage(r)}`;
});

const imgPath = arg("image") ?? "test-images/pons_test.png";
await step(`Image input (${imgPath})`, async () => {
  const ext = imgPath.toLowerCase().endsWith(".png") ? "png" : "jpeg";
  const dataUrl = `data:image/${ext};base64,${readFileSync(imgPath).toString("base64")}`;
  const r = await client.chat.completions.create({
    model, max_tokens: 2000,
    messages: [{ role: "user", content: [
      { type: "text", text: "List up to 6 concrete objects drawn in this image, one short noun phrase each, comma-separated." },
      { type: "image_url", image_url: { url: dataUrl } },
    ] }],
  });
  return `   ${r.choices[0].message.content?.trim()}\n${usage(r)}`;
});
