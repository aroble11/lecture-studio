"use client";

import { useEffect, useRef, useState } from "react";
import { decodeToMono, formatTime, SAMPLE_RATE, transcribeLecture, type Turn } from "@/lib/audio-client";
import type { DiagramContext, DiagramResult } from "@/lib/diagram";
import { prepareImage, type PreparedImage } from "@/lib/image-client";
import type { GenerateResult, LessonContext } from "@/lib/materials";
import { loadProfile, type TeacherProfile } from "@/lib/profile-store";
import { clearSession, loadSession, saveSession } from "@/lib/session-store";
import MaterialsView from "./MaterialsView";
import ProfileCard from "./ProfileCard";

const MAX_FILE_MB = 300;
const MAX_MINUTES = 90;

type Audio = { blob: Blob; url: string; label: string };
type Status =
  | { kind: "idle" }
  | { kind: "recording"; startedAt: number }
  | { kind: "decoding" }
  | { kind: "transcribing"; done: number; total: number }
  | { kind: "done"; seconds: number }
  | { kind: "error"; message: string };
type RefImage = PreparedImage & { name: string };
type ImageStatus = { kind: "idle" } | { kind: "analyzing" } | { kind: "error"; message: string };
type GenStatus =
  | { kind: "idle" }
  | { kind: "generating"; startedAt: number }
  | { kind: "error"; message: string };

const inputClass = "mt-1 w-full rounded-lg border border-zinc-300 bg-transparent p-2 text-sm dark:border-zinc-700";

