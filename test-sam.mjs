// Day 5 test: SAM 3.1 segmentation via the Responses API (one concept per request).
// Usage: node --env-file=.env.local test-sam.mjs <image> [phrase ...] [--model=sam-3.1]
//   e.g. node --env-file=.env.local test-sam.mjs test-images/slide-articles.png diagram chart
// Writes <image dir>/sam-result.html (boxes drawn on the image; loads the image from the same folder)
// and sam-result.json (raw responses).
import OpenAI from "openai";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const [imagePath, ...rest] = args.filter((a) => !a.startsWith("--"));
if (!imagePath) {
  console.error("Usage: node --env-file=.env.local test-sam.mjs <image> [phrase ...] [--model=sam-3.1]");
  process.exit(1);
}
const phrases = rest.length ? rest : ["diagram"];
const candidates = flag("model") ? [flag("model")] : ["sam-3.1", "sam-3-1"];

const client = new OpenAI({
  apiKey: process.env.META_API_KEY,
  baseURL: process.env.META_API_BASE_URL ?? "https://api.meta.ai/v1",
});

const buf = await readFile(imagePath);
const mime =
  { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[path.extname(imagePath).toLowerCase()] ??
  "image/png";
const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
console.log(`image: ${imagePath} — ${(buf.length / 1e6).toFixed(2)} MB (base64 ${(dataUrl.length / 1e6).toFixed(2)} MB)`);

/** Parse "<|box;x1=..;y1=..|><|mask;...|>" tokens. A new detection starts at each box. */
function parse(text) {
  const dets = [];
  for (const m of text.matchAll(/<\|(\w+);([^|]*)\|>/g)) {
    const [, kind, body] = m;
    const fields = {};
    for (const kv of body.split(";")) {
      const i = kv.indexOf("=");
      if (i > 0) fields[kv.slice(0, i)] = kv.slice(i + 1);
    }
    if (kind === "box" || dets.length === 0) dets.push({});
    dets.at(-1)[kind] = fields;
  }
  return dets;
}

const short = (o) =>
  JSON.stringify(o, (k, v) => (typeof v === "string" && v.length > 40 ? `${v.slice(0, 20)}…(${v.length} chars)` : v));

async function segment(model, phrase) {
  return client.responses.create({
    model,
    input: [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: dataUrl },
          { type: "input_text", text: phrase },
        ],
      },
    ],
    metadata: { include_confidence: "true", mask_encoding: "one_bit" },
  });
}

let model;
const results = [];
for (const phrase of phrases) {
  const tryModels = model ? [model] : candidates;
  for (const m of tryModels) {
    const t0 = Date.now();
    try {
      const res = await segment(m, phrase);
      model = m;
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const text = res.output_text ?? "";
      const dets = parse(text);
      console.log(`\n✅ model=${m} (reported ${res.model}) phrase="${phrase}" time=${secs}s detections=${dets.length}`);
      console.log("usage:", JSON.stringify(res.usage));
      console.log("raw output (first 400 chars):", text.slice(0, 400) || "(empty)");
      dets.forEach((d, i) => console.log(`  #${i + 1}`, short(d)));
      results.push({ phrase, model: m, seconds: Number(secs), dets, raw: res });
      break;
    } catch (err) {
      console.error(`\n❌ model=${m} phrase="${phrase}" failed after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      console.error(err?.status, err?.message ?? err);
    }
  }
}

const dir = path.dirname(imagePath);
await writeFile(path.join(dir, "sam-result.json"), JSON.stringify(results, null, 2));
const colors = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#008080"];
const boxes = results.flatMap((r, ri) =>
  r.dets.filter((d) => d.box).map((d) => ({ ...d.box, phrase: r.phrase, color: colors[ri % colors.length] })),
);
await writeFile(
  path.join(dir, "sam-result.html"),
  `<!doctype html><meta charset="utf-8"><title>SAM result</title>
<body style="font:14px sans-serif;margin:16px"><p>${results.map((r, i) => `<b style="color:${colors[i % colors.length]}">${r.phrase}</b>: ${r.dets.length}`).join(" · ")}</p>
<canvas id="c" style="max-width:100%;border:1px solid #ccc"></canvas>
<script>
const boxes=${JSON.stringify(boxes)};const img=new Image();img.onload=()=>{const c=document.getElementById("c");c.width=img.width;c.height=img.height;
const g=c.getContext("2d");g.drawImage(img,0,0);g.lineWidth=4;g.font="bold 22px sans-serif";
for(const b of boxes){const sx=b.w?img.width/b.w:1,sy=b.h?img.height/b.h:1;g.strokeStyle=g.fillStyle=b.color;
g.strokeRect(b.x1*sx,b.y1*sy,(b.x2-b.x1)*sx,(b.y2-b.y1)*sy);g.fillText(b.phrase+(b.c?" "+Number(b.c).toFixed(2):""),b.x1*sx+6,b.y1*sy+24);}};
img.src=${JSON.stringify(path.basename(imagePath))};
</script>`,
);
console.log(`\nwrote ${path.join(dir, "sam-result.html")} and sam-result.json`);
