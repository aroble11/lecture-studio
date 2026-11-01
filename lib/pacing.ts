// Pacing from the transcript's turn times (Meta ASR audioProcessedMs) and the guided-notes section starts.
// Safe to import from client code.
import type { Turn } from "./audio-client";

export type PacingRow = {
  heading: string;
  startMs: number;
  endMs: number;
  /** Share of the recording, 0–1. */
  share: number;
  words: number;
  /** Words per minute of speech in this section (null when no speech landed in it). */
  wpm: number | null;
};

export type Pacing = {
  totalMs: number;
  /** Time with speech (turn start → end), summed. */
  speakingMs: number;
  words: number;
  wpm: number | null;
  rows: PacingRow[];
};

const countWords = (t: string) => t.split(/\s+/).filter(Boolean).length;
const rate = (words: number, ms: number) => (ms >= 5_000 ? Math.round(words / (ms / 60_000)) : null);

export function computePacing(
  sections: { heading: string; startSec: number }[],
  turns: Turn[],
  durationMs: number,
): Pacing {
  const totalMs = Math.max(durationMs, ...turns.map((t) => t.endMs), 1);
  const speakingMs = turns.reduce((n, t) => n + Math.max(0, t.endMs - t.startMs), 0);
  const words = turns.reduce((n, t) => n + countWords(t.text), 0);

  const starts = [...sections]
    .map((s) => ({ heading: s.heading, startMs: Math.min(totalMs, s.startSec * 1000) }))
    .sort((a, b) => a.startMs - b.startMs);
  if (starts.length) starts[0].startMs = 0; // anything before the first section belongs to it
  // Sections that start at the same time can't be told apart from turn times, so they share one row.
  for (let i = starts.length - 1; i > 0; i--) {
    if (starts[i].startMs === starts[i - 1].startMs) {
      starts[i - 1].heading += ` + ${starts[i].heading}`;
      starts.splice(i, 1);
    }
  }

  const rows: PacingRow[] = starts.map((s, i) => {
    const endMs = i + 1 < starts.length ? starts[i + 1].startMs : totalMs;
    const inside = turns.filter((t) => t.startMs >= s.startMs && (t.startMs < endMs || i === starts.length - 1));
    const w = inside.reduce((n, t) => n + countWords(t.text), 0);
    const ms = inside.reduce((n, t) => n + Math.max(0, t.endMs - t.startMs), 0);
    return { heading: s.heading, startMs: s.startMs, endMs, share: (endMs - s.startMs) / totalMs, words: w, wpm: rate(w, ms) };
  });

  return { totalMs, speakingMs, words, wpm: rate(words, speakingMs), rows };
}
