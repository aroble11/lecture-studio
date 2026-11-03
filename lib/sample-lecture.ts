// "Try a sample lecture": a reviewed, versioned fixture served from public/sample/.
// Loading it makes zero provider calls: it must already contain the transcript, any image labels, and the materials.
import { validateSavedSession, type SavedSession } from "./session-store";

export const SAMPLE_URL = "/sample/sample-lecture.json";
export const SAMPLE_FORMAT = "lecture-studio-sample";

export type SampleLecture = {
  title: string;
  /** The lecture to show. Audio is never embedded; see `audio`. */
  session: SavedSession;
  /** Optional recording served beside the fixture, so the sample can be played. */
  audio?: { url: string; label: string };
};

const AUDIO_URL = /^\/sample\/[a-z0-9][a-z0-9._-]{0,80}\.(?:m4a|mp3|wav|webm|ogg)$/i;

/** The bundled file is still treated as untrusted input and checked exactly like a saved lecture. */
export function parseSampleLecture(value: unknown): SampleLecture {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sample is invalid");
  const sample = value as Record<string, unknown>;
  if (sample.format !== SAMPLE_FORMAT || sample.version !== 1) throw new Error("sample format is unsupported");

  const { session, warning } = validateSavedSession(sample.session);
  if (warning) throw new Error("sample has invalid parts");
  if (!session.result) throw new Error("sample has no materials");
  if (session.refImage && !session.diagram) throw new Error("sample image has no labels");

  const title = typeof sample.title === "string" && sample.title.trim() && sample.title.length <= 120
    ? sample.title.trim()
    : "Sample lecture";

  let audio: SampleLecture["audio"];
  if (sample.audio !== undefined) {
    const a = sample.audio as Record<string, unknown> | null;
    if (!a || typeof a.url !== "string" || !AUDIO_URL.test(a.url) || typeof a.label !== "string" || !a.label.trim() || a.label.length > 200) {
      throw new Error("sample audio is invalid");
    }
    audio = { url: a.url, label: a.label.trim() };
  }

  return { title, session: { ...session, audio: null, audioRevision: null }, audio };
}
