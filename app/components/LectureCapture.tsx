"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { decodeToMono, formatTime, SAMPLE_RATE, transcribeLecture, type Turn } from "@/lib/audio-client";
import type { DiagramContext, DiagramResult } from "@/lib/diagram";
import { prepareImage, type PreparedImage } from "@/lib/image-client";
import type { GenerateResult, LessonContext } from "@/lib/materials";
import { createOperationRevision } from "@/lib/operation-revision";
import { loadProfile, type TeacherProfile } from "@/lib/profile-store";
import { RECORDING_LIMITS, recordingLimitMessage, recordingLimitReason, stopMediaRecorder, stopMediaStream, type RecordingLimitReason } from "@/lib/recording-lifecycle";
import { clearSession, loadSession, MAX_SAVED_AUDIO_BYTES, saveAudio, saveSession, type ResultSource } from "@/lib/session-store";
import MaterialsView from "./MaterialsView";
import ProfileCard from "./ProfileCard";

const MAX_FILE_MB = RECORDING_LIMITS.bytes / (1024 * 1024);
const MAX_MINUTES = RECORDING_LIMITS.durationMs / 60_000;

type Audio = { blob: Blob; url: string; label: string; revision: string };
type Status =
  | { kind: "idle" }
  | { kind: "requesting-microphone" }
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
type SaveState =
  | { kind: "idle" | "saving" | "saved" }
  | { kind: "error"; message: string }
  | { kind: "warning"; message: string }
  | { kind: "too-large"; maxBytes: number };