export default function LectureCapture() {
  const [audio, setAudio] = useState<Audio | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const [keywords, setKeywords] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [durationMs, setDurationMs] = useState(0);
  const [lesson, setLesson] = useState({ subject: "", grade: "", objective: "", standards: "" });
  const [gen, setGen] = useState<GenStatus>({ kind: "idle" });
  const [genElapsed, setGenElapsed] = useState(0);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [refImage, setRefImage] = useState<RefImage | null>(null);
  const [diagram, setDiagram] = useState<DiagramResult | null>(null);
  const [imageStatus, setImageStatus] = useState<ImageStatus>({ kind: "idle" });
  /** Image + labels as they were when the current materials were generated. */
  const [resultDiagram, setResultDiagram] = useState<{ image: string; result: DiagramResult } | null>(null);
  const labelRef = useRef<{ image: RefImage; promise: Promise<DiagramResult | null> } | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** False until the saved session has been read, so the empty first render doesn't overwrite it. */
  const [restored, setRestored] = useState(false);
  const [profile, setProfile] = useState<TeacherProfile | null>(null);

  // Restore the last session after a page refresh.
  useEffect(() => {
    let cancelled = false;
    loadSession().then((saved) => {
      if (cancelled) return;
      const prof = loadProfile();
      setProfile(prof);
      if (!saved && prof) setLesson((l) => ({ ...l, subject: prof.subject, grade: prof.grade }));
      if (saved) {
        if (saved.audio) setAudio({ ...saved.audio, url: URL.createObjectURL(saved.audio.blob) });
        setKeywords(saved.keywords);
        setLesson(saved.lesson);
        setTurns(saved.turns);
        setDurationMs(saved.durationMs);
        setResult(saved.result);
        setResultDiagram(saved.resultDiagram);
        if (saved.refImage) {
          setRefImage(saved.refImage);
          if (saved.diagram) {
            setDiagram(saved.diagram);
            labelRef.current = { image: saved.refImage, promise: Promise.resolve(saved.diagram) };
          } else {
            analyzeImage(saved.refImage); // the refresh interrupted analysis — run it again
          }
        }
      }
      setRestored(true);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  // Save after each change (debounced).
  useEffect(() => {
    if (!restored) return;
    const t = setTimeout(() => {
      saveSession({
        version: 1,
        audio: audio ? { blob: audio.blob, label: audio.label } : null,
        keywords, lesson, turns, durationMs, refImage, diagram, result, resultDiagram,
      });
    }, 500);
    return () => clearTimeout(t);
  }, [restored, audio, keywords, lesson, turns, durationMs, refImage, diagram, result, resultDiagram]);

  function onSaveProfile(p: TeacherProfile) {
    setProfile(p);
    // Fill blanks in the current lesson; never overwrite what the teacher typed for this lecture.
    setLesson((l) => ({ ...l, subject: l.subject || p.subject, grade: l.grade || p.grade }));
  }

  function startOver() {
    if (!window.confirm("Clear the audio, transcript, image, and materials and start a new lecture?")) return;
    if (audio) URL.revokeObjectURL(audio.url);
    labelRef.current = null;
    setAudio(null);
    setStatus({ kind: "idle" });
    setKeywords("");
    setLesson({ subject: profile?.subject ?? "", grade: profile?.grade ?? "", objective: "", standards: "" });
    setTurns([]);
    setDurationMs(0);
    setGen({ kind: "idle" });
    setResult(null);
    setRefImage(null);
    setDiagram(null);
    setImageStatus({ kind: "idle" });
    setResultDiagram(null);
    clearSession();
  }

  const busy = status.kind === "decoding" || status.kind === "transcribing";
  const recording = status.kind === "recording";

  function selectAudio(blob: Blob, label: string) {
    const url = URL.createObjectURL(blob);
    setAudio((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { blob, url, label };
    });
    setTurns([]);
    setResult(null);
    setGen({ kind: "idle" });
    setStatus({ kind: "idle" });
  }

  const vocabulary = () => keywords.split(/[,\n]/).map((k) => k.trim()).filter(Boolean);

  /** Wonder names the objects in the image, SAM 3.1 boxes them. Runs as soon as an image is added. */
  function analyzeImage(img: RefImage) {
    setDiagram(null);
    setImageStatus({ kind: "analyzing" });
    const context: LessonContext = { ...lesson, vocabulary: vocabulary(), style: profile?.style, classNotes: profile?.classNotes };
    const promise = (async () => {
      try {
        const res = await fetch("/api/label", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ image: img.dataUrl, context }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.summary) throw new Error(data?.error ?? `Image analysis failed (HTTP ${res.status})`);
        if (labelRef.current?.image !== img) return null; // replaced or removed meanwhile
        setDiagram(data as DiagramResult);
        setImageStatus({ kind: "idle" });
        return data as DiagramResult;
      } catch (err) {
        if (labelRef.current?.image === img) {
          setImageStatus({ kind: "error", message: err instanceof Error ? err.message : "Something went wrong." });
        }
        return null;
      }
    })();
    labelRef.current = { image: img, promise };
  }

  async function onImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const prepared = await prepareImage(file);
      const img: RefImage = { ...prepared, name: file.name };
      setRefImage(img);
      analyzeImage(img);
    } catch {
      setImageStatus({ kind: "error", message: "This browser couldn't read that image. Try a JPEG or PNG." });
    }
  }

  function removeImage() {
    labelRef.current = null;
    setRefImage(null);
    setDiagram(null);
    setImageStatus({ kind: "idle" });
  }

  async function generate() {
    const startedAt = Date.now();
    setGen({ kind: "generating", startedAt });
    setGenElapsed(0);
    const tick = setInterval(() => setGenElapsed(Date.now() - startedAt), 1000);
    try {
      const context: LessonContext = { ...lesson, vocabulary: vocabulary(), style: profile?.style, classNotes: profile?.classNotes };
      // If the reference image is still being analyzed, wait for it so its labels shape the materials.
      const pending = labelRef.current;
      const labeled = pending ? await pending.promise : null;
      const img = pending?.image ?? null;
      const diagramContext: DiagramContext | undefined = labeled?.items.length
        ? { summary: labeled.summary, items: labeled.items.map(({ n, label }) => ({ n, label })) }
        : undefined;
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turns, context, diagram: diagramContext }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.materials) throw new Error(data?.error ?? `Generation failed (HTTP ${res.status})`);
      setResult(data as GenerateResult);
      setResultDiagram(labeled && img && diagramContext ? { image: img.dataUrl, result: labeled } : null);
      setGen({ kind: "idle" });
    } catch (err) {
      setGen({ kind: "error", message: err instanceof Error ? err.message : "Something went wrong." });
    } finally {
      clearInterval(tick);
    }
  }

  async function startRecording() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true },
      });
    } catch {
      setStatus({ kind: "error", message: "Microphone access was blocked. Allow it in the browser's address bar and try again." });
      return;
    }
    const recorder = new MediaRecorder(stream);
    const parts: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (timerRef.current) clearInterval(timerRef.current);
      const blob = new Blob(parts, { type: recorder.mimeType });
      selectAudio(blob, `Recording (${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })})`);
    };
    recorder.start(1000);
    recorderRef.current = recorder;
    const startedAt = Date.now();
    setElapsed(0);
    timerRef.current = setInterval(() => setElapsed(Date.now() - startedAt), 500);
    setStatus({ kind: "recording", startedAt });
  }

  function stopRecording() {
    recorderRef.current?.stop();
    recorderRef.current = null;
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      setStatus({ kind: "error", message: `That file is over ${MAX_FILE_MB} MB. Try a compressed audio file (m4a or mp3).` });
      return;
    }
    selectAudio(file, file.name);
  }

  async function transcribe() {
    if (!audio) return;
    const started = Date.now();
    try {
      setStatus({ kind: "decoding" });
      const samples = await decodeToMono(audio.blob);
      const ms = (samples.length / SAMPLE_RATE) * 1000;
      if (ms > MAX_MINUTES * 60_000) {
        throw new Error(`Lectures up to ${MAX_MINUTES} minutes are supported; this one is ${formatTime(ms)}.`);
      }
      setDurationMs(ms);
      const transcript = await transcribeLecture(samples, vocabulary(), {
        onProgress: (p) => setStatus({ kind: "transcribing", ...p }),
      });
      setTurns(transcript);
      setResult(null);
      setStatus({ kind: "done", seconds: (Date.now() - started) / 1000 });
    } catch (err) {
      const message =
        err instanceof DOMException && err.name === "EncodingError"
          ? "This browser couldn't read that audio file. Try m4a, mp3, or wav."
          : err instanceof Error ? err.message : "Something went wrong.";
      setStatus({ kind: "error", message });
    }
  }

  const words = turns.reduce((n, t) => n + t.text.split(/\s+/).filter(Boolean).length, 0);

  return (
    <section className="flex flex-col gap-6">
      {restored && <ProfileCard profile={profile} onSave={onSaveProfile} />}
      {(audio || turns.length > 0 || refImage || result) && (
        <div className="-mb-3 flex justify-end">
          <button onClick={startOver} disabled={busy || recording || gen.kind === "generating"} className="text-sm text-zinc-500 underline hover:text-zinc-900 disabled:opacity-40 dark:hover:text-zinc-100">
            Start over
          </button>
        </div>
      )}
      <div className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="text-lg font-semibold">1. Capture your lecture</h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Record yourself teaching, or upload an audio file. Teacher voice only — never record students.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {recording ? (
            <button onClick={stopRecording} className="rounded-lg bg-red-600 px-4 py-2 font-medium text-white hover:bg-red-700">
              ■ Stop · {formatTime(elapsed)}
            </button>
          ) : (
            <button onClick={startRecording} disabled={busy} className="rounded-lg bg-zinc-900 px-4 py-2 font-medium text-white hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300">
              ● Record
            </button>
          )}
          <label className={`cursor-pointer rounded-lg border border-zinc-300 px-4 py-2 font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900 ${recording || busy ? "pointer-events-none opacity-40" : ""}`}>
            Upload audio
            <input type="file" accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg" onChange={onFile} className="hidden" />
          </label>
        </div>

        {audio && !recording && (
          <div className="mt-4 flex flex-col gap-2">
            <span className="text-sm font-medium">{audio.label}</span>
            <audio controls src={audio.url} className="w-full" />
          </div>
        )}
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="text-lg font-semibold">2. About this lesson <span className="font-normal text-zinc-500">(optional)</span></h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Helps the transcript spell key terms right and fits the materials to your class.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-medium">
            Subject
            <input value={lesson.subject} onChange={(e) => setLesson({ ...lesson, subject: e.target.value })} placeholder="U.S. History" className={inputClass} />
          </label>
          <label className="text-sm font-medium">
            Grade
            <input value={lesson.grade} onChange={(e) => setLesson({ ...lesson, grade: e.target.value })} placeholder="10" className={inputClass} />
          </label>
          <label className="text-sm font-medium sm:col-span-2">
            Lesson objective
            <input value={lesson.objective} onChange={(e) => setLesson({ ...lesson, objective: e.target.value })} placeholder="Students can explain why the Articles of Confederation were replaced" className={inputClass} />
          </label>
          <label className="text-sm font-medium sm:col-span-2">
            Standards
            <input value={lesson.standards} onChange={(e) => setLesson({ ...lesson, standards: e.target.value })} placeholder="e.g. C3 D2.His.14.9-12" className={inputClass} />
          </label>
          <label className="text-sm font-medium sm:col-span-2">
            Key vocabulary <span className="font-normal text-zinc-500">(names and terms, separated by commas)</span>
            <textarea
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              rows={2}
              placeholder="Articles of Confederation, Shays' Rebellion, ratification"
              className={inputClass}
            />
          </label>
          <div className="text-sm sm:col-span-2">
            <span className="font-medium">Reference image</span>{" "}
            <span className="text-zinc-500">(a slide, worksheet, diagram, or photo — we&apos;ll find objects to label)</span>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <label className="cursor-pointer rounded-lg border border-zinc-300 px-3 py-1.5 font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
                {refImage ? "Replace image" : "Add image"}
                <input type="file" accept="image/jpeg,image/png,image/webp" onChange={onImage} className="hidden" />
              </label>
              {refImage && (
                <button onClick={removeImage} className="text-zinc-500 underline hover:text-zinc-900 dark:hover:text-zinc-100">
                  Remove
                </button>
              )}
            </div>
            {refImage && (
              <div className="mt-3 flex items-start gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element -- local data URL preview */}
                <img src={refImage.dataUrl} alt="" className="h-20 w-auto rounded border border-zinc-200 dark:border-zinc-800" />
                <div className="text-zinc-600 dark:text-zinc-400">
                  <p className="font-medium text-zinc-900 dark:text-zinc-100">{refImage.name}</p>
                  {imageStatus.kind === "analyzing" && <p>Finding objects to label…</p>}
                  {imageStatus.kind === "error" && <p className="text-red-600">{imageStatus.message}</p>}
                  {diagram && diagram.items.length > 0 && (
                    <p>
                      {diagram.items.length} items to label: {diagram.items.map((d) => d.label).join(", ")}
                    </p>
                  )}
                  {diagram && diagram.items.length === 0 && (
                    <p>{diagram.kind === "mostly_text" ? "This image is mostly writing — nothing to label." : "No objects to label were found."}</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
        <button
          onClick={transcribe}
          disabled={!audio || busy || recording}
          className="mt-4 rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {busy ? "Transcribing…" : "Transcribe lecture"}
        </button>

        {status.kind === "decoding" && <p className="mt-3 text-sm text-zinc-600">Preparing audio…</p>}
        {status.kind === "transcribing" && (
          <div className="mt-3">
            <div className="h-2 w-full overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
              <div className="h-full bg-blue-600 transition-all" style={{ width: `${(status.done / Math.max(1, status.total)) * 100}%` }} />
            </div>
            <p className="mt-1 text-sm text-zinc-600">Transcribing section {Math.min(status.done + 1, status.total)} of {status.total}…</p>
          </div>
        )}
        {status.kind === "error" && <p className="mt-3 text-sm text-red-600">{status.message}</p>}
      </div>

      {turns.length > 0 && (
        <div className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">Transcript</h2>
            <span className="text-sm text-zinc-500">
              {formatTime(durationMs)} of audio · {turns.length} segments · {words} words
              {status.kind === "done" && ` · ready in ${status.seconds.toFixed(0)} s`}
            </span>
          </div>
          <ol className="mt-4 flex flex-col gap-3">
            {turns.map((t, i) => (
              <li key={i} className="flex gap-3 text-sm leading-6">
                <span className="w-24 shrink-0 font-mono text-xs leading-6 text-zinc-500">
                  {formatTime(t.startMs)}–{formatTime(t.endMs)}
                </span>
                <span>{t.text}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {turns.length > 0 && (
        <div className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="text-lg font-semibold">3. Generate materials</h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Guided notes, a 5-question check for understanding, an exit ticket, and tomorrow&apos;s bell ringer
            {refImage ? ", plus a label-the-diagram activity from your image" : ""}.
          </p>
          <button
            onClick={generate}
            disabled={gen.kind === "generating" || busy}
            className="mt-4 rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            {gen.kind === "generating" ? `Generating… ${formatTime(genElapsed)}` : result ? "Regenerate" : "Generate materials"}
          </button>
          {gen.kind === "error" && <p className="mt-3 text-sm text-red-600">{gen.message}</p>}
        </div>
      )}

      {result && <MaterialsView result={result} diagram={resultDiagram} turns={turns} durationMs={durationMs} />}
    </section>
  );
}
