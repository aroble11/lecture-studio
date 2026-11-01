// Shared shapes for generated classroom materials. Safe to import from client code.

export type LessonContext = {
  subject?: string;
  grade?: string;
  objective?: string;
  standards?: string;
  vocabulary?: string[];
  /** From the saved teacher profile: how this teacher likes materials written. */
  style?: string;
  /** From the saved teacher profile: the class in general terms (never student names or records). */
  classNotes?: string;
};

export type GuidedNoteItem = {
  /** Sentence with exactly one blank written as "_____". */
  text: string;
  /** Word or phrase that fills the blank. */
  answer: string;
};

export type Materials = {
  guidedNotes: {
    title: string;
    sections: { heading: string; startSec: number; items: GuidedNoteItem[] }[];
    /** Answers listed for students who need the support (empty unless the teacher profile asks). */
    wordBank: string[];
  };
  quiz: { question: string; choices: string[]; answerIndex: number; explanation: string }[];
  exitTicket: { question: string; sampleAnswer: string }[];
  bellRinger: { prompt: string; teacherNote: string };
  /** One note per labeled item in the reference image (empty when there is no image). */
  diagramNotes: { n: number; note: string }[];
  /** Teacher-facing: 1–3 observations about time use, from the transcript timestamps. */
  pacingFeedback: string[];
  /** Teacher-facing: concepts mentioned but under-explained (may be empty). */
  contentGaps: ContentGap[];
};

export type ContentGap = {
  concept: string;
  /** Where in the recording the concept comes up. */
  atSec: number;
  /** What is missing, in one sentence. */
  issue: string;
  /** What to add next time, in one sentence. */
  suggestion: string;
};

export type GenerateResult = {
  materials: Materials;
  model: string;
  seconds: number;
  /** True when generated in Privacy Mode on the open-weight model. */
  privacy?: boolean;
};

const str = { type: "string" } as const;
const int = { type: "integer" } as const;
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const arr = (items: unknown) => ({ type: "array", items });

/** Strict JSON schema sent to the model (Responses API text.format). Counts are enforced in code. */
export const MATERIALS_SCHEMA = obj({
  guidedNotes: obj({
    title: str,
    sections: arr(obj({ heading: str, startSec: int, items: arr(obj({ text: str, answer: str })) })),
    wordBank: arr(str),
  }),
  quiz: arr(obj({ question: str, choices: arr(str), answerIndex: int, explanation: str })),
  exitTicket: arr(obj({ question: str, sampleAnswer: str })),
  bellRinger: obj({ prompt: str, teacherNote: str }),
  diagramNotes: arr(obj({ n: int, note: str })),
  pacingFeedback: arr(str),
  contentGaps: arr(obj({ concept: str, atSec: int, issue: str, suggestion: str })),
});
