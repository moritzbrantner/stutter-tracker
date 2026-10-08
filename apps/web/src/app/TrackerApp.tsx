import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type AnalyzedSpeech,
  createComputeClient,
  ON_DEVICE_ANALYZER,
  processingPolicyForServerUrl,
} from "@stutter-tracker/compute-client";
import {
  type AnalysisRunIdentity,
  type AnalyzerIdentity,
  canonicalSpokenLanguage,
  createSessionRecord,
  isAnalysisVerified,
  isReplayable,
  reanalyzeSession,
  fallbackAnalyze as sharedFallbackAnalyze,
  observationFingerprint,
  UNKNOWN_INPUT_ID,
  audioFingerprint,
  resampleSamples as sharedResampleSamples,
} from "@stutter-tracker/shared";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { DashboardHeader } from "../components/DashboardHeader";
import { InsightsSidebar } from "../components/InsightsSidebar";
import { LowerDashboard } from "../components/LowerDashboard";
import { RecordingWorkspace } from "../components/RecordingWorkspace";
import { StatusMetrics } from "../components/StatusMetrics";
import {
  BrowserRecorderError,
  createBrowserRecorder,
  type BrowserRecorder,
} from "../audio/browserRecorder";
import { planAvailableChunks } from "../recording/chunks";
import type {
  AnalysisReport,
  BlockerStats,
  PauseSpan,
  SavedSession,
  SpeakerIdentification,
  SpeakerIntentPrediction,
  SpeakerMatch,
  SpeakerProfile,
  StutterEvent,
  SpeechCorpusAnalysis,
  SpeechStats,
  TranscriptSegment,
  TranscriptionChunkRecord,
  TranscriptionChunkStats,
  TranscriptionChunkSummary,
  TranscriptionEngine,
  TranscriptionEngineId,
  TranscriptionModelStatus,
  TranscriptionProgressEvent,
  TranscriptionSettings,
  Voiceprint,
} from "../types";
import {
  loadRemoteConsent,
  loadSessionsFromStorage,
  saveRemoteConsent,
} from "../storage/localStorage";
export { formatTime } from "../utils/formatting";

const STORE_KEY = "stutter-tracker:sessions";
const VOICE_KEY = "stutter-tracker:voiceprint";
const SPEAKERS_KEY = "stutter-tracker:speakers";
/** How long speaker removal waits for the startup load before it is enabled anyway. */
const SPEAKER_LOAD_GRACE_MS = 5_000;
const TRANSCRIPTION_KEY = "stutter-tracker:transcription";
const LANGUAGES = ["en-US", "de-DE", "en-GB"];
const COMPUTE_SERVER_URL = import.meta.env.VITE_STUTTER_SERVER_URL ?? "http://127.0.0.1:8787";
const TRANSCRIPTION_CHUNK_SECONDS = 8;
/** Upper bound for browser recognition to deliver its final results after Stop. */
const RECOGNITION_END_TIMEOUT_MS = 3_000;
const TRANSCRIPTION_TARGET_SAMPLE_RATE = 16_000;
const TRANSCRIPTION_ENGINES: TranscriptionEngine[] = [
  {
    id: "browser",
    label: "Browser Speech",
    mode: "Live",
    nativeOnly: false,
    models: ["default"],
  },
  {
    id: "whisperCpp",
    label: "whisper.cpp",
    mode: "Chunked",
    nativeOnly: true,
    models: [
      "tiny.en",
      "tiny",
      "base.en",
      "base",
      "small.en",
      "small",
      "medium.en",
      "medium",
      "large-v3",
      "large-v3-turbo",
    ],
  },
  {
    id: "whisperCli",
    label: "Whisper CLI",
    mode: "Chunked",
    nativeOnly: true,
    models: ["tiny", "base", "small", "medium", "large", "turbo"],
  },
  {
    id: "fasterWhisper",
    label: "Faster-Whisper",
    mode: "Chunked",
    nativeOnly: true,
    models: ["tiny", "base", "small", "medium", "large-v3", "distil-large-v3"],
  },
];
const COMPUTE_API_TOKEN = import.meta.env.VITE_STUTTER_API_TOKEN ?? "";
const CONSENT_SERVER_URL = COMPUTE_SERVER_URL.trim().replace(/\/+$/, "");
// The destination is fixed for the page lifetime; consent changes reload the page so an
// in-flight run can never switch destinations.
const computeClient = createComputeClient({
  processingPolicy: processingPolicyForServerUrl(
    COMPUTE_SERVER_URL,
    loadRemoteConsent(CONSENT_SERVER_URL),
  ),
  apiToken: COMPUTE_API_TOKEN,
});

