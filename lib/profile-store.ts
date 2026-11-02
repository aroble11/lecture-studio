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

export function loadProfile(): TeacherProfile | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...EMPTY_PROFILE, ...JSON.parse(raw) } : null;
  } catch {
    return null;
  }
}

export function saveProfile(p: TeacherProfile): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
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
