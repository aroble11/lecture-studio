// Turn a lecture exported from the browser into the public "Try a sample lecture" fixture.
//
//   node scripts/make-sample.mjs <exported-session.json> [--audio <recording.m4a>] [--title "Sample title"]
//
// Writes public/sample/sample-lecture.json (and copies the audio beside it), after checking it with the
// same rules the app uses. The sample is public: the teacher-profile guidance (style, class notes) is removed.
// See docs/SAMPLE-LECTURE.md for the full procedure. Makes no network or provider calls.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const audioPath = option("--audio");
const titleArg = option("--title");
const [exportPath] = args;
if (!exportPath) {
  console.error('Usage: node scripts/make-sample.mjs <exported-session.json> [--audio <recording.m4a>] [--title "Sample title"]');
  process.exit(1);
}

// Load the app's own checks (lib/session-store.ts and lib/sample-lecture.ts) without a build step.
function load(file, require) {
  const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const compiled = { exports: {} };
  vm.runInNewContext(source, { module: compiled, exports: compiled.exports, require, Blob, console });
  return compiled.exports;
}
const store = load("lib/session-store.ts", (name) => { throw new Error(`Unexpected dependency ${name}`); });
const { parseSampleLecture, SAMPLE_FORMAT } = load("lib/sample-lecture.ts", (name) => {
  if (name === "./session-store") return store;
  throw new Error(`Unexpected dependency ${name}`);
});

const exported = JSON.parse(fs.readFileSync(exportPath, "utf8"));
const { audio: _audio, audioRevision: _revision, ...session } = exported;
void _audio; void _revision;
// Public file: drop the teacher's private profile guidance from the recorded generation inputs.
if (session.resultSource?.context) {
  delete session.resultSource.context.style;
  delete session.resultSource.context.classNotes;
}

const outDir = path.join("public", "sample");
fs.mkdirSync(outDir, { recursive: true });
let audio;
if (audioPath) {
  const ext = path.extname(audioPath).toLowerCase();
  if (![".m4a", ".mp3", ".wav", ".webm", ".ogg"].includes(ext)) throw new Error("Sample audio must be .m4a, .mp3, .wav, .webm, or .ogg");
  const target = `sample-lecture${ext}`;
  fs.copyFileSync(audioPath, path.join(outDir, target));
  audio = { url: `/sample/${target}`, label: `Sample lecture${ext}` };
}

const title = titleArg ?? session.result?.materials?.guidedNotes?.title ?? "Sample lecture";
const sample = { format: SAMPLE_FORMAT, version: 1, title, session, ...(audio ? { audio } : {}) };
const parsed = parseSampleLecture(sample); // throws with the reason if anything is missing or invalid
const json = JSON.stringify(sample);
fs.writeFileSync(path.join(outDir, "sample-lecture.json"), json);

const s = parsed.session;
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`Wrote ${path.join(outDir, "sample-lecture.json")} (${mb(json.length)})`);
console.log(`  Title: ${parsed.title}`);
console.log(`  Transcript: ${s.turns.length} segments, ${Math.round(s.durationMs / 1000)} s`);
console.log(`  Materials: ${s.result.materials.guidedNotes.sections.length} note sections, ${s.result.materials.quiz.length} quiz questions (${s.result.model})`);
console.log(`  Reference picture: ${s.refImage ? `${s.diagram?.items.length ?? 0} labels` : "none"}`);
console.log(`  Whiteboard moments: ${s.boardMoments?.length ?? 0} (${(s.boardMoments ?? []).filter((m) => m.diagram?.kind === "objects").length} drawings)`);
console.log(`  Audio: ${audio ? `${audio.url} (${mb(fs.statSync(path.join(outDir, path.basename(audio.url))).size)})` : "none (transcript only)"}`);
console.log("Review it with the Try a sample lecture button (npm run dev), then commit public/sample/.");
