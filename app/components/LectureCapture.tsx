"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { decodeToMono, formatTime, readAudioDurationMs, SAMPLE_RATE, transcribeLecture, TranscriptionError, type ChunkResults, type Turn } from "@/lib/audio-client";
import type { DiagramResult } from "@/lib/diagram";
import { prepareImage, type PreparedImage } from "@/lib/image-client";
import type { GenerateResult } from "@/lib/materials";
import { createOperationRevision } from "@/lib/operation-revision";
import { loadProfile, type TeacherProfile } from "@/lib/profile-store";
import { createCompatibleMediaRecorder, RECORDING_LIMITS, recordingLimitMessage, recordingLimitReason, stopMediaRecorder, stopMediaStream, type RecordingLimitReason } from "@/lib/recording-lifecycle";
import { parseSampleLecture, SAMPLE_URL } from "@/lib/sample-lecture";
import { extractVideoAudio, isVideoFile, MAX_VIDEO_BYTES } from "@/lib/video-audio";
import type { ResultSource } from "@/lib/session-store";
import { clearSession, loadSession, MAX_BOARD_MOMENTS, MAX_SAVED_AUDIO_BYTES, saveAudio, saveSession, type BoardMoment } from "@/lib/session-store";
import { applyTranscriptEdits, buildLessonContext, countWords, materialsOutdated, diagramContextFor, generateRequestBody, keywordKey, lectureTooLongMessage, parseVocabulary, restoredResultSource, resumableChunks, saveStatus, snapshotResultSource, transcriptionErrorMessage, type SaveState } from "@/lib/lecture-workflow";
import BoardMoments, { type MomentCheck } from "./BoardMoments";
import MaterialsView from "./MaterialsView";
import PrintableMaterials from "./PrintableMaterials";
import type { PrintCopy } from "@/lib/export-plan";
import ProfileCard from "./ProfileCard";
import ThemeSwitch from "./ThemeSwitch";

const MAX_FILE_MB = RECORDING_LIMITS.bytes / (1024 * 1024);
const MAX_MINUTES = RECORDING_LIMITS.durationMs / 60_000;

type Audio = { blob: Blob; url: string; label: string; revision: string };
type Status =
  | { kind: "idle" }
  | { kind: "requesting-microphone" }
  | { kind: "recording"; startedAt: number }
  | { kind: "decoding"; progress?: number }
  | { kind: "transcribing"; done: number; total: number; waiting?: boolean }
  | { kind: "done"; seconds: number }
  | { kind: "error"; message: string };
type RefImage = PreparedImage & { name: string };
type ImageStatus = { kind: "idle" } | { kind: "analyzing" } | { kind: "error"; message: string };
type GenStatus =
  | { kind: "idle" }
  | { kind: "generating"; startedAt: number }
  | { kind: "error"; message: string };

