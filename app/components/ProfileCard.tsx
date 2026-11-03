"use client";

import { useState } from "react";
import { clearProfile, EMPTY_PROFILE, isEmptyProfile, saveProfile, type TeacherProfile } from "@/lib/profile-store";

const inputClass = "mt-1.5 w-full rounded-xl border border-field bg-surface px-3.5 py-2.5 text-base font-semibold text-ink placeholder:font-normal placeholder:text-subtle focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25";

/** Saved teacher profile: a header button that opens a dialog. It fills in subject/grade and shapes every generation. */
export default function ProfileCard({
  profile,
  onSave,
  onClear,
}: {
  profile: TeacherProfile | null;
  onSave: (p: TeacherProfile) => void;
  onClear: () => void;
}) {
  const [isOpen, setOpen] = useState(false);
  const [draft, setDraft] = useState<TeacherProfile>(profile ?? EMPTY_PROFILE);
  const [saveFailed, setSaveFailed] = useState(false);
  const empty = isEmptyProfile(profile);

  function open() {
    setDraft(profile ?? EMPTY_PROFILE);
    setSaveFailed(false);
    setOpen(true);
  }

  function close() {
    setOpen(false);
  }

  function save() {
    const clean = Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, v.trim()])) as TeacherProfile;
    const saved = saveProfile(clean); // still used for this visit even if the browser blocks storage
    setSaveFailed(!saved);
    onSave(clean);
    if (saved) close();
  }

  function clear() {
    if (!window.confirm("Delete your saved class profile from this browser? Your current lecture will not be deleted.")) return;
    if (!clearProfile()) {
      setSaveFailed(true);
      return;
    }
    setSaveFailed(false);
    setDraft(EMPTY_PROFILE);
    onClear();
    close();
  }

  const summary = [profile?.subject, profile?.grade && `Grade ${profile.grade}`].filter(Boolean).join(" · ");

  return (
    <>
      <button
        onClick={open}
        className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line-strong bg-surface px-4 text-[15px] font-bold text-ink hover:border-brand hover:text-brand"
      >
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
        {empty ? "Set up my class" : "My class profile"}
        {!empty && summary && <span className="hidden font-semibold text-subtle sm:inline">· {summary}</span>}
      </button>

      {isOpen && <dialog
        // Rendered only while open (so its fields never duplicate the lesson form's labels), then shown modally.
        ref={(el) => { if (el && !el.open) el.showModal(); }}
        onClose={close}
        aria-labelledby="profile-title"
        className="m-auto w-[min(640px,calc(100vw-32px))] rounded-3xl border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/50"
      >
        <form method="dialog" onSubmit={(e) => { e.preventDefault(); save(); }} className="flex flex-col gap-5 p-7">
          <div>
            <h2 id="profile-title" className="text-2xl font-extrabold">My class profile</h2>
            <p className="mt-1 text-[15px] leading-relaxed text-muted">
              Saved on this computer and used for every lecture. Describe your class in general terms — never student names or records.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-[15px] font-bold">
              Subject you usually teach
              <input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} maxLength={100} placeholder="U.S. History" className={inputClass} />
            </label>
            <label className="text-[15px] font-bold">
              Grade
              <input value={draft.grade} onChange={(e) => setDraft({ ...draft, grade: e.target.value })} maxLength={50} placeholder="10" className={inputClass} />
            </label>
            <label className="text-[15px] font-bold sm:col-span-2">
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
            <label className="text-[15px] font-bold sm:col-span-2">
              About your class <span className="font-semibold text-subtle">(general — no names)</span>
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
          {saveFailed && <p role="alert" className="text-[15px] font-semibold text-danger">This browser could not update the saved profile.</p>}
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className="min-h-11 rounded-xl bg-brand px-5 text-[15px] font-extrabold text-on-brand hover:bg-brand-dark">
              Save profile
            </button>
            <button type="button" onClick={close} className="min-h-11 rounded-xl border border-line-strong bg-surface px-5 text-[15px] font-bold hover:bg-tint">
              Cancel
            </button>
            {!empty && (
              <button type="button" onClick={clear} className="ml-auto min-h-11 px-2 text-[15px] font-bold text-muted underline hover:text-danger">
                Delete profile
              </button>
            )}
          </div>
        </form>
      </dialog>}
    </>
  );
}
