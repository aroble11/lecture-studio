// Shared shapes for reference-image labeling (Wonder names objects, SAM 3.1 boxes them).
// Safe to import from client code.

/** Box in coordinates normalized 0–1000 (0,0 = top-left of the image). */
export type Box = { x1: number; y1: number; x2: number; y2: number };

export type DiagramItem = {
  /** Number shown on the image marker, in reading order. */
  n: number;
  /** Term students write. */
  label: string;
  /** Short noun phrase SAM searched for. */
  phrase: string;
  /** Precise SAM box. */
  box: Box;
  /** SAM confidence 0–1. */
  score: number;
};

export type DiagramResult = {
  /** "mostly_text" = the image is mainly writing, so there is nothing for SAM to label. */
  kind: "objects" | "mostly_text";
  /** One sentence describing the image. */
  summary: string;
  items: DiagramItem[];
  model: string;
  seconds: number;
};

/** What the generation step needs to know about the image. */
export type DiagramContext = { summary: string; items: { n: number; label: string }[] };
