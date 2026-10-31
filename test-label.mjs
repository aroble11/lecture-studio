// Day 5 test: Muse Wonder looks at an image and names the concrete objects worth labeling,
// then SAM 3.1 finds each one (one request per object, in parallel).
// Usage: node --env-file=.env.local test-label.mjs <image> [--topic="lesson topic"] [--model=muse-wonder-1.0] [--effort=low]
// Writes <image dir>/label-result.html (numbered boxes + key) and label-result.json.
import OpenAI from "openai";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const [imagePath] = args.filter((a) => !a.startsWith("--"));
if (!imagePath) {
  console.error('Usage: node --env-file=.env.local test-label.mjs <image> [--topic="..."] [--effort=low]');
  process.exit(1);
}
const visionModel = flag("model", "muse-wonder-1.0");
const effort = flag("effort", "low");
const topic = flag("topic", "");
const SAM = "sam-3.1";

const client = new OpenAI({
  apiKey: process.env.META_API_KEY,
  baseURL: process.env.META_API_BASE_URL ?? "https://api.meta.ai/v1",
});

const buf = await readFile(imagePath);
const mime =
  { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[path.extname(imagePath).toLowerCase()] ??
  "image/png";
const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
console.log(`image: ${imagePath} — base64 ${(dataUrl.length / 1e6).toFixed(2)} MB`);

// ---- 1. Wonder: what's in the image, and which objects are worth labeling? ----
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "summary", "objects"],
  properties: {
    kind: { type: "string", enum: ["objects", "mostly_text"] },
    summary: { type: "string" },
    objects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["phrase", "label", "approxBox"],
        properties: {
          phrase: { type: "string" },
          label: { type: "string" },
          approxBox: {
            type: "object",
            additionalProperties: false,
            required: ["x1", "y1", "x2", "y2"],
            properties: { x1: { type: "integer" }, y1: { type: "integer" }, x2: { type: "integer" }, y2: { type: "integer" } },
          },
        },
      },
    },
  },
};
const instructions = `You help a teacher turn a reference image into a "label the diagram" activity.
An object detector will search the image for each "phrase" you give. It only finds concrete, visible things
named by a short noun (1-3 words, singular, e.g. "skull", "necklace", "keyboard", "heart"). It cannot find
text, handwriting, tables, layout regions, or abstract ideas.
Return up to 6 distinct objects that are clearly visible and worth labeling for students. Each item is ONE object
(if a picture shows a shirt and shorts, pick the main one or list them as separate items). "label" is the term
students should write (can be more specific than the phrase). Do not list the same thing twice.
"approxBox" is your rough location of that one object, in coordinates normalized 0-1000
(x1,y1 = top-left, x2,y2 = bottom-right; 0,0 is the image's top-left corner, 1000,1000 its bottom-right).
The detector may find several matches for a phrase; your box decides which one is meant.
Set kind to "mostly_text" (and objects to []) if the image is mainly writing with no drawn or photographed objects.
"summary" is one sentence describing the image.`;

let t0 = Date.now();
const vis = await client.responses.create({
  model: visionModel,
  reasoning: { effort },
  max_output_tokens: 4000,
  instructions,
  input: [
    {
      role: "user",
      content: [
        { type: "input_image", image_url: dataUrl },
        { type: "input_text", text: topic ? `Lesson topic: ${topic}` : "No lesson topic given." },
      ],
    },
  ],
  text: { format: { type: "json_schema", name: "labels", strict: true, schema } },
});
const plan = JSON.parse(vis.output_text);
console.log(`\n① ${vis.model} (${effort}) in ${((Date.now() - t0) / 1000).toFixed(1)}s — usage ${JSON.stringify(vis.usage)}`);
console.log(JSON.stringify(plan, null, 2));

// ---- 2. SAM: find each object (parallel, one concept per request) ----
const parseBoxes = (text) =>
  [...text.matchAll(/<\|box;([^|>]*)\|>/g)].map((m) =>
    Object.fromEntries(m[1].split(";").map((kv) => kv.split("=")).map(([k, v]) => [k, Number(v)])),
  );

