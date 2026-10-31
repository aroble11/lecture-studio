// Day 4: POST a sample transcript to our /api/generate route (dev server must be running).
// Usage: node test-generate-route.mjs [transcript.json]   (file = { turns, context } — optional)
import { readFile } from "node:fs/promises";

const file = process.argv[2];
const body = file
  ? JSON.parse(await readFile(file, "utf8"))
  : {
      context: { subject: "U.S. History", grade: "10", objective: "Explain why the Articles of Confederation were replaced" },
      turns: [
        [0, "Today we're looking at why the Articles of Confederation failed and what replaced them."],
        [9, "After the Revolution, the states wanted a weak central government, so the Articles gave Congress very little power."],
        [21, "Congress couldn't tax. It could only ask the states for money, and most states just didn't pay."],
        [33, "That meant Congress couldn't pay soldiers or the war debts it owed to France and the Netherlands."],
        [46, "Congress also couldn't regulate trade, so states put tariffs on each other's goods."],
        [58, "In 1786, farmers in western Massachusetts led by Daniel Shays rebelled over debts and high state taxes."],
        [72, "The national government had no army to stop them. Massachusetts had to raise a private militia."],
        [85, "Shays' Rebellion scared leaders like George Washington and James Madison."],
        [94, "So in 1787 delegates met in Philadelphia at the Constitutional Convention, first just to revise the Articles."],
        [108, "Instead they wrote a new Constitution with a stronger national government that could tax and regulate trade."],
        [121, "To win ratification, Madison, Hamilton, and Jay wrote the Federalist Papers defending it."],
      ].map(([s, text]) => ({ startMs: s * 1000, endMs: s * 1000 + 8000, text })),
    };

const t0 = Date.now();
const res = await fetch("http://localhost:3000/api/generate", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const secs = ((Date.now() - t0) / 1000).toFixed(1);
const raw = await res.text();
let out;
try {
  out = JSON.parse(raw);
} catch {
  out = null;
}
if (!res.ok || !out) {
  console.error(`❌ HTTP ${res.status} after ${secs}s:`, out ?? (raw.slice(0, 500) || "(empty body — check the dev server window)"));
  process.exit(1);
}
const m = out.materials;
console.log(`✅ model=${out.model} model-time=${out.seconds}s round-trip=${secs}s`);
console.log(`guided notes: "${m.guidedNotes.title}" — ${m.guidedNotes.sections.length} sections, ` +
  `${m.guidedNotes.sections.reduce((n, s) => n + s.items.length, 0)} blanks`);
console.log(`quiz: ${m.quiz.length} questions · answer positions: ${m.quiz.map((q) => q.answerIndex).join(",")}`);
console.log(`exit ticket: ${m.exitTicket.length} · bell ringer: ${m.bellRinger.prompt.slice(0, 80)}…`);
console.log("\n" + JSON.stringify(m, null, 2));
