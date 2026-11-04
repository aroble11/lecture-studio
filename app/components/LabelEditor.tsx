"use client";

import { useEffect, useRef, useState } from "react";
import type { DiagramItem } from "@/lib/diagram";
import { addDiagramItem, MAX_DIAGRAM_ITEMS, MAX_LABEL_CHARS, moveDiagramItem, removeDiagramItem, renameDiagramItem } from "@/lib/lecture-workflow";
import MarkerImage from "./MarkerImage";

/**
 * Edit a labeled picture: drag (or arrow-key) the numbered markers and rename what each number is.
 * With `canAddRemove`, labels can also be added and removed (numbers stay 1..k), so a drawing's blanks match its labels.
 */
export default function LabelEditor({
  src,
  alt,
  items,
  boxes = false,
  canAddRemove = false,
  onChange,
  onDone,
}: {
  src: string;
  alt: string;
  items: DiagramItem[];
  boxes?: boolean;
  canAddRemove?: boolean;
  onChange: (items: DiagramItem[]) => void;
  onDone: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<number, string>>(() => Object.fromEntries(items.map((d) => [d.n, d.label])));
  const [error, setError] = useState<string | null>(null);
  /** Number whose name box gets focus after the next render (a just-added label, or the row that replaced a removed one). */
  const focusAfterRender = useRef<number | null>(null);
  const inputs = useRef(new Map<number, HTMLInputElement>());
  const addButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const n = focusAfterRender.current;
    if (n === null) return;
    focusAfterRender.current = null;
    (inputs.current.get(n) ?? addButton.current)?.focus();
  });

  function done() {
    const blank = items.find((d) => !(drafts[d.n] ?? d.label).trim());
    if (blank) {
      setError(canAddRemove ? `Type a name for number ${blank.n}, or remove it.` : `Type a name for number ${blank.n}.`);
      inputs.current.get(blank.n)?.focus();
      return;
    }
    onChange(items.reduce((list, d) => renameDiagramItem(list, d.n, drafts[d.n] ?? d.label), items));
    onDone();
  }

  function add() {
    const next = addDiagramItem(items);
    if (next === items) return;
    const added = next[next.length - 1];
    setDrafts((all) => ({ ...all, [added.n]: "" }));
    setError(null);
    onChange(next);
    focusAfterRender.current = added.n;
  }

  function remove(n: number) {
    const next = removeDiagramItem(items, n);
    if (next === items) return;
    // Numbers shift down after the removed one, so carry each typed name to its new number.
    const kept = [...items].sort((a, b) => a.n - b.n).filter((d) => d.n !== n);
    setDrafts(Object.fromEntries(kept.map((d, i) => [i + 1, drafts[d.n] ?? d.label])));
    setError(null);
    onChange(next);
    focusAfterRender.current = Math.min(n, next.length);
  }

  return (
    <div className="flex flex-col gap-4 rounded-2xl border-2 border-dashed border-brand/50 p-3 sm:p-4">
      <p className="text-[15px] text-muted">
        Drag a numbered circle to move it (or select it and use the arrow keys). Type over a name to change it.
        {canAddRemove && " Add or remove labels; students get one blank for each."}
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
              ref={(el) => { if (el) inputs.current.set(d.n, el); else inputs.current.delete(d.n); }}
              value={drafts[d.n] ?? ""}
              onChange={(e) => { setDrafts((all) => ({ ...all, [d.n]: e.target.value })); setError(null); }}
              maxLength={MAX_LABEL_CHARS}
              placeholder={`What is number ${d.n}?`}
              aria-label={`Name for marker ${d.n}`}
              className="min-h-11 w-full min-w-0 rounded-xl border border-field bg-surface px-3 text-[15px] font-semibold text-ink placeholder:font-normal placeholder:text-subtle focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
            />
            {canAddRemove && items.length > 1 && (
              <button
                type="button"
                onClick={() => remove(d.n)}
                aria-label={`Remove label ${d.n}`}
                title={`Remove label ${d.n}`}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line-strong bg-surface text-muted hover:border-apple hover:text-apple"
              >
                <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            )}
          </li>
        ))}
      </ol>
      {error && <p role="alert" className="text-[15px] font-semibold text-apple">{error}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={done} className="inline-flex min-h-11 items-center justify-center rounded-xl bg-brand px-5 text-[15px] font-extrabold text-on-brand hover:bg-brand-dark">
          Done editing
        </button>
        {canAddRemove && (items.length < MAX_DIAGRAM_ITEMS ? (
          <button ref={addButton} type="button" onClick={add} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-line-strong bg-surface px-4 text-[15px] font-bold text-ink hover:border-brand hover:text-brand">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            Add a label
          </button>
        ) : (
          <span className="text-sm text-muted">Up to {MAX_DIAGRAM_ITEMS} labels per drawing.</span>
        ))}
      </div>
    </div>
  );
}
