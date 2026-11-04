"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { decodeToMono, formatTime, readAudioDurationMs, SAMPLE_RATE, transcribeLecture, TranscriptionError, type ChunkResults, type Turn } from "@/lib/audio-client";
import type { DiagramResult } from "@/lib/diagram";
import { prepareImage, type PreparedImage } from "@/lib/image-client";
import type { GenerateResult } from "@/lib/materials";
import { createOperationRevision } from "@/lib/operation-revision";
import { loadProfile, type TeacherProfile } from "@/lib/profile-store";
import { canPauseRecorder, createCompatibleMediaRecorder, isSiteRecording, pauseRecordingClock, RECORDING_LIMITS, recordedMs, recordingFileName, recordingLabel, recordingLimitMessage, recordingLimitReason, resumeRecordingClock, startRecordingClock, stopMediaRecorder, stopMediaStream, type RecordingClock, type RecordingLimitReason } from "@/lib/recording-lifecycle";
import { parseSampleLecture, SAMPLE_URL } from "@/lib/sample-lecture";
import { extractVideoAudio, isVideoFile, MAX_VIDEO_BYTES } from "@/lib/video-audio";
import type { ResultSource } from "@/lib/session-store";
import { clearSession, loadSession, MAX_BOARD_MOMENTS, MAX_SAVED_AUDIO_BYTES, saveAudio, saveSession, type BoardMoment } from "@/lib/session-store";
import { applyTranscriptEdits, buildLessonContext, countWords, materialsOutdated, diagramContextFor, generateRequestBody, keywordKey, lastOpenStep, lectureTooLongMessage, parseVocabulary, restoredResultSource, resumableChunks, saveStatus, snapshotResultSource, stepState, transcriptionErrorMessage, visibleStep, type SaveState, type StepNumber } from "@/lib/lecture-workflow";
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
  | { kind: "recording"; startedAt: number; paused: boolean; canPause: boolean }
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
const inputClass = "mt-1.5 w-full rounded-xl border border-field bg-surface px-3.5 py-2.5 text-base font-semibold text-ink placeholder:font-normal placeholder:text-subtle/70 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25 disabled:bg-tint disabled:opacity-60";
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
  /** Recorded time for the current recording, excluding pauses. */
  const recordingClockRef = useRef<RecordingClock | null>(null);
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
  /** The step the teacher chose to look at; null = follow the lecture (see visibleStep). */
  const [chosenStep, setChosenStep] = useState<StepNumber | null>(null);
  const stepHeadings = useRef(new Map<StepNumber, HTMLHeadingElement>());
  const focusStepAfterRender = useRef<StepNumber | null>(null);
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
    setChosenStep(null);
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
  const recordingPaused = status.kind === "recording" && status.paused;
  const recordingCanPause = status.kind === "recording" && status.canPause;
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
    setChosenStep(2);
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

  function keepMoment(timeMs: number, image: BoardMoment["image"], original?: BoardMoment["image"]) {
    if (boardMoments.length >= MAX_BOARD_MOMENTS || boardMoments.some((m) => m.timeMs === timeMs)) return;
    setBoardMoments((list) => [...list, { timeMs, image, original, diagram: null }].sort((a, b) => a.timeMs - b.timeMs));
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
      setChosenStep(3);
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
    const clock = startRecordingClock(startedAt);
    recordingClockRef.current = clock;
    const recordedSoFar = () => recordedMs(recordingClockRef.current ?? clock, Date.now());
    recorder.ondataavailable = (e) => {
      if (!e.data.size) return;
      parts.push(e.data);
      recordedBytes += e.data.size;
      limitReason ??= recordingLimitReason(recordedSoFar(), recordedBytes);
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
      selectAudio(blob, recordingLabel(new Date(startedAt)));
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
        const nextElapsed = recordedSoFar();
        setElapsed(nextElapsed);
        limitReason ??= recordingLimitReason(nextElapsed, recordedBytes);
        if (limitReason) stopMediaRecorder(recorder);
      }, 500);
      setStatus({ kind: "recording", startedAt, paused: false, canPause: canPauseRecorder(recorder) });
    } catch {
      stopMediaStream(stream);
      streamRef.current = null;
      setStatus({ kind: "error", message: "This browser could not start an audio recording." });
    }
  }

  function stopRecording() {
    stopMediaRecorder(recorderRef.current);
  }

  /** Show a step and move keyboard focus to its heading (which also scrolls it into view). */
  function goToStep(n: StepNumber) {
    setChosenStep(n);
    focusStepAfterRender.current = n;
  }

  useEffect(() => {
    const n = focusStepAfterRender.current;
    if (n === null) return;
    focusStepAfterRender.current = null;
    stepHeadings.current.get(n)?.focus();
  });

  /** Pause keeps the microphone open (the browser still shows it in use) but adds nothing to the recording. */
  function pauseRecording() {
    const recorder = recorderRef.current;
    const clock = recordingClockRef.current;
    if (!recorder || !clock || recorder.state !== "recording") return;
    try { recorder.pause(); } catch { return; }
    recordingClockRef.current = pauseRecordingClock(clock, Date.now());
    setElapsed(recordedMs(recordingClockRef.current, Date.now()));
    setStatus((current) => current.kind === "recording" ? { ...current, paused: true } : current);
  }

  function resumeRecording() {
    const recorder = recorderRef.current;
    const clock = recordingClockRef.current;
    if (!recorder || !clock || recorder.state !== "paused") return;
    try { recorder.resume(); } catch { return; }
    recordingClockRef.current = resumeRecordingClock(clock, Date.now());
    setStatus((current) => current.kind === "recording" ? { ...current, paused: false } : current);
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
  // 1 add a lecture → 2 lesson details, transcript, whiteboard → 3 materials. Only the shown step is visible;
  // the others stay mounted (hidden) so nothing in progress is lost when the teacher switches steps.
  const progress = { hasLecture: Boolean(audio), hasTranscript: turns.length > 0, hasMaterials: Boolean(result) };
  const shownStep = visibleStep(chosenStep, progress);
  const lastOpen = lastOpenStep(progress);
  const STEPS = ["Add your lecture", "Tell us about the lesson", "Get your materials"] as const;
  const isVideo = Boolean(audio && isVideoFile({ type: audio.blob.type, name: audio.label }));
  const outdated = Boolean(result) && materialsOutdated(turns, resultSource);
  const lessonFilled = Boolean(lesson.subject || lesson.grade || lesson.objective || lesson.standards || keywords.trim());
  const transcriptProgress = status.kind === "transcribing" ? status.done / Math.max(1, status.total)
    : status.kind === "decoding" && status.progress !== undefined ? status.progress : null;
  const transcriptLine = status.kind === "decoding"
    ? (status.progress !== undefined ? `Reading the sound from your video… ${Math.round(status.progress * 100)}%` : "Getting your audio ready…")
    : status.kind === "transcribing"
      ? (status.waiting ? `Waiting for a free slot · ${status.done} of ${status.total} done` : `Transcribing · ${status.done} of ${status.total} parts`)
      : turns.length > 0 ? `Ready · ${words} words`
      : status.kind === "error" ? "Stopped — see the message in step 2"
      : "Not started yet";
  const stepWorking: Record<StepNumber, boolean> = {
    1: recording || requestingMicrophone || loadingSample,
    2: busy || imageStatus.kind === "analyzing",
    3: generating,
  };
  const stepDetail: Record<StepNumber, string> = {
    1: recording ? `${recordingPaused ? "Paused" : "Recording"} · ${formatTime(elapsed)}`
      : requestingMicrophone ? "Waiting for the microphone…"
      : loadingSample ? "Opening the sample…"
      : sample ? `Sample: ${sample.title}`
      : audio ? audio.label
      : turns.length > 0 ? "Lecture added"
      : "Record, upload, or try the sample",
    2: transcriptLine,
    3: generating ? `Writing your materials… ${formatTime(genElapsed)}`
      : gen.kind === "error" ? "Didn't finish — try again"
      : result ? (outdated ? "Made before your transcript edits" : "Ready to print")
      : lastOpen >= 3 ? "Ready to make" : "Opens when the transcript is ready",
  };
  const stateLabel = { current: "You are here", done: "Done", open: "Ready", locked: "Up next" } as const;

  return (
    <>
      <header className="border-b border-line bg-surface print:hidden">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5 text-ink">
            <svg aria-hidden="true" width="40" height="40" viewBox="0 0 64 64" className="shrink-0"><rect width="64" height="64" rx="14" fill="#2457d0" /><rect x="21" y="6" width="31" height="44" rx="3.5" fill="#9db5ee" /><rect x="12" y="13" width="33" height="45" rx="3.5" fill="#fff" /><rect x="17" y="21" width="20" height="3.5" rx="1.75" fill="#8a93aa" /><rect x="17" y="28" width="23" height="3.5" rx="1.75" fill="#8a93aa" /><rect x="17" y="36" width="23" height="9" rx="2" fill="#ffe08a" /><rect x="17" y="43" width="23" height="3" rx="1.5" fill="#1e2433" /></svg>
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

      <main className="mx-auto flex w-full max-w-[1240px] flex-col gap-7 px-4 pb-16 pt-10 sm:px-6 print:hidden">
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
            <span className="whitespace-nowrap text-muted">
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="mr-1.5 inline-block h-[0.85em] w-[0.85em] align-[-0.08em]"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></svg>
              Lecture In,
            </span>{" "}
            <span className="whitespace-nowrap text-brand">
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="mr-1.5 inline-block h-[0.85em] w-[0.85em] align-[-0.08em]"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6" /><path d="M9 17h6" /></svg>
              Handouts Out
            </span>
          </h1>
          <p className="max-w-[640px] text-lg leading-relaxed text-muted sm:text-[19px]">
            Record or upload your lesson. Lecture Studio turns what you actually said into guided notes, a quick quiz, an exit ticket, and a bell ringer for you to review — ready for absent students, accommodations, and review days.
          </p>
        </section>

          {sample && (
            <div role="status" className="flex flex-wrap items-center gap-3 rounded-2xl border border-sun-line bg-sun-soft px-4 py-3 text-[15px] text-sun-ink">
              <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z" /></svg>
              <span><strong>Sample lecture: {sample.title}.</strong> Its transcript is in step 2 and its materials in step 3. Nothing was sent anywhere to show this.</span>
            </div>
          )}
        <div className="grid items-start gap-7 lg:grid-cols-[290px_minmax(0,1fr)]">
          <nav aria-label="Your progress" className="rounded-3xl border border-line bg-surface p-3 sm:p-4 lg:sticky lg:top-6">
            <h2 className="px-2 pb-2 text-[13px] font-extrabold uppercase tracking-wider text-muted">Your progress</h2>
            <ol className="grid grid-cols-3 gap-2 lg:grid-cols-1 lg:gap-1.5">
              {STEPS.map((title, i) => {
                const n = (i + 1) as StepNumber;
                const state = stepState(n, shownStep, progress);
                const working = stepWorking[n];
                const tone = state === "current" ? "bg-brand-soft ring-2 ring-brand"
                  : state === "locked" ? "border border-dashed border-line-strong text-subtle"
                  : "hover:bg-tint";
                const body = (
                  <>
                    <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[15px] font-extrabold ${state === "current" ? "bg-brand text-on-brand" : state === "done" ? "bg-ok-soft text-ok" : "border border-line-strong bg-tint text-muted"}`}>
                      {state === "done" ? <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10" /></svg> : n}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                      <span className={`text-[12px] font-extrabold uppercase tracking-wide ${state === "current" ? "text-brand" : state === "done" ? "text-ok" : "text-muted"}`}>
                        <span className="lg:hidden">Step {n}</span>
                        <span className="hidden lg:inline">Step {n} · {stateLabel[state]}</span>
                      </span>
                      <span className="text-[13px] font-extrabold leading-tight sm:text-[15px] lg:text-base">{title}</span>
                      <span className="hidden items-center gap-1.5 text-sm text-muted lg:flex">
                        {working && <span aria-hidden="true" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-brand" />}
                        <span className="min-w-0 break-words">{stepDetail[n]}</span>
                      </span>
                      {n === 2 && (state === "current" || working) && progress.hasLecture && (
                        <span className="mt-1.5 hidden flex-col gap-1.5 text-sm lg:flex">
                          {transcriptProgress !== null && (
                            <span className="block h-2 overflow-hidden rounded-full bg-surface"><span className="block h-full rounded-full bg-brand transition-all" style={{ width: `${Math.round(transcriptProgress * 100)}%` }} /></span>
                          )}
                          <span className={lessonFilled ? "text-ok" : "text-muted"}>{lessonFilled ? "✓ Lesson details" : "Lesson details · optional"}</span>
                          {refImage && <span className="text-muted">{imageStatus.kind === "analyzing" ? "Picture · finding things to label…" : "✓ Picture to label"}</span>}
                          {isVideo && <span className="text-muted">Whiteboard moments · {boardMoments.length > 0 ? `${boardMoments.length} kept` : "optional"}</span>}
                        </span>
                      )}
                    </span>
                  </>
                );
                return (
                  <li key={title} aria-current={state === "current" ? "step" : undefined}>
                    {state === "locked" ? (
                      <div className={`flex h-full flex-col items-start gap-2 rounded-2xl p-2.5 lg:flex-row lg:gap-3 lg:p-3 ${tone}`}>{body}</div>
                    ) : (
                      <button type="button" onClick={() => goToStep(n)} className={`flex h-full w-full flex-col items-start gap-2 rounded-2xl p-2.5 lg:flex-row lg:gap-3 lg:p-3 ${tone}`}>{body}</button>
                    )}
                  </li>
                );
              })}
            </ol>
            <p className="mt-2 flex items-center gap-2 px-2 text-sm text-muted lg:hidden">
              {stepWorking[shownStep] && <span aria-hidden="true" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-brand" />}
              <span><span className="font-bold text-ink">Step {shownStep}:</span> {stepDetail[shownStep]}</span>
            </p>
            {hasWork && (
              <div className="mt-2 border-t border-line px-1 pt-2">
                <button onClick={startOver} disabled={controlsLocked} className="min-h-11 px-1 text-[15px] font-bold text-muted underline hover:text-ink disabled:opacity-40">
                  Start over
                </button>
              </div>
            )}
          </nav>

          <div className="flex min-w-0 flex-col gap-7">
          <div hidden={shownStep !== 1} className="flex flex-col gap-7">

        <section className={cardClass}>
          <h2 ref={(el) => { if (el) stepHeadings.current.set(1, el); }} tabIndex={-1} className="text-2xl font-extrabold focus:outline-none">1. Add your lecture</h2>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {recording ? (
              <div className={`${tileClass} ${recordingPaused ? "border-2 border-sun-line bg-sun-soft text-ink" : "bg-apple text-white"}`}>
                <span className="sr-only" role="status">{recordingPaused ? "Recording paused" : "Recording"}</span>
                <span className="flex items-center gap-2.5 text-xl font-extrabold">
                  <span aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 rounded-full ${recordingPaused ? "bg-sun-ink" : "animate-pulse bg-white"}`} />
                  {recordingPaused ? "Paused" : "Recording"} · {formatTime(elapsed)}
                </span>
                <span className="text-[15px] leading-snug opacity-95">
                  {recordingPaused
                    ? "The microphone is still on, but nothing is being recorded."
                    : `Stops by itself after ${MAX_MINUTES} minutes of recording.`}
                </span>
                <div className="mt-1 flex flex-wrap gap-2">
                  {recordingCanPause && (
                    <button
                      onClick={recordingPaused ? resumeRecording : pauseRecording}
                      className={`inline-flex min-h-11 items-center gap-2 rounded-xl px-4 text-[15px] font-extrabold ${recordingPaused ? "bg-brand text-on-brand hover:bg-brand-dark" : "bg-white text-apple hover:bg-white/90"}`}
                    >
                      {recordingPaused ? (
                        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5v14l12-7z" /></svg>
                      ) : (
                        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
                      )}
                      {recordingPaused ? "Continue" : "Pause"}
                    </button>
                  )}
                  <button
                    onClick={stopRecording}
                    className={`inline-flex min-h-11 items-center gap-2 rounded-xl px-4 text-[15px] font-extrabold ${recordingPaused ? "border border-line-strong bg-surface text-ink hover:border-brand hover:text-brand" : "border border-white/70 text-white hover:bg-white/15"}`}
                  >
                    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
                    Stop
                  </button>
                </div>
              </div>
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
              {isSiteRecording(audio.label) && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <a href={audio.url} download={recordingFileName(audio.label, audio.blob.type)} className={`${secondaryButtonClass} gap-2 self-start`}>
                    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" /></svg>
                    Save recording
                  </a>
                  <span className="text-sm text-muted">Keep a copy on this device. Start over deletes the copy in this browser.</span>
                </div>
              )}
            </div>
          )}
        </section>

        {(audio || turns.length > 0) && !recording && (
          <button onClick={() => goToStep(2)} className={`${primaryButtonClass} self-end`}>Continue to step 2 →</button>
        )}
          </div>

          <div hidden={shownStep !== 2} className="flex flex-col gap-7">
        <section className={cardClass}>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 ref={(el) => { if (el) stepHeadings.current.set(2, el); }} tabIndex={-1} className="text-2xl font-extrabold focus:outline-none">2. Tell us about the lesson</h2>
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
            video={isVideo && audio ? audio.blob : null}
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
          <button onClick={() => goToStep(3)} className={`${primaryButtonClass} self-end`}>Continue to step 3 →</button>
        )}
          </div>

          <div hidden={shownStep !== 3} className="flex flex-col gap-7">
        {turns.length > 0 && (
          <section className={cardClass}>
            <h2 ref={(el) => { if (el) stepHeadings.current.set(3, el); }} tabIndex={-1} className="text-2xl font-extrabold focus:outline-none">3. Get your materials</h2>
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
          onBoardSkipCleanupChange={(timeMs, value) => setBoardMoments((list) => list.map((b) => (b.timeMs === timeMs ? { ...b, skipCleanup: value } : b)))}
          onDiagramItemsChange={(items) => setResultDiagram((d) => (d ? { ...d, result: { ...d.result, items } } : d))}
          onPrint={(copy) => setPrintRequest((r) => ({ copy, id: (r?.id ?? 0) + 1 }))}
        />}
          </div>
          </div>
        </div>
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
