"use client";

import { useState } from "react";
import type { DiagramItem, DiagramResult } from "@/lib/diagram";
import LabelEditor from "./LabelEditor";
import MarkerImage from "./MarkerImage";

/** Reference image with numbered boxes, a word bank, and blanks (or the answer key). Labels can be edited. */
export default function DiagramView({
  image,
  diagram,
  notes,
  answers,
  onItemsChange,
}: {
  image: string;
  diagram: DiagramResult;
  notes: { n: number; note: string }[];
  answers: boolean;
  onItemsChange?: (items: DiagramItem[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const noteFor = (n: number) => notes.find((d) => d.n === n)?.note;
  const bank = [...diagram.items].map((d) => d.label).sort((a, b) => a.localeCompare(b));

  if (editing && onItemsChange) {
    return <LabelEditor src={image} alt={diagram.summary} items={diagram.items} boxes onChange={onItemsChange} onDone={() => setEditing(false)} />;
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-bold">Label each numbered item in the picture.</p>
        {onItemsChange && (
          <button type="button" onClick={() => setEditing(true)} className="inline-flex min-h-11 items-center rounded-xl border border-line-strong bg-surface px-4 text-[15px] font-bold text-ink hover:border-brand hover:text-brand">
            Edit labels
          </button>
        )}
      </div>
      <MarkerImage src={image} alt={diagram.summary} items={diagram.items} boxes className="mt-3" />

      {!answers && (
        <p className="mt-4">
          <span className="font-bold">Word bank: </span>
          {bank.join(" · ")}
        </p>
      )}

      <ol className="mt-4 space-y-3">
        {diagram.items.map((d) => (
          <li key={d.n} className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-apple text-xs font-bold text-white">
              {d.n}
            </span>
            {answers ? (
              <span>
                <span className="font-extrabold text-brand">{d.label}</span>
                {noteFor(d.n) && <span className="text-muted"> — {noteFor(d.n)}</span>}
              </span>
            ) : (
              <span className="inline-block w-64 max-w-full border-b border-blank" />
            )}
          </li>
        ))}
      </ol>
      <p className="mt-4 text-sm text-subtle">
        Objects named by {diagram.model} and located by SAM 3.1 · {diagram.seconds.toFixed(0)} s
      </p>
    </div>
  );
}