/** Normalize a SAM box to 0-1000 and pick the one that best matches Wonder's rough box. */
const norm = (b) => ({ x1: (b.x1 / b.w) * 1000, y1: (b.y1 / b.h) * 1000, x2: (b.x2 / b.w) * 1000, y2: (b.y2 / b.h) * 1000 });
const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy, area = (r) => (r.x2 - r.x1) * (r.y2 - r.y1);
  return inter / (area(a) + area(b) - inter || 1);
};
const dist = (a, b) => Math.hypot((a.x1 + a.x2 - b.x1 - b.x2) / 2, (a.y1 + a.y2 - b.y1 - b.y2) / 2);
function pick(all, approx) {
  if (!all.length) return { boxes: [], iou: 0 };
  const scored = all.map((b) => ({ b, iou: iou(norm(b), approx), d: dist(norm(b), approx) }));
  scored.sort((p, q) => q.iou - p.iou || p.d - q.d);
  return { boxes: [scored[0].b], iou: Number(scored[0].iou.toFixed(2)) };
}

t0 = Date.now();
const found = await Promise.all(
  plan.objects.map(async (o, i) => {
    try {
      const res = await client.responses.create({
        model: SAM,
        input: [{ role: "user", content: [{ type: "input_image", image_url: dataUrl }, { type: "input_text", text: o.phrase }] }],
        metadata: { include_confidence: "true", mask_encoding: "one_bit" },
      });
      const all = parseBoxes(res.output_text ?? "").filter((b) => (b.c ?? 1) >= 0.5);
      return { n: i + 1, ...o, all, ...pick(all, o.approxBox) };
    } catch (err) {
      return { n: i + 1, ...o, boxes: [], error: `${err?.status} ${err?.message}` };
    }
  }),
);
console.log(`\n② ${SAM}: ${found.length} requests in parallel, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const f of found)
  console.log(
    `  ${f.n}. "${f.phrase}" → SAM found ${f.all?.length ?? 0}, kept ${f.boxes.length} (overlap with Wonder's box ${f.iou ?? 0})${f.error ? " ERROR " + f.error : ""}  [label: ${f.label}]`,
  );

// ---- 3. Preview ----
const dir = path.dirname(imagePath);
await writeFile(path.join(dir, "label-result.json"), JSON.stringify({ plan, found }, null, 2));
await writeFile(
  path.join(dir, "label-result.html"),
  `<!doctype html><meta charset="utf-8"><title>Label result</title>
<body style="font:15px sans-serif;margin:16px;display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
<canvas id="c" style="max-width:min(100%,900px);border:1px solid #ccc"></canvas>
<div><p style="color:#555">Red = SAM box kept · dashed blue = Wonder's rough location</p><p><i>${plan.summary.replace(/</g, "&lt;")}</i></p><ol>${found
    .map((f) => `<li><b>${f.label.replace(/</g, "&lt;")}</b> — "${f.phrase.replace(/</g, "&lt;")}", SAM ${f.all?.length ?? 0} → kept ${f.boxes.length}</li>`)
    .join("")}</ol></div>
<script>
const found=${JSON.stringify(found)};const img=new Image();img.onload=()=>{const c=document.getElementById("c");
c.width=img.width;c.height=img.height;const g=c.getContext("2d");g.drawImage(img,0,0);
const r=Math.max(12,img.width/45);g.lineWidth=Math.max(2,img.width/300);g.font="bold "+r*1.2+"px sans-serif";g.textAlign="center";g.textBaseline="middle";
g.setLineDash([8,6]);g.strokeStyle="#1d4ed8";g.lineWidth=Math.max(1,img.width/600);
for(const f of found){const a=f.approxBox;g.strokeRect(a.x1*img.width/1000,a.y1*img.height/1000,(a.x2-a.x1)*img.width/1000,(a.y2-a.y1)*img.height/1000);}
g.setLineDash([]);g.lineWidth=Math.max(2,img.width/300);
for(const f of found)for(const b of f.boxes){const sx=img.width/(b.w||img.width),sy=img.height/(b.h||img.height);
const x1=b.x1*sx,y1=b.y1*sy,x2=b.x2*sx,y2=b.y2*sy;g.strokeStyle="#d62828";g.strokeRect(x1,y1,x2-x1,y2-y1);
g.fillStyle="#d62828";g.beginPath();g.arc(x1,y1,r,0,7);g.fill();g.fillStyle="#fff";g.fillText(f.n,x1,y1+1);}};
img.src=${JSON.stringify(path.basename(imagePath))};
</script>`,
);
console.log(`\nwrote ${path.join(dir, "label-result.html")}`);