const inputClass = "mt-1 w-full rounded-lg border border-zinc-300 bg-transparent p-2 text-sm dark:border-zinc-700";
const newAudioRevision = () => typeof globalThis.crypto.randomUUID === "function"
  ? globalThis.crypto.randomUUID()
  : `${Date.now()}-${globalThis.crypto.getRandomValues(new Uint32Array(2)).join("-")}`;

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
  const [resultSource, setResultSource] = useState<ResultSource | null>(null);
  const [refImage, setRefImage] = useState<RefImage | null>(null);
  const [diagram, setDiagram] = useState<DiagramResult | null>(null);
  const [imageStatus, setImageStatus] = useState<ImageStatus>({ kind: "idle" });
  /** Image + labels as they were when the current materials were generated. */
  const [resultDiagram, setResultDiagram] = useState<{ image: string; result: DiagramResult } | null>(null);
  const labelRef = useRef<{ image: RefImage; promise: Promise<DiagramResult | null>; controller: AbortController } | null>(null);
  const lectureOps = useRef(createOperationRevision());
  const imageOps = useRef(createOperationRevision());

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const microphoneRequestRef = useRef(0);
  const mountedRef = useRef(true);
  const discardRecordingRef = useRef(false);
  const [recordingNotice, setRecordingNotice] = useState<string | null>(null);
  /** False until the saved session has been read, so the empty first render doesn't overwrite it. */
  const [restored, setRestored] = useState(false);
  /** Audio blob currently in storage, so it's written once per new recording or upload. */
  const savedBlobRef = useRef<Blob | null>(null);
  const [profile, setProfile] = useState<TeacherProfile | null>(null);
  const [privacy, setPrivacy] = useState(false);
  const [sessionSave, setSessionSave] = useState<SaveState>({ kind: "idle" });
  const [audioSave, setAudioSave] = useState<SaveState>({ kind: "idle" });
  const [saveRetry, setSaveRetry] = useState(0);
  const [persistenceEnabled, setPersistenceEnabled] = useState(false);
  const sessionSaveAttempt = useRef(0);
  const audioSaveAttempt = useRef(0);

  // Restore the last session after a page refresh.
  useEffect(() => {
    let cancelled = false;
    const restoreRevision = lectureOps.current.revision();
    loadSession().then((loaded) => {
      if (cancelled) return;
      const loadedProfile = loadProfile();
      const prof = loadedProfile.profile;
      setProfile(prof);
      if (lectureOps.current.revision() !== restoreRevision) {
        setPersistenceEnabled(true);
        setRestored(true);
        return;
      }
      if (!loaded.ok) {
        setSessionSave({ kind: "error", message: loaded.error });
        setRestored(true);
        return;
      }
      const saved = loaded.value;
      setPersistenceEnabled(true);
      setSessionSave({ kind: "saved" });
      const restoreWarning = loaded.warning ?? loadedProfile.warning;
      if (restoreWarning) setAudioSave({ kind: "warning", message: restoreWarning });
      if (!saved && prof) setLesson((l) => ({ ...l, subject: prof.subject, grade: prof.grade }));
      if (saved) {
        if (saved.audio) {
          const revision = saved.audio.revision ?? newAudioRevision();
          if (saved.audio.revision) savedBlobRef.current = saved.audio.blob; // already stored — don't write it again
          setAudio({ ...saved.audio, revision, url: URL.createObjectURL(saved.audio.blob) });
          if (saved.audio.revision) setAudioSave({ kind: "saved" });
        }
        setKeywords(saved.keywords);
        setLesson(saved.lesson);
        setTurns(saved.turns);
        setDurationMs(saved.durationMs);
        setResult(saved.result);
        setResultSource(saved.result ? (saved.resultSource ?? {
          turns: saved.turns,
          durationMs: saved.durationMs,
          context: {
            ...saved.lesson,
            vocabulary: saved.keywords.split(/[,\n]/).map((k) => k.trim()).filter(Boolean),
            style: prof?.style,
            classNotes: prof?.classNotes,
          },
        }) : null);
        setResultDiagram(saved.resultDiagram);
        setPrivacy(saved.privacy ?? false);
        if (saved.refImage) {
          setRefImage(saved.refImage);
          if (saved.diagram) {
            setDiagram(saved.diagram);
            labelRef.current = { image: saved.refImage, promise: Promise.resolve(saved.diagram), controller: new AbortController() };
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
    if (!restored || !persistenceEnabled) return;
    const attempt = ++sessionSaveAttempt.current;
    const statusTimer = setTimeout(() => setSessionSave({ kind: "saving" }), 0);
    const t = setTimeout(async () => {
      const saveResult = await saveSession({
        version: 1,
        audioRevision: audio && audio.blob.size <= MAX_SAVED_AUDIO_BYTES ? audio.revision : null,
        keywords, lesson, turns, durationMs, refImage, diagram, result, resultSource, resultDiagram, privacy,
      });
      if (attempt !== sessionSaveAttempt.current) return;
      setSessionSave(saveResult.ok ? { kind: "saved" } : { kind: "error", message: "Changes could not be saved in this browser." });
    }, 500);
    return () => { clearTimeout(statusTimer); clearTimeout(t); };
  }, [restored, persistenceEnabled, audio, keywords, lesson, turns, durationMs, refImage, diagram, result, resultSource, resultDiagram, privacy, saveRetry]);

  useEffect(() => {
    mountedRef.current = true;
    const lectureOperations = lectureOps.current;
    const imageOperations = imageOps.current;
    return () => {
      mountedRef.current = false;
      microphoneRequestRef.current += 1;
      discardRecordingRef.current = true;
      stopMediaRecorder(recorderRef.current);
      stopMediaStream(streamRef.current);
      recorderRef.current = null;
      streamRef.current = null;
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      lectureOperations.invalidate();
      imageOperations.invalidate();
    };
  }, []);

  // Save the audio only when it changes.
  useEffect(() => {
    if (!restored || !persistenceEnabled || (audio?.blob ?? null) === savedBlobRef.current) return;
    const attempt = ++audioSaveAttempt.current;
    const t = setTimeout(async () => {
      setAudioSave({ kind: "saving" });
      const result = await saveAudio(audio ? { blob: audio.blob, label: audio.label, revision: audio.revision } : null);
      if (attempt !== audioSaveAttempt.current) return;
      if (result.ok) {
        savedBlobRef.current = audio?.blob ?? null;
        setAudioSave({ kind: "saved" });
      } else if (result.reason === "too-large") {
        setAudioSave({ kind: "too-large", maxBytes: result.maxBytes });
      } else {
        setAudioSave({ kind: "error", message: "The audio could not be saved in this browser." });
      }
    }, 0);
    return () => clearTimeout(t);
  }, [restored, persistenceEnabled, audio, saveRetry]);

  function onSaveProfile(p: TeacherProfile) {
    invalidateLectureWork();
    setProfile(p);
    // Fill blanks in the current lesson; never overwrite what the teacher typed for this lecture.
    setLesson((l) => ({ ...l, subject: l.subject || p.subject, grade: l.grade || p.grade }));
  }

  function onClearProfile() {
    invalidateLectureWork();
    setProfile(null);
  }

  function startOver() {
    if (!window.confirm("Clear the audio, transcript, image, and materials and start a new lecture?")) return;
    invalidateLectureWork();
    imageOps.current.invalidate();
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
    setResultSource(null);
    setRefImage(null);
    setDiagram(null);
    setImageStatus({ kind: "idle" });
    setResultDiagram(null);
    void clearSession().then((cleared) => {
      if (!cleared.ok) setSessionSave({ kind: "error", message: "The previous saved lecture could not be cleared." });
    });
  }

  const busy = status.kind === "decoding" || status.kind === "transcribing";
  const requestingMicrophone = status.kind === "requesting-microphone";
  const recording = status.kind === "recording";
  const generating = gen.kind === "generating";
  const controlsLocked = !restored || busy || requestingMicrophone || recording || generating;

  function invalidateLectureWork() {
    lectureOps.current.invalidate();
    setGen({ kind: "idle" });
    setStatus((current) => current.kind === "decoding" || current.kind === "transcribing" ? { kind: "idle" } : current);
  }

  function changeLectureInputs(change: () => void) {
    invalidateLectureWork();
    change();
  }

  function selectAudio(blob: Blob, label: string) {
    invalidateLectureWork();
    const url = URL.createObjectURL(blob);
    setAudio((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { blob, url, label, revision: newAudioRevision() };
    });
    setTurns([]);
    setResult(null);
    setResultSource(null);
    setGen({ kind: "idle" });
    setStatus({ kind: "idle" });
  }

  const vocabulary = () => keywords.split(/[,\n]/).map((k) => k.trim()).filter(Boolean);

  /** Wonder names the objects in the image, SAM 3.1 boxes them. Runs as soon as an image is added. */
  function analyzeImage(img: RefImage) {
    imageOps.current.invalidate();
    const ticket = imageOps.current.begin();
    setDiagram(null);
    setImageStatus({ kind: "analyzing" });
    const context: LessonContext = { ...lesson, vocabulary: vocabulary(), style: profile?.style, classNotes: profile?.classNotes };
    const promise = (async () => {
      try {
        const res = await fetch("/api/label", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ image: img.dataUrl, context }),
          signal: ticket.controller.signal,
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.summary) throw new Error(data?.error ?? `Image analysis failed (HTTP ${res.status})`);
        if (!imageOps.current.isCurrent(ticket) || labelRef.current?.image !== img) return null;
        setDiagram(data as DiagramResult);
        setImageStatus({ kind: "idle" });
        return data as DiagramResult;
      } catch (err) {
        if (imageOps.current.isCurrent(ticket) && labelRef.current?.image === img) {
          setImageStatus({ kind: "error", message: err instanceof Error ? err.message : "Something went wrong." });
        }
        return null;
      } finally {
        imageOps.current.finish(ticket);
      }
    })();
    labelRef.current = { image: img, promise, controller: ticket.controller };
  }

  async function onImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    invalidateLectureWork();
    imageOps.current.invalidate();
    const revision = lectureOps.current.revision();
    try {
      const prepared = await prepareImage(file);
      if (lectureOps.current.revision() !== revision) return;
      const img: RefImage = { ...prepared, name: file.name };
      setRefImage(img);
      analyzeImage(img);
    } catch {
      setImageStatus({ kind: "error", message: "This browser couldn't read that image. Try a JPEG or PNG." });
    }
  }

  function removeImage() {
    invalidateLectureWork();
    imageOps.current.invalidate();
    labelRef.current = null;
    setRefImage(null);
    setDiagram(null);
    setImageStatus({ kind: "idle" });
  }

  async function generate() {
    const ticket = lectureOps.current.begin();
    const startedAt = Date.now();
    setGen({ kind: "generating", startedAt });
    setGenElapsed(0);
    const tick = setInterval(() => setGenElapsed(Date.now() - startedAt), 1000);
    try {
      const context: LessonContext = { ...lesson, vocabulary: vocabulary(), style: profile?.style, classNotes: profile?.classNotes };
      const source: ResultSource = {
        turns: turns.map((turn) => ({ ...turn })),
        durationMs,
        context: { ...context, vocabulary: context.vocabulary ? [...context.vocabulary] : undefined },
      };
      const usePrivacy = privacy;
      // If the reference image is still being analyzed, wait for it so its labels shape the materials.
      const pending = labelRef.current;
      const labeled = pending ? await pending.promise : null;
      if (!lectureOps.current.isCurrent(ticket)) return;
      const img = pending?.image ?? null;
      const diagramContext: DiagramContext | undefined = labeled?.items.length
        ? { summary: labeled.summary, items: labeled.items.map(({ n, label }) => ({ n, label })) }
        : undefined;
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turns: source.turns, context: source.context, diagram: diagramContext, ...(usePrivacy ? { privacy: true } : {}) }),
        signal: ticket.controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.materials) throw new Error(data?.error ?? `Generation failed (HTTP ${res.status})`);
      if (!lectureOps.current.isCurrent(ticket)) return;
      setResult(data as GenerateResult);
      setResultSource(source);
      setResultDiagram(labeled && img && diagramContext ? { image: img.dataUrl, result: labeled } : null);
      setGen({ kind: "idle" });
    } catch (err) {
      if (lectureOps.current.isCurrent(ticket)) {
        setGen({ kind: "error", message: err instanceof Error ? err.message : "Something went wrong." });
      }
    } finally {
      clearInterval(tick);
      lectureOps.current.finish(ticket);
    }
  }

  async function startRecording() {
    invalidateLectureWork();
    const requestedRevision = lectureOps.current.revision();
    const requestId = ++microphoneRequestRef.current;
    discardRecordingRef.current = false;
    setRecordingNotice(null);
    setStatus({ kind: "requesting-microphone" });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true },
      });
    } catch {
      if (!mountedRef.current || requestId !== microphoneRequestRef.current) return;
      setStatus({ kind: "error", message: "Microphone access was blocked. Allow it in the browser's address bar and try again." });
      return;
    }
    if (!mountedRef.current || requestId !== microphoneRequestRef.current || lectureOps.current.revision() !== requestedRevision) {
      stopMediaStream(stream);
      return;
    }
    streamRef.current = stream;
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { audioBitsPerSecond: RECORDING_LIMITS.audioBitsPerSecond });
    } catch {
      stopMediaStream(stream);
      streamRef.current = null;
      setStatus({ kind: "error", message: "This browser could not start an audio recording." });
      return;
    }
    const parts: Blob[] = [];
    let recordedBytes = 0;
    let limitReason: RecordingLimitReason | null = null;
    const startedAt = Date.now();
    recorder.ondataavailable = (e) => {
      if (!e.data.size) return;
      parts.push(e.data);
      recordedBytes += e.data.size;
      limitReason ??= recordingLimitReason(Date.now() - startedAt, recordedBytes);
      if (limitReason) stopMediaRecorder(recorder);
    };
    recorder.onstop = () => {
      stopMediaStream(stream);
      if (streamRef.current === stream) streamRef.current = null;
      if (recorderRef.current === recorder) recorderRef.current = null;
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      if (!mountedRef.current || discardRecordingRef.current) return;
      const blob = new Blob(parts, { type: recorder.mimeType });
      selectAudio(blob, `Recording (${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })})`);
      if (limitReason) setRecordingNotice(recordingLimitMessage(limitReason));
    };
    recorder.onerror = () => {
      discardRecordingRef.current = true;
      stopMediaRecorder(recorder);
      stopMediaStream(stream);
      if (recorderRef.current === recorder) recorderRef.current = null;
      if (streamRef.current === stream) streamRef.current = null;
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      if (mountedRef.current) setStatus({ kind: "error", message: "The recording stopped because the browser reported a microphone error." });
    };
    try {
      recorder.start(1000);
      recorderRef.current = recorder;
      setElapsed(0);
      timerRef.current = setInterval(() => {
        const nextElapsed = Date.now() - startedAt;
        setElapsed(nextElapsed);
        limitReason ??= recordingLimitReason(nextElapsed, recordedBytes);
        if (limitReason) stopMediaRecorder(recorder);
      }, 500);
      setStatus({ kind: "recording", startedAt });
    } catch {
      stopMediaStream(stream);
      streamRef.current = null;
      setStatus({ kind: "error", message: "This browser could not start an audio recording." });
    }
  }

  function stopRecording() {
    stopMediaRecorder(recorderRef.current);
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
    const ticket = lectureOps.current.begin();
    const sourceAudio = audio;
    const started = Date.now();
    try {
      setStatus({ kind: "decoding" });
      const samples = await decodeToMono(sourceAudio.blob);
      if (!lectureOps.current.isCurrent(ticket)) return;
      const ms = (samples.length / SAMPLE_RATE) * 1000;
      if (ms > MAX_MINUTES * 60_000) {
        throw new Error(`Lectures up to ${MAX_MINUTES} minutes are supported; this one is ${formatTime(ms)}.`);
      }
      setDurationMs(ms);
      const transcript = await transcribeLecture(samples, vocabulary(), {
        onProgress: (p) => { if (lectureOps.current.isCurrent(ticket)) setStatus({ kind: "transcribing", ...p }); },
        signal: ticket.controller.signal,
      });
      if (!lectureOps.current.isCurrent(ticket)) return;
      setTurns(transcript);
      setResult(null);
      setResultSource(null);
      setStatus({ kind: "done", seconds: (Date.now() - started) / 1000 });
    } catch (err) {
      if (!lectureOps.current.isCurrent(ticket)) return;
      const message =
        err instanceof DOMException && err.name === "EncodingError"
          ? "This browser couldn't read that audio file. Try m4a, mp3, or wav."
          : err instanceof Error ? err.message : "Something went wrong.";
      setStatus({ kind: "error", message });
    } finally {
      lectureOps.current.finish(ticket);
    }
  }

  const words = turns.reduce((n, t) => n + t.text.split(/\s+/).filter(Boolean).length, 0);
  const saveError = sessionSave.kind === "error" ? sessionSave.message : audioSave.kind === "error" ? audioSave.message : null;
  const saveWarning = audioSave.kind === "warning" ? audioSave.message : null;
  const saving = sessionSave.kind === "saving" || audioSave.kind === "saving";

  return (
    <section className="flex flex-col gap-6">
      {restored && <ProfileCard profile={profile} onSave={onSaveProfile} onClear={onClearProfile} />}
      {restored && (
        <div
          role="status"
          className={`-mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm ${saveError || saveWarning || audioSave.kind === "too-large" ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200" : "border-zinc-200 bg-white text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400"}`}
        >
          <span>
            {saveError ? saveError : saveWarning ? saveWarning : saving ? (
              audioSave.kind === "too-large"
                ? `Saving lecture details… The audio exceeds the ${Math.round(audioSave.maxBytes / (1024 * 1024))} MB browser-save limit and will not survive a refresh.`
                : "Saving this lecture in your browser…"
            ) : audioSave.kind === "too-large" ? (
              <>Lecture details are saved, but this {((audio?.blob.size ?? 0) / (1024 * 1024)).toFixed(1)} MB audio exceeds the {Math.round(audioSave.maxBytes / (1024 * 1024))} MB browser-save limit. It will not survive a refresh.</>
            ) : "Saved in this browser."}
          </span>
          {saveError && (
            <button onClick={() => { setPersistenceEnabled(true); setSaveRetry((n) => n + 1); }} className="font-medium underline">
              Retry save
            </button>
          )}
        </div>
      )}
      {(audio || turns.length > 0 || refImage || result) && (
        <div className="-mb-3 flex justify-end">
          <button onClick={startOver} disabled={controlsLocked} className="text-sm text-zinc-500 underline hover:text-zinc-900 disabled:opacity-40 dark:hover:text-zinc-100">
            Start over
          </button>
        </div>
      )}
      <div className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="text-lg font-semibold">1. Capture your lecture</h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Record yourself teaching, or upload an audio file. Teacher voice only — never record students.
        </p>
        <div className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-950 dark:bg-blue-950 dark:text-blue-100">
          <span className="font-medium">Where data goes:</span> Audio chunks and key vocabulary go to Meta for transcription.
          An optional reference image plus subject, grade, objective, and vocabulary go to Meta for labeling.
          Materials use Meta by default; the open-weight option sends that generation step to Baseten instead.{" "}
          <Link href="/privacy" className="font-medium underline">Privacy and data flow</Link>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {recording ? (
            <button onClick={stopRecording} className="rounded-lg bg-red-600 px-4 py-2 font-medium text-white hover:bg-red-700">
              ■ Stop · {formatTime(elapsed)}
            </button>
          ) : (
            <button onClick={startRecording} disabled={controlsLocked} className="rounded-lg bg-zinc-900 px-4 py-2 font-medium text-white hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300">
              {requestingMicrophone ? "Waiting for microphone…" : "● Record"}
            </button>
          )}
          <label className={`cursor-pointer rounded-lg border border-zinc-300 px-4 py-2 font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900 ${controlsLocked ? "pointer-events-none opacity-40" : ""}`}>
            Upload audio
            <input type="file" accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg" onChange={onFile} disabled={controlsLocked} className="hidden" />
          </label>
        </div>
        {requestingMicrophone && <p role="status" className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">Waiting for microphone permission…</p>}
        {recordingNotice && <p role="status" className="mt-3 text-sm text-amber-700 dark:text-amber-300">{recordingNotice}</p>}

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
            <input value={lesson.subject} onChange={(e) => changeLectureInputs(() => setLesson((l) => ({ ...l, subject: e.target.value })))} disabled={controlsLocked} placeholder="U.S. History" className={inputClass} />
          </label>
          <label className="text-sm font-medium">
            Grade
            <input value={lesson.grade} onChange={(e) => changeLectureInputs(() => setLesson((l) => ({ ...l, grade: e.target.value })))} disabled={controlsLocked} placeholder="10" className={inputClass} />
          </label>
          <label className="text-sm font-medium sm:col-span-2">
            Lesson objective
            <input value={lesson.objective} onChange={(e) => changeLectureInputs(() => setLesson((l) => ({ ...l, objective: e.target.value })))} disabled={controlsLocked} placeholder="Students can explain why the Articles of Confederation were replaced" className={inputClass} />
          </label>
          <label className="text-sm font-medium sm:col-span-2">
            Standards
            <input value={lesson.standards} onChange={(e) => changeLectureInputs(() => setLesson((l) => ({ ...l, standards: e.target.value })))} disabled={controlsLocked} placeholder="e.g. C3 D2.His.14.9-12" className={inputClass} />
          </label>
          <label className="text-sm font-medium sm:col-span-2">
            Key vocabulary <span className="font-normal text-zinc-500">(names and terms, separated by commas)</span>
            <textarea
              value={keywords}
              onChange={(e) => changeLectureInputs(() => setKeywords(e.target.value))}
              disabled={controlsLocked}
              rows={2}
              placeholder="Articles of Confederation, Shays' Rebellion, ratification"
              className={inputClass}
            />
          </label>
          <div className="text-sm sm:col-span-2">
            <span className="font-medium">Reference image</span>{" "}
            <span className="text-zinc-500">(a slide, worksheet, diagram, or photo — we&apos;ll find objects to label)</span>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <label className={`cursor-pointer rounded-lg border border-zinc-300 px-3 py-1.5 font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900 ${controlsLocked ? "pointer-events-none opacity-40" : ""}`}>
                {refImage ? "Replace image" : "Add image"}
                <input type="file" accept="image/jpeg,image/png,image/webp" onChange={onImage} disabled={controlsLocked} className="hidden" />
              </label>
              {refImage && (
                <button onClick={removeImage} disabled={controlsLocked} className="text-zinc-500 underline hover:text-zinc-900 disabled:opacity-40 dark:hover:text-zinc-100">
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
          disabled={!audio || controlsLocked}
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
          <label className="mt-4 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={privacy}
              onChange={(e) => changeLectureInputs(() => setPrivacy(e.target.checked))}
              disabled={controlsLocked}
              className="mt-1"
            />
            <span>
              <span className="font-medium">Use open-weight model for materials</span>{" "}
              <span className="text-zinc-600 dark:text-zinc-400">
                — sends the transcript, lesson details, and any diagram-label terms to Muse Spark Open on Baseten instead of Meta
                for materials generation only. Audio transcription and optional image labeling still use Meta&apos;s API.
              </span>
            </span>
          </label>
          <button
            onClick={generate}
            disabled={controlsLocked}
            className="mt-4 rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            {gen.kind === "generating" ? `Generating… ${formatTime(genElapsed)}` : result ? "Regenerate" : "Generate materials"}
          </button>
          {gen.kind === "error" && <p className="mt-3 text-sm text-red-600">{gen.message}</p>}
        </div>
      )}

      {result && <MaterialsView
        result={result}
        diagram={resultDiagram}
        turns={resultSource?.turns ?? turns}
        durationMs={resultSource?.durationMs ?? durationMs}
      />}
    </section>
  );
}