export function App() {
  const queryClient = useQueryClient();
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [pauses, setPauses] = useState<PauseSpan[]>([]);
  const [report, setReport] = useState<AnalysisReport>(() => emptyReport());
  // Identity of the analysis run that produced `report`; null when nothing has analyzed it.
  const [reportRun, setReportRun] = useState<AnalysisRunIdentity | null>(null);
  const [sessions, setSessions] = useState<SavedSession[]>(() => loadSessions());
  const [speakers, setSpeakers] = useState<SpeakerProfile[]>(() => loadSpeakerProfiles());
  // Removal waits for the startup load, which could otherwise restore or re-upload a removed
  // voiceprint from its earlier snapshot.
  const [speakersReady, setSpeakersReady] = useState(false);
  // Counts removals, so a slow startup load can tell its snapshot is stale.
  const speakerRemovalsRef = useRef(0);
  const speakerMutationTailRef = useRef<Promise<unknown>>(Promise.resolve());
  const [corpusAnalysis, setCorpusAnalysis] = useState<SpeechCorpusAnalysis>(() =>
    emptyCorpusAnalysis(),
  );
  const [transcription, setTranscription] = useState<TranscriptionSettings>(() =>
    loadTranscriptionSettings(),
  );
  const [downloadProgress, setDownloadProgress] = useState<TranscriptionProgressEvent | null>(null);
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [chunkStats, setChunkStats] = useState<TranscriptionChunkStats>(() => emptyChunkStats());
  const [transcriptionChunks, setTranscriptionChunks] = useState<TranscriptionChunkRecord[]>([]);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isFinishingCapture, setIsFinishingCapture] = useState(false);
  // Bumped when a capture finishes, so the final audio (which can grow after the last transcript
  // update) gets its own analysis before the session can be saved.
  const [captureRevision, setCaptureRevision] = useState(0);
  const [isNative, setIsNative] = useState(() => isDesktopApp());
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isEnrolling, setIsEnrolling] = useState(false);
  const [isMatchingVoice, setIsMatchingVoice] = useState(false);
  const [language, setLanguage] = useState(LANGUAGES[0]);
  const [speakerLabel, setSpeakerLabel] = useState("");
  const [interimText, setInterimText] = useState("");
  const [level, setLevel] = useState(0);
  const [speakerMatch, setSpeakerMatch] = useState<SpeakerMatch | null>(null);
  const [message, setMessage] = useState("Idle");

  const sessionsRef = useRef(sessions);
  const activeSessionIdRef = useRef<string | null>(null);
  const sessionMutationTailRef = useRef<Promise<void>>(Promise.resolve());
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const browserRecorderRef = useRef<BrowserRecorder | null>(null);
  const startedAtRef = useRef<Date | null>(null);
  const lastFinalEndRef = useRef(0);
  const lastVoiceAtRef = useRef(0);
  const lastSpeakerMatchAtRef = useRef(0);
  const sampleRateRef = useRef(48_000);
  const samplesRef = useRef<number[]>([]);
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const pausesRef = useRef<PauseSpan[]>([]);
  const speakersRef = useRef<SpeakerProfile[]>(speakers);
  const speakerMatchRef = useRef<SpeakerMatch | null>(speakerMatch);
  const speakerMatchInFlightRef = useRef(false);
  const transcriptionRef = useRef(transcription);
  const recordingTranscriptionRef = useRef<TranscriptionSettings | null>(null);
  const recordingLanguageRef = useRef(language);
  // Language of the session in the workspace, fixed when recording starts or a session loads; the
  // selector can change before Save without relabelling the finished recording.
  const sessionLanguageRef = useRef<string | null>(null);
  // The saved record shown in the workspace, so saving it again keeps its analysis history.
  const loadedSessionRef = useRef<SavedSession | null>(null);
  // The saved session shown in the workspace. While one is shown, the view keeps its stored
  // analysis: live analysis does not run, and a late result never replaces it. The ref is set
  // synchronously so a result that lands before React applies the load is still ignored.
  const [viewedSession, setViewedSessionState] = useState<SavedSession | null>(null);
  const reanalyzingRef = useRef(new Set<string>());
  const [reanalyzingSessionIds, setReanalyzingSessionIds] = useState<string[]>([]);
  const viewedSessionRef = useRef<SavedSession | null>(null);
  const setViewedSession = (session: SavedSession | null) => {
    viewedSessionRef.current = session;
    setViewedSessionState(session);
  };
  const nextChunkStartSampleRef = useRef(0);
  const chunkIndexRef = useRef(0);
  const chunkTranscriptionTailRef = useRef<Promise<void>>(Promise.resolve());
  const queuedTranscriptionTasksRef = useRef(0);
  const transcriptionRunIdRef = useRef(0);
  const chunkResultsRef = useRef({ completed: 0, failed: 0 });
  const modelDownloadKeyRef = useRef<string | null>(null);
  const modelDownloadPromiseRef = useRef<Promise<boolean> | null>(null);

  const analysisRequest = useMemo(() => {
    const audio = analysisAudioPayload(samplesRef.current, sampleRateRef.current);
    return {
      segments,
      pauses,
      sessionStartedAt: startedAtRef.current?.toISOString(),
      ...audio,
    };
    // captureRevision is a deliberate trigger: samplesRef is a ref and not a dependency itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, pauses, captureRevision]);

  const analysisQuery = useQuery({
    queryKey: ["analysis", analysisRequest],
    queryFn: () => analyzeWithFallback(analysisRequest),
    enabled: viewedSession === null,
  });

  const modelStatusesQuery = useQuery({
    queryKey: ["transcription-models", transcription.engine, isNative],
    queryFn: async () => {
      try {
        return await loadTranscriptionModels(transcription.engine);
      } catch {
        return staticModelStatuses(transcription.engine);
      }
    },
    staleTime: 10_000,
  });

  const modelStatuses = modelStatusesQuery.data ?? staticModelStatuses(transcription.engine);
  const isAnalyzing = analysisQuery.isFetching;
  const selectedEngine = getTranscriptionEngine(transcription.engine);
  const selectedModels = modelStatuses.length
    ? modelStatuses.map((model) => model.id)
    : selectedEngine.models;
  const selectedModelStatus = modelStatuses.find((model) => model.id === transcription.model);
  const chunkProgress = useMemo(
    () => summarizeTranscriptionChunks(transcriptionChunks),
    [transcriptionChunks],
  );
  const captureInProgress =
    isRecording ||
    isFinishingCapture ||
    isTranscribing ||
    chunkProgress.queued + chunkProgress.processing > 0;
  const transcript = useMemo(() => segments.map((segment) => segment.text).join(" "), [segments]);
  const speechStats = normalizedSpeechStats(report);
  const blockerStats = normalizedBlockerStats(report);
  const analyzedChunks = report.chunks ?? [];
  const intentPredictionRequest = useMemo(
    () => ({
      segments,
      sessions,
      events: report.events ?? [],
      partialText: [transcript, interimText].filter(Boolean).join(" ").trim(),
      maxContexts: 6,
      maxPredictions: 4,
      phraseTokens: 4,
    }),
    [segments, sessions, report.events, transcript, interimText],
  );
  const intentPredictionsQuery = useQuery({
    queryKey: ["intent-predictions", intentPredictionRequest],
    queryFn: () => predictSpeakerIntentWithFallback(intentPredictionRequest),
    staleTime: 1_000,
  });
  const intentPredictions =
    intentPredictionsQuery.data ?? fallbackPredictSpeakerIntent(intentPredictionRequest);

  const downloadModelMutation = useMutation({
    mutationFn: ({ engine, model }: { engine: TranscriptionEngineId; model: string }) =>
      downloadTranscriptionModel(engine, model),
    onSuccess: async (_result, { engine, model }) => {
      await queryClient.invalidateQueries({ queryKey: ["transcription-models", engine] });
      setTranscription((current) => {
        if (current.engine !== engine) {
          return current;
        }
        const next = { ...current, model };
        localStorage.setItem(TRANSCRIPTION_KEY, JSON.stringify(next));
        return next;
      });
      setMessage(`${model} ready`);
    },
    onError: (error) => {
      setMessage(`Download failed: ${errorMessage(error)}`);
    },
    onSettled: () => {
      setDownloadingModel(null);
    },
  });

  useEffect(() => {
    startedAtAccessor = () => startedAtRef.current;
    return () => {
      startedAtAccessor = null;
    };
  }, []);

  useEffect(() => {
    setIsNative(isDesktopApp());
  }, []);

  useEffect(() => {
    if (!isNative) {
      return;
    }
    let cancelled = false;
    loadSpeechCorpus()
      .then((analysis) => {
        if (!cancelled) {
          setCorpusAnalysis(analysis);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCorpusAnalysis(analyzeLocalCorpus(sessions));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isNative]);

  useEffect(() => {
    if (!isNative) {
      setCorpusAnalysis(analyzeLocalCorpus(sessions));
    }
  }, [isNative, sessions]);

  useEffect(() => {
    let cancelled = false;
    const removalsAtStart = speakerRemovalsRef.current;
    const isStale = () => cancelled || speakerRemovalsRef.current !== removalsAtStart;
    // A stalled server must not block local removal forever; the load then cannot apply or
    // re-upload its snapshot once a removal has happened.
    const readyTimer = setTimeout(() => setSpeakersReady(true), SPEAKER_LOAD_GRACE_MS);
    loadPersistedSpeakerProfiles(isStale, (profiles) =>
      queueSpeakerMutation(async () => {
        if (isStale()) return [];
        return savePersistedSpeakerProfiles(profiles);
      }),
    )
      .then((persistedSpeakers) => {
        if (!isStale()) {
          setSpeakers(persistedSpeakers);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(readyTimer);
        if (!cancelled) {
          setSpeakersReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    segmentsRef.current = segments;
    pausesRef.current = pauses;
  }, [segments, pauses]);

  useEffect(() => {
    speakersRef.current = speakers;
  }, [speakers]);

  useEffect(() => {
    speakerMatchRef.current = speakerMatch;
  }, [speakerMatch]);

  useEffect(() => {
    transcriptionRef.current = transcription;
  }, [transcription]);

  useEffect(() => {
    recordingLanguageRef.current = language;
  }, [language]);

  useEffect(() => {
    // A late result must not replace a saved session's stored analysis.
    if (analysisQuery.data && viewedSessionRef.current === null) {
      setReport(analysisQuery.data.report);
      setReportRun({
        id: analysisQuery.data.runId,
        createdAt: analysisQuery.data.createdAt,
        analyzer: analysisQuery.data.analyzer,
        usedAudio: analysisQuery.data.usedAudio,
        audioId: analysisQuery.data.audioId,
        inputId: analysisQuery.data.inputId,
      });
    }
  }, [analysisQuery.data]);

  useEffect(() => {
    if (
      modelStatusesQuery.data?.length &&
      !modelStatusesQuery.data.some((model) => model.id === transcription.model)
    ) {
      updateTranscriptionModel(modelStatusesQuery.data[0]?.id ?? "default");
    }
  }, [modelStatusesQuery.data, transcription.model]);

  useEffect(() => {
    if (
      isRecording ||
      selectedEngine.id !== "whisperCpp" ||
      !selectedModelStatus?.downloadable ||
      selectedModelStatus.cached
    ) {
      return;
    }
    void downloadModel(selectedModelStatus.id, transcription.engine);
  }, [
    isRecording,
    selectedEngine.id,
    selectedModelStatus?.id,
    selectedModelStatus?.cached,
    selectedModelStatus?.downloadable,
    transcription.engine,
  ]);

  useEffect(() => {
    if (!isNative) {
      return;
    }
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<TranscriptionProgressEvent>("transcription-progress", (event) => {
          if (cancelled) {
            return;
          }
          setDownloadProgress(event.payload);
          if (event.payload.phase === "downloading") {
            setDownloadingModel(event.payload.model ?? null);
          } else {
            setDownloadingModel(null);
          }
        }),
      )
      .then((cleanup) => {
        if (cancelled) {
          cleanup();
        } else {
          unlisten = cleanup;
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isNative]);

  // Sessions whose saved analysis is not verified for their transcript, flagged next to the corpus
  // (local or desktop) instead of being counted silently.
  const localUnverifiedCount = useMemo(
    () => sessions.filter((session) => !isAnalysisVerified(session)).length,
    [sessions],
  );
  // The desktop corpus keeps sessions the browser history has pruned, so in the desktop app the
  // warning is counted over the corpus actually shown.
  const [desktopUnverifiedCount, setDesktopUnverifiedCount] = useState<number | null>(null);
  useEffect(() => {
    if (!isNative) {
      setDesktopUnverifiedCount(null);
      return;
    }
    let cancelled = false;
    // A small payload (inputId and observation per session), not the full store.
    void invoke<unknown>("speech_corpus_observations")
      .then((exported) => {
        if (!cancelled) {
          setDesktopUnverifiedCount(countUnverifiedCorpusSessions(exported));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDesktopUnverifiedCount(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isNative, corpusAnalysis]);
  const unverifiedSessionCount = desktopUnverifiedCount ?? localUnverifiedCount;

  const todayStats = useMemo(() => {
    const now = new Date().toDateString();
    const todays = sessions.filter((session) => new Date(session.startedAt).toDateString() === now);
    const totalEvents = todays.reduce((sum, session) => sum + session.report.stutterCount, 0);
    const totalMinutes = todays.reduce(
      (sum, session) => sum + session.report.totalDurationSeconds / 60,
      0,
    );
    const unverified = todays.filter((session) => !isAnalysisVerified(session)).length;
    return { count: todays.length, totalEvents, totalMinutes, unverified };
  }, [sessions]);

  async function startRecording() {
    // A new capture would reset the refs the previous one is still finishing with.
    if (isRecording || isFinishingCapture) {
      return;
    }
    try {
      if (selectedEngine.id !== "browser") {
        const ready = await ensureSelectedModelReady(transcription);
        if (!ready) {
          return;
        }
      }
      setMessage("Requesting microphone");
      const recorder = await createBrowserRecorder({
        onSamples: handleRecordedSamples,
        onLevel: setLevel,
      });

      browserRecorderRef.current = recorder;
      sampleRateRef.current = recorder.sampleRate;
      samplesRef.current = [];
      recordingTranscriptionRef.current = transcriptionRef.current;
      recordingLanguageRef.current = language;
      sessionLanguageRef.current = language;
      loadedSessionRef.current = null;
      setViewedSession(null);
      resetChunkTranscription();
      startedAtRef.current = new Date();
      activeSessionIdRef.current = null;
      lastFinalEndRef.current = 0;
      lastVoiceAtRef.current = 0;
      lastSpeakerMatchAtRef.current = 0;
      setSegments([]);
      setPauses([]);
      setInterimText("");
      setSpeakerMatch(null);
      setIsRecording(true);
      setMessage(
        selectedEngine.id === "browser"
          ? "Recording"
          : `Recording and chunking for ${selectedEngine.label}`,
      );
      if (selectedEngine.id === "browser") {
        startSpeechRecognition();
      }
    } catch (error) {
      await browserRecorderRef.current?.stop();
      browserRecorderRef.current = null;
      recordingTranscriptionRef.current = null;
      setIsRecording(false);
      setIsTranscribing(false);
      setLevel(0);
      setMessage(recordingErrorMessage(error));
    }
  }

  function startSpeechRecognition() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    if (!Recognition) {
      setMessage("Recording without browser transcription");
      return;
    }
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = language;
    recognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0]?.transcript.trim() ?? "";
        if (!text) {
          continue;
        }
        if (result.isFinal) {
          const endSeconds = elapsedSeconds();
          const estimatedDuration = Math.max(0.7, text.split(/\s+/).length * 0.34);
          const startSeconds = Math.max(lastFinalEndRef.current, endSeconds - estimatedDuration);
          lastFinalEndRef.current = endSeconds;
          const match = speakerMatchRef.current;
          const segment: TranscriptSegment = {
            text,
            startSeconds,
            endSeconds,
            confidence: result[0]?.confidence,
            speakerId: match?.speakerId,
            speakerLabel: match?.label,
            speakerScore: match?.score,
            isFinal: true,
          };
          setSegments((current) => [...current, segment]);
          setInterimText("");
        } else {
          setInterimText(text);
        }
      }
    };
    recognition.onerror = (event) => {
      setMessage(`Speech recognition: ${event.error}`);
    };
    recognition.onend = () => {
      if (!isRecordingRef.current) {
        recognitionEndedRef.current?.();
      }
      if (isRecordingRef.current) {
        try {
          recognition.start();
        } catch {
          setMessage("Speech recognition paused");
        }
      }
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      setMessage("Speech recognition unavailable");
    }
  }

  const isRecordingRef = useRef(false);
  // Resolves when browser recognition has delivered its final results after Stop.
  const recognitionEndedRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  function handleRecordedSamples(chunk: Float32Array) {
    const samples = samplesRef.current;
    for (const sample of chunk) {
      samples.push(sample);
    }
    const maxSamples = sampleRateRef.current * 90;
    if (recordingTranscriptionRef.current?.engine === "browser" && samples.length > maxSamples) {
      samples.splice(0, samples.length - maxSamples);
    }
    enqueueAvailableTranscriptionChunks(false);

    const frame = chunk.length ? chunk : new Float32Array();
    void (async () => {
      let energy = 0;
      for (const sample of frame) {
        energy += sample * sample;
      }
      const rms = Math.sqrt(energy / Math.max(1, frame.length));
      setLevel(Math.min(1, rms * 12));

      const now = elapsedSeconds();
      if (rms > 0.025) {
        if (lastVoiceAtRef.current > 0 && now - lastVoiceAtRef.current > 0.75) {
          setPauses((current) => [
            ...current,
            {
              startSeconds: lastVoiceAtRef.current,
              endSeconds: now,
              afterText: interimText || segmentsRef.current.at(-1)?.text,
            },
          ]);
        }
        lastVoiceAtRef.current = now;
      }

      const speakerProfiles = speakersRef.current;
      if (
        speakerProfiles.length &&
        !speakerMatchInFlightRef.current &&
        samplesRef.current.length > sampleRateRef.current * 1.5 &&
        now - lastSpeakerMatchAtRef.current > 0.8
      ) {
        const recent = samplesRef.current.slice(-Math.floor(sampleRateRef.current * 2));
        lastSpeakerMatchAtRef.current = now;
        speakerMatchInFlightRef.current = true;
        setIsMatchingVoice(true);
        identifySpeaker(recent, sampleRateRef.current, speakerProfiles)
          .then((result) => {
            // A speaker removed while identification ran must not come back as a match.
            const match =
              result.bestMatch &&
              speakersRef.current.some((speaker) => speaker.id === result.bestMatch?.speakerId)
                ? result.bestMatch
                : null;
            speakerMatchRef.current = match;
            setSpeakerMatch(match);
          })
          .catch(() => undefined)
          .finally(() => {
            speakerMatchInFlightRef.current = false;
            setIsMatchingVoice(false);
          });
      }
    })();
  }

  async function stopRecording() {
    if (!isRecording) {
      return;
    }
    // Saving and loading stay unavailable until every late transcript result has arrived.
    setIsFinishingCapture(true);
    try {
      await finishCapture();
    } finally {
      setIsFinishingCapture(false);
      setCaptureRevision((revision) => revision + 1);
    }
  }

  async function finishCapture() {
    const shouldTranscribeNative = recordingTranscriptionRef.current?.engine !== "browser";
    const capturedSamples = samplesRef.current.slice();
    const capturedSampleRate = sampleRateRef.current;
    setIsRecording(false);
    isRecordingRef.current = false;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    const recognitionEnded = recognition
      ? new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            // It never ended: detach it so late callbacks cannot reach a later capture.
            recognition.onresult = null;
            recognition.onerror = null;
            recognition.onend = null;
            try {
              recognition.abort();
            } catch {
              // Already stopped.
            }
            recognitionEndedRef.current = null;
            resolve();
          }, RECOGNITION_END_TIMEOUT_MS);
          recognitionEndedRef.current = () => {
            clearTimeout(timer);
            recognitionEndedRef.current = null;
            resolve();
          };
        })
      : Promise.resolve();
    recognition?.stop();
    await browserRecorderRef.current?.stop();
    browserRecorderRef.current = null;
    setLevel(0);
    await recognitionEnded;
    if (!shouldTranscribeNative) {
      setMessage("Stopped");
      recordingTranscriptionRef.current = null;
      return;
    }
    if (
      capturedSamples.length < capturedSampleRate / 2 &&
      chunkResultsRef.current.completed === 0
    ) {
      setMessage("Not enough audio to transcribe");
      recordingTranscriptionRef.current = null;
      return;
    }
    setMessage("Finishing transcription chunks");
    try {
      samplesRef.current = capturedSamples;
      sampleRateRef.current = capturedSampleRate;
      enqueueAvailableTranscriptionChunks(true);
      await chunkTranscriptionTailRef.current;
      const { completed, failed } = chunkResultsRef.current;
      if (completed > 0) {
        setMessage(
          failed > 0
            ? `Transcribed ${completed} chunk${completed === 1 ? "" : "s"}, ${failed} failed`
            : `Transcribed ${completed} chunk${completed === 1 ? "" : "s"}`,
        );
      } else {
        setMessage("No transcript returned");
      }
    } finally {
      recordingTranscriptionRef.current = null;
      fetchModelStatuses();
    }
  }

  async function saveSpeakerProfile() {
    if (samplesRef.current.length < sampleRateRef.current) {
      setMessage("Record a short sample first");
      return;
    }
    const label = speakerLabel.trim() || `Speaker ${speakersRef.current.length + 1}`;
    const existing = speakersRef.current.find(
      (speaker) => speaker.label.toLowerCase() === label.toLowerCase(),
    );
    setIsEnrolling(true);
    setMessage("Enrolling speaker");
    try {
      const result = await createSpeakerProfile(
        existing?.id,
        label,
        samplesRef.current.slice(-sampleRateRef.current * 12),
        sampleRateRef.current,
      );
      // Same queue as removals, built from the latest list when it runs, so an enrollment
      // cannot write back a profile removed while it was being created.
      const persisted = await queueSpeakerMutation(async () => {
        const latest = speakersRef.current;
        if (existing && !latest.some((speaker) => speaker.id === existing.id)) {
          throw new Error(
            "This voiceprint was removed while enrollment was pending. Enroll again to create a new profile.",
          );
        }
        const next =
          existing && latest.some((speaker) => speaker.id === existing.id)
            ? latest.map((speaker) =>
                speaker.id === existing.id
                  ? {
                      ...speaker,
                      label: result.label,
                      embeddings: [...speaker.embeddings, ...result.embeddings],
                      sampleCount: speaker.sampleCount + result.sampleCount,
                      sampleRate: result.sampleRate,
                    }
                  : speaker,
              )
            : [...latest, result];
        const saved = await savePersistedSpeakerProfiles(next);
        speakersRef.current = saved;
        return saved;
      });
      setSpeakers(persisted);
      setSpeakerLabel("");
      setMessage(`${result.label} enrolled`);
    } catch (error) {
      setMessage(`Enrollment failed: ${errorMessage(error)}`);
    } finally {
      setIsEnrolling(false);
    }
  }

  // Writes storage first, so a failed write (quota, blocked storage) leaves memory unchanged.
  function persistSessions(next: SavedSession[]) {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
    sessionsRef.current = next;
    setSessions(next);
  }

  function serializeSessionMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const operation = sessionMutationTailRef.current.then(mutation);
    sessionMutationTailRef.current = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async function saveSession() {
    if (!segments.length && !report.events.length) {
      setMessage("Nothing to save");
      return;
    }
    // A saved session freezes the workspace's analysis, so the observation must be complete and
    // the shown report must be the analysis of exactly that observation.
    if (captureInProgress) {
      setMessage("Stop recording and let transcription finish before saving");
      return;
    }
    if (
      !viewedSessionRef.current &&
      (isAnalyzing ||
        (reportRun !== null &&
          (reportRun.inputId !== observationFingerprint(segments, pauses) ||
            reportRun.audioId !== currentAudioId())))
    ) {
      setMessage("Analysis is still updating; save again in a moment");
      return;
    }
    const loaded = loadedSessionRef.current;
    if (
      loaded &&
      observationFingerprint(segments, pauses) ===
        observationFingerprint(loaded.segments, loaded.pauses)
    ) {
      await saveLoadedSession(loaded);
      return;
    }
    const session: SavedSession = createSessionRecord({
      id: crypto.randomUUID(),
      startedAt: startedAtRef.current?.toISOString() ?? new Date().toISOString(),
      segments,
      pauses,
      report,
      run: reportRun ?? {
        id: crypto.randomUUID(),
        createdAt: null,
        analyzer: null,
        usedAudio: null,
        audioId: null,
        // Saved before any analysis finished: the report was not computed from this observation.
        inputId: UNKNOWN_INPUT_ID,
      },
      context: {
        spokenLanguage: canonicalSpokenLanguage(sessionLanguageRef.current),
        task: null,
        condition: null,
      },
    });
    const next = [session, ...sessionsRef.current].slice(0, 50);
    try {
      persistSessions(next);
    } catch {
      setMessage("Could not save the session: browser storage is full or unavailable");
      return;
    }
    activeSessionIdRef.current = session.id;
    // Later saves of this workspace append runs to this record instead of creating copies.
    loadedSessionRef.current = session;
    setViewedSession(session);
    try {
      const corpus = await serializeSessionMutation(() => saveSpeechCorpusSession(session));
      setCorpusAnalysis(corpus);
      setMessage("Session saved to corpus");
    } catch {
      setCorpusAnalysis(analyzeLocalCorpus(sessionsRef.current));
      setMessage("Session saved locally");
    }
  }

  // Fingerprint of the audio an analysis of the workspace would use now (null without audio).
  function currentAudioId() {
    const audio = analysisAudioPayload(samplesRef.current, sampleRateRef.current);
    return audio.samples && audio.sampleRate
      ? audioFingerprint(audio.samples, audio.sampleRate)
      : null;
  }

  // Saving the session already on screen never creates a copy: either it is unchanged, or a new
  // analysis run is appended to its history.
  async function saveLoadedSession(loaded: SavedSession) {
    const knownRuns = [loaded.analysis.id, ...loaded.priorAnalyses.map((run) => run.id)];
    if (!reportRun || knownRuns.includes(reportRun.id)) {
      setMessage("Session is already saved");
      return;
    }
    const run = reportRun;
    const savedReport = report;
    // Runs after every queued mutation and rebuilds from the latest stored record, so a session
    // deleted meanwhile is never written back and queued saves keep each other's runs.
    const outcome = await serializeSessionMutation(async () => {
      const latest = sessionsRef.current.find((candidate) => candidate.id === loaded.id);
      if (!latest) {
        return "deleted" as const;
      }
      if (
        latest.analysis.id === run.id ||
        latest.priorAnalyses.some((prior) => prior.id === run.id)
      ) {
        return "unchanged" as const;
      }
      const updated = reanalyzeSession(latest, run, savedReport);
      // The user may have opened another session while this save waited in the queue.
      if (loadedSessionRef.current?.id === updated.id) {
        loadedSessionRef.current = updated;
      }
      try {
        persistSessions(
          sessionsRef.current.map((candidate) =>
            candidate.id === updated.id ? updated : candidate,
          ),
        );
      } catch {
        return "failed" as const;
      }
      try {
        setCorpusAnalysis(await saveSpeechCorpusSession(updated));
        return "corpus" as const;
      } catch {
        setCorpusAnalysis(analyzeLocalCorpus(sessionsRef.current));
        return "local" as const;
      }
    });
    setMessage(
      outcome === "failed"
        ? "Could not save the session: browser storage is full or unavailable"
        : outcome === "deleted"
          ? "Session was deleted; nothing saved"
          : outcome === "unchanged"
            ? "Session is already saved"
            : outcome === "corpus"
              ? "New analysis saved to the session"
              : "New analysis saved locally",
    );
  }

  // Explicit reanalysis of a saved transcript (no stored audio): appends a run, keeping the
  // earlier ones, and shows the new result if that session is on screen.
  async function reanalyzeSavedSession(session: SavedSession) {
    if (captureInProgress) {
      setMessage("Stop recording and let transcription finish before reanalyzing");
      return;
    }
    // Audio is not stored, so a session without transcript or pauses has nothing to replay;
    // analyzing empty input would replace an acoustic-only result with nothing.
    if (!isReplayable(session)) {
      setMessage("This session has no saved transcript to reanalyze");
      return;
    }
    // One run per session at a time, so runs are appended in the order they were started.
    if (reanalyzingRef.current.has(session.id)) {
      return;
    }
    reanalyzingRef.current.add(session.id);
    setReanalyzingSessionIds([...reanalyzingRef.current]);
    try {
      await runReanalysis(session);
    } finally {
      reanalyzingRef.current.delete(session.id);
      setReanalyzingSessionIds([...reanalyzingRef.current]);
    }
  }

  async function runReanalysis(session: SavedSession) {
    setMessage("Reanalyzing saved session");
    const analysis = await analyzeWithFallback({
      segments: session.segments,
      pauses: session.pauses,
      sessionStartedAt: session.startedAt,
    });
    const outcome = await serializeSessionMutation(async () => {
      const latest = sessionsRef.current.find((candidate) => candidate.id === session.id);
      if (!latest) {
        return "deleted" as const;
      }
      const updated = reanalyzeSession(
        latest,
        {
          id: analysis.runId,
          createdAt: analysis.createdAt,
          analyzer: analysis.analyzer,
          usedAudio: false,
          audioId: null,
        },
        analysis.report,
      );
      try {
        persistSessions(
          sessionsRef.current.map((candidate) =>
            candidate.id === updated.id ? updated : candidate,
          ),
        );
      } catch {
        return "failed" as const;
      }
      if (viewedSessionRef.current?.id === updated.id) {
        loadedSessionRef.current = updated;
        setViewedSession(updated);
        setReport(updated.report);
        setReportRun(updated.analysis);
      }
      try {
        setCorpusAnalysis(await saveSpeechCorpusSession(updated));
        return "saved" as const;
      } catch {
        setCorpusAnalysis(analyzeLocalCorpus(sessionsRef.current));
        return "local" as const;
      }
    });
    setMessage(
      outcome === "saved"
        ? "Reanalysis added to the session"
        : outcome === "local"
          ? isDesktopApp()
            ? "Reanalysis saved locally; the desktop corpus still has the earlier analysis"
            : "Reanalysis added to the session"
          : outcome === "deleted"
            ? "Session was deleted; nothing reanalyzed"
            : "Could not save the reanalysis: browser storage is full or unavailable",
    );
  }

  // Removing a voiceprint deletes the local copy and, when a server holds it, the server copy;
  // the message says which happened. Removals run one at a time from the latest list.
  function removeSpeakerProfile(speaker: SpeakerProfile) {
    if (!window.confirm(`Remove the voiceprint for ${speaker.label}?`)) {
      return Promise.resolve();
    }
    speakerRemovalsRef.current += 1;
    return queueSpeakerMutation(() => removeSpeakerLocally(speaker)).then((removed) =>
      // The server deletion runs outside the queue: a stalled server must not hold up later
      // local changes.
      removed ? deleteSpeakerRemotely(speaker) : undefined,
    );
  }

  function queueSpeakerMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const operation = speakerMutationTailRef.current.then(mutation);
    speakerMutationTailRef.current = operation.catch(() => undefined);
    return operation;
  }

  /** Removes the local copies; resolves true when the speaker is gone locally. */
  async function removeSpeakerLocally(speaker: SpeakerProfile): Promise<boolean> {
    const remaining = speakersRef.current.filter((candidate) => candidate.id !== speaker.id);
    // Browser-storage copies go first (on desktop they are what the profile was migrated from),
    // so a failure leaves the profile listed and removable.
    try {
      removeLocalSpeakerCopy(speaker.id);
    } catch (error) {
      setMessage(`Could not remove ${speaker.label} from this browser: ${errorMessage(error)}`);
      return false;
    }
    let next = remaining;
    if (isDesktopApp()) {
      try {
        next = await invoke<SpeakerProfile[]>("save_speaker_profiles", { speakers: remaining });
      } catch (error) {
        setMessage(`Could not remove ${speaker.label}: ${errorMessage(error)}`);
        return false;
      }
    }
    speakersRef.current = next;
    setSpeakers(next);
    if (speakerMatchRef.current?.speakerId === speaker.id) {
      speakerMatchRef.current = null;
      setSpeakerMatch(null);
    }
    if (isDesktopApp()) {
      setMessage(`Removed ${speaker.label}`);
    }
    return true;
  }

  async function deleteSpeakerRemotely(speaker: SpeakerProfile) {
    if (isDesktopApp()) {
      return;
    }
    try {
      const result = await computeClient.deleteSpeakerProfile(speaker.id);
      setMessage(
        result === "noServer"
          ? // No server is permitted now; one used under earlier consent may still hold a copy.
            `Removed ${speaker.label} from this device. No compute server is selected now; if you sent it to one earlier, delete it there too.`
          : `Removed ${speaker.label} here and from the compute server`,
      );
    } catch (error) {
      setMessage(
        `Removed ${speaker.label} on this device only; deleting it from the compute server failed (${errorMessage(error)})`,
      );
    }
  }

  async function deleteSession(session: SavedSession) {
    setDeletingSessionId(session.id);
    try {
      const corpus = await serializeSessionMutation(async () => {
        const remainingSessions = sessionsRef.current.filter(
          (candidate) => candidate.id !== session.id,
        );
        const analysis = await deleteSpeechCorpusSession(session.id, remainingSessions);
        const next = sessionsRef.current.filter((candidate) => candidate.id !== session.id);
        persistSessions(next);
        if (activeSessionIdRef.current === session.id) {
          startedAtRef.current = null;
          samplesRef.current = [];
          setSegments([]);
          setPauses([]);
          setReport(emptyReport());
          setReportRun(null);
          sessionLanguageRef.current = null;
          loadedSessionRef.current = null;
          setViewedSession(null);
          setInterimText("");
          setSpeakerMatch(null);
          resetChunkTranscription();
          activeSessionIdRef.current = null;
        }
        return analysis;
      });
      setCorpusAnalysis(corpus);
      setMessage("Session deleted");
    } catch (error) {
      setMessage(`Delete failed: ${errorMessage(error)}`);
    } finally {
      setDeletingSessionId(null);
    }
  }

  function exportJson() {
    downloadJsonFile("stutter-tracker-export.json", { sessions, speakers, corpus: corpusAnalysis });
  }

  async function exportCorpusJson() {
    const corpus = await loadSpeechCorpusExport(sessions);
    downloadJsonFile("stutter-tracker-corpus.json", {
      exportedAt: new Date().toISOString(),
      corpus,
      analysis: corpusAnalysis,
    });
  }

  function downloadJsonFile(filename: string, value: unknown) {
    const payload = JSON.stringify(value, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function updateTranscriptionEngine(engine: TranscriptionEngineId) {
    const nextEngine = getTranscriptionEngine(engine);
    const next = {
      engine,
      model: nextEngine.models[0],
    };
    setTranscription(next);
    localStorage.setItem(TRANSCRIPTION_KEY, JSON.stringify(next));
  }

  function updateTranscriptionModel(model: string) {
    const next = { ...transcription, model };
    setTranscription(next);
    localStorage.setItem(TRANSCRIPTION_KEY, JSON.stringify(next));
  }

  async function fetchModelStatuses() {
    await queryClient.invalidateQueries({
      queryKey: ["transcription-models", transcription.engine],
    });
  }

  async function ensureSelectedModelReady(settings: TranscriptionSettings) {
    let status = modelStatusesQuery.data?.find((model) => model.id === settings.model);
    if (!status) {
      try {
        const models = await loadTranscriptionModels(settings.engine);
        status = models.find((model) => model.id === settings.model);
      } catch {
        status = modelStatuses.find((model) => model.id === settings.model);
      }
    }
    if (!status || status.cached || !status.downloadable) {
      return true;
    }
    setMessage(`Preparing ${settings.model}`);
    return downloadModel(settings.model, settings.engine);
  }

  async function downloadModel(model: string, engine = transcription.engine) {
    const key = `${engine}:${model}`;
    if (modelDownloadKeyRef.current === key && modelDownloadPromiseRef.current) {
      return modelDownloadPromiseRef.current;
    }
    setDownloadingModel(model);
    setDownloadProgress({
      phase: "downloading",
      message: `Downloading \`${model}\``,
      model,
      progress: 0,
    });
    setMessage(`Downloading ${model}`);
    const promise = downloadModelMutation
      .mutateAsync({ engine, model })
      .then(() => true)
      .catch(() => false)
      .finally(() => {
        if (modelDownloadKeyRef.current === key) {
          modelDownloadKeyRef.current = null;
          modelDownloadPromiseRef.current = null;
        }
      });
    modelDownloadKeyRef.current = key;
    modelDownloadPromiseRef.current = promise;
    return promise;
  }

  function resetChunkTranscription() {
    transcriptionRunIdRef.current += 1;
    nextChunkStartSampleRef.current = 0;
    chunkIndexRef.current = 0;
    queuedTranscriptionTasksRef.current = 0;
    chunkResultsRef.current = { completed: 0, failed: 0 };
    chunkTranscriptionTailRef.current = Promise.resolve();
    setChunkStats(emptyChunkStats());
    setTranscriptionChunks([]);
    setIsTranscribing(false);
  }

  function enqueueAvailableTranscriptionChunks(forceFinal: boolean) {
    const settings = recordingTranscriptionRef.current;
    if (!settings || settings.engine === "browser") {
      return;
    }
    const sampleRate = sampleRateRef.current;
    for (const { startSample, endSample } of planAvailableChunks({
      totalSamples: samplesRef.current.length,
      nextStartSample: nextChunkStartSampleRef.current,
      sampleRate,
      chunkSeconds: TRANSCRIPTION_CHUNK_SECONDS,
      forceFinal,
    })) {
      nextChunkStartSampleRef.current = endSample;
      enqueueTranscriptionChunk(
        samplesRef.current.slice(startSample, endSample),
        sampleRate,
        startSample / sampleRate,
        settings,
        recordingLanguageRef.current,
      );
      if (forceFinal) {
        return;
      }
    }
  }

  function enqueueTranscriptionChunk(
    chunkSamples: number[],
    sampleRate: number,
    offsetSeconds: number,
    settings: TranscriptionSettings,
    language: string,
  ) {
    const runId = transcriptionRunIdRef.current;
    const chunkNumber = ++chunkIndexRef.current;
    const durationSeconds = chunkSamples.length / sampleRate;
    queuedTranscriptionTasksRef.current += 1;
    setIsTranscribing(true);
    setTranscriptionChunks((current) => [
      ...current,
      {
        id: chunkNumber,
        startSeconds: offsetSeconds,
        endSeconds: offsetSeconds + durationSeconds,
        durationSeconds,
        status: "queued",
        transcript: "",
        segmentCount: 0,
      },
    ]);
    setChunkStats((current) => ({
      ...current,
      queued: current.queued + 1,
      lastMessage: `Queued chunk ${chunkNumber}`,
    }));

    const task = async () => {
      if (runId !== transcriptionRunIdRef.current) {
        return;
      }
      setChunkStats((current) => ({
        ...current,
        queued: Math.max(0, current.queued - 1),
        processing: current.processing + 1,
        lastMessage: `Transcribing chunk ${chunkNumber}`,
      }));
      setTranscriptionChunks((current) =>
        updateTranscriptionChunk(current, chunkNumber, { status: "processing" }),
      );
      setMessage(`Transcribing chunk ${chunkNumber}`);
      try {
        const transcriptionSamples = resampleSamples(
          chunkSamples,
          sampleRate,
          TRANSCRIPTION_TARGET_SAMPLE_RATE,
        );
        const result = await transcribeAudio(
          transcriptionSamples,
          TRANSCRIPTION_TARGET_SAMPLE_RATE,
          settings,
          language,
        );
        if (runId !== transcriptionRunIdRef.current) {
          return;
        }
        const chunkSegments = await identifyTranscriptSpeakers(
          result.segments,
          transcriptionSamples,
          TRANSCRIPTION_TARGET_SAMPLE_RATE,
          speakersRef.current,
        );
        const offsetSegments = offsetTranscriptSegments(chunkSegments, offsetSeconds);
        const chunkTranscript = offsetSegments
          .map((segment) => segment.text)
          .join(" ")
          .trim();
        setSegments((current) => mergeTranscriptSegments(current, offsetSegments));
        setInterimText("");
        chunkResultsRef.current.completed += 1;
        setTranscriptionChunks((current) =>
          updateTranscriptionChunk(current, chunkNumber, {
            status: "completed",
            transcript: chunkTranscript,
            segmentCount: offsetSegments.length,
            error: undefined,
          }),
        );
        setChunkStats((current) => ({
          ...current,
          completed: current.completed + 1,
          lastMessage: `Completed chunk ${chunkNumber}`,
        }));
      } catch (error) {
        const message = errorMessage(error);
        chunkResultsRef.current.failed += 1;
        setTranscriptionChunks((current) =>
          updateTranscriptionChunk(current, chunkNumber, {
            status: "failed",
            error: message,
          }),
        );
        setChunkStats((current) => ({
          ...current,
          failed: current.failed + 1,
          lastMessage: `Chunk ${chunkNumber} failed: ${message}`,
        }));
        setMessage(`Chunk ${chunkNumber} failed: ${message}`);
      } finally {
        queuedTranscriptionTasksRef.current = Math.max(0, queuedTranscriptionTasksRef.current - 1);
        setChunkStats((current) => ({
          ...current,
          processing: Math.max(0, current.processing - 1),
        }));
        if (queuedTranscriptionTasksRef.current === 0) {
          setIsTranscribing(false);
        }
      }
    };

    chunkTranscriptionTailRef.current = chunkTranscriptionTailRef.current
      .catch(() => undefined)
      .then(task);
  }

  return (
    <main className="mx-auto min-h-screen max-w-[1420px] bg-[#f5f7f5] p-5 text-[#17201b] max-sm:p-3">
      <DashboardHeader
        isFinishingCapture={isFinishingCapture}
        engines={TRANSCRIPTION_ENGINES}
        languages={LANGUAGES}
        transcription={transcription}
        selectedModels={selectedModels}
        language={language}
        isNative={isNative}
        isRecording={isRecording}
        processingDestination={
          isNative
            ? { kind: "onDevice", label: "On this device (desktop app)" }
            : computeClient.destination
        }
        onRemoteConsentChange={(granted) => {
          if (computeClient.destination.kind === "onDevice") return;
          saveRemoteConsent(CONSENT_SERVER_URL, granted);
          window.location.reload();
        }}
        onEngineChange={updateTranscriptionEngine}
        onModelChange={updateTranscriptionModel}
        onLanguageChange={setLanguage}
        onRecordingToggle={isRecording ? stopRecording : startRecording}
      />

      <StatusMetrics report={report} speechStats={speechStats} blockerStats={blockerStats} />

      <section className="mb-4 flex items-stretch gap-4 max-lg:flex-col">
        <RecordingWorkspace
          isNative={isNative}
          message={message}
          speakersCount={speakers.length}
          speakerMatch={speakerMatch}
          isRecording={isRecording}
          isTranscribing={isTranscribing}
          isAnalyzing={isAnalyzing}
          isEnrolling={isEnrolling}
          isMatchingVoice={isMatchingVoice}
          downloadingModel={downloadingModel}
          downloadProgress={downloadProgress}
          selectedModelStatus={selectedModelStatus}
          chunkStats={chunkStats}
          chunkProgress={chunkProgress}
          transcriptionChunks={transcriptionChunks}
          hasAnalysisEvents={report.events.length > 0}
          level={level}
          transcript={transcript}
          interimText={interimText}
          canEnroll={samplesRef.current.length > 0}
          onEnroll={saveSpeakerProfile}
          onSave={saveSession}
          saveDisabled={captureInProgress || isAnalyzing}
          onExport={exportJson}
        />

        <InsightsSidebar
          todayStats={todayStats}
          report={report}
          speechStats={speechStats}
          blockerStats={blockerStats}
          selectedEngine={selectedEngine}
          selectedModel={transcription.model}
          selectedModelStatus={selectedModelStatus}
          modelStatuses={modelStatuses}
          corpusAnalysis={corpusAnalysis}
          unverifiedSessionCount={unverifiedSessionCount}
          speakers={speakers}
          speakerLabel={speakerLabel}
          canEnroll={samplesRef.current.length > 0}
          isRecording={isRecording}
          isTranscribing={isTranscribing}
          downloadingModel={downloadingModel}
          isDownloadPending={downloadModelMutation.isPending}
          onModelSelect={updateTranscriptionModel}
          onModelDownload={(model) => downloadModel(model)}
          onSpeakerLabelChange={setSpeakerLabel}
          onSpeakerRemove={
            speakersReady ? (speaker) => void removeSpeakerProfile(speaker) : undefined
          }
          onEnroll={saveSpeakerProfile}
          onCorpusExport={exportCorpusJson}
        />
      </section>

      <LowerDashboard
        report={report}
        segments={segments}
        intentPredictions={intentPredictions}
        analyzedChunks={analyzedChunks}
        blockerStats={blockerStats}
        sessions={sessions}
        deletingSessionId={deletingSessionId}
        sessionLoadDisabled={captureInProgress}
        onSessionLoad={(session) => {
          // Live capture would keep appending to the loaded transcript.
          if (captureInProgress) {
            return;
          }
          startedAtRef.current = new Date(session.startedAt);
          activeSessionIdRef.current = session.id;
          setSegments(session.segments);
          setPauses(session.pauses);
          setReport(session.report);
          setReportRun(session.analysis);
          sessionLanguageRef.current = session.context.spokenLanguage;
          loadedSessionRef.current = session;
          setViewedSession(session);
          // Audio is not stored with sessions; keeping the last recording's PCM would analyze
          // this session against someone else's audio.
          samplesRef.current = [];
        }}
        onSessionDelete={(session) => void deleteSession(session)}
        onSessionReanalyze={(session) => void reanalyzeSavedSession(session)}
        reanalyzingSessionIds={reanalyzingSessionIds}
      />
    </main>
  );
}

async function analyze(request: {
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
  sessionStartedAt?: string;
  samples?: number[];
  sampleRate?: number;
}): Promise<AnalyzedSpeech> {
  if (!isDesktopApp()) {
    return computeClient.analyzeSpeechSessionRun(request);
  }
  const report = await invoke<AnalysisReport & { analyzerVersion?: string }>(
    "analyze_speech_session",
    { request },
  );
  return { report, analyzer: desktopAnalyzer(report.analyzerVersion) };
}

/** The desktop command reports its detector version; older desktop builds leave it unknown. */
export function desktopAnalyzer(version: string | undefined): AnalyzerIdentity {
  return {
    producer: "desktopNative",
    algorithm: "analyze_speech_session",
    version: version ?? null,
  };
}

async function analyzeWithFallback(request: {
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
  sessionStartedAt?: string;
  samples?: number[];
  sampleRate?: number;
}): Promise<
  AnalyzedSpeech & {
    usedAudio: boolean;
    inputId: string;
    audioId: string | null;
    runId: string;
    createdAt: string;
  }
> {
  const usedAudio = Boolean(request.samples?.length && request.sampleRate);
  // Minted here, where the analyzer actually runs, so a cached result keeps its identity.
  const provenance = {
    runId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    usedAudio,
    audioId:
      usedAudio && request.samples && request.sampleRate
        ? audioFingerprint(request.samples, request.sampleRate)
        : null,
    inputId: observationFingerprint(request.segments, request.pauses),
  };
  try {
    return { ...(await analyze(request)), ...provenance };
  } catch {
    return { report: fallbackAnalyze(request), analyzer: ON_DEVICE_ANALYZER, ...provenance };
  }
}

export type IntentPredictionRequest = {
  segments: TranscriptSegment[];
  sessions: SavedSession[];
  events: StutterEvent[];
  partialText: string;
  maxContexts: number;
  maxPredictions: number;
  phraseTokens: number;
};

async function predictSpeakerIntentWithFallback(
  request: IntentPredictionRequest,
): Promise<SpeakerIntentPrediction[]> {
  try {
    return await predictSpeakerIntent(request);
  } catch {
    return fallbackPredictSpeakerIntent(request);
  }
}

async function predictSpeakerIntent(
  request: IntentPredictionRequest,
): Promise<SpeakerIntentPrediction[]> {
  if (!isDesktopApp()) {
    return fallbackPredictSpeakerIntent(request);
  }
  return invoke<SpeakerIntentPrediction[]>("predict_speaker_intent", { request });
}

async function createSpeakerProfile(
  id: string | undefined,
  label: string,
  samples: number[],
  sampleRate: number,
): Promise<SpeakerProfile> {
  if (!isDesktopApp()) {
    return computeClient.createSpeakerProfile({ id, label, samples, sampleRate });
  }
  return invoke<SpeakerProfile>("create_speaker_profile", {
    request: { id, label, samples: decimate(samples), sampleRate },
  });
}

async function identifySpeaker(
  samples: number[],
  sampleRate: number,
  speakers: SpeakerProfile[],
): Promise<SpeakerIdentification> {
  if (!speakers.length) {
    return { matches: [], isMatch: false };
  }
  if (!isDesktopApp()) {
    return computeClient.identifySpeaker({
      samples,
      sampleRate,
      speakers,
      threshold: 0.82,
      maxResults: 3,
    });
  }
  return invoke<SpeakerIdentification>("identify_speaker", {
    request: {
      samples: decimate(samples),
      sampleRate,
      speakers,
      threshold: 0.82,
      maxResults: 3,
    },
  });
}

async function identifyTranscriptSpeakers(
  segments: TranscriptSegment[],
  samples: number[],
  sampleRate: number,
  speakers: SpeakerProfile[],
) {
  if (!speakers.length) {
    return segments;
  }
  return Promise.all(
    segments.map(async (segment) => {
      const start = Math.max(0, Math.floor(segment.startSeconds * sampleRate));
      const end = Math.min(samples.length, Math.ceil(segment.endSeconds * sampleRate));
      if (end - start < sampleRate / 4) {
        return segment;
      }
      try {
        const result = await identifySpeaker(samples.slice(start, end), sampleRate, speakers);
        const match = result.bestMatch;
        if (!match) {
          return segment;
        }
        return {
          ...segment,
          speakerId: match.speakerId,
          speakerLabel: match.label,
          speakerScore: match.score,
        };
      } catch {
        return segment;
      }
    }),
  );
}

async function loadTranscriptionModels(
  engine: TranscriptionEngineId,
): Promise<TranscriptionModelStatus[]> {
  if (!isDesktopApp()) {
    return computeClient.transcriptionModels(engine);
  }
  const result = await invoke<{ models: TranscriptionModelStatus[] }>("transcription_models", {
    request: { provider: engine },
  });
  return result.models;
}

async function transcribeAudio(
  samples: number[],
  sampleRate: number,
  settings: TranscriptionSettings,
  language: string,
): Promise<{ segments: TranscriptSegment[] }> {
  if (!isDesktopApp()) {
    return computeClient.transcribeAudio({
      samples,
      sampleRate,
      provider: settings.engine,
      model: settings.model,
      language,
    });
  }
  return invoke<{ segments: TranscriptSegment[] }>("transcribe_audio", {
    request: {
      samples,
      sampleRate,
      provider: settings.engine,
      model: settings.model,
      language,
    },
  });
}

async function downloadTranscriptionModel(engine: TranscriptionEngineId, model: string) {
  if (!isDesktopApp()) {
    return computeClient.downloadTranscriptionModel(engine, model);
  }
  return invoke<TranscriptionModelStatus>("download_transcription_model", {
    request: {
      provider: engine,
      model,
    },
  });
}

async function loadSpeechCorpus(): Promise<SpeechCorpusAnalysis> {
  if (!isDesktopApp()) {
    throw new Error("desktop corpus is only available in the Tauri app");
  }
  return invoke<SpeechCorpusAnalysis>("load_speech_corpus");
}

/**
 * Counts desktop-corpus sessions whose analysis is not verified for their transcript: those
 * without stored provenance, and those whose `analysis.inputId` does not match the untouched
 * observation (`observedSegments` and `pauses`) the corpus keeps.
 */
export function countUnverifiedCorpusSessions(exported: unknown): number {
  const sessions =
    exported &&
    typeof exported === "object" &&
    Array.isArray((exported as { sessions?: unknown }).sessions)
      ? ((exported as { sessions: unknown[] }).sessions as Record<string, unknown>[])
      : [];
  return sessions.filter((session) => {
    const analysis = session.analysis as { inputId?: unknown } | undefined;
    if (!analysis || !Array.isArray(session.observedSegments) || !Array.isArray(session.pauses)) {
      return true;
    }
    return (
      analysis.inputId !==
      observationFingerprint(
        session.observedSegments as TranscriptSegment[],
        session.pauses as PauseSpan[],
      )
    );
  }).length;
}

async function loadSpeechCorpusExport(sessions: SavedSession[]) {
  if (!isDesktopApp()) {
    return localSpeechCorpusExport(sessions);
  }
  try {
    return await invoke<unknown>("export_speech_corpus");
  } catch {
    return localSpeechCorpusExport(sessions);
  }
}

async function saveSpeechCorpusSession(session: SavedSession): Promise<SpeechCorpusAnalysis> {
  if (!isDesktopApp()) {
    throw new Error("desktop corpus is only available in the Tauri app");
  }
  return invoke<SpeechCorpusAnalysis>("save_speech_corpus_session", { session });
}

async function deleteSpeechCorpusSession(
  sessionId: string,
  remainingSessions: SavedSession[],
): Promise<SpeechCorpusAnalysis> {
  if (!isDesktopApp()) {
    return analyzeLocalCorpus(remainingSessions);
  }
  return invoke<SpeechCorpusAnalysis>("delete_speech_corpus_session", { sessionId });
}

export function fallbackAnalyze(request: {
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
  sessionStartedAt?: string;
  samples?: number[];
  sampleRate?: number;
}): AnalysisReport {
  return sharedFallbackAnalyze(request) as AnalysisReport;
}

function emptySpeechStats(): SpeechStats {
  return {
    speakingDurationSeconds: 0,
    pauseDurationSeconds: 0,
    wordsPerMinute: 0,
    articulationRateWpm: 0,
    meanChunkWords: 0,
    meanChunkDurationSeconds: 0,
    eventDensityPer100Words: 0,
    fluencyPercentage: 100,
  };
}

function emptyBlockerStats(): BlockerStats {
  return {
    blockCount: 0,
    totalBlockSeconds: 0,
    averageBlockSeconds: 0,
    longestBlockSeconds: 0,
    blocksPerMinute: 0,
    blockedTimePercentage: 0,
  };
}

function decimate(samples: number[]) {
  const maxSamples = 96_000;
  if (samples.length <= maxSamples) {
    return samples;
  }
  const step = Math.ceil(samples.length / maxSamples);
  const result: number[] = [];
  for (let index = 0; index < samples.length; index += step) {
    result.push(samples[index]);
  }
  return result;
}

function analysisAudioPayload(samples: number[], sampleRate: number) {
  if (!samples.length || sampleRate <= 0) {
    return {};
  }
  const maxSourceSamples = Math.floor(sampleRate * 90);
  const capped = samples.slice(Math.max(0, samples.length - maxSourceSamples));
  return {
    samples: resampleSamples(capped, sampleRate, TRANSCRIPTION_TARGET_SAMPLE_RATE),
    sampleRate: TRANSCRIPTION_TARGET_SAMPLE_RATE,
  };
}

export const resampleSamples = sharedResampleSamples;

export function offsetTranscriptSegments(
  segments: TranscriptSegment[],
  offsetSeconds: number,
): TranscriptSegment[] {
  return segments.map((segment) => ({
    ...segment,
    startSeconds: segment.startSeconds + offsetSeconds,
    endSeconds: segment.endSeconds + offsetSeconds,
  }));
}

function mergeTranscriptSegments(
  current: TranscriptSegment[],
  incoming: TranscriptSegment[],
): TranscriptSegment[] {
  if (!incoming.length) {
    return current;
  }
  return [...current, ...incoming].sort((left, right) => left.startSeconds - right.startSeconds);
}

function updateTranscriptionChunk(
  chunks: TranscriptionChunkRecord[],
  id: number,
  patch: Partial<TranscriptionChunkRecord>,
) {
  return chunks.map((chunk) => (chunk.id === id ? { ...chunk, ...patch } : chunk));
}

export function summarizeTranscriptionChunks(
  chunks: Pick<TranscriptionChunkRecord, "status">[],
): TranscriptionChunkSummary {
  return chunks.reduce<TranscriptionChunkSummary>(
    (summary, chunk) => {
      summary.total += 1;
      summary[chunk.status] += 1;
      return summary;
    },
    {
      total: 0,
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    },
  );
}

type LocalMarkov = {
  order: number;
  transitions: Map<string, Map<string, number>>;
};

type IntentCandidate = Omit<SpeakerIntentPrediction, "id" | "confidence" | "suggestions"> & {
  tokens: string[];
};

export function fallbackPredictSpeakerIntent(
  request: IntentPredictionRequest,
): SpeakerIntentPrediction[] {
  const orderTwo = createLocalMarkov(2);
  const orderOne = createLocalMarkov(1);
  for (const document of intentTrainingDocuments(request)) {
    trainLocalMarkov(orderTwo, document);
    trainLocalMarkov(orderOne, document);
  }

  const predictions: SpeakerIntentPrediction[] = [];
  const seen = new Set<string>();
  for (const candidate of intentCandidates(request).slice(0, request.maxContexts * 2)) {
    const suggestions =
      predictLocalIntent(
        orderTwo,
        candidate.tokens,
        request.maxPredictions,
        request.phraseTokens,
      ) ||
      predictLocalIntent(orderOne, candidate.tokens, request.maxPredictions, request.phraseTokens);
    if (!suggestions?.length) {
      continue;
    }
    const key = `${candidate.reason}:${candidate.contextText}:${candidate.triggerText ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    predictions.push({
      id: `intent-${predictions.length + 1}`,
      reason: candidate.reason,
      contextText: candidate.contextText,
      triggerText: candidate.triggerText,
      startSeconds: candidate.startSeconds,
      endSeconds: candidate.endSeconds,
      speakerId: candidate.speakerId,
      speakerLabel: candidate.speakerLabel,
      confidence: Math.max(...suggestions.map((suggestion) => suggestion.probability)),
      suggestions,
    });
    if (predictions.length >= request.maxContexts) {
      break;
    }
  }
  return predictions;
}

function intentTrainingDocuments(request: IntentPredictionRequest) {
  return [...request.sessions.flatMap((session) => session.segments), ...request.segments]
    .filter((segment) => segment.isFinal)
    .map((segment) => segment.text.trim())
    .filter(Boolean);
}

function intentCandidates(request: IntentPredictionRequest): IntentCandidate[] {
  const candidates: IntentCandidate[] = [];
  const partialTokens = tokenizeIntentText(request.partialText);
  if (partialTokens.length) {
    const latestSegment = request.segments.at(-1);
    candidates.push({
      reason: "currentContext",
      contextText: intentContextText(partialTokens),
      tokens: partialTokens,
      triggerText: null,
      startSeconds: latestSegment?.endSeconds,
      endSeconds: latestSegment?.endSeconds,
      speakerId: latestSegment?.speakerId,
      speakerLabel: latestSegment?.speakerLabel,
    });
  }

  for (const event of [...request.events].reverse()) {
    const segment = nearestIntentSegment(request.segments, event.startSeconds, event.endSeconds);
    if (!segment) {
      continue;
    }
    const segmentTokens = tokenizeIntentText(segment.text);
    const eventTokens = tokenizeIntentText(event.text);
    const tokens =
      prefixForIntentEvent(segmentTokens, eventTokens) ??
      tokensBeforeIntentTime(request.segments, event.startSeconds);
    if (!tokens.length) {
      continue;
    }
    candidates.push({
      reason: intentReasonForKind(event.kind),
      contextText: intentContextText(tokens),
      tokens,
      triggerText: event.text,
      startSeconds: event.startSeconds,
      endSeconds: event.endSeconds,
      speakerId: segment.speakerId,
      speakerLabel: segment.speakerLabel,
    });
  }
  return candidates;
}

function createLocalMarkov(order: number): LocalMarkov {
  return { order, transitions: new Map() };
}

function trainLocalMarkov(model: LocalMarkov, text: string) {
  const tokens = tokenizeIntentText(text);
  for (let index = model.order; index < tokens.length; index += 1) {
    const key = markovKey(tokens.slice(index - model.order, index));
    const next = model.transitions.get(key) ?? new Map<string, number>();
    next.set(tokens[index], (next.get(tokens[index]) ?? 0) + 1);
    model.transitions.set(key, next);
  }
}

function predictLocalIntent(
  model: LocalMarkov,
  context: string[],
  limit: number,
  phraseTokens: number,
) {
  if (context.length < model.order) {
    return null;
  }
  const key = markovKey(context.slice(-model.order));
  const counts = model.transitions.get(key);
  if (!counts?.size) {
    return null;
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0) || 1;
  return [...counts.entries()]
    .map(([token, count]) => ({
      token,
      count,
      probability: count / total,
      phrase: generateLocalPhrase(model, [...context, token], context.length + phraseTokens)
        .slice(context.length)
        .join(" "),
    }))
    .sort((left, right) => right.count - left.count || left.token.localeCompare(right.token))
    .slice(0, limit);
}

function generateLocalPhrase(model: LocalMarkov, seed: string[], maxTokens: number) {
  const tokens = [...seed];
  while (tokens.length < maxTokens) {
    const counts = model.transitions.get(markovKey(tokens.slice(-model.order)));
    const next = bestLocalNext(counts);
    if (!next) {
      break;
    }
    tokens.push(next);
  }
  return tokens;
}

function bestLocalNext(counts?: Map<string, number>) {
  if (!counts?.size) {
    return null;
  }
  return [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0]?.[0];
}

function markovKey(tokens: string[]) {
  return JSON.stringify(tokens);
}

function tokenizeIntentText(text: string) {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

function nearestIntentSegment(
  segments: TranscriptSegment[],
  startSeconds: number,
  endSeconds: number,
) {
  return segments
    .filter((segment) => segment.isFinal)
    .sort(
      (left, right) =>
        distanceToIntentSpan(left, startSeconds, endSeconds) -
        distanceToIntentSpan(right, startSeconds, endSeconds),
    )[0];
}

function distanceToIntentSpan(
  segment: TranscriptSegment,
  startSeconds: number,
  endSeconds: number,
) {
  if (segment.startSeconds <= endSeconds && segment.endSeconds >= startSeconds) {
    return 0;
  }
  return segment.endSeconds < startSeconds
    ? startSeconds - segment.endSeconds
    : segment.startSeconds - endSeconds;
}

function prefixForIntentEvent(segmentTokens: string[], eventTokens: string[]) {
  if (!eventTokens.length) {
    return null;
  }
  for (let index = 0; index < segmentTokens.length; index += 1) {
    const matches = eventTokens.every((token, offset) => segmentTokens[index + offset] === token);
    if (matches) {
      return segmentTokens.slice(0, Math.min(segmentTokens.length, index + 1));
    }
  }
  return null;
}

function tokensBeforeIntentTime(segments: TranscriptSegment[], seconds: number) {
  return segments
    .filter((segment) => segment.isFinal && segment.endSeconds <= seconds)
    .flatMap((segment) => tokenizeIntentText(segment.text));
}

function intentContextText(tokens: string[]) {
  return tokens.slice(-5).join(" ");
}

function intentReasonForKind(kind: StutterEvent["kind"]): IntentCandidate["reason"] {
  const reasons = {
    block: "block",
    filler: "filler",
    wordRepetition: "repetition",
    soundRepetition: "repetition",
    prolongation: "prolongation",
  } as const;
  return reasons[kind];
}

function emptyReport(): AnalysisReport {
  return {
    totalDurationSeconds: 0,
    wordCount: 0,
    stutterCount: 0,
    stuttersPerMinute: 0,
    severity: "none",
    speechStats: emptySpeechStats(),
    blockerStats: emptyBlockerStats(),
    chunks: [],
    events: [],
    byKind: {},
  };
}

function emptyCorpusAnalysis(): SpeechCorpusAnalysis {
  return {
    stats: {
      sessions: 0,
      documents: 0,
      speakers: 0,
      totalDurationSeconds: 0,
      totalTerms: 0,
      uniqueTerms: 0,
      averageTermsPerDocument: 0,
      wordCount: 0,
      stutterCount: 0,
      stuttersPerMinute: 0,
      lexicalDiversity: 0,
    },
    text: {
      bytes: 0,
      chars: 0,
      words: 0,
      lines: 0,
      sentences: 0,
      uniqueTerms: 0,
    },
    readability: {
      sentenceCount: 0,
      wordCount: 0,
      averageSentenceWords: 0,
      averageWordChars: 0,
    },
    sentiment: {
      positiveScore: 0,
      negativeScore: 0,
      compound: 0,
      tokenCount: 0,
      matchedTerms: 0,
      label: "neutral",
    },
    linguistic: {
      tokenCount: 0,
      sentenceCount: 0,
      lemmaCount: 0,
      entityCount: 0,
      entities: [],
      topics: [],
      register: "Neutral",
      disfluencyMarkers: 0,
      questionCount: 0,
      exclamationCount: 0,
    },
    topTerms: [],
    keywords: [],
    summary: [],
    speakers: [],
  };
}

function localSpeechCorpusExport(sessions: SavedSession[]) {
  return {
    sessions: sessions.map((session) => ({
      id: session.id,
      startedAt: session.startedAt,
      segments: session.segments.filter((segment) => segment.isFinal && segment.text.trim()),
      totalDurationSeconds: session.report.totalDurationSeconds,
      wordCount: session.report.wordCount,
      stutterCount: session.report.stutterCount,
      stuttersPerMinute: session.report.stuttersPerMinute,
    })),
  };
}

function analyzeLocalCorpus(sessions: SavedSession[]): SpeechCorpusAnalysis {
  const corpus = emptyCorpusAnalysis();
  const terms = new Map<string, { count: number; documents: Set<string> }>();
  const speakerTerms = new Map<string, Map<string, number>>();
  const speakerSummaries = new Map<
    string,
    { label: string; documents: number; words: number; duration: number; stutters: number }
  >();
  let documents = 0;
  let duration = 0;
  let stutters = 0;

  for (const session of sessions) {
    duration += session.report.totalDurationSeconds;
    stutters += session.report.stutterCount;
    for (const [index, segment] of session.segments.entries()) {
      if (!segment.isFinal || !segment.text.trim()) {
        continue;
      }
      documents += 1;
      const documentId = `${session.id}:${index}`;
      const speakerKey = segment.speakerId ?? segment.speakerLabel ?? "Unknown speaker";
      const speakerLabel = segment.speakerLabel ?? segment.speakerId ?? "Unknown speaker";
      const words = corpusTerms(segment.text);
      const segmentStutters =
        session.report.wordCount > 0
          ? Math.round((session.report.stutterCount * words.length) / session.report.wordCount)
          : 0;
      const speaker = speakerSummaries.get(speakerKey) ?? {
        label: speakerLabel,
        documents: 0,
        words: 0,
        duration: 0,
        stutters: 0,
      };
      speaker.documents += 1;
      speaker.words += words.length;
      speaker.duration += Math.max(0, segment.endSeconds - segment.startSeconds);
      speaker.stutters += segmentStutters;
      speakerSummaries.set(speakerKey, speaker);
      const perSpeaker = speakerTerms.get(speakerKey) ?? new Map<string, number>();
      speakerTerms.set(speakerKey, perSpeaker);
      for (const word of words) {
        const entry = terms.get(word) ?? { count: 0, documents: new Set<string>() };
        entry.count += 1;
        entry.documents.add(documentId);
        terms.set(word, entry);
        perSpeaker.set(word, (perSpeaker.get(word) ?? 0) + 1);
      }
    }
  }

  const totalTerms = [...terms.values()].reduce((sum, term) => sum + term.count, 0);
  corpus.stats = {
    sessions: sessions.length,
    documents,
    speakers: speakerSummaries.size,
    totalDurationSeconds: duration,
    totalTerms,
    uniqueTerms: terms.size,
    averageTermsPerDocument: documents ? totalTerms / documents : 0,
    wordCount: sessions.reduce((sum, session) => sum + session.report.wordCount, 0),
    stutterCount: stutters,
    stuttersPerMinute: stutters / Math.max(1 / 60, duration / 60),
    lexicalDiversity: totalTerms ? terms.size / totalTerms : 0,
  };
  corpus.text.words = totalTerms;
  corpus.text.uniqueTerms = terms.size;
  corpus.topTerms = termEntries(terms, documents);
  corpus.keywords = corpus.topTerms.slice(0, 10).map((term) => ({
    text: term.term,
    score: term.collectionFrequency,
    count: term.collectionCount,
  }));
  corpus.speakers = [...speakerSummaries.entries()]
    .map(([key, speaker]) => ({
      speakerId: key === "Unknown speaker" ? null : key,
      speakerLabel: speaker.label,
      documents: speaker.documents,
      wordCount: speaker.words,
      durationSeconds: speaker.duration,
      stutterCount: speaker.stutters,
      lexicalDiversity: speaker.words ? (speakerTerms.get(key)?.size ?? 0) / speaker.words : 0,
      topTerms: termEntries(speakerTerms.get(key) ?? new Map<string, number>(), speaker.documents),
      keywords: termEntries(speakerTerms.get(key) ?? new Map<string, number>(), speaker.documents)
        .slice(0, 8)
        .map((term) => ({
          text: term.term,
          score: term.collectionFrequency,
          count: term.collectionCount,
        })),
    }))
    .sort((left, right) => right.wordCount - left.wordCount);
  return corpus;
}

function corpusTerms(text: string) {
  return (
    text
      .toLowerCase()
      .match(/[a-z0-9]+(?:'[a-z0-9]+)?/g)
      ?.filter((term) => term.length > 1) ?? []
  );
}

function termEntries(
  terms: Map<string, { count: number; documents: Set<string> } | number>,
  documentCount: number,
) {
  const total = [...terms.values()].reduce<number>(
    (sum, value) => sum + (typeof value === "number" ? value : value.count),
    0,
  );
  return [...terms.entries()]
    .map(([term, value]) => {
      const count = typeof value === "number" ? value : value.count;
      return {
        term,
        collectionCount: count,
        documentCount: typeof value === "number" ? documentCount : value.documents.size,
        collectionFrequency: total ? count / total : 0,
      };
    })
    .sort((left, right) => right.collectionCount - left.collectionCount)
    .slice(0, 12);
}

function normalizedSpeechStats(report: AnalysisReport): SpeechStats {
  return report.speechStats ?? emptySpeechStats();
}

function normalizedBlockerStats(report: AnalysisReport): BlockerStats {
  return report.blockerStats ?? emptyBlockerStats();
}

function emptyChunkStats(): TranscriptionChunkStats {
  return {
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    lastMessage: "No chunks yet",
  };
}

function removeLocalSpeakerCopy(id: string) {
  const raw = localStorage.getItem(SPEAKERS_KEY);
  let stored: unknown;
  try {
    stored = JSON.parse(raw ?? "[]");
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    // Corrupt payloads contain no usable local profiles; do not block server deletion.
    stored = [];
  }
  if (Array.isArray(stored)) {
    const kept = stored.filter(
      (candidate: unknown) =>
        !(
          typeof candidate === "object" &&
          candidate !== null &&
          "id" in candidate &&
          candidate.id === id
        ),
    );
    if (kept.length !== stored.length) {
      localStorage.setItem(SPEAKERS_KEY, JSON.stringify(kept));
    }
  }
  // The pre-profile key belongs only to this profile. Absent copies need no write.
  if (id === "legacy-speaker" && localStorage.getItem(VOICE_KEY) !== null) {
    localStorage.removeItem(VOICE_KEY);
  }
}

/** `isStale` turns true after a removal, so the snapshot taken at start is not re-uploaded. */
async function loadPersistedSpeakerProfiles(
  isStale: () => boolean = () => false,
  migrate: (profiles: SpeakerProfile[]) => Promise<SpeakerProfile[]> = savePersistedSpeakerProfiles,
): Promise<SpeakerProfile[]> {
  const localSpeakers = loadSpeakerProfiles();
  if (isDesktopApp()) {
    try {
      const speakers = await invoke<SpeakerProfile[]>("load_speaker_profiles");
      if (speakers.length) {
        return normalizeSpeakerProfiles(speakers);
      }
      if (localSpeakers.length && !isStale()) {
        return migrate(localSpeakers);
      }
      return [];
    } catch {
      return localSpeakers;
    }
  }

  try {
    const speakers = await computeClient.listSpeakerProfiles();
    if (speakers.length) {
      return normalizeSpeakerProfiles(speakers);
    }
    if (localSpeakers.length && !isStale()) {
      return migrate(localSpeakers);
    }
    return [];
  } catch {
    return localSpeakers;
  }
}

async function savePersistedSpeakerProfiles(speakers: SpeakerProfile[]): Promise<SpeakerProfile[]> {
  const normalized = normalizeSpeakerProfiles(speakers);
  if (isDesktopApp()) {
    return invoke<SpeakerProfile[]>("save_speaker_profiles", { speakers: normalized });
  }
  if (computeClient.destination.kind !== "server") {
    // No permitted server: voiceprints stay in this browser.
    localStorage.setItem(SPEAKERS_KEY, JSON.stringify(normalized));
    return normalized;
  }
  try {
    return await computeClient.saveSpeakerProfiles(normalized);
  } catch {
    localStorage.setItem(SPEAKERS_KEY, JSON.stringify(normalized));
    return normalized;
  }
}

function loadSessions(): SavedSession[] {
  try {
    return loadSessionsFromStorage();
  } catch {
    return [];
  }
}

function loadSpeakerProfiles(): SpeakerProfile[] {
  try {
    const speakers = JSON.parse(localStorage.getItem(SPEAKERS_KEY) ?? "[]") as SpeakerProfile[];
    if (Array.isArray(speakers) && speakers.length > 0) {
      return normalizeSpeakerProfiles(speakers);
    }
    const legacy = JSON.parse(localStorage.getItem(VOICE_KEY) ?? "null") as Voiceprint | null;
    if (legacy?.embedding?.length) {
      return [
        {
          id: "legacy-speaker",
          label: "Enrolled speaker",
          embeddings: [legacy.embedding],
          sampleRate: legacy.sampleRate,
          sampleCount: legacy.sampleCount,
        },
      ];
    }
    return [];
  } catch {
    return [];
  }
}

function normalizeSpeakerProfiles(speakers: SpeakerProfile[]) {
  return speakers.filter(
    (speaker) =>
      typeof speaker.id === "string" &&
      speaker.id.trim().length > 0 &&
      typeof speaker.label === "string" &&
      speaker.label.trim().length > 0 &&
      Array.isArray(speaker.embeddings) &&
      speaker.embeddings.length > 0,
  );
}

function loadTranscriptionSettings(): TranscriptionSettings {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(TRANSCRIPTION_KEY) ?? "null",
    ) as Partial<TranscriptionSettings> | null;
    const fallback = defaultTranscriptionSettings();
    const engine =
      TRANSCRIPTION_ENGINES.find((item) => item.id === parsed?.engine) ??
      getTranscriptionEngine(fallback.engine);
    const model = engine.models.includes(parsed?.model ?? "")
      ? (parsed?.model ?? engine.models[0])
      : engine.models.includes(fallback.model)
        ? fallback.model
        : engine.models[0];
    return { engine: engine.id, model };
  } catch {
    return defaultTranscriptionSettings();
  }
}

function defaultTranscriptionSettings(): TranscriptionSettings {
  return isDesktopApp()
    ? { engine: "whisperCpp", model: "base.en" }
    : { engine: "browser", model: "default" };
}

export function staticModelStatuses(engine: TranscriptionEngineId): TranscriptionModelStatus[] {
  return getTranscriptionEngine(engine).models.map((model) => ({
    id: model,
    label: model,
    cached: engine === "browser",
    downloadable: false,
  }));
}

function isDesktopApp() {
  return isTauri() || "__TAURI_INTERNALS__" in window;
}

function getTranscriptionEngine(id: TranscriptionEngineId) {
  return TRANSCRIPTION_ENGINES.find((engine) => engine.id === id) ?? TRANSCRIPTION_ENGINES[0];
}

function elapsedSeconds() {
  const startedAt = startedAtRefGlobal();
  return startedAt ? (Date.now() - startedAt.getTime()) / 1000 : 0;
}

let startedAtAccessor: (() => Date | null) | null = null;
function startedAtRefGlobal() {
  return startedAtAccessor?.() ?? null;
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("native_worker_unavailable")) {
    return "Compute server has no native transcription worker configured.";
  }
  if (message.includes("server_busy")) {
    return "Compute server is busy; try again shortly.";
  }
  if (message.includes("unauthorized")) {
    return "Compute server rejected the API token.";
  }
  return message;
}

function recordingErrorMessage(error: unknown) {
  if (error instanceof BrowserRecorderError) {
    if (error.code === "denied") {
      return "Microphone permission was denied";
    }
    if (error.code === "unavailable") {
      return "Microphone recording is unavailable in this browser";
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Recording failed: ${message}`;
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
    __TAURI_INTERNALS__?: unknown;
  }
}