const cardClass = "flex flex-col gap-5 rounded-3xl border border-line bg-surface p-5 sm:p-7";
const tileClass = "flex flex-col items-start gap-2.5 rounded-[20px] p-5 text-left disabled:opacity-40 sm:p-6";
const labelClass = "text-[15px] font-bold";
const inputClass = "mt-1.5 w-full rounded-xl border border-field bg-surface px-3.5 py-2.5 text-base font-semibold text-ink placeholder:font-normal placeholder:text-subtle focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25 disabled:bg-tint disabled:opacity-60";
const primaryButtonClass = "inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-brand px-6 text-base font-extrabold text-on-brand hover:bg-brand-dark disabled:opacity-40";
const secondaryButtonClass = "inline-flex min-h-11 items-center justify-center rounded-xl border border-line-strong bg-surface px-4 text-[15px] font-bold text-ink hover:border-brand hover:text-brand";
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
  const boardOps = useRef(createOperationRevision());
  const momentQueue = useRef<Promise<void>>(Promise.resolve());
  // Finished chunks from an interrupted transcription, reused only for the same audio and keywords.
  const partialTranscript = useRef<{ audio: Audio; keywords: string; results: ChunkResults } | null>(null);

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
  const [sample, setSample] = useState<{ title: string } | null>(null);
  const [boardMoments, setBoardMoments] = useState<BoardMoment[]>([]);
  const [transcriptDrafts, setTranscriptDrafts] = useState<string[] | null>(null);
  const [printRequest, setPrintRequest] = useState<{ copy: PrintCopy; id: number } | null>(null);
  const [momentChecks, setMomentChecks] = useState<Record<number, MomentCheck>>({});
  const [sampleStatus, setSampleStatus] = useState<{ kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string }>({ kind: "idle" });
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
        setResultSource(restoredResultSource(saved, prof));
        setResultDiagram(saved.resultDiagram);
        setBoardMoments(saved.boardMoments ?? []);
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

  // Print once the requested copy has rendered (the printable copy is hidden on screen).
  // The page title names the saved PDF and the print header, so it says which handout this is while printing.
  useEffect(() => {
    if (!printRequest) return;
    const timer = setTimeout(() => {
      const previous = document.title;
      const name = result?.materials.guidedNotes.title || "Lecture Studio";
      document.title = `${name} — ${printRequest.copy === "student" ? "student copy" : "teacher copy"}`;
      const restore = () => { document.title = previous; };
      window.addEventListener("afterprint", restore, { once: true });
      window.print();
      setTimeout(restore, 1_000); // browsers that don't block on print() fire afterprint late or never
    }, 50);
    return () => clearTimeout(timer);
  }, [printRequest, result]);

  // Save after each change (debounced).
  useEffect(() => {
    if (!restored || !persistenceEnabled) return;
    const attempt = ++sessionSaveAttempt.current;
    const statusTimer = setTimeout(() => setSessionSave({ kind: "saving" }), 0);
    const t = setTimeout(async () => {
      const saveResult = await saveSession({
        version: 1,
        audioRevision: audio && audio.blob.size <= MAX_SAVED_AUDIO_BYTES ? audio.revision : null,
        keywords, lesson, turns, durationMs, refImage, diagram, result, resultSource, resultDiagram, privacy, boardMoments,
      });
      if (attempt !== sessionSaveAttempt.current) return;
      setSessionSave(saveResult.ok ? { kind: "saved" } : { kind: "error", message: "Changes could not be saved in this browser." });
    }, 500);
    return () => { clearTimeout(statusTimer); clearTimeout(t); };
  }, [restored, persistenceEnabled, audio, keywords, lesson, turns, durationMs, refImage, diagram, result, resultSource, resultDiagram, privacy, boardMoments, saveRetry]);

  useEffect(() => {
    mountedRef.current = true;
    const lectureOperations = lectureOps.current;
    const imageOperations = imageOps.current;
    const boardOperations = boardOps.current;
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
      boardOperations.invalidate();
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
    clearBoardMoments();
    setTranscriptDrafts(null);
    void clearSession().then((cleared) => {
      if (!cleared.ok) setSessionSave({ kind: "error", message: "The previous saved lecture could not be cleared." });
    });
  }

  const busy = status.kind === "decoding" || status.kind === "transcribing";
  const requestingMicrophone = status.kind === "requesting-microphone";
  const recording = status.kind === "recording";
  const generating = gen.kind === "generating";
  const loadingSample = sampleStatus.kind === "loading";
  const controlsLocked = !restored || busy || requestingMicrophone || recording || generating || loadingSample || transcriptDrafts !== null;
  const hasWork = Boolean(audio || turns.length > 0 || refImage || result);

  function invalidateLectureWork() {
    lectureOps.current.invalidate();
    setSample(null);
    setSampleStatus((current) => current.kind === "idle" ? current : { kind: "idle" });
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
    clearBoardMoments(); // their times belong to the previous recording
    setTranscriptDrafts(null);
    setTurns([]);
    setResult(null);
    setResultSource(null);
    setGen({ kind: "idle" });
    setStatus({ kind: "idle" });
  }

  function saveTranscriptEdits() {
    if (!transcriptDrafts) return;
    const edited = applyTranscriptEdits(turns, transcriptDrafts);
    setTranscriptDrafts(null);
    if (edited.length === turns.length && edited.every((t, i) => t.text === turns[i].text)) return;
    invalidateLectureWork();
    setTurns(edited);
  }

  function clearBoardMoments() {
    boardOps.current.invalidate();
    setBoardMoments([]);
    setMomentChecks({});
  }

  /** Label kept whiteboard moments one at a time (labeling allows only a couple of requests at once site-wide). */
  function checkMoment(timeMs: number, image: BoardMoment["image"]) {
    const ticket = boardOps.current.begin();
    setMomentChecks((c) => ({ ...c, [timeMs]: "checking" }));
    const context = buildLessonContext(lesson, keywords, profile);
    momentQueue.current = momentQueue.current.then(async () => {
      if (!boardOps.current.isCurrent(ticket)) return;
      try {
        const res = await fetch("/api/label", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ image: image.dataUrl, context, board: true }),
          signal: ticket.controller.signal,
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.summary) throw new Error(data?.error ?? `Image analysis failed (HTTP ${res.status})`);
        if (!boardOps.current.isCurrent(ticket)) return;
        setBoardMoments((list) => list.map((m) => (m.timeMs === timeMs && m.image === image ? { ...m, diagram: data as DiagramResult } : m)));
        setMomentChecks(({ [timeMs]: _done, ...rest }) => { void _done; return rest; });
      } catch {
        if (boardOps.current.isCurrent(ticket)) setMomentChecks((c) => ({ ...c, [timeMs]: "error" }));
      } finally {
        boardOps.current.finish(ticket);
      }
    });
  }

  function keepMoment(timeMs: number, image: BoardMoment["image"]) {
    if (boardMoments.length >= MAX_BOARD_MOMENTS || boardMoments.some((m) => m.timeMs === timeMs)) return;
    setBoardMoments((list) => [...list, { timeMs, image, diagram: null }].sort((a, b) => a.timeMs - b.timeMs));
    checkMoment(timeMs, image);
  }

  function removeMoment(timeMs: number) {
    setBoardMoments((list) => list.filter((m) => m.timeMs !== timeMs));
    setMomentChecks(({ [timeMs]: _removed, ...rest }) => { void _removed; return rest; });
  }

  function retryMoment(timeMs: number) {
    const moment = boardMoments.find((m) => m.timeMs === timeMs);
    if (moment) checkMoment(timeMs, moment.image);
  }

  /** Wonder names the objects in the image, SAM 3.1 boxes them. Runs as soon as an image is added. */
  function analyzeImage(img: RefImage) {
    imageOps.current.invalidate();
    const ticket = imageOps.current.begin();
    setDiagram(null);
    setImageStatus({ kind: "analyzing" });
    const context = buildLessonContext(lesson, keywords, profile);
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
      const source = snapshotResultSource(turns, durationMs, buildLessonContext(lesson, keywords, profile));
      const usePrivacy = privacy;
      // If the reference image is still being analyzed, wait for it so its labels shape the materials.
      const pending = labelRef.current;
      const labeled = pending ? await pending.promise : null;
      if (!lectureOps.current.isCurrent(ticket)) return;
      const img = pending?.image ?? null;
      const diagramContext = diagramContextFor(labeled);
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(generateRequestBody(source, diagramContext, usePrivacy)),
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

  /** Replaces the current lecture with the bundled sample. Never calls a provider. */
  async function loadSample() {
    if (hasWork && !window.confirm("Replace your current lecture with the sample lecture? Your current audio, transcript, picture, and materials will be cleared.")) return;
    invalidateLectureWork();
    imageOps.current.invalidate();
    const ticket = lectureOps.current.begin();
    setSampleStatus({ kind: "loading" });
    let sampleAudio: Audio | null = null;
    try {
      const response = await fetch(SAMPLE_URL, { cache: "no-cache", signal: ticket.controller.signal });
      if (!response.ok) throw new Error(`sample request failed (${response.status})`);
      const parsed = parseSampleLecture(await response.json());
      if (parsed.audio) {
        const audioResponse = await fetch(parsed.audio.url, { signal: ticket.controller.signal });
        if (!audioResponse.ok) throw new Error(`sample audio request failed (${audioResponse.status})`);
        const blob = await audioResponse.blob();
        sampleAudio = { blob, url: URL.createObjectURL(blob), label: parsed.audio.label, revision: newAudioRevision() };
      }
      if (!lectureOps.current.isCurrent(ticket)) {
        if (sampleAudio) URL.revokeObjectURL(sampleAudio.url);
        return;
      }
      const s = parsed.session;
      setAudio((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return sampleAudio;
      });
      setStatus({ kind: "idle" });
      setGen({ kind: "idle" });
      setKeywords(s.keywords);
      setLesson(s.lesson);
      setTurns(s.turns);
      setDurationMs(s.durationMs);
      setResult(s.result);
      setResultSource(restoredResultSource(s, profile));
      setResultDiagram(s.resultDiagram);
      clearBoardMoments();
      setTranscriptDrafts(null);
      setBoardMoments(s.boardMoments ?? []);
      setPrivacy(s.privacy ?? false);
      setRefImage(s.refImage);
      setDiagram(s.diagram);
      setImageStatus({ kind: "idle" });
      labelRef.current = s.refImage && s.diagram
        ? { image: s.refImage, promise: Promise.resolve(s.diagram), controller: new AbortController() }
        : null;
      setSample({ title: parsed.title });
      setSampleStatus({ kind: "idle" });
    } catch (err) {
      if (sampleAudio) URL.revokeObjectURL(sampleAudio.url);
      if (!lectureOps.current.isCurrent(ticket)) return;
      console.warn("[sample] could not load:", err instanceof Error ? err.message : err);
      setSampleStatus({ kind: "error", message: "The sample lecture couldn't be loaded right now. Please try again in a moment." });
    } finally {
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
      recorder = createCompatibleMediaRecorder(stream);
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
    if (isVideoFile(file)) {
      // Only the sound is read from a class video, a window at a time, so large files are fine.
      if (file.size > MAX_VIDEO_BYTES) {
        setStatus({ kind: "error", message: `That video is over ${MAX_VIDEO_BYTES / 1024 ** 3} GB. Try a shorter or lower-resolution recording.` });
        return;
      }
      selectAudio(file, file.name);
      return;
    }
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      setStatus({ kind: "error", message: `That file is over ${MAX_FILE_MB} MB. Try a compressed audio file (m4a or mp3).` });
      return;
    }
    selectAudio(file, file.name);
  }

  async function transcribe() {
    if (!audio) return;
    if (turns.length && !window.confirm("Transcribe again? This replaces the current transcript, including any edits you made.")) return;
    setTranscriptDrafts(null);
    const ticket = lectureOps.current.begin();
    const sourceAudio = audio;
    const keywordList = parseVocabulary(keywords);
    const resume = resumableChunks(partialTranscript.current, sourceAudio, keywordList);
    if (!resume) partialTranscript.current = null;
    const started = Date.now();
    try {
      setStatus({ kind: "decoding" });
      const metadataDurationMs = await readAudioDurationMs(sourceAudio.blob);
      if (!lectureOps.current.isCurrent(ticket)) return;
      const metadataTooLong = metadataDurationMs === null ? null : lectureTooLongMessage(metadataDurationMs, MAX_MINUTES, formatTime);
      if (metadataTooLong) throw new Error(metadataTooLong);
      const samples = isVideoFile({ type: sourceAudio.blob.type, name: sourceAudio.label })
        ? await extractVideoAudio(sourceAudio.blob, {
          signal: ticket.controller.signal,
          onProgress: (progress) => { if (lectureOps.current.isCurrent(ticket)) setStatus({ kind: "decoding", progress }); },
        })
        : await decodeToMono(sourceAudio.blob);
      if (!lectureOps.current.isCurrent(ticket)) return;
      const ms = (samples.length / SAMPLE_RATE) * 1000;
      const tooLong = lectureTooLongMessage(ms, MAX_MINUTES, formatTime);
      if (tooLong) throw new Error(tooLong);
      setDurationMs(ms);
      const transcript = await transcribeLecture(samples, keywordList, {
        onProgress: (p) => { if (lectureOps.current.isCurrent(ticket)) setStatus({ kind: "transcribing", ...p }); },
        signal: ticket.controller.signal,
        resume,
      });
      if (!lectureOps.current.isCurrent(ticket)) return;
      partialTranscript.current = null;
      setTurns(transcript);
      setResult(null);
      setResultSource(null);
      setStatus({ kind: "done", seconds: (Date.now() - started) / 1000 });
    } catch (err) {
      if (!lectureOps.current.isCurrent(ticket)) return;
      const partial = err instanceof TranscriptionError ? err.partial : undefined;
      if (partial?.some(Boolean)) {
        partialTranscript.current = { audio: sourceAudio, keywords: keywordKey(keywordList), results: partial };
      }
      setStatus({ kind: "error", message: transcriptionErrorMessage(err, partial) });
    } finally {
      lectureOps.current.finish(ticket);
    }
  }

  const words = countWords(turns);
  const save = saveStatus(sessionSave, audioSave, audio?.blob.size ?? 0);
  const saving = sessionSave.kind === "saving" || audioSave.kind === "saving";
  // 1 add audio → 2 lesson + transcribe → 3 generate → 4 all done.
  const step = result ? 4 : turns.length > 0 ? 3 : audio ? 2 : 1;
  const STEPS = ["Add your lecture", "Tell us about the lesson", "Get your materials"];

  return (
    <>
      <header className="border-b border-line bg-surface print:hidden">
        <div className="mx-auto flex max-w-[1080px] flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5 text-ink">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[#ffe8a3] text-apple">
              <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 7c-1.5-1-4-1.2-5.6.3C4.6 9 4.8 12.6 6.3 15.4 7.5 17.7 9.2 20 11 19.6c.6-.1.9-.4 1-.4s.4.3 1 .4c1.8.4 3.5-1.9 4.7-4.2 1.5-2.8 1.7-6.4-.1-8.1C16 5.8 13.5 6 12 7z" /><path d="M12 7c0-1.8.8-3.2 2.4-4" /></svg>
            </span>
            <span className="text-xl font-extrabold tracking-tight">Lecture Studio</span>
          </Link>
          <nav aria-label="Main" className="flex flex-wrap items-center gap-2">
            {restored && !save.attention && (
              <span role="status" className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-bold ${saving ? "bg-tint text-muted" : "bg-ok-soft text-ok"}`}>
                {!saving && <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10" /></svg>}
                {save.message}
              </span>
            )}
            <Link href="/privacy" className="px-3 py-2.5 text-[15px] font-bold text-brand hover:text-brand-dark">Privacy</Link>
            <ThemeSwitch />
            {restored && <ProfileCard profile={profile} onSave={onSaveProfile} onClear={onClearProfile} />}
          </nav>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1080px] flex-col gap-7 px-4 pb-16 pt-10 sm:px-6 print:hidden">
        {restored && save.attention && (
          <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-sun-line bg-sun-soft px-4 py-3 text-[15px] font-semibold text-sun-ink">
            <span>{save.message}</span>
            {save.retry && (
              <button onClick={() => { setPersistenceEnabled(true); setSaveRetry((n) => n + 1); }} className="min-h-11 rounded-xl bg-surface px-4 font-bold underline">
                Retry save
              </button>
            )}
          </div>
        )}

        <section className="flex flex-col gap-2">
          <h1 className="text-[clamp(30px,5vw,40px)] font-extrabold leading-[1.15] tracking-tight">
            Turn today&apos;s lesson into <span className="bg-[linear-gradient(transparent_62%,var(--color-sun)_62%)]">tomorrow&apos;s handouts</span>.
          </h1>
          <p className="max-w-[640px] text-lg leading-relaxed text-muted sm:text-[19px]">
            Record yourself teaching. Lecture Studio writes guided notes, a quick quiz, an exit ticket, and a bell ringer for you to review.
          </p>
        </section>

        <ol aria-label="Progress" className="flex flex-wrap gap-2.5">
          {STEPS.map((label, i) => {
            const n = i + 1;
            const current = n === step;
            const done = n < step;
            return (
              <li
                key={label}
                aria-current={current ? "step" : undefined}
                className={`flex items-center gap-2.5 rounded-full py-2.5 pl-2.5 pr-4 text-[15px] ${current ? "bg-brand font-extrabold text-on-brand" : "border border-line-strong bg-surface font-bold text-body"}`}
              >
                <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full ${current ? "bg-on-brand text-brand" : done ? "bg-ok-soft text-ok" : "bg-tint"}`}>
                  {done ? <svg aria-label="done" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10" /></svg> : n}
                </span>
                {label}
              </li>
            );
          })}
        </ol>

        <section className={cardClass}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-2xl font-extrabold">1. Add your lecture</h2>
            {hasWork && (
              <button onClick={startOver} disabled={controlsLocked} className="min-h-11 px-2 text-[15px] font-bold text-muted underline hover:text-ink disabled:opacity-40">
                Start over
              </button>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {recording ? (
              <button onClick={stopRecording} className={`${tileClass} bg-apple text-white hover:bg-[#962817]`}>
                <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-white/20">
                  <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                </span>
                <span className="text-xl font-extrabold">Stop recording · {formatTime(elapsed)}</span>
                <span className="text-[15px] leading-snug opacity-95">Recording stops by itself at {MAX_MINUTES} minutes.</span>
              </button>
            ) : (
              <button onClick={startRecording} disabled={controlsLocked} className={`${tileClass} bg-brand text-on-brand hover:bg-brand-dark`}>
                <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-white/20">
                  <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></svg>
                </span>
                <span className="text-xl font-extrabold">{requestingMicrophone ? "Waiting for microphone…" : "Record now"}</span>
                <span className="text-[15px] leading-snug opacity-95">Use your computer&apos;s microphone. Up to {MAX_MINUTES} minutes.</span>
              </button>
            )}
            <div className="relative flex">
              <input
                id="lecture-audio-upload"
                type="file"
                accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg,video/mp4,video/quicktime,.mp4,.m4v,.mov"
                onChange={onFile}
                disabled={controlsLocked}
                className="peer sr-only"
              />
              <label
                htmlFor="lecture-audio-upload"
                className={`${tileClass} w-full cursor-pointer border-2 border-dashed border-field bg-tint-soft text-ink hover:border-brand peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand ${controlsLocked ? "pointer-events-none opacity-40" : ""}`}
              >
                <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-soft text-brand">
                  <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg>
                </span>
                <span className="text-xl font-extrabold">Upload a recording</span>
                <span className="text-[15px] leading-snug text-muted">Audio or a class video (MP4, MOV) — only the sound is used.</span>
              </label>
            </div>
            <button onClick={loadSample} disabled={controlsLocked} className={`${tileClass} relative bg-sun-soft text-ink hover:ring-2 hover:ring-sun-line sm:col-span-2 lg:col-span-1`}>
              <span className="absolute right-3.5 top-3.5 rounded-full bg-surface px-2.5 py-1 text-[13px] font-extrabold text-sun-ink">No setup</span>
              <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-sun text-sun-ink">
                <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M10 8.5l5 3.5-5 3.5z" /></svg>
              </span>
              <span className="text-xl font-extrabold">{loadingSample ? "Opening the sample…" : "Try a sample lecture"}</span>
              <span className="text-[15px] leading-snug text-muted">See finished materials in one click — nothing to record.</span>
            </button>
          </div>

          {sampleStatus.kind === "error" && <p role="alert" className="text-[15px] font-semibold text-danger">{sampleStatus.message}</p>}
          {sample && (
            <div role="status" className="flex flex-wrap items-center gap-3 rounded-2xl border border-sun-line bg-sun-soft px-4 py-3 text-[15px] text-sun-ink">
              <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z" /></svg>
              <span><strong>Sample lecture: {sample.title}.</strong> Scroll down to see its transcript and materials. Nothing was sent anywhere to show this.</span>
            </div>
          )}

          <details className="group rounded-2xl bg-tint px-4 py-3.5 text-[15px] text-body">
            <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-x-6 gap-y-2 [&::-webkit-details-marker]:hidden">
              <span className="flex items-center gap-2.5">
                <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
                Record your own voice only — never students. Audio is sent to Meta to be transcribed.
              </span>
              <span className="font-bold text-brand underline group-open:no-underline">Where my data goes</span>
            </summary>
            <div className="mt-3 border-t border-line-strong pt-3 leading-relaxed">
              Audio chunks and key vocabulary go to Meta for transcription.
              An optional reference image plus subject, grade, objective, and vocabulary go to Meta for labeling.
              Materials use Meta by default; the open-weight option sends that generation step to Baseten instead.{" "}
              <Link href="/privacy" className="font-bold text-brand underline">Privacy and data flow</Link>
            </div>
          </details>

          {requestingMicrophone && <p role="status" className="text-[15px] text-muted">Waiting for microphone permission…</p>}
          {recordingNotice && <p role="status" className="text-[15px] font-semibold text-sun-ink">{recordingNotice}</p>}

          {audio && !recording && (
            <div className="flex flex-col gap-3 rounded-2xl border border-line p-4">
              <div className="flex flex-wrap items-center gap-4">
                <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ok-soft text-ok">
                  <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10" /></svg>
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-base font-extrabold">{audio.label}</div>
                  <div className="text-sm text-muted">
                    {turns.length > 0 ? `${formatTime(durationMs)} · Transcript ready` : "Ready to transcribe"}
                    {refImage ? " · 1 picture" : ""}
                  </div>
                </div>
              </div>
              <audio controls src={audio.url} className="w-full" />
            </div>
          )}
        </section>

        <section className={cardClass}>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-2xl font-extrabold">2. Tell us about the lesson</h2>
            <span className="text-[15px] text-subtle">Optional — helps spell names right and fit your class</span>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className={labelClass}>
              Subject
              <input value={lesson.subject} onChange={(e) => changeLectureInputs(() => setLesson((l) => ({ ...l, subject: e.target.value })))} disabled={controlsLocked} placeholder="U.S. History" className={inputClass} />
            </label>
            <label className={labelClass}>
              Grade
              <input value={lesson.grade} onChange={(e) => changeLectureInputs(() => setLesson((l) => ({ ...l, grade: e.target.value })))} disabled={controlsLocked} placeholder="10" className={inputClass} />
            </label>
            <label className={`${labelClass} sm:col-span-2`}>
              What should students learn?
              <input value={lesson.objective} onChange={(e) => changeLectureInputs(() => setLesson((l) => ({ ...l, objective: e.target.value })))} disabled={controlsLocked} placeholder="Students can explain why the Articles of Confederation were replaced" className={inputClass} />
            </label>
            <label className={`${labelClass} sm:col-span-2`}>
              Key words and names <span className="font-semibold text-subtle">(separated by commas, so the transcript spells them right)</span>
              <textarea
                value={keywords}
                onChange={(e) => changeLectureInputs(() => setKeywords(e.target.value))}
                disabled={controlsLocked}
                rows={2}
                placeholder="Articles of Confederation, Shays' Rebellion, ratification"
                className={inputClass}
              />
            </label>
            <label className={`${labelClass} sm:col-span-2`}>
              Standards <span className="font-semibold text-subtle">(optional)</span>
              <input value={lesson.standards} onChange={(e) => changeLectureInputs(() => setLesson((l) => ({ ...l, standards: e.target.value })))} disabled={controlsLocked} placeholder="e.g. C3 D2.His.14.9-12" className={inputClass} />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-4 rounded-2xl border-2 border-dashed border-field bg-tint-soft p-4">
            {refImage ? (
              // eslint-disable-next-line @next/next/no-img-element -- local data URL preview
              <img src={refImage.dataUrl} alt="" className="h-[72px] w-24 shrink-0 rounded-xl border border-line object-cover" />
            ) : (
              <span className="flex h-[72px] w-24 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
                <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-9 9" /></svg>
              </span>
            )}
            <div className="min-w-[200px] flex-1 text-[15px]">
              <div className="font-extrabold">
                {refImage ? refImage.name : <>Add a picture to label <span className="font-semibold text-subtle">(optional)</span></>}
              </div>
              {!refImage && (
                <p id="reference-image-help" className="text-sm text-muted">
                  A slide, worksheet, or photo — we&apos;ll number the things in it for a label-the-picture activity. The picture is sent to Meta.
                </p>
              )}
              {refImage && imageStatus.kind === "analyzing" && <p role="status" className="text-sm text-muted">Finding things to label…</p>}
              {refImage && imageStatus.kind === "error" && <p className="text-sm font-semibold text-danger">{imageStatus.message}</p>}
              {refImage && diagram && diagram.items.length > 0 && (
                <p className="text-sm text-muted">{diagram.items.length} things to label: {diagram.items.map((d) => d.label).join(", ")}</p>
              )}
              {refImage && diagram && diagram.items.length === 0 && (
                <p className="text-sm text-muted">{diagram.kind === "mostly_text" ? "This picture is mostly writing — nothing to label." : "Nothing to label was found."}</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id="reference-image-upload"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={onImage}
                disabled={controlsLocked}
                aria-describedby={refImage ? undefined : "reference-image-help"}
                className="peer sr-only"
              />
              <label
                htmlFor="reference-image-upload"
                className={`${secondaryButtonClass} cursor-pointer peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand ${controlsLocked ? "pointer-events-none opacity-40" : ""}`}
              >
                {refImage ? "Replace picture" : "Choose picture"}
              </label>
              {refImage && (
                <button onClick={removeImage} disabled={controlsLocked} className="min-h-11 px-2 text-[15px] font-bold text-muted underline hover:text-ink disabled:opacity-40">
                  Remove
                </button>
              )}
            </div>
          </div>

          <BoardMoments
            video={audio && isVideoFile({ type: audio.blob.type, name: audio.label }) ? audio.blob : null}
            moments={boardMoments}
            checks={momentChecks}
            disabled={controlsLocked}
            onKeep={keepMoment}
            onRemove={removeMoment}
            onRetry={retryMoment}
          />

          <div className="flex flex-col gap-3">
            <button onClick={transcribe} disabled={!audio || controlsLocked} className={`${primaryButtonClass} self-start`}>
              {busy ? "Transcribing…" : turns.length > 0 ? "Transcribe again" : "Transcribe lecture"}
            </button>
            {!audio && <p className="text-sm text-subtle">Add a recording in step 1 first.</p>}
            {status.kind === "decoding" && (
              <div role="status">
                {status.progress !== undefined && (
                  <div className="mb-2 h-3 w-full overflow-hidden rounded-full bg-tint">
                    <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${Math.round(status.progress * 100)}%` }} />
                  </div>
                )}
                <p className="text-[15px] text-muted">
                  {status.progress !== undefined ? `Reading the sound from your video… ${Math.round(status.progress * 100)}%` : "Getting your audio ready…"}
                </p>
              </div>
            )}
            {status.kind === "transcribing" && (
              <div role="status">
                <div className="h-3 w-full overflow-hidden rounded-full bg-tint">
                  <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${(status.done / Math.max(1, status.total)) * 100}%` }} />
                </div>
                <p className="mt-2 text-[15px] text-muted">
                  {status.waiting
                    ? `The service is busy — waiting for a free slot. ${status.done} of ${status.total} sections done; finished sections are kept.`
                    : `Listening to section ${Math.min(status.done + 1, status.total)} of ${status.total}…`}
                </p>
              </div>
            )}
            {status.kind === "error" && <p role="alert" className="text-[15px] font-semibold text-danger">{status.message}</p>}
          </div>
        </section>

        {turns.length > 0 && (
          <section className={cardClass}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-xl font-extrabold">Transcript</h2>
                <span className="text-sm text-subtle">
                  {formatTime(durationMs)} of audio · {words} words
                  {status.kind === "done" && ` · ready in ${status.seconds.toFixed(0)} s`}
                </span>
              </div>
              {transcriptDrafts ? (
                <div className="flex flex-wrap gap-2">
                  <button onClick={saveTranscriptEdits} className={primaryButtonClass}>Save changes</button>
                  <button onClick={() => setTranscriptDrafts(null)} className={secondaryButtonClass}>Cancel</button>
                </div>
              ) : (
                <button onClick={() => setTranscriptDrafts(turns.map((t) => t.text))} disabled={controlsLocked} className={`${secondaryButtonClass} disabled:opacity-40`}>
                  Edit transcript
                </button>
              )}
            </div>
            {transcriptDrafts && (
              <p className="-mt-2 text-sm text-muted">Fix names, numbers, or anything misheard. Clearing a segment removes it. Times stay the same.</p>
            )}
            <ol className="flex max-h-[32rem] flex-col gap-3 overflow-y-auto rounded-2xl bg-tint p-4" tabIndex={transcriptDrafts ? undefined : 0} aria-label="Transcript text">
              {turns.map((t, i) => (
                <li key={`${t.startMs}-${i}`} className="flex gap-3 text-[15px] leading-relaxed">
                  <span className="w-24 shrink-0 pt-0.5 font-mono text-xs leading-7 text-subtle">
                    {formatTime(t.startMs)}–{formatTime(t.endMs)}
                  </span>
                  {transcriptDrafts ? (
                    <textarea
                      value={transcriptDrafts[i] ?? ""}
                      onChange={(e) => setTranscriptDrafts((d) => d && d.map((v, j) => (j === i ? e.target.value : v)))}
                      aria-label={`Transcript from ${formatTime(t.startMs)} to ${formatTime(t.endMs)}`}
                      rows={Math.max(2, Math.ceil((transcriptDrafts[i]?.length ?? 0) / 90))}
                      maxLength={12_000}
                      className="w-full rounded-xl border border-field bg-surface px-3 py-2 text-[15px] text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
                    />
                  ) : (
                    <span>{t.text}</span>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}

        {turns.length > 0 && (
          <section className={cardClass}>
            <h2 className="text-2xl font-extrabold">3. Get your materials</h2>
            <p className="-mt-2 text-[15px] leading-relaxed text-muted">
              Guided notes, a 5-question check for understanding, an exit ticket, and tomorrow&apos;s bell ringer
              {refImage ? ", plus a label-the-picture activity from your image" : ""}.
            </p>
            <label className="flex items-start gap-3 rounded-2xl border border-line p-4 text-[15px]">
              <input
                type="checkbox"
                checked={privacy}
                onChange={(e) => changeLectureInputs(() => setPrivacy(e.target.checked))}
                disabled={controlsLocked}
                className="mt-1 h-5 w-5 shrink-0 accent-brand"
              />
              <span>
                <span className="font-bold">Use open-weight model for materials</span>{" "}
                <span className="text-muted">
                  — sends the transcript, lesson details, and any diagram-label terms to Muse Spark Open on Baseten instead of Meta
                  for materials generation only. Audio transcription and optional image labeling still use Meta&apos;s API.
                </span>
              </span>
            </label>
            <div className="flex flex-col gap-3">
              {result && materialsOutdated(turns, resultSource) && (
                <p role="status" className="rounded-2xl border border-sun-line bg-sun-soft px-4 py-3 text-[15px] font-semibold text-sun-ink">
                  You edited the transcript after these materials were made. Select Regenerate to include your changes.
                </p>
              )}
              <button onClick={generate} disabled={controlsLocked} className={`${primaryButtonClass} self-start`}>
                {gen.kind === "generating" ? `Writing your materials… ${formatTime(genElapsed)}` : result ? "Regenerate" : "Generate materials"}
              </button>
              {gen.kind === "generating" && <p role="status" className="text-[15px] text-muted">This can take a minute or two.</p>}
              {gen.kind === "error" && <p role="alert" className="text-[15px] font-semibold text-danger">{gen.message}</p>}
            </div>
          </section>
        )}

        {result && <MaterialsView
          result={result}
          diagram={resultDiagram}
          turns={resultSource?.turns ?? turns}
          durationMs={resultSource?.durationMs ?? durationMs}
          boardMoments={boardMoments}
          outdated={materialsOutdated(turns, resultSource)}
          onBoardItemsChange={(timeMs, items) => setBoardMoments((list) => list.map((b) => (b.timeMs === timeMs && b.diagram ? { ...b, diagram: { ...b.diagram, items } } : b)))}
          onDiagramItemsChange={(items) => setResultDiagram((d) => (d ? { ...d, result: { ...d.result, items } } : d))}
          onPrint={(copy) => setPrintRequest((r) => ({ copy, id: (r?.id ?? 0) + 1 }))}
        />}
      </main>

      {result && printRequest && (
        <PrintableMaterials
          copy={printRequest.copy}
          result={result}
          lessonLine={[resultSource?.context.subject ?? lesson.subject, (resultSource?.context.grade ?? lesson.grade) && `Grade ${resultSource?.context.grade ?? lesson.grade}`].filter(Boolean).join(" · ")}
          diagram={resultDiagram}
          boardMoments={boardMoments}
          turns={resultSource?.turns ?? turns}
          durationMs={resultSource?.durationMs ?? durationMs}
        />
      )}
    </>
  );
}
