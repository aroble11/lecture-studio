"use client";

import { useState } from "react";
import { formatTime, type Turn } from "@/lib/audio-client";
import type { DiagramResult } from "@/lib/diagram";
import type { GenerateResult } from "@/lib/materials";
import { computePacing } from "@/lib/pacing";
import DiagramView from "./DiagramView";

const BASE_TABS = ["Guided Notes", "CFU Quiz", "Exit Ticket", "Bell Ringer"] as const;
/** Feedback for the teacher, not handouts — no answer key. */
const TEACHER_TABS = ["Pacing", "Content Gaps"] as const;
type Tab = (typeof BASE_TABS)[number] | "Label the Diagram" | (typeof TEACHER_TABS)[number];
const LETTERS = "ABCDEFGH";

export default function MaterialsView({
  result,
  diagram,
  turns,
  durationMs,
}: {
  result: GenerateResult;
  /** Transcript the materials were made from (for pacing). */
  turns: Turn[];
  durationMs: number;
  /** Reference image analyzed before generation; adds the "Label the Diagram" tab when it has items. */
  diagram?: { image: string; result: DiagramResult } | null;
}) {
  const [tab, setTab] = useState<Tab>("Guided Notes");
  const [answers, setAnswers] = useState(false);
  const { materials: m } = result;
  const hasDiagram = !!diagram && diagram.result.items.length > 0;
  const TABS: Tab[] = [...BASE_TABS, ...(hasDiagram ? (["Label the Diagram"] as const) : []), ...TEACHER_TABS];
  const teacherTab = (TEACHER_TABS as readonly string[]).includes(tab);
  const pacing = computePacing(m.guidedNotes.sections, turns, durationMs);
  const gaps = m.contentGaps ?? [];
  const feedback = m.pacingFeedback ?? [];

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Materials</h2>
        <span className="text-sm text-zinc-500">
          {result.model} · {result.seconds.toFixed(0)} s
        </span>
      </div>
      <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
        AI-generated — review before use.
      </p>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 dark:border-zinc-800">
        <div role="tablist" className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
                tab === t
                  ? "border-blue-600 text-blue-700 dark:text-blue-400"
                  : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        {teacherTab ? (
          <span className="mb-2 text-sm text-zinc-500">Feedback for you — not a handout</span>
        ) : (
          <label className="mb-2 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <input type="checkbox" checked={answers} onChange={(e) => setAnswers(e.target.checked)} />
            Show answer key
          </label>
        )}
      </div>

      <div className="mt-5 text-sm leading-6">
        {tab === "Guided Notes" && (
          <div>
            <h3 className="text-base font-semibold">{m.guidedNotes.title}</h3>
            {(m.guidedNotes.wordBank?.length ?? 0) > 0 && (
              <div className="mt-3 rounded-lg border border-zinc-300 px-4 py-3 dark:border-zinc-700">
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Word bank</p>
                <p className="mt-1 flex flex-wrap gap-x-5 gap-y-1">
                  {m.guidedNotes.wordBank.map((w) => <span key={w}>{w}</span>)}
                </p>
              </div>
            )}
            {m.guidedNotes.sections.map((s, i) => (
              <div key={i} className="mt-5">
                <h4 className="flex items-baseline gap-2 font-semibold">
                  {s.heading}
                  <span className="font-mono text-xs font-normal text-zinc-500">{formatTime(s.startSec * 1000)}</span>
                </h4>
                <ol className="mt-2 list-decimal space-y-2 pl-6">
                  {s.items.map((it, j) => {
                    const [before, ...rest] = it.text.split("_____");
                    return (
                      <li key={j}>
                        {before}
                        <span className={`inline-block min-w-24 border-b border-zinc-500 px-1 text-center ${answers ? "font-semibold text-blue-700 dark:text-blue-400" : "text-transparent select-none"}`}>
                          {answers ? it.answer : "_"}
                        </span>
                        {rest.join("_____")}
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))}
          </div>
        )}

        {tab === "CFU Quiz" && (
          <ol className="list-decimal space-y-5 pl-6">
            {m.quiz.map((q, i) => (
              <li key={i}>
                <p className="font-medium">{q.question}</p>
                <ul className="mt-2 space-y-1">
                  {q.choices.map((c, j) => (
                    <li key={j} className={answers && j === q.answerIndex ? "font-semibold text-blue-700 dark:text-blue-400" : ""}>
                      {LETTERS[j]}. {c}
                      {answers && j === q.answerIndex && " ✓"}
                    </li>
                  ))}
                </ul>
                {answers && <p className="mt-1 text-zinc-600 dark:text-zinc-400">{q.explanation}</p>}
              </li>
            ))}
          </ol>
        )}

        {tab === "Exit Ticket" && (
          <ol className="list-decimal space-y-5 pl-6">
            {m.exitTicket.map((q, i) => (
              <li key={i}>
                <p className="font-medium">{q.question}</p>
                {answers ? (
                  <p className="mt-1 text-zinc-600 dark:text-zinc-400">Sample answer: {q.sampleAnswer}</p>
                ) : (
                  <div className="mt-2 space-y-5" aria-hidden>
                    <div className="border-b border-zinc-300 dark:border-zinc-700" />
                    <div className="border-b border-zinc-300 dark:border-zinc-700" />
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}

        {tab === "Label the Diagram" && hasDiagram && (
          <DiagramView image={diagram.image} diagram={diagram.result} notes={m.diagramNotes ?? []} answers={answers} />
        )}

        {tab === "Pacing" && (
          <div>
            <dl className="grid grid-cols-3 gap-3">
              {[
                ["Length", formatTime(pacing.totalMs)],
                ["Speaking", `${Math.round((pacing.speakingMs / pacing.totalMs) * 100)}% of the time`],
                ["Pace", pacing.wpm ? `${pacing.wpm} words/min` : "—"],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                  <dt className="text-xs text-zinc-500">{k}</dt>
                  <dd className="mt-1 text-base font-semibold">{v}</dd>
                </div>
              ))}
            </dl>

            <h3 className="mt-6 font-semibold">Time per section</h3>
            {pacing.rows.length === 0 ? (
              <p className="mt-2 text-zinc-500">No sections to measure.</p>
            ) : (
              <ul className="mt-3 space-y-4">
                {pacing.rows.map((r, i) => {
                  const pct = Math.round(r.share * 100);
                  const tip = `${r.heading}: ${formatTime(r.startMs)}–${formatTime(r.endMs)}, ${formatTime(r.endMs - r.startMs)} (${pct}%)${r.wpm ? `, ${r.wpm} words/min` : ""}`;
                  return (
                    <li key={i} title={tip}>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="font-medium">
                          {r.heading}{" "}
                          <span className="font-mono text-xs font-normal text-zinc-500">
                            {formatTime(r.startMs)}–{formatTime(r.endMs)}
                          </span>
                        </span>
                        <span className="text-zinc-600 dark:text-zinc-400">
                          {formatTime(r.endMs - r.startMs)} · {pct}%{r.wpm ? ` · ${r.wpm} wpm` : ""}
                        </span>
                      </div>
                      <div className="mt-1.5 h-2 w-full rounded-full bg-zinc-100 dark:bg-zinc-900">
                        <div className="h-full rounded-full bg-blue-600 dark:bg-blue-500" style={{ width: `${Math.max(1, r.share * 100)}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {feedback.length > 0 && (
              <>
                <h3 className="mt-6 font-semibold">Notes for you</h3>
                <ul className="mt-2 list-disc space-y-1 pl-6">
                  {feedback.map((f, i) => <li key={i}>{f}</li>)}
                </ul>
              </>
            )}
            <p className="mt-6 text-xs text-zinc-500">
              Section times come from the guided-notes sections; speaking time and pace come from the transcript&apos;s timestamps.
            </p>
          </div>
        )}

        {tab === "Content Gaps" && (
          gaps.length === 0 ? (
            <p className="text-zinc-600 dark:text-zinc-400">No gaps found — every concept that came up was explained.</p>
          ) : (
            <ol className="space-y-4">
              {gaps.map((g, i) => (
                <li key={i} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
                  <p className="flex flex-wrap items-baseline gap-2 font-semibold">
                    {g.concept}
                    <span className="font-mono text-xs font-normal text-zinc-500">at {formatTime(g.atSec * 1000)}</span>
                  </p>
                  <p className="mt-1">{g.issue}</p>
                  <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">Next time: </span>
                    {g.suggestion}
                  </p>
                </li>
              ))}
            </ol>
          )
        )}

        {tab === "Bell Ringer" && (
          <div>
            <p className="text-base">{m.bellRinger.prompt}</p>
            <p className="mt-3 text-zinc-600 dark:text-zinc-400">Teacher note: {m.bellRinger.teacherNote}</p>
          </div>
        )}
      </div>
    </div>
  );
}
