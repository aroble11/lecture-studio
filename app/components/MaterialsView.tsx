"use client";

import { useRef, useState } from "react";
import { formatTime, type Turn } from "@/lib/audio-client";
import type { DiagramItem, DiagramResult } from "@/lib/diagram";
import type { GenerateResult } from "@/lib/materials";
import { sectionIndexForTime } from "@/lib/board-frames";
import { computePacing } from "@/lib/pacing";
import type { BoardMoment } from "@/lib/session-store";
import DiagramView from "./DiagramView";
import LabelEditor from "./LabelEditor";
import MarkerImage from "./MarkerImage";

const BASE_TABS = ["Guided notes", "Quiz", "Exit ticket", "Bell ringer"] as const;
/** Feedback for the teacher, not handouts — no answer key. */
const TEACHER_TABS = ["Pacing", "Gaps to revisit"] as const;
type Tab = (typeof BASE_TABS)[number] | "Label the picture" | (typeof TEACHER_TABS)[number];
const LETTERS = "ABCDEFGH";
const tabId = (t: Tab) => `materials-tab-${t.toLowerCase().replace(/[^a-z]+/g, "-")}`;

export default function MaterialsView({
  result,
  diagram,
  turns,
  durationMs,
  boardMoments = [],
  outdated = false,
  onBoardItemsChange,
  onDiagramItemsChange,
  onPrint,
}: {
  /** Print (or save as PDF) the student handout or the teacher's answer-key copy. */
  onPrint?: (copy: "student" | "teacher") => void;
  /** The transcript was edited after these materials were made. */
  outdated?: boolean;
  /** Teacher moved or renamed the numbered labels on a whiteboard drawing. */
  onBoardItemsChange?: (timeMs: number, items: DiagramItem[]) => void;
  /** Teacher moved or renamed the numbered labels in the label-the-picture activity. */
  onDiagramItemsChange?: (items: DiagramItem[]) => void;
  result: GenerateResult;
  /** Whiteboard drawings kept from the class video; each appears beside the notes section covering its time. */
  boardMoments?: BoardMoment[];
  /** Transcript the materials were made from (for pacing). */
  turns: Turn[];
  durationMs: number;
  /** Reference image analyzed before generation; adds the "Label the picture" tab when it has items. */
  diagram?: { image: string; result: DiagramResult } | null;
}) {
  const [tab, setTab] = useState<Tab>("Guided notes");
  const [answers, setAnswers] = useState(false);
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());
  const { materials: m } = result;
  const hasDiagram = !!diagram && diagram.result.items.length > 0;
  const studentTabs: Tab[] = [...BASE_TABS, ...(hasDiagram ? (["Label the picture"] as const) : [])];
  const TABS: Tab[] = [...studentTabs, ...TEACHER_TABS];
  const teacherTab = (TEACHER_TABS as readonly string[]).includes(tab);
  const pacing = computePacing(m.guidedNotes.sections, turns, durationMs);
  const gaps = m.contentGaps ?? [];
  const feedback = m.pacingFeedback ?? [];
  // Only real drawings are paired; boards that are mostly writing would repeat the notes.
  const drawings = boardMoments.filter((b) => b.diagram?.kind === "objects" && b.diagram.items.length > 0);
  const drawingsFor = (section: number) => drawings.filter((b) => sectionIndexForTime(m.guidedNotes.sections, b.timeMs) === section);

  // Arrow keys / Home / End move between tabs (WAI-ARIA tabs pattern, automatic activation).
  function onTabKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    const i = TABS.indexOf(tab);
    const next = e.key === "ArrowRight" ? TABS[(i + 1) % TABS.length]
      : e.key === "ArrowLeft" ? TABS[(i - 1 + TABS.length) % TABS.length]
      : e.key === "Home" ? TABS[0]
      : e.key === "End" ? TABS[TABS.length - 1]
      : null;
    if (!next) return;
    e.preventDefault();
    setTab(next);
    tabRefs.current.get(next)?.focus();
  }

  function tabButton(t: Tab, teacher: boolean) {
    const selected = tab === t;
    return (
      <button
        key={t}
        ref={(el) => { if (el) tabRefs.current.set(t, el); else tabRefs.current.delete(t); }}
        id={tabId(t)}
        role="tab"
        aria-selected={selected}
        aria-controls="materials-panel"
        tabIndex={selected ? 0 : -1}
        onClick={() => setTab(t)}
        onKeyDown={onTabKey}
        className={`min-h-11 rounded-full px-4 text-[15px] ${
          selected
            ? "bg-ink font-extrabold text-canvas"
            : teacher
              ? "border border-sun-line bg-sun-soft font-bold text-sun-ink hover:border-sun-ink"
              : "border border-line-strong bg-surface font-bold text-ink hover:border-brand"
        }`}
      >
        {teacher && <span className="sr-only">For you: </span>}
        {t}
      </button>
    );
  }

  return (
    <section className="flex flex-col gap-5 rounded-3xl border border-line bg-surface p-5 sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div>
          <h2 className="text-2xl font-extrabold">Your materials</h2>
          <span className="flex flex-wrap items-center gap-2 text-sm text-subtle">
            {result.privacy && (
              <span className="rounded-full bg-ok-soft px-2.5 py-0.5 text-xs font-bold text-ok">Open-weight generation</span>
            )}
            {result.model} · {result.seconds.toFixed(0)} s
          </span>
        </div>
        {onPrint && (
          <div className="flex flex-wrap gap-2.5">
            <button type="button" onClick={() => onPrint("student")} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand px-4 text-[15px] font-extrabold text-on-brand hover:bg-brand-dark">
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 9V3h10v6" /><rect x="3" y="9" width="18" height="8" rx="2" /><path d="M7 14h10v7H7z" /></svg>
              Print student copy
            </button>
            <button type="button" onClick={() => onPrint("teacher")} className="inline-flex min-h-11 items-center rounded-xl border border-line-strong bg-surface px-4 text-[15px] font-extrabold text-ink hover:border-brand hover:text-brand">
              Print teacher copy
            </button>
          </div>
        )}
      </div>
      {onPrint && <p className="-mt-2 text-sm text-subtle">To save a PDF instead, choose &quot;Save as PDF&quot; in the print window. For a clean page, turn off &quot;Headers and footers&quot; under More settings. The student copy never includes answers.</p>}
      <p className="flex items-center gap-2.5 rounded-2xl bg-sun-soft px-4 py-3 text-[15px] font-bold text-sun-ink">
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z" /></svg>
        Written by AI from your lecture — give it a quick read before class.
      </p>
      {outdated && (
        <p role="status" className="rounded-2xl border border-sun-line bg-sun-soft px-4 py-3 text-[15px] font-semibold text-sun-ink">
          These materials were made before you edited the transcript. Select Regenerate above to include your changes.
        </p>
      )}

      <div role="tablist" aria-label="Materials" className="flex flex-wrap items-center gap-2">
        {studentTabs.map((t) => tabButton(t, false))}
        <span aria-hidden="true" className="mx-1 hidden h-7 w-px bg-line-strong sm:block" />
        {/* Keeps the "For you:" label on the same line as the teacher-only tabs when they wrap. */}
        <div role="none" className="flex flex-wrap items-center gap-2">
          <span aria-hidden="true" className="text-sm font-bold text-sun-ink">For you:</span>
          {TEACHER_TABS.map((t) => tabButton(t, true))}
        </div>
      </div>

      <div id="materials-panel" role="tabpanel" aria-labelledby={tabId(tab)} tabIndex={0} className="flex flex-col gap-5 rounded-2xl border border-line p-5 text-base leading-relaxed sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {teacherTab ? (
            <span className="text-[15px] font-semibold text-sun-ink">Feedback for you — not a handout.</span>
          ) : (
            <span className="text-[15px] font-semibold text-subtle">{answers ? "Answer key" : "Student view"}</span>
          )}
          {!teacherTab && (
            <label className="inline-flex min-h-11 items-center gap-2.5 text-[15px] font-bold text-body">
              <input type="checkbox" checked={answers} onChange={(e) => setAnswers(e.target.checked)} className="h-5 w-5 accent-brand" />
              Show answers
            </label>
          )}
        </div>

        {tab === "Guided notes" && (
          <div className="flex flex-col gap-5">
            <h3 className="text-[22px] font-extrabold leading-tight">{m.guidedNotes.title}</h3>
            {(m.guidedNotes.wordBank?.length ?? 0) > 0 && (
              <div className="rounded-xl border border-dashed border-field px-4 py-3">
                <p className="text-[13px] font-extrabold tracking-wider text-subtle">WORD BANK</p>
                <p className="mt-1 flex flex-wrap gap-x-5 gap-y-1">
                  {m.guidedNotes.wordBank.map((w) => <span key={w}>{w}</span>)}
                </p>
              </div>
            )}
            {m.guidedNotes.sections.map((s, i) => (
              <div key={i}>
                <h4 className="flex flex-wrap items-baseline gap-2 text-[17px] font-extrabold">
                  {s.heading}
                  <span className="text-sm font-semibold text-subtle">at {formatTime(s.startSec * 1000)}</span>
                </h4>
                <ol className="mt-2 list-decimal space-y-2.5 pl-6 text-[17px]">
                  {s.items.map((it, j) => {
                    const [before, ...rest] = it.text.split("_____");
                    return (
                      <li key={j}>
                        {before}
                        <span className={`inline-block min-w-28 border-b-2 border-blank px-1 text-center ${answers ? "font-extrabold text-brand" : "select-none text-transparent"}`}>
                          {answers ? it.answer : "_"}
                        </span>
                        {rest.join("_____")}
                      </li>
                    );
                  })}
                </ol>
                {drawingsFor(i).map((b) => <BoardDrawing key={b.timeMs} moment={b} answers={answers} wordBank={(m.guidedNotes.wordBank?.length ?? 0) > 0} onItemsChange={onBoardItemsChange && ((items) => onBoardItemsChange(b.timeMs, items))} />)}
              </div>
            ))}
          </div>
        )}

        {tab === "Quiz" && (
          <ol className="list-decimal space-y-6 pl-6">
            {m.quiz.map((q, i) => (
              <li key={i}>
                <p className="font-bold">{q.question}</p>
                <ul className="mt-2 space-y-1.5">
                  {q.choices.map((c, j) => (
                    <li key={j} className={answers && j === q.answerIndex ? "font-extrabold text-brand" : ""}>
                      {LETTERS[j]}. {c}
                      {answers && j === q.answerIndex && " ✓"}
                    </li>
                  ))}
                </ul>
                {answers && <p className="mt-1.5 text-muted">{q.explanation}</p>}
              </li>
            ))}
          </ol>
        )}

        {tab === "Exit ticket" && (
          <ol className="list-decimal space-y-6 pl-6">
            {m.exitTicket.map((q, i) => (
              <li key={i}>
                <p className="font-bold">{q.question}</p>
                {answers ? (
                  <p className="mt-1.5 text-muted">Sample answer: {q.sampleAnswer}</p>
                ) : (
                  <div className="mt-3 space-y-6" aria-hidden>
                    <div className="border-b border-field" />
                    <div className="border-b border-field" />
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}

        {tab === "Bell ringer" && (
          <div>
            <p className="text-lg">{m.bellRinger.prompt}</p>
            {answers && <p className="mt-3 rounded-xl bg-tint px-4 py-3 text-muted"><span className="font-bold text-ink">Teacher note: </span>{m.bellRinger.teacherNote}</p>}
          </div>
        )}

        {tab === "Label the picture" && hasDiagram && (
          <DiagramView image={diagram.image} diagram={diagram.result} notes={m.diagramNotes ?? []} answers={answers} onItemsChange={onDiagramItemsChange} />
        )}

        {tab === "Pacing" && (
          <div>
            <dl className="grid gap-3 sm:grid-cols-3">
              {[
                ["Length", formatTime(pacing.totalMs)],
                ["Speaking", `${Math.round((pacing.speakingMs / pacing.totalMs) * 100)}% of the time`],
                ["Pace", pacing.wpm ? `${pacing.wpm} words/min` : "—"],
              ].map(([k, v]) => (
                <div key={k} className="rounded-2xl bg-tint p-4">
                  <dt className="text-sm font-bold text-subtle">{k}</dt>
                  <dd className="mt-1 text-lg font-extrabold">{v}</dd>
                </div>
              ))}
            </dl>

            <h3 className="mt-7 text-lg font-extrabold">Time per section <span className="text-sm font-semibold text-subtle">(estimated)</span></h3>
            {pacing.rows.length === 0 ? (
              <p className="mt-2 text-subtle">No sections to measure.</p>
            ) : (
              <ul className="mt-3 space-y-4">
                {pacing.rows.map((r, i) => {
                  const pct = Math.round(r.share * 100);
                  const tip = `${r.heading}: ${formatTime(r.startMs)}–${formatTime(r.endMs)}, ${formatTime(r.endMs - r.startMs)} (${pct}%)${r.wpm ? `, ${r.wpm} words/min` : ""}`;
                  return (
                    <li key={i} title={tip}>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="font-bold">
                          {r.heading}{" "}
                          <span className="font-mono text-xs font-normal text-subtle">
                            {formatTime(r.startMs)}–{formatTime(r.endMs)}
                          </span>
                        </span>
                        <span className="text-muted">
                          {formatTime(r.endMs - r.startMs)} · {pct}%{r.wpm ? ` · ${r.wpm} wpm` : ""}
                        </span>
                      </div>
                      <div className="mt-1.5 h-2.5 w-full rounded-full bg-tint">
                        <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(1, r.share * 100)}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {feedback.length > 0 && (
              <>
                <h3 className="mt-7 text-lg font-extrabold">Notes for you</h3>
                <ul className="mt-2 list-disc space-y-1 pl-6">
                  {feedback.map((f, i) => <li key={i}>{f}</li>)}
                </ul>
              </>
            )}
            <p className="mt-6 text-sm text-subtle">
              Section times are estimates from the guided-notes sections; speaking time and pace come from the transcript&apos;s timestamps.
            </p>
          </div>
        )}

        {tab === "Gaps to revisit" && (
          gaps.length === 0 ? (
            <p className="text-muted">No gaps were flagged in this analysis.</p>
          ) : (
            <ol className="space-y-4">
              {gaps.map((g, i) => (
                <li key={i} className="rounded-2xl border border-line p-4">
                  <p className="flex flex-wrap items-baseline gap-2 font-extrabold">
                    {g.concept}
                    <span className="text-sm font-semibold text-subtle">at {formatTime(g.atSec * 1000)}</span>
                  </p>
                  <p className="mt-1">{g.issue}</p>
                  <p className="mt-1 text-muted">
                    <span className="font-bold text-ink">Next time: </span>
                    {g.suggestion}
                  </p>
                </li>
              ))}
            </ol>
          )
        )}
      </div>
    </section>
  );
}

/** A kept whiteboard drawing with its numbered labels, shown beside the matching notes. Labels can be edited. */
function BoardDrawing({ moment, answers, wordBank, onItemsChange }: { moment: BoardMoment; answers: boolean; wordBank: boolean; onItemsChange?: (items: DiagramItem[]) => void }) {
  const [editing, setEditing] = useState(false);
  const items = moment.diagram?.items ?? [];
  const alt = moment.diagram?.summary ?? "Whiteboard drawing";
  if (editing && onItemsChange) {
    return (
      <div className="mt-4">
        <LabelEditor src={moment.image.dataUrl} alt={alt} items={items} onChange={onItemsChange} onDone={() => setEditing(false)} />
      </div>
    );
  }
  return (
    <figure className="mt-4 flex flex-col gap-3 rounded-2xl border border-line bg-tint-soft p-3 sm:flex-row sm:items-start">
      <MarkerImage src={moment.image.dataUrl} alt={alt} items={items} size="sm" className="w-full shrink-0 sm:w-[60%]" />
      <figcaption className="flex flex-col gap-2 text-[15px]">
        <p className="font-bold">From the board at {formatTime(moment.timeMs)}{answers ? "" : " — label each number"}</p>
        {!answers && wordBank && (
          <p className="text-sm"><span className="font-bold">Word bank: </span>{items.map((d) => d.label).sort((a, b) => a.localeCompare(b)).join(" · ")}</p>
        )}
        <ol className={answers ? "space-y-1" : "space-y-2.5"}>
          {items.map((d) => (
            <li key={d.n} className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-apple text-[11px] font-bold text-white">{d.n}</span>
              {answers ? <span className="font-extrabold text-brand">{d.label}</span> : <span aria-label="blank" className="inline-block w-36 border-b-2 border-blank" />}
            </li>
          ))}
        </ol>
        {onItemsChange && (
          <button type="button" onClick={() => setEditing(true)} className="inline-flex min-h-11 items-center self-start rounded-xl border border-line-strong bg-surface px-4 text-[15px] font-bold text-ink hover:border-brand hover:text-brand">
            Edit labels
          </button>
        )}
      </figcaption>
    </figure>
  );
}
