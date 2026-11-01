"use client";

import type { DiagramResult } from "@/lib/diagram";

/** Reference image with numbered SAM boxes, a word bank, and blanks (or the answer key). */
export default function DiagramView({
  image,
  diagram,
  notes,
  answers,
}: {
  image: string;
  diagram: DiagramResult;
  notes: { n: number; note: string }[];
  answers: boolean;
}) {
  const noteFor = (n: number) => notes.find((d) => d.n === n)?.note;
  const bank = [...diagram.items].map((d) => d.label).sort((a, b) => a.localeCompare(b));

  return (
    <div>
      <p className="font-medium">Label each numbered item in the picture.</p>
      <div className="relative mt-3 inline-block max-w-full">
        {/* eslint-disable-next-line @next/next/no-img-element -- local data URL, nothing for next/image to optimize */}
        <img src={image} alt={diagram.summary} className="block max-h-[70vh] max-w-full rounded-md border border-zinc-200 dark:border-zinc-800" />
        {diagram.items.map((d) => (
          <div key={d.n}>
            <div
              className="pointer-events-none absolute rounded-sm border-2 border-red-600/80"
              style={{
                left: `${d.box.x1 / 10}%`,
                top: `${d.box.y1 / 10}%`,
                width: `${(d.box.x2 - d.box.x1) / 10}%`,
                height: `${(d.box.y2 - d.box.y1) / 10}%`,
              }}
            />
            <span
              className="absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-red-600 text-sm font-bold text-white shadow"
              style={{ left: `${d.box.x1 / 10}%`, top: `${d.box.y1 / 10}%` }}
            >
              {d.n}
            </span>
          </div>
        ))}
      </div>

      {!answers && (
        <p className="mt-4">
          <span className="font-medium">Word bank: </span>
          {bank.join(" · ")}
        </p>
      )}

      <ol className="mt-4 space-y-3">
        {diagram.items.map((d) => (
          <li key={d.n} className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-red-600 text-xs font-bold text-white">
              {d.n}
            </span>
            {answers ? (
              <span>
                <span className="font-semibold text-blue-700 dark:text-blue-400">{d.label}</span>
                {noteFor(d.n) && <span className="text-zinc-600 dark:text-zinc-400"> — {noteFor(d.n)}</span>}
              </span>
            ) : (
              <span className="inline-block w-64 max-w-full border-b border-zinc-500" />
            )}
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs text-zinc-500">
        Objects named by {diagram.model} and located by SAM 3.1 · {diagram.seconds.toFixed(0)} s
      </p>
    </div>
  );
}
