"use client";

import { useState } from "react";
import { formatTime } from "@/lib/audio-client";
import type { DiagramResult } from "@/lib/diagram";
import type { GenerateResult } from "@/lib/materials";
import DiagramView from "./DiagramView";

const BASE_TABS = ["Guided Notes", "CFU Quiz", "Exit Ticket", "Bell Ringer"] as const;
type Tab = (typeof BASE_TABS)[number] | "Label the Diagram";
const LETTERS = "ABCDEFGH";

export default function MaterialsView({
  result,
  diagram,
}: {
  result: GenerateResult;
  /** Reference image analyzed before generation; adds the "Label the Diagram" tab when it has items. */
  diagram?: { image: string; result: DiagramResult } | null;
}) {
  const [tab, setTab] = useState<Tab>("Guided Notes");
  const [answers, setAnswers] = useState(false);
  const { materials: m } = result;
  const hasDiagram = !!diagram && diagram.result.items.length > 0;
  const TABS: Tab[] = hasDiagram ? [...BASE_TABS, "Label the Diagram"] : [...BASE_TABS];

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
        <label className="mb-2 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={answers} onChange={(e) => setAnswers(e.target.checked)} />
          Show answer key
        </label>
      </div>

      <div className="mt-5 text-sm leading-6">
        {tab === "Guided Notes" && (
          <div>
            <h3 className="text-base font-semibold">{m.guidedNotes.title}</h3>
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
