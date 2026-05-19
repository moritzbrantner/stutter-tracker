import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  Activity,
  BarChart3,
  CheckCircle2,
  Clock,
  Cpu,
  Download,
  HardDriveDownload,
  ListChecks,
  LoaderCircle,
  Mic,
  MicOff,
  PlayCircle,
  Save,
  ShieldCheck,
  Sparkles,
  UserCheck,
  Waves,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type TranscriptSegment = {
  text: string;
  startSeconds: number;
  endSeconds: number;
  confidence?: number;
  speakerScore?: number;
  isFinal: boolean;
};

type PauseSpan = {
  startSeconds: number;
  endSeconds: number;
  afterText?: string;
};

type StutterKind = "wordRepetition" | "soundRepetition" | "prolongation" | "block" | "filler";

type StutterEvent = {
  kind: StutterKind;
  startSeconds: number;
  endSeconds: number;
  text: string;
  detail: string;
  confidence: number;
};

type AnalysisReport = {
  sessionStartedAt?: string;
  totalDurationSeconds: number;
  wordCount: number;
  stutterCount: number;
  stuttersPerMinute: number;
  severity: "none" | "mild" | "moderate" | "high";
  events: StutterEvent[];
  byKind: Partial<Record<StutterKind, number>>;
};

type Voiceprint = {
  embedding: number[];
  sampleRate: number;
  sampleCount: number;
};

type TranscriptionEngineId = "browser" | "whisperCpp" | "whisperCli" | "fasterWhisper";

type TranscriptionSettings = {
  engine: TranscriptionEngineId;
  model: string;
};

type TranscriptionEngine = {
  id: TranscriptionEngineId;
  label: string;
  mode: string;
  nativeOnly: boolean;
  models: string[];
};

type TranscriptionModelStatus = {
  id: string;
  label: string;
  cached: boolean;
  downloadable: boolean;
};

type TranscriptionProgressEvent = {
  phase: string;
  message: string;
  model?: string;
  progress?: number;
};

type SavedSession = {
  id: string;
  startedAt: string;
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
  report: AnalysisReport;
};

const STORE_KEY = "stutter-tracker:sessions";
const VOICE_KEY = "stutter-tracker:voiceprint";
const TRANSCRIPTION_KEY = "stutter-tracker:transcription";
const LANGUAGES = ["en-US", "de-DE", "en-GB"];
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
    mode: "On stop",
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
    mode: "On stop",
    nativeOnly: true,
    models: ["tiny", "base", "small", "medium", "large", "turbo"],
  },
  {
    id: "fasterWhisper",
    label: "Faster-Whisper",
    mode: "On stop",
    nativeOnly: true,
    models: ["tiny", "base", "small", "medium", "large-v3", "distil-large-v3"],
  },
];

