"use client";

import { formatTime, type Turn } from "@/lib/audio-client";
import { sectionIndexForTime } from "@/lib/board-frames";
import type { DiagramResult } from "@/lib/diagram";
import { forStudents, printSections, type PrintCopy } from "@/lib/export-plan";
import type { GenerateResult } from "@/lib/materials";
import { computePacing } from "@/lib/pacing";
import type { BoardMoment } from "@/lib/session-store";
import MarkerImage from "./MarkerImage";

const LETTERS = "ABCDEFGH";
const line = "inline-block min-w-32 border-b border-black align-baseline";

/**
 * The printed handout (print or "Save as PDF"). Built from the materials themselves, never from what the
 * screen shows; the student copy is made from a version with every answer and teacher-only note removed.
 * Hidden on screen; shown only when printing.
 */
export default function PrintableMaterials({
  copy,
  result,
  lessonLine,
  diagram,
  boardMoments,
  turns,
  durationMs,
}: {
  copy: PrintCopy;
  result: GenerateResult;
  /** e.g. "U.S. History · Grade 10" */
  lessonLine: string;
  diagram: { image: string; result: DiagramResult } | null;
  boardMoments: BoardMoment[];
  turns: Turn[];
  durationMs: number;
}) {
  const teacher = copy === "teacher";
  const m = teacher ? result.materials : forStudents(result.materials);
  const hasDiagram = !!diagram && diagram.result.items.length > 0;
  const sections = printSections(copy, { hasDiagram });
  const drawings = boardMoments.filter((b) => b.diagram?.kind === "objects" && b.diagram.items.length > 0);
  const pacing = teacher ? computePacing(m.guidedNotes.sections, turns, durationMs) : null;
  const noteFor = (n: number) => result.materials.diagramNotes.find((d) => d.n === n)?.note;

  return (
    <div id="print-root" data-copy={copy} className="print-root hidden bg-white text-[11pt] leading-snug text-black print:block">
      <header className="mb-5 flex items-end justify-between gap-6 border-b-2 border-black pb-3">
        <div>
          <h1 className="text-[18pt] font-extrabold leading-tight">{m.guidedNotes.title}</h1>
          {lessonLine && <p className="mt-1 text-[10pt]">{lessonLine}</p>}
        </div>
        {teacher ? (
          <div className="text-right text-[10pt]">
            <p className="font-extrabold">Teacher copy — answer key</p>
            <p>AI-generated — review before use.</p>
          </div>
        ) : (
          <div className="shrink-0 text-[10pt] leading-7">
            <p>Name <span className="inline-block w-48 border-b border-black" /></p>
            <p>Date <span className="inline-block w-24 border-b border-black" /> Period <span className="inline-block w-12 border-b border-black" /></p>
          </div>
        )}
      </header>

      {sections.includes("guidedNotes") && (
        <section>
          <h2 className="mb-2 text-[14pt] font-extrabold">Guided notes</h2>
          {m.guidedNotes.wordBank.length > 0 && (
            <p className="mb-3 break-inside-avoid rounded border border-dashed border-black px-3 py-2">
              <span className="font-extrabold">Word bank: </span>{m.guidedNotes.wordBank.join("  ·  ")}
            </p>
          )}
          {m.guidedNotes.sections.map((s, i) => (
            <div key={i} className="mb-4">
              <h3 className="break-after-avoid font-extrabold">{s.heading}</h3>
              <ol className="mt-1 list-decimal space-y-2 pl-6">
                {s.items.map((it, j) => {
                  const [before, ...rest] = it.text.split("_____");
                  return (
                    <li key={j} className="break-inside-avoid">
                      {before}
                      {teacher ? <span className="font-extrabold underline">{it.answer}</span> : <span className={line} />}
                      {rest.join("_____")}
                    </li>
                  );
                })}
              </ol>
              {drawings.filter((b) => sectionIndexForTime(m.guidedNotes.sections, b.timeMs) === i).map((b) => (
                <figure key={b.timeMs} className="mt-3 flex break-inside-avoid items-start gap-4">
                  <MarkerImage src={b.image.dataUrl} alt={b.diagram?.summary ?? "Whiteboard drawing"} items={b.diagram?.items ?? []} size="sm" className="w-[60%] shrink-0" />
                  <figcaption>
                    <p className="font-bold">From the board{teacher ? "" : " — label each number"}</p>
                    {!teacher && m.guidedNotes.wordBank.length > 0 && (
                      <p className="mt-1 text-[10pt]"><span className="font-bold">Word bank: </span>{(b.diagram?.items ?? []).map((d) => d.label).sort((x, y) => x.localeCompare(y)).join("  ·  ")}</p>
                    )}
                    <ol className={`mt-1 ${teacher ? "space-y-0.5" : "space-y-3"}`}>
                      {(b.diagram?.items ?? []).map((d) => (
                        <li key={d.n}>
                          {d.n}. {teacher ? <span className="font-extrabold underline">{d.label}</span> : <span className="inline-block w-44 border-b border-black" />}
                        </li>
                      ))}
                    </ol>
                  </figcaption>
                </figure>
              ))}
            </div>
          ))}
        </section>
      )}

      {sections.includes("labelPicture") && diagram && (
        <section className="break-before-page">
          <h2 className="mb-2 text-[14pt] font-extrabold">Label the picture</h2>
          <p className="mb-3">Write the name of each numbered item.</p>
          <div className="break-inside-avoid">
            <MarkerImage src={diagram.image} alt={diagram.result.summary} items={diagram.result.items} boxes className="max-w-[85%]" />
          </div>
          {!teacher && (
            <p className="mt-3"><span className="font-extrabold">Word bank: </span>{[...diagram.result.items].map((d) => d.label).sort((a, b) => a.localeCompare(b)).join("  ·  ")}</p>
          )}
          <ol className="mt-3 space-y-3">
            {diagram.result.items.map((d) => (
              <li key={d.n} className="break-inside-avoid">
                <span className="font-extrabold">{d.n}. </span>
                {teacher ? <><span className="font-extrabold underline">{d.label}</span>{noteFor(d.n) && <> — {noteFor(d.n)}</>}</> : <span className="inline-block w-72 border-b border-black" />}
              </li>
            ))}
          </ol>
        </section>
      )}

      {sections.includes("quiz") && (
        <section className="break-before-page">
          <h2 className="mb-3 text-[14pt] font-extrabold">Check for understanding</h2>
          <ol className="list-decimal space-y-4 pl-6">
            {m.quiz.map((q, i) => (
              <li key={i} className="break-inside-avoid">
                <p className="font-bold">{q.question}</p>
                <ul className="mt-1 space-y-0.5">
                  {q.choices.map((c, j) => (
                    <li key={j} className={teacher && j === q.answerIndex ? "font-extrabold" : ""}>
                      {LETTERS[j]}. {c}{teacher && j === q.answerIndex && "  ✓"}
                    </li>
                  ))}
                </ul>
                {teacher && q.explanation && <p className="mt-1 italic">{q.explanation}</p>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {sections.includes("exitTicket") && (
        <section className="break-before-page">
          <h2 className="mb-3 text-[14pt] font-extrabold">Exit ticket</h2>
          <ol className="list-decimal space-y-5 pl-6">
            {m.exitTicket.map((q, i) => (
              <li key={i} className="break-inside-avoid">
                <p className="font-bold">{q.question}</p>
                {teacher ? (
                  <p className="mt-1"><span className="font-bold">Sample answer: </span>{q.sampleAnswer}</p>
                ) : (
                  <div aria-hidden="true" className="mt-2 space-y-6"><div className="border-b border-black" /><div className="border-b border-black" /><div className="border-b border-black" /></div>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {sections.includes("bellRinger") && (
        <section className="mt-10 break-inside-avoid">
          {!teacher && (
            <p aria-hidden="true" className="mb-8 border-t-2 border-dashed border-black pt-1 text-center text-[9pt]">✂ cut here</p>
          )}
          <h2 className="mb-2 text-[14pt] font-extrabold">Bell ringer</h2>
          <p>{m.bellRinger.prompt}</p>
          {teacher ? (
            m.bellRinger.teacherNote && <p className="mt-2"><span className="font-bold">Teacher note: </span>{m.bellRinger.teacherNote}</p>
          ) : (
            <div aria-hidden="true" className="mt-3 space-y-6"><div className="border-b border-black" /><div className="border-b border-black" /><div className="border-b border-black" /></div>
          )}
        </section>
      )}

      {sections.includes("teacherFeedback") && pacing && (
        <section className="break-before-page">
          <h2 className="mb-1 text-[14pt] font-extrabold">For you: pacing and gaps</h2>
          <p className="mb-3 text-[10pt]">Feedback for the teacher — not a handout. Section times are estimates.</p>
          <p>
            Length {formatTime(pacing.totalMs)} · Speaking {Math.round((pacing.speakingMs / Math.max(1, pacing.totalMs)) * 100)}% of the time
            {pacing.wpm ? ` · ${pacing.wpm} words/min` : ""}
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-6">
            {pacing.rows.map((r, i) => <li key={i}>{r.heading}: {formatTime(r.endMs - r.startMs)} ({Math.round(r.share * 100)}%)</li>)}
          </ul>
          {m.pacingFeedback.length > 0 && (
            <>
              <h3 className="mt-4 font-extrabold">Notes</h3>
              <ul className="mt-1 list-disc space-y-1 pl-6">{m.pacingFeedback.map((f, i) => <li key={i}>{f}</li>)}</ul>
            </>
          )}
          <h3 className="mt-4 font-extrabold">Gaps to revisit</h3>
          {m.contentGaps.length === 0 ? (
            <p>No gaps were flagged in this analysis.</p>
          ) : (
            <ol className="mt-1 list-decimal space-y-2 pl-6">
              {m.contentGaps.map((g, i) => (
                <li key={i} className="break-inside-avoid">
                  <span className="font-bold">{g.concept}</span> (at {formatTime(g.atSec * 1000)}): {g.issue} <span className="font-bold">Next time:</span> {g.suggestion}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}
