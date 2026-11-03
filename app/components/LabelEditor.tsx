"use client";

import { useState } from "react";
import type { DiagramItem } from "@/lib/diagram";
import { MAX_LABEL_CHARS, moveDiagramItem, renameDiagramItem } from "@/lib/lecture-workflow";
import MarkerImage from "./MarkerImage";

/** Edit a labeled picture: drag (or arrow-key) the numbered markers and rename what each number is. */
export default function LabelEditor({
  src,
  alt,
  items,
  boxes = false,
  onChange,
  onDone,
}: {
  src: string;
  alt: string;
  items: DiagramItem[];
  boxes?: boolean;
  onChange: (items: DiagramItem[]) => void;
  onDone: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<number, string>>(() => Object.fromEntries(items.map((d) => [d.n, d.label])));

  function done() {
    onChange(items.reduce((list, d) => renameDiagramItem(list, d.n, drafts[d.n] ?? d.label), items));
    onDone();
  }

  return (
    <div className="flex flex-col gap-4 rounded-2xl border-2 border-dashed border-brand/50 p-3 sm:p-4">
      <p className="text-[15px] text-muted">
        Drag a numbered circle to move it (or select it and use the arrow keys). Type over a name to change it.
      </p>
      <MarkerImage
        src={src}
        alt={alt}
        items={items}
        boxes={boxes}
        editing
        onMove={(n, x, y) => onChange(items.map((d) => (d.n === n ? moveDiagramItem(d, x, y) : d)))}
      />
      <ol className="grid gap-2 sm:grid-cols-2">
        {items.map((d) => (
          <li key={d.n} className="flex items-center gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-apple text-sm font-bold text-white">{d.n}</span>
            <input
              value={drafts[d.n] ?? ""}
              onChange={(e) => setDrafts((all) => ({ ...all, [d.n]: e.target.value }))}
              maxLength={MAX_LABEL_CHARS}
              aria-label={`Name for marker ${d.n}`}
              className="min-h-11 w-full rounded-xl border border-field bg-surface px-3 text-[15px] font-semibold text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
            />
          </li>
        ))}
      </ol>
      <button type="button" onClick={done} className="inline-flex min-h-11 items-center justify-center self-start rounded-xl bg-brand px-5 text-[15px] font-extrabold text-on-brand hover:bg-brand-dark">
        Done editing
      </button>
    </div>
  );
}
