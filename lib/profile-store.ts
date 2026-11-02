// Browser-only: the teacher's saved profile (localStorage). Survives "Start over".
// Keeps class descriptions general — the form tells teachers never to enter student names or records.

export type TeacherProfile = {
  subject: string;
  grade: string;
  /** How this teacher likes materials written. */
  style: string;
  /** The class in general terms. */
  classNotes: string;
};

export const EMPTY_PROFILE: TeacherProfile = { subject: "", grade: "", style: "", classNotes: "" };

const KEY = "lecture-studio:profile";

export type ProfileLoadResult = { profile: TeacherProfile | null; warning?: string };

export function validateSavedProfile(value: unknown): TeacherProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid profile");
  const source = value as Record<string, unknown>;
  const field = (name: keyof TeacherProfile, max: number) => {
    const item = source[name];
    if (item === undefined) return "";
    if (typeof item !== "string" || item.length > max) throw new Error(`invalid ${name}`);
    return item;
  };
  return { subject: field("subject", 100), grade: field("grade", 50), style: field("style", 600), classNotes: field("classNotes", 600) };
}

export function loadProfile(): ProfileLoadResult {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { profile: null };
    const value: unknown = JSON.parse(raw);
    return { profile: validateSavedProfile(value) };
  } catch {
    return { profile: null, warning: "An invalid saved teaching profile was ignored. Save the profile again to replace it." };
  }
}

export function saveProfile(p: TeacherProfile): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(validateSavedProfile(p)));
    return true;
  } catch {
    return false;
  }
}

export function clearProfile(): boolean {
  try {
    localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

export function isEmptyProfile(p: TeacherProfile | null): boolean {
  return !p || Object.values(p).every((v) => !v.trim());
}
