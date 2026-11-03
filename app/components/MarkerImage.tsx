"use client";

import { useRef, useState } from "react";
import type { DiagramItem } from "@/lib/diagram";

/**
 * A picture with numbered markers. While `editing`, each marker can be dragged to a new spot, or focused and
 * moved with the arrow keys (Shift moves farther). Positions are 0–1000 coordinates of the marker's corner.
 */
export default function MarkerImage({
  src,
  alt,
  items,
  editing = false,
  boxes = false,
  size = "md",
  onMove,
  className = "",
}: {
  src: string;
  alt: string;
  items: DiagramItem[];
  editing?: boolean;
  /** Also outline each item's box (the label-the-picture activity does). */
  boxes?: boolean;
  size?: "sm" | "md";
  onMove?: (n: number, x: number, y: number) => void;
  className?: string;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ n: number; x: number; y: number } | null>(null);
  const dot = size === "sm" ? "h-6 w-6 text-xs" : "h-7 w-7 text-sm";

  const toPicture = (clientX: number, clientY: number) => {
    const rect = frame.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return null;
    return { x: ((clientX - rect.left) / rect.width) * 1000, y: ((clientY - rect.top) / rect.height) * 1000 };
  };

  return (
    <div ref={frame} className={`relative inline-block max-w-full touch-none select-none ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- local data URL */}
      <img src={src} alt={alt} draggable={false} className="block max-h-[70vh] max-w-full rounded-xl border border-line" />
      {items.map((d) => {
        const at = drag?.n === d.n ? drag : { x: d.box.x1, y: d.box.y1 };
        const style = { left: `${at.x / 10}%`, top: `${at.y / 10}%` };
        return (
          <div key={d.n}>
            {boxes && drag?.n !== d.n && (
              <div
                className="pointer-events-none absolute rounded-sm border-2 border-apple/80"
                style={{ left: `${d.box.x1 / 10}%`, top: `${d.box.y1 / 10}%`, width: `${(d.box.x2 - d.box.x1) / 10}%`, height: `${(d.box.y2 - d.box.y1) / 10}%` }}
              />
            )}
            {editing ? (
              <button
                type="button"
                aria-label={`Marker ${d.n}, ${d.label}. Drag, or use the arrow keys, to move it.`}
                className={`absolute flex ${dot} -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full bg-apple font-bold text-white shadow ring-2 ring-white active:cursor-grabbing focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand`}
                style={style}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const p = toPicture(e.clientX, e.clientY);
                  if (p) setDrag({ n: d.n, ...p });
                }}
                onPointerMove={(e) => {
                  if (drag?.n !== d.n) return;
                  const p = toPicture(e.clientX, e.clientY);
                  if (p) setDrag({ n: d.n, x: Math.min(1000, Math.max(0, p.x)), y: Math.min(1000, Math.max(0, p.y)) });
                }}
                onPointerUp={() => {
                  if (drag?.n === d.n) onMove?.(d.n, drag.x, drag.y);
                  setDrag(null);
                }}
                onPointerCancel={() => setDrag(null)}
                onKeyDown={(e) => {
                  const step = e.shiftKey ? 50 : 10;
                  const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
                  if (!move) return;
                  e.preventDefault();
                  onMove?.(d.n, d.box.x1 + move[0], d.box.y1 + move[1]);
                }}
              >
                {d.n}
              </button>
            ) : (
              <span aria-hidden="true" className={`pointer-events-none absolute flex ${dot} -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-apple font-bold text-white shadow`} style={style}>
                {d.n}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
