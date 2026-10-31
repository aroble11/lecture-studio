// Shared shapes for generated classroom materials. Safe to import from client code.

export type LessonContext = {
  subject?: string;
  grade?: string;
  objective?: string;
  standards?: string;
  vocabulary?: string[];
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
  };
  quiz: { question: string; choices: string[]; answerIndex: number; explanation: string }[];
  exitTicket: { question: string; sampleAnswer: string }[];
  bellRinger: { prompt: string; teacherNote: string };
};

export type GenerateResult = { materials: Materials; model: string; seconds: number };

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
  }),
  quiz: arr(obj({ question: str, choices: arr(str), answerIndex: int, explanation: str })),
  exitTicket: arr(obj({ question: str, sampleAnswer: str })),
  bellRinger: obj({ prompt: str, teacherNote: str }),
});