export function App() {
  const queryClient = useQueryClient();
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [pauses, setPauses] = useState<PauseSpan[]>([]);
  const [report, setReport] = useState<AnalysisReport>(() => emptyReport());
  const [sessions, setSessions] = useState<SavedSession[]>(() => loadSessions());
  const [voiceprint, setVoiceprint] = useState<Voiceprint | null>(() => loadVoiceprint());
  const [transcription, setTranscription] = useState<TranscriptionSettings>(() =>
    loadTranscriptionSettings(),
  );
  const [downloadProgress, setDownloadProgress] = useState<TranscriptionProgressEvent | null>(null);
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isNative, setIsNative] = useState(() => isDesktopApp());
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isEnrolling, setIsEnrolling] = useState(false);
  const [isMatchingVoice, setIsMatchingVoice] = useState(false);
  const [language, setLanguage] = useState(LANGUAGES[0]);
  const [interimText, setInterimText] = useState("");
  const [level, setLevel] = useState(0);
  const [speakerScore, setSpeakerScore] = useState<number | null>(null);
  const [message, setMessage] = useState("Idle");

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recorderRef = useRef<ScriptProcessorNode | null>(null);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef<Date | null>(null);
  const lastFinalEndRef = useRef(0);
  const lastVoiceAtRef = useRef(0);
  const sampleRateRef = useRef(48_000);
  const samplesRef = useRef<number[]>([]);
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const pausesRef = useRef<PauseSpan[]>([]);

  const analysisRequest = useMemo(
    () => ({
      segments,
      pauses,
      sessionStartedAt: startedAtRef.current?.toISOString(),
    }),
    [segments, pauses],
  );

  const analysisQuery = useQuery({
    queryKey: ["analysis", analysisRequest],
    queryFn: () => analyzeWithFallback(analysisRequest),
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

  const downloadModelMutation = useMutation({
    mutationFn: ({ engine, model }: { engine: TranscriptionEngineId; model: string }) =>
      downloadTranscriptionModel(engine, model),
    onSuccess: async (_result, { engine, model }) => {
      await queryClient.invalidateQueries({ queryKey: ["transcription-models", engine] });
      updateTranscriptionModel(model);
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
    if (!isNative && getTranscriptionEngine(transcription.engine).nativeOnly) {
      const fallback = { engine: "browser" as const, model: "default" };
      setTranscription(fallback);
      localStorage.setItem(TRANSCRIPTION_KEY, JSON.stringify(fallback));
    }
  }, [isNative, transcription.engine]);

  useEffect(() => {
    segmentsRef.current = segments;
    pausesRef.current = pauses;
  }, [segments, pauses]);

  useEffect(() => {
    if (analysisQuery.data) {
      setReport(analysisQuery.data);
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

  const transcript = useMemo(() => segments.map((segment) => segment.text).join(" "), [segments]);
  const selectedEngine = getTranscriptionEngine(transcription.engine);
  const selectedModels = modelStatuses.length
    ? modelStatuses.map((model) => model.id)
    : selectedEngine.models;
  const selectedModelStatus = modelStatuses.find((model) => model.id === transcription.model);

  const todayStats = useMemo(() => {
    const now = new Date().toDateString();
    const todays = sessions.filter((session) => new Date(session.startedAt).toDateString() === now);
    const totalEvents = todays.reduce((sum, session) => sum + session.report.stutterCount, 0);
    const totalMinutes = todays.reduce(
      (sum, session) => sum + session.report.totalDurationSeconds / 60,
      0,
    );
    return { count: todays.length, totalEvents, totalMinutes };
  }, [sessions]);

  async function startRecording() {
    if (isRecording) {
      return;
    }
    setMessage("Requesting microphone");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
    });
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) {
      throw new Error("AudioContext is unavailable");
    }
    const audioContext = new AudioContextConstructor();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.55;
    source.connect(analyser);
    const recorder = audioContext.createScriptProcessor(4096, 1, 1);
    recorder.onaudioprocess = (event) => {
      const input = event.inputBuffer;
      const output = event.outputBuffer;
      for (let channel = 0; channel < output.numberOfChannels; channel += 1) {
        output.getChannelData(channel).fill(0);
      }
      const channelData = Array.from({ length: input.numberOfChannels }, (_, channel) =>
        input.getChannelData(channel),
      );
      const samples = samplesRef.current;
      for (let index = 0; index < input.length; index += 1) {
        let sample = 0;
        for (const channel of channelData) {
          sample += channel[index];
        }
        samples.push(sample / Math.max(1, channelData.length));
      }
      const maxSamples = sampleRateRef.current * 90;
      if (samples.length > maxSamples) {
        samples.splice(0, samples.length - maxSamples);
      }
    };
    source.connect(recorder);
    recorder.connect(audioContext.destination);

    mediaStreamRef.current = stream;
    sourceRef.current = source;
    audioContextRef.current = audioContext;
    analyserRef.current = analyser;
    recorderRef.current = recorder;
    sampleRateRef.current = audioContext.sampleRate;
    samplesRef.current = [];
    startedAtRef.current = new Date();
    lastFinalEndRef.current = 0;
    lastVoiceAtRef.current = 0;
    setSegments([]);
    setPauses([]);
    setInterimText("");
    setSpeakerScore(null);
    setIsRecording(true);
    setMessage(
      selectedEngine.id === "browser" ? "Recording" : `Recording for ${selectedEngine.label}`,
    );
    if (selectedEngine.id === "browser") {
      startSpeechRecognition();
    }
    startAudioLoop();
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
          const segment: TranscriptSegment = {
            text,
            startSeconds,
            endSeconds,
            confidence: result[0]?.confidence,
            speakerScore: speakerScore ?? undefined,
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
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  function startAudioLoop() {
    const analyser = analyserRef.current;
    if (!analyser) {
      return;
    }
    const frame = new Float32Array(analyser.fftSize);
    const loop = async () => {
      const activeAnalyser = analyserRef.current;
      if (!activeAnalyser) {
        return;
      }
      activeAnalyser.getFloatTimeDomainData(frame);
      let energy = 0;
      for (const sample of frame) {
        energy += sample * sample;
      }
      const rms = Math.sqrt(energy / frame.length);
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

      if (voiceprint && samplesRef.current.length > sampleRateRef.current * 1.5) {
        const recent = samplesRef.current.slice(-Math.floor(sampleRateRef.current * 2));
        setIsMatchingVoice(true);
        compareVoice(recent, sampleRateRef.current, voiceprint.embedding)
          .then((result) => setSpeakerScore(result.score))
          .catch(() => undefined)
          .finally(() => setIsMatchingVoice(false));
      }
    };
    timerRef.current = window.setInterval(loop, 160);
  }

  async function stopRecording() {
    if (!isRecording) {
      return;
    }
    const shouldTranscribeNative = selectedEngine.id !== "browser";
    const capturedSamples = samplesRef.current.slice();
    const capturedSampleRate = sampleRateRef.current;
    setIsRecording(false);
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (recorderRef.current) {
      recorderRef.current.onaudioprocess = null;
      recorderRef.current.disconnect();
      recorderRef.current = null;
    }
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    await audioContextRef.current?.close();
    audioContextRef.current = null;
    analyserRef.current = null;
    setLevel(0);
    if (!shouldTranscribeNative) {
      setMessage("Stopped");
      return;
    }
    if (capturedSamples.length < capturedSampleRate) {
      setMessage("Not enough audio to transcribe");
      return;
    }
    setIsTranscribing(true);
    setMessage(`Transcribing with ${selectedEngine.label}`);
    try {
      const result = await transcribeAudio(
        resampleSamples(capturedSamples, capturedSampleRate, 16_000),
        16_000,
        transcription,
        language,
      );
      setSegments(result.segments);
      setInterimText("");
      setMessage(`Transcribed with ${selectedEngine.label}`);
    } catch (error) {
      setMessage(`Transcription failed: ${errorMessage(error)}`);
    } finally {
      setIsTranscribing(false);
      fetchModelStatuses();
    }
  }

  async function saveVoiceprint() {
    if (samplesRef.current.length < sampleRateRef.current) {
      setMessage("Record a short sample first");
      return;
    }
    setIsEnrolling(true);
    setMessage("Calculating voiceprint");
    try {
      const result = await createVoice(
        samplesRef.current.slice(-sampleRateRef.current * 12),
        sampleRateRef.current,
      );
      setVoiceprint(result);
      localStorage.setItem(VOICE_KEY, JSON.stringify(result));
      setMessage("Voiceprint saved");
    } finally {
      setIsEnrolling(false);
    }
  }

  function saveSession() {
    if (!segments.length && !report.events.length) {
      setMessage("Nothing to save");
      return;
    }
    const session: SavedSession = {
      id: crypto.randomUUID(),
      startedAt: startedAtRef.current?.toISOString() ?? new Date().toISOString(),
      segments,
      pauses,
      report,
    };
    const next = [session, ...sessions].slice(0, 50);
    setSessions(next);
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
    setMessage("Session saved");
  }

  function exportJson() {
    const payload = JSON.stringify({ sessions, voiceprint }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "stutter-tracker-export.json";
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

  async function downloadModel(model: string) {
    setDownloadingModel(model);
    setDownloadProgress({
      phase: "downloading",
      message: `Downloading \`${model}\``,
      model,
      progress: 0,
    });
    setMessage(`Downloading ${model}`);
    try {
      await downloadModelMutation.mutateAsync({ engine: transcription.engine, model });
    } catch {
      // Error state is reported by the mutation handler.
    }
  }

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Stutter Tracker</p>
          <h1>Speech Log</h1>
        </div>
        <div className="topbar-actions">
          <select
            value={transcription.engine}
            onChange={(event) =>
              updateTranscriptionEngine(event.target.value as TranscriptionEngineId)
            }
            disabled={isRecording}
            aria-label="Transcription engine"
          >
            {TRANSCRIPTION_ENGINES.map((engine) => (
              <option key={engine.id} value={engine.id} disabled={engine.nativeOnly && !isNative}>
                {engine.label}
              </option>
            ))}
          </select>
          <select
            value={transcription.model}
            onChange={(event) => updateTranscriptionModel(event.target.value)}
            disabled={isRecording || selectedModels.length < 2}
            aria-label="Transcription model"
          >
            {selectedModels.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
            disabled={isRecording}
            aria-label="Recognition language"
          >
            {LANGUAGES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <button
            className={isRecording ? "danger" : "primary"}
            onClick={isRecording ? stopRecording : startRecording}
          >
            {isRecording ? <MicOff size={18} /> : <Mic size={18} />}
            {isRecording ? "Stop" : "Record"}
          </button>
        </div>
      </section>

      <section className="status-grid">
        <Metric icon={<Activity />} label="Events" value={report.stutterCount.toString()} />
        <Metric
          icon={<BarChart3 />}
          label="Rate"
          value={`${report.stuttersPerMinute.toFixed(1)}/min`}
        />
        <Metric icon={<Clock />} label="Words" value={report.wordCount.toString()} />
        <Metric icon={<Sparkles />} label="Severity" value={titleCase(report.severity)} />
      </section>

      <section className="workspace">
        <div className="recording-surface">
          <div className="panel-header">
            <div>
              <p className="eyebrow">{isNative ? "Native Rust" : "Web Fallback"}</p>
              <h2>{message}</h2>
            </div>
            <div className="voice-state">
              <UserCheck size={18} />
              {voiceprint ? `${formatPercent(speakerScore)} match` : "No voiceprint"}
            </div>
          </div>

          <div className="activity-strip" aria-label="Processing status">
            <StatusPill active={isRecording} icon={<Mic size={15} />} label="Recording" />
            <StatusPill
              active={isTranscribing}
              icon={<LoaderCircle size={15} />}
              label="Transcribing"
            />
            <StatusPill
              active={Boolean(downloadingModel)}
              icon={<HardDriveDownload size={15} />}
              label={downloadingModel ? `Downloading ${downloadingModel}` : "Downloading"}
              progress={downloadProgress?.progress}
            />
            <StatusPill active={isAnalyzing} icon={<LoaderCircle size={15} />} label="Analyzing" />
            <StatusPill active={isEnrolling} icon={<LoaderCircle size={15} />} label="Voiceprint" />
            <StatusPill
              active={isMatchingVoice}
              icon={<LoaderCircle size={15} />}
              label="Matching voice"
            />
          </div>

          <div className="meter" aria-label="Audio level">
            {Array.from({ length: 42 }).map((_, index) => (
              <span
                key={index}
                style={{
                  transform: `scaleY(${0.18 + Math.min(1, level * (1 + (index % 5) * 0.11))})`,
                  opacity: index / 42 < level ? 1 : 0.35,
                }}
              />
            ))}
          </div>

          <div className="transcript">
            <div className="transcript-text">
              {transcript || "Transcript will appear here."}
              {interimText && <span className="interim"> {interimText}</span>}
            </div>
          </div>

          <div className="controls-row">
            <button onClick={saveVoiceprint} disabled={!samplesRef.current.length}>
              <ShieldCheck size={17} />
              Enroll
            </button>
            <button onClick={saveSession}>
              <Save size={17} />
              Save
            </button>
            <button onClick={exportJson}>
              <Download size={17} />
              Export
            </button>
          </div>
        </div>

        <aside className="side-panel">
          <div className="panel-block">
            <h3>Today</h3>
            <div className="mini-stats">
              <span>{todayStats.count} sessions</span>
              <span>{todayStats.totalEvents} events</span>
              <span>{todayStats.totalMinutes.toFixed(1)} min</span>
            </div>
          </div>
          <div className="panel-block">
            <h3>Transcription</h3>
            <div className="engine-summary">
              <Cpu size={18} />
              <div>
                <strong>{selectedEngine.label}</strong>
                <span>
                  {selectedEngine.mode} · {transcription.model} ·{" "}
                  {modelStatusLabel(selectedModelStatus)}
                </span>
              </div>
            </div>
          </div>
          <div className="panel-block">
            <h3>Models</h3>
            <div className="model-list">
              {modelStatuses.map((model) => (
                <div
                  key={model.id}
                  className={`model-row ${model.id === transcription.model ? "selected" : ""}`}
                  onClick={() => {
                    if (!isRecording && !isTranscribing) {
                      updateTranscriptionModel(model.id);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (
                      (event.key === "Enter" || event.key === " ") &&
                      !isRecording &&
                      !isTranscribing
                    ) {
                      updateTranscriptionModel(model.id);
                    }
                  }}
                  role="button"
                  tabIndex={isRecording || isTranscribing ? -1 : 0}
                >
                  <span className={`model-dot ${model.cached ? "cached" : ""}`} />
                  <span>
                    <strong>{model.label}</strong>
                    <small>{modelStatusLabel(model)}</small>
                  </span>
                  {model.id === transcription.model && <CheckCircle2 size={17} />}
                  {model.downloadable && !model.cached && (
                    <button
                      className="icon-action"
                      onClick={(event) => {
                        event.stopPropagation();
                        downloadModel(model.id);
                      }}
                      disabled={Boolean(downloadingModel) || downloadModelMutation.isPending}
                      aria-label={`Download ${model.label}`}
                    >
                      {downloadingModel === model.id ? (
                        <LoaderCircle size={16} />
                      ) : (
                        <Download size={16} />
                      )}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="panel-block">
            <h3>Profile</h3>
            <p className="muted">
              Voice matching uses a local spectral embedding from your Rust audio package.
            </p>
          </div>
          <div className="panel-block">
            <h3>Scope</h3>
            <p className="muted">
              This tracks speech patterns for review. It is not a medical diagnosis.
            </p>
          </div>
        </aside>
      </section>

      <section className="lower-grid">
        <div className="events-panel">
          <div className="panel-header compact">
            <h2>Events</h2>
            <span>{report.events.length}</span>
          </div>
          <div className="event-list">
            {report.events.length === 0 ? (
              <div className="empty-state">
                <Waves size={24} />
                <span>No events in the current session.</span>
              </div>
            ) : (
              report.events.map((event, index) => (
                <div className="event-row" key={`${event.kind}-${event.startSeconds}-${index}`}>
                  <div className={`event-kind ${event.kind}`}>{kindLabel(event.kind)}</div>
                  <div>
                    <strong>{event.text}</strong>
                    <span>{event.detail}</span>
                  </div>
                  <time>{formatTime(event.startSeconds)}</time>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="speech-log-panel">
          <div className="panel-header compact">
            <h2>Speech Log</h2>
            <span>{segments.length}</span>
          </div>
          <div className="speech-log-list">
            {segments.length === 0 ? (
              <div className="empty-state">
                <ListChecks size={24} />
                <span>Spoken segments will be logged here.</span>
              </div>
            ) : (
              segments.map((segment, index) => (
                <div className="speech-log-row" key={`${segment.startSeconds}-${index}`}>
                  <time>{formatTime(segment.startSeconds)}</time>
                  <p>{segment.text}</p>
                  <span>{formatPercent(segment.confidence ?? null)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="sessions-panel">
          <div className="panel-header compact">
            <h2>Sessions</h2>
            <span>{sessions.length}</span>
          </div>
          <div className="session-list">
            {sessions.map((session) => (
              <button
                key={session.id}
                className="session-row"
                onClick={() => {
                  startedAtRef.current = new Date(session.startedAt);
                  setSegments(session.segments);
                  setPauses(session.pauses);
                  setReport(session.report);
                }}
              >
                <PlayCircle size={18} />
                <span>{new Date(session.startedAt).toLocaleString()}</span>
                <strong>{session.report.stutterCount}</strong>
              </button>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="metric">
      <div className="metric-icon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function StatusPill({
  active,
  icon,
  label,
  progress,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  progress?: number;
}) {
  return (
    <div className={`status-pill ${active ? "active" : ""}`}>
      {icon}
      <span>{label}</span>
      {active && progress != null && <strong>{Math.round(progress * 100)}%</strong>}
    </div>
  );
}

async function analyze(request: {
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
  sessionStartedAt?: string;
}): Promise<AnalysisReport> {
  if (!isDesktopApp()) {
    return fallbackAnalyze(request);
  }
  return invoke<AnalysisReport>("analyze_speech_session", { request });
}

async function analyzeWithFallback(request: {
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
  sessionStartedAt?: string;
}): Promise<AnalysisReport> {
  try {
    return await analyze(request);
  } catch {
    return fallbackAnalyze(request);
  }
}

async function createVoice(samples: number[], sampleRate: number): Promise<Voiceprint> {
  if (!isDesktopApp()) {
    return {
      embedding: fallbackEmbedding(samples),
      sampleRate,
      sampleCount: samples.length,
    };
  }
  return invoke<Voiceprint>("create_voiceprint", {
    request: { samples: decimate(samples), sampleRate },
  });
}

async function compareVoice(samples: number[], sampleRate: number, referenceEmbedding: number[]) {
  if (!isDesktopApp()) {
    const current = fallbackEmbedding(samples);
    return {
      score: cosine(current, referenceEmbedding),
      isMatch: false,
    };
  }
  return invoke<{ score: number; isMatch: boolean }>("compare_voiceprint", {
    request: {
      samples: decimate(samples),
      sampleRate,
      referenceEmbedding,
      threshold: 0.82,
    },
  });
}

async function loadTranscriptionModels(
  engine: TranscriptionEngineId,
): Promise<TranscriptionModelStatus[]> {
  if (!isDesktopApp()) {
    return staticModelStatuses(engine);
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
    throw new Error("native transcription requires the desktop app");
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
    throw new Error("model downloads require the desktop app");
  }
  return invoke<TranscriptionModelStatus>("download_transcription_model", {
    request: {
      provider: engine,
      model,
    },
  });
}

function fallbackAnalyze(request: {
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
  sessionStartedAt?: string;
}): AnalysisReport {
  const events: StutterEvent[] = [];
  let wordCount = 0;
  let duration = 0;
  for (const segment of request.segments.filter((item) => item.isFinal)) {
    const words = segment.text.split(/\s+/).filter(Boolean);
    wordCount += words.filter((word) => !isFiller(normalize(word))).length;
    duration = Math.max(duration, segment.endSeconds);
    const step = Math.max(
      0.1,
      (segment.endSeconds - segment.startSeconds) / Math.max(1, words.length),
    );
    for (let index = 0; index < words.length; index += 1) {
      const word = normalize(words[index]);
      const next = normalize(words[index + 1] ?? "");
      const start = segment.startSeconds + step * index;
      if (word && word === next && !isFiller(word)) {
        events.push(
          event(
            "wordRepetition",
            start,
            start + step * 2,
            `${words[index]} ${words[index + 1]}`,
            "Repeated word sequence",
            0.78,
          ),
        );
      }
      if (longestRun(word) >= 4) {
        events.push(
          event("prolongation", start, start + step, words[index], "Extended sound in word", 0.74),
        );
      }
      if (isFiller(word)) {
        events.push(
          event("filler", start, start + step, words[index], "Filler or restart marker", 0.58),
        );
      }
    }
  }
  for (const pause of request.pauses) {
    duration = Math.max(duration, pause.endSeconds);
    if (pause.endSeconds - pause.startSeconds >= 0.75) {
      events.push(
        event(
          "block",
          pause.startSeconds,
          pause.endSeconds,
          pause.afterText ?? "pause",
          `${(pause.endSeconds - pause.startSeconds).toFixed(1)}s silent pause before speech`,
          0.62,
        ),
      );
    }
  }
  events.sort((left, right) => left.startSeconds - right.startSeconds);
  const minutes = Math.max(duration / 60, 1 / 60);
  const rate = events.length / minutes;
  const density = wordCount ? events.length / wordCount : 0;
  return {
    sessionStartedAt: request.sessionStartedAt,
    totalDurationSeconds: duration,
    wordCount,
    stutterCount: events.length,
    stuttersPerMinute: rate,
    severity:
      events.length === 0
        ? "none"
        : rate >= 12 || density >= 0.18
          ? "high"
          : rate >= 6 || density >= 0.1
            ? "moderate"
            : "mild",
    events,
    byKind: events.reduce<Partial<Record<StutterKind, number>>>((acc, item) => {
      acc[item.kind] = (acc[item.kind] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

function event(
  kind: StutterKind,
  startSeconds: number,
  endSeconds: number,
  text: string,
  detail: string,
  confidence: number,
): StutterEvent {
  return { kind, startSeconds, endSeconds, text, detail, confidence };
}

function fallbackEmbedding(samples: number[]) {
  const bands = 20;
  const values = Array.from({ length: bands }, () => 0);
  const stride = Math.max(1, Math.floor(samples.length / bands));
  for (let index = 0; index < bands; index += 1) {
    const chunk = samples.slice(index * stride, (index + 1) * stride);
    values[index] = Math.sqrt(
      chunk.reduce((sum, sample) => sum + sample * sample, 0) / Math.max(1, chunk.length),
    );
  }
  const norm = Math.hypot(...values) || 1;
  return values.map((value) => value / norm);
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

function resampleSamples(samples: number[], sampleRate: number, targetSampleRate: number) {
  if (sampleRate === targetSampleRate) {
    return samples;
  }
  const resultLength = Math.max(1, Math.round((samples.length * targetSampleRate) / sampleRate));
  const result = new Array<number>(resultLength);
  const ratio = sampleRate / targetSampleRate;
  for (let index = 0; index < resultLength; index += 1) {
    const sourceIndex = index * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = sourceIndex - left;
    result[index] = samples[left] * (1 - fraction) + samples[right] * fraction;
  }
  return result;
}

function cosine(left: number[], right: number[]) {
  const size = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < size; index += 1) {
    sum += left[index] * right[index];
  }
  return sum;
}

function emptyReport(): AnalysisReport {
  return {
    totalDurationSeconds: 0,
    wordCount: 0,
    stutterCount: 0,
    stuttersPerMinute: 0,
    severity: "none",
    events: [],
    byKind: {},
  };
}

function loadSessions(): SavedSession[] {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function loadVoiceprint(): Voiceprint | null {
  try {
    return JSON.parse(localStorage.getItem(VOICE_KEY) ?? "null");
  } catch {
    return null;
  }
}

function loadTranscriptionSettings(): TranscriptionSettings {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(TRANSCRIPTION_KEY) ?? "null",
    ) as Partial<TranscriptionSettings> | null;
    const engine =
      TRANSCRIPTION_ENGINES.find((item) => item.id === parsed?.engine) ?? TRANSCRIPTION_ENGINES[0];
    const model = engine.models.includes(parsed?.model ?? "")
      ? (parsed?.model ?? engine.models[0])
      : engine.models[0];
    return { engine: engine.id, model };
  } catch {
    return { engine: "browser", model: "default" };
  }
}

function staticModelStatuses(engine: TranscriptionEngineId): TranscriptionModelStatus[] {
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

function normalize(value: string) {
  return value.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
}

function isFiller(value: string) {
  return ["um", "uh", "erm", "hm", "hmm", "like", "äh", "ähm", "eh"].includes(value);
}

function longestRun(value: string) {
  let previous = "";
  let current = 0;
  let longest = 0;
  for (const char of value) {
    current = char === previous ? current + 1 : 1;
    previous = char;
    longest = Math.max(longest, current);
  }
  return longest;
}

function kindLabel(kind: StutterKind) {
  return {
    wordRepetition: "Word",
    soundRepetition: "Sound",
    prolongation: "Long",
    block: "Block",
    filler: "Filler",
  }[kind];
}

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${mins}:${secs}`;
}

function titleCase(value: string) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function formatPercent(value: number | null) {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  return `${Math.round(value * 100)}%`;
}

function modelStatusLabel(model?: TranscriptionModelStatus) {
  if (!model) {
    return "Not checked";
  }
  if (model.cached) {
    return "Ready";
  }
  if (model.downloadable) {
    return "Not downloaded";
  }
  return "External CLI";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
    __TAURI_INTERNALS__?: unknown;
  }
}
