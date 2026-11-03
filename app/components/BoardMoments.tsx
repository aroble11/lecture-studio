"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatTime } from "@/lib/audio-client";
import { liftMoments, suggestBoardMoments } from "@/lib/board-frames";
import type { PreparedImage } from "@/lib/image-client";
import { MAX_BOARD_MOMENTS, type BoardMoment } from "@/lib/session-store";

export type MomentCheck = "checking" | "error";
type Scan = { kind: "idle" } | { kind: "scanning"; progress: number } | { kind: "capturing" } | { kind: "done" } | { kind: "error"; message: string };

/**
 * Whiteboard moments from a class video: suggestions are found on this computer; the teacher keeps the ones
 * worth pairing with the notes. Only kept moments leave the browser (for labeling, done by the parent).
 */
export default function BoardMoments({
  video,
  moments,
  checks,
  disabled,
  onKeep,
  onRemove,
  onRetry,
}: {
  video: Blob | null;
  moments: BoardMoment[];
  checks: Record<number, MomentCheck>;
  disabled: boolean;
  onKeep: (timeMs: number, image: PreparedImage) => void;
  onRemove: (timeMs: number) => void;
  onRetry: (timeMs: number) => void;
}) {
  const [scan, setScan] = useState<Scan>({ kind: "idle" });
  const [suggestions, setSuggestions] = useState<{ timeMs: number; image: PreparedImage }[]>([]);
  const everClean = useRef<Uint8Array | null>(null);
  const [scannedFor, setScannedFor] = useState<Blob | null>(video);
  const [adding, setAdding] = useState(false);
  const scrubber = useRef<HTMLVideoElement>(null);

  // A different video replaces the old suggestions (React's "adjust state when a prop changes" pattern).
  if (scannedFor !== video) {
    setScannedFor(video);
    setSuggestions([]);
    setScan({ kind: "idle" });
  }

  const videoUrl = useMemo(() => (video ? URL.createObjectURL(video) : null), [video]);
  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); }, [videoUrl]);

  useEffect(() => {
    if (!video) return;
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      try {
        await Promise.resolve(); // start after this render commits
        if (signal.aborted) return;
        setScan({ kind: "scanning", progress: 0 });
        const found = await suggestBoardMoments(video, { signal, onProgress: (progress) => { if (!signal.aborted) setScan({ kind: "scanning", progress }); } });
        if (signal.aborted) return;
        everClean.current = found.everClean;
        setScan({ kind: "capturing" });
        const frames = await liftMoments(video, found.moments, found.everClean, signal);
        if (signal.aborted) return;
        setSuggestions(frames);
        setScan({ kind: "done" });
      } catch (err) {
        if (signal.aborted) return;
        setScan({ kind: "error", message: err instanceof Error ? err.message : "The video couldn't be looked through." });
      }
    })();
    return () => controller.abort();
  }, [video]);

  async function addCurrentMoment() {
    const player = scrubber.current;
    if (!video || !player) return;
    setAdding(true);
    try {
      const timeMs = Math.round(player.currentTime * 1000);
      const [frame] = await liftMoments(video, [{ timeMs }], everClean.current);
      if (frame) onKeep(frame.timeMs, frame.image);
    } catch (err) {
      setScan({ kind: "error", message: err instanceof Error ? err.message : "That moment couldn't be captured." });
    } finally {
      setAdding(false);
    }
  }

  const keptTimes = new Set(moments.map((m) => m.timeMs));
  const cards = [
    ...moments.map((m) => ({ timeMs: m.timeMs, image: m.image })),
    ...suggestions.filter((s) => !keptTimes.has(s.timeMs)),
  ].sort((a, b) => a.timeMs - b.timeMs);
  const full = moments.length >= MAX_BOARD_MOMENTS;
  if (!video && !moments.length) return null;

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-line p-4 sm:p-5">
      <div>
        <h3 className="text-lg font-extrabold">Whiteboard moments <span className="text-[15px] font-semibold text-subtle">(from your video)</span></h3>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          We looked through your video on this computer for moments when the board was full and lifted the writing off the
          board. Keep the ones with a drawing or diagram (up to {MAX_BOARD_MOMENTS}) and they&apos;ll appear beside the matching
          guided notes. Only kept drawings are sent to Meta, to name their parts.
        </p>
      </div>

      {scan.kind === "scanning" && (
        <div role="status">
          <div className="h-3 w-full overflow-hidden rounded-full bg-tint">
            <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${Math.round(scan.progress * 100)}%` }} />
          </div>
          <p className="mt-2 text-[15px] text-muted">Looking through your video for full boards… {Math.round(scan.progress * 100)}%</p>
        </div>
      )}
      {scan.kind === "capturing" && <p role="status" className="text-[15px] text-muted">Lifting the drawings off the board…</p>}
      {scan.kind === "error" && <p role="alert" className="text-[15px] font-semibold text-danger">{scan.message}</p>}
      {scan.kind === "done" && suggestions.length === 0 && !moments.length && (
        <p className="text-[15px] text-muted">No full whiteboards were found. You can still add a moment yourself below.</p>
      )}

      {cards.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => {
            const kept = moments.find((m) => m.timeMs === card.timeMs);
            const check = checks[card.timeMs];
            const drawing = kept?.diagram?.kind === "objects" && kept.diagram.items.length > 0;
            return (
              <li key={card.timeMs} className={`flex flex-col overflow-hidden rounded-2xl border ${kept ? "border-brand ring-2 ring-brand/30" : "border-line"} bg-surface`}>
                {/* eslint-disable-next-line @next/next/no-img-element -- local data URL from the teacher's video */}
                <img src={card.image.dataUrl} alt={`Whiteboard at ${formatTime(card.timeMs)}`} className="aspect-video w-full bg-white object-contain p-2" />
                <div className="flex flex-1 flex-col gap-2 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[15px] font-extrabold">at {formatTime(card.timeMs)}</span>
                    {kept ? (
                      <button onClick={() => onRemove(card.timeMs)} disabled={disabled} className="min-h-11 rounded-xl border border-line-strong bg-surface px-3 text-sm font-bold text-ink hover:border-danger hover:text-danger disabled:opacity-40">
                        Remove
                      </button>
                    ) : (
                      <button onClick={() => onKeep(card.timeMs, card.image)} disabled={disabled || full} className="min-h-11 rounded-xl bg-brand px-4 text-sm font-extrabold text-on-brand hover:bg-brand-dark disabled:opacity-40">
                        Keep
                      </button>
                    )}
                  </div>
                  {kept && (
                    <p className="text-sm text-muted" role="status">
                      {check === "checking" ? "Checking for a drawing…"
                        : check === "error" ? <>Couldn&apos;t check this one. <button onClick={() => onRetry(card.timeMs)} disabled={disabled} className="font-bold text-brand underline">Try again</button></>
                        : !kept.diagram ? <>Not checked yet. <button onClick={() => onRetry(card.timeMs)} disabled={disabled} className="font-bold text-brand underline">Check now</button></>
                        : drawing ? `Drawing found (${kept.diagram.items.length} labels) — it goes beside the matching notes.`
                        : "Mostly writing — it won't be added to the notes."}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {full && <p className="text-sm text-subtle">You&apos;ve kept {MAX_BOARD_MOMENTS} moments — remove one to keep a different one.</p>}

      {videoUrl && (
        <details className="rounded-2xl bg-tint p-3 text-[15px]">
          <summary className="cursor-pointer font-bold text-brand">Add a different moment yourself</summary>
          <div className="mt-3 flex flex-col gap-3">
            <video ref={scrubber} src={videoUrl} controls muted preload="metadata" className="w-full rounded-xl bg-black" />
            <button onClick={addCurrentMoment} disabled={disabled || full || adding} className="inline-flex min-h-11 items-center justify-center self-start rounded-xl border border-line-strong bg-surface px-4 text-[15px] font-bold text-ink hover:border-brand hover:text-brand disabled:opacity-40">
              {adding ? "Capturing…" : "Keep the moment shown above"}
            </button>
          </div>
        </details>
      )}
    </div>
  );
}
