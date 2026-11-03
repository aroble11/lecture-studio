// What each printed copy contains. Pure (no React, no browser APIs) so the rules are unit tested.
import type { Materials } from "./materials";

export type PrintCopy = "student" | "teacher";

/**
 * The student handout is printed from a copy of the materials with every answer and teacher-only note removed,
 * so nothing the screen happens to show (an open tab, the "Show answers" box) can leak into it.
 * The word bank stays: it is printed for students on purpose when the teacher's profile asks for one.
 */
export function forStudents(m: Materials): Materials {
  return {
    guidedNotes: {
      title: m.guidedNotes.title,
      sections: m.guidedNotes.sections.map((s) => ({ heading: s.heading, startSec: s.startSec, items: s.items.map((it) => ({ text: it.text, answer: "" })) })),
      wordBank: [...m.guidedNotes.wordBank],
    },
    quiz: m.quiz.map((q) => ({ question: q.question, choices: [...q.choices], answerIndex: -1, explanation: "" })),
    exitTicket: m.exitTicket.map((q) => ({ question: q.question, sampleAnswer: "" })),
    bellRinger: { prompt: m.bellRinger.prompt, teacherNote: "" },
    diagramNotes: [],
    pacingFeedback: [],
    contentGaps: [],
  };
}

export type PrintSection = "guidedNotes" | "labelPicture" | "quiz" | "exitTicket" | "bellRinger" | "teacherFeedback";

/** Sections in print order. Teacher feedback (pacing and gaps) is only in the teacher copy. */
export function printSections(copy: PrintCopy, { hasDiagram }: { hasDiagram: boolean }): PrintSection[] {
  return [
    "guidedNotes",
    ...(hasDiagram ? (["labelPicture"] as const) : []),
    "quiz",
    "exitTicket",
    "bellRinger",
    ...(copy === "teacher" ? (["teacherFeedback"] as const) : []),
  ];
}
