"use client";

import { useState } from "react";
import { clearProfile, EMPTY_PROFILE, isEmptyProfile, saveProfile, type TeacherProfile } from "@/lib/profile-store";

const inputClass = "mt-1 w-full rounded-lg border border-zinc-300 bg-transparent p-2 text-sm dark:border-zinc-700";

/** Saved teacher profile: fills in subject/grade for each new lecture and shapes every generation. */
export default function ProfileCard({
  profile,
  onSave,
  onClear,
}: {
  profile: TeacherProfile | null;
  onSave: (p: TeacherProfile) => void;
  onClear: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<TeacherProfile>(profile ?? EMPTY_PROFILE);
  const [saveFailed, setSaveFailed] = useState(false);
  const empty = isEmptyProfile(profile);

  function open() {
    setDraft(profile ?? EMPTY_PROFILE);
    setSaveFailed(false);
    setEditing(true);
  }

  function save() {
    const clean = Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, v.trim()])) as TeacherProfile;
    setSaveFailed(!saveProfile(clean)); // still used for this visit even if the browser blocks storage
    onSave(clean);
    setEditing(false);
  }

  function clear() {
    if (!window.confirm("Delete your saved teaching profile from this browser? Your current lecture will not be deleted.")) return;
    if (!clearProfile()) {
      setSaveFailed(true);
      return;
    }
    setSaveFailed(false);
    setDraft(EMPTY_PROFILE);
    onClear();
  }

  if (!editing) {
    const summary = [profile?.subject, profile?.grade && `Grade ${profile.grade}`].filter(Boolean).join(" · ");
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-200 bg-white px-6 py-3 text-sm dark:border-zinc-800 dark:bg-zinc-950">
        <span className="text-zinc-600 dark:text-zinc-400">
          {empty ? (
            "Save a teaching profile so every lecture starts with your subject, grade, and style."
          ) : (
            <>
              <span className="font-medium text-zinc-900 dark:text-zinc-100">Your profile</span>
              {summary && ` · ${summary}`}
              {profile?.style && " · style saved"}
            </>
          )}
        </span>
        <div className="flex gap-3">
          <button onClick={open} className="font-medium text-blue-700 underline hover:text-blue-900 dark:text-blue-400">
            {empty ? "Set up profile" : "Edit"}
          </button>
          {!empty && (
            <button onClick={clear} className="font-medium text-zinc-500 underline hover:text-red-700">
              Delete profile
            </button>
          )}
        </div>
        {saveFailed && <span className="w-full text-red-600">This browser could not update the saved profile.</span>}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
      <h2 className="text-lg font-semibold">Your teaching profile</h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Saved in this browser and used for every lecture. Describe your class in general terms — never student names or records.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium">
          Subject you usually teach
          <input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} placeholder="U.S. History" className={inputClass} />
        </label>
        <label className="text-sm font-medium">
          Grade
          <input value={draft.grade} onChange={(e) => setDraft({ ...draft, grade: e.target.value })} placeholder="10" className={inputClass} />
        </label>
        <label className="text-sm font-medium sm:col-span-2">
          How you like materials written
          <textarea
            value={draft.style}
            onChange={(e) => setDraft({ ...draft, style: e.target.value })}
            rows={2}
            maxLength={600}
            placeholder="Short sentences, friendly tone; real-world examples; quiz questions that ask why, not just what"
            className={inputClass}
          />
        </label>
        <label className="text-sm font-medium sm:col-span-2">
          About your class <span className="font-normal text-zinc-500">(general — no names)</span>
          <textarea
            value={draft.classNotes}
            onChange={(e) => setDraft({ ...draft, classNotes: e.target.value })}
            rows={2}
            maxLength={600}
            placeholder="Several English learners — include a word bank and sentence starters; 50-minute periods"
            className={inputClass}
          />
        </label>
      </div>
      <div className="mt-4 flex gap-3">
        <button onClick={save} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          Save profile
        </button>
        <button onClick={() => setEditing(false)} className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
          Cancel
        </button>
      </div>
    </div>
  );
}
