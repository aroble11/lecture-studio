import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy and data flow · Lecture Studio",
  description: "What Lecture Studio sends to providers and saves in your browser.",
};

export default function PrivacyPage() {
  return (
    <div className="flex flex-1 justify-center bg-canvas">
      <main className="w-full max-w-3xl px-4 py-12 sm:px-8">
        <Link href="/" className="text-sm font-medium text-brand underline">
          ← Back to Lecture Studio
        </Link>
        <h1 className="mt-6 text-3xl font-extrabold tracking-tight">Privacy and data flow</h1>
        <p className="mt-3 text-muted">
          Lecture Studio is for teacher-only recordings. Do not record students or enter student names, records, or other identifying information.
        </p>

        <section className="mt-8 rounded-3xl border border-line bg-surface p-6">
          <h2 className="text-xl font-semibold">What leaves your browser</h2>
          <ul className="mt-4 list-disc space-y-3 pl-5 text-sm leading-6 text-body">
            <li><strong>Transcription — Meta:</strong> audio is divided into chunks; each chunk and the key-vocabulary list are sent to Meta&apos;s transcription API.</li>
            <li><strong>Reference-image labeling — Meta:</strong> if you add an image, the prepared image plus subject, grade, objective, and vocabulary are sent to Meta. The image is not fetched from a caller-provided URL.</li>
            <li><strong>Class videos — stay in your browser:</strong> only the sound is read from a video and sent to Meta for transcription, in chunks. Whiteboard moments are found and lifted off the board on your computer; only the drawings you choose to keep are sent to Meta to name their parts, with the same lesson details as a reference image.</li>
            <li><strong>Materials generation — Meta by default:</strong> the transcript, lesson details, teacher-profile guidance, and any diagram-label terms are sent to Meta&apos;s generation API.</li>
            <li><strong>Open-weight materials generation — Baseten when selected:</strong> that same generation payload goes to Muse Spark Open on Baseten instead of Meta&apos;s generation API. This option does not change where transcription or image labeling runs.</li>
          </ul>
          <p className="mt-4 text-sm text-muted">
            This page describes the app&apos;s routing. It does not make claims about provider retention, district approval, or legal compliance. Review the applicable provider and district policies before use.
          </p>
        </section>

        <section className="mt-6 rounded-3xl border border-line bg-surface p-6">
          <h2 className="text-xl font-semibold">Usage limits on the server</h2>
          <div className="mt-4 space-y-3 text-sm leading-6 text-body">
            <p>To share the demo fairly, the server counts how many transcription, labeling, and generation requests come from each network address per day. It stores only a one-way coded form of the address that changes every day, never the address itself, and the counts expire within 48 hours. No lecture content is stored with them.</p>
          </div>
        </section>

        <section className="mt-6 rounded-3xl border border-line bg-surface p-6">
          <h2 className="text-xl font-semibold">What is saved in this browser</h2>
          <div className="mt-4 space-y-3 text-sm leading-6 text-body">
            <p>The current lecture can be stored in this browser&apos;s IndexedDB: audio up to 100 MB, transcript, lesson details, reference image and labels, generated materials, and the selected generation option.</p>
            <p>The teaching profile is stored separately in this browser&apos;s local storage. It should contain only general class guidance—not student information.</p>
            <p>The save-status message on the main page reports whether the current lecture was saved. Audio over 100 MB is explicitly marked as unable to survive refresh even when the smaller lecture data is saved.</p>
          </div>
        </section>

        <section className="mt-6 rounded-3xl border border-line bg-surface p-6">
          <h2 className="text-xl font-semibold">How to delete local data</h2>
          <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-body">
            <li><strong>Start over</strong> deletes the saved current lecture, including its saved audio, transcript, image, and materials.</li>
            <li><strong>Delete profile</strong> separately deletes the saved teaching profile without deleting the current lecture.</li>
            <li>Clearing this site&apos;s browser storage also removes both records.</li>
          </ul>
        </section>
      </main>
    </div>
  );
}
