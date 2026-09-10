import { Headphones, Play, RotateCcw, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_AUDITORY_FEEDBACK_SETTINGS,
  type AuditoryFeedbackSession,
  type AuditoryFeedbackSettings,
  startAuditoryFeedbackSession,
} from "../audio/auditoryFeedback";

type RecordingUrls = {
  raw: string | null;
  processed: string | null;
};

type PitchSupport = "unknown" | "supported" | "unsupported";

const DELAY_PRESETS = [0, 25, 50, 75, 100, 150, 200];

export function AuditoryFeedbackLab() {
  const [settings, setSettings] = useState<AuditoryFeedbackSettings>(
    DEFAULT_AUDITORY_FEEDBACK_SETTINGS,
  );
  const [headphonesConfirmed, setHeadphonesConfirmed] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [pitchSupport, setPitchSupport] = useState<PitchSupport>("unknown");
  const [status, setStatus] = useState(
    "Connect headphones, choose a feedback setting, then start a short practice trial.",
  );
  const [recordingUrls, setRecordingUrls] = useState<RecordingUrls>({
    raw: null,
    processed: null,
  });
  const sessionRef = useRef<AuditoryFeedbackSession | null>(null);

  useEffect(() => {
    sessionRef.current?.update(settings);
  }, [settings]);

  useEffect(
    () => () => {
      const session = sessionRef.current;
      sessionRef.current = null;
      void session?.stop().catch(() => undefined);
      releaseRecordingUrls(recordingUrls);
    },
    [recordingUrls],
  );

  async function startFeedback() {
    if (!headphonesConfirmed || isActive || isStopping) {
      return;
    }
    setStatus("Requesting microphone access…");
    try {
      const session = await startAuditoryFeedbackSession(settings);
      sessionRef.current = session;
      setIsActive(true);
      setPitchSupport(session.capabilities.pitchShift ? "supported" : "unsupported");
      if (!session.capabilities.pitchShift && settings.pitchShiftSemitones !== 0) {
        setSettings((current) => ({ ...current, pitchShiftSemitones: 0 }));
      }
      setStatus(
        session.capabilities.localCapture
          ? "Feedback is live. The raw and processed comparison stays only in this browser tab."
          : "Feedback is live. This browser cannot make the local comparison recording.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to start live audio feedback");
    }
  }

  async function stopFeedback() {
    const session = sessionRef.current;
    if (!session || isStopping) {
      return;
    }
    sessionRef.current = null;
    setIsStopping(true);
    setStatus("Stopping feedback and preparing the local comparison…");
    try {
      const recording = await session.stop();
      const nextUrls = {
        raw: recording.raw ? URL.createObjectURL(recording.raw) : null,
        processed: recording.processed ? URL.createObjectURL(recording.processed) : null,
      };
      setRecordingUrls((current) => {
        releaseRecordingUrls(current);
        return nextUrls;
      });
      setStatus(
        nextUrls.raw && nextUrls.processed
          ? "Trial stopped. Compare the untouched microphone recording with the monitored feedback below."
          : "Trial stopped.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to finish the feedback trial");
    } finally {
      setIsActive(false);
      setIsStopping(false);
    }
  }

  function resetSettings() {
    setSettings(DEFAULT_AUDITORY_FEEDBACK_SETTINGS);
  }

  return (
    <section className="mx-auto max-w-[1420px] px-5 pb-8 text-[#17201b] max-sm:px-3">
      <div className="rounded-[24px] border border-[#dfe6e1] bg-white p-5 shadow-sm">
        <div className="mb-5 flex items-start justify-between gap-4 max-md:flex-col">
          <div className="max-w-3xl">
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-[#5c6c62]">
              Practice experiment
            </p>
            <h2 className="text-2xl font-semibold tracking-tight">Auditory Feedback Lab</h2>
            <p className="mt-2 text-sm leading-6 text-[#536158]">
              Hear your own microphone with a controlled delay, optional pitch shift, and adjustable
              dry/altered mix. People respond differently to altered auditory feedback, so use short
              trials to learn what feels easier rather than treating one setting as a target.
            </p>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full border border-[#ccd7d0] px-3 py-2 text-sm font-medium hover:bg-[#f4f7f5] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={resetSettings}
            disabled={isActive || isStopping}
          >
            <RotateCcw size={16} aria-hidden="true" />
            Reset
          </button>
        </div>

        <div className="mb-5 rounded-2xl border border-[#e1e7e3] bg-[#f7f9f7] p-4">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              className="mt-1 h-4 w-4 accent-[#276749]"
              type="checkbox"
              checked={headphonesConfirmed}
              disabled={isActive || isStopping}
              onChange={(event) => setHeadphonesConfirmed(event.target.checked)}
            />
            <span>
              <span className="flex items-center gap-2 font-medium">
                <Headphones size={17} aria-hidden="true" />I am using headphones
              </span>
              <span className="mt-1 block text-sm leading-5 text-[#657169]">
                The browser cannot reliably prove that audio is going only to headphones. This gate
                reduces the risk of loudspeaker feedback before microphone monitoring starts.
              </span>
            </span>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-x-8 gap-y-6 max-md:grid-cols-1">
          <Control
            label="Feedback delay"
            value={`${settings.delayMs} ms`}
            hint="The intentional delay added before the altered voice path. Wireless headphones may add their own latency."
          >
            <input
              className="w-full accent-[#276749]"
              aria-label="Feedback delay"
              type="range"
              min="0"
              max="200"
              step="5"
              value={settings.delayMs}
              onChange={(event) =>
                setSettings((current) => ({ ...current, delayMs: Number(event.target.value) }))
              }
            />
            <div className="mt-2 flex flex-wrap gap-2">
              {DELAY_PRESETS.map((delayMs) => (
                <button
                  key={delayMs}
                  type="button"
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                    settings.delayMs === delayMs
                      ? "border-[#276749] bg-[#eaf4ee] text-[#1f573e]"
                      : "border-[#d8e0da] text-[#59665e] hover:bg-[#f4f7f5]"
                  }`}
                  onClick={() => setSettings((current) => ({ ...current, delayMs }))}
                >
                  {delayMs} ms
                </button>
              ))}
            </div>
          </Control>

          <Control
            label="Pitch shift"
            value={`${settings.pitchShiftSemitones > 0 ? "+" : ""}${settings.pitchShiftSemitones} st`}
            hint={
              pitchSupport === "unsupported"
                ? "This browser cannot load the real-time pitch processor, so pitch shifting is disabled."
                : "Optional frequency-altered feedback. Pitch processing adds a small amount of processing latency."
            }
          >
            <input
              className="w-full accent-[#276749] disabled:opacity-40"
              aria-label="Pitch shift"
              type="range"
              min="-4"
              max="4"
              step="1"
              value={settings.pitchShiftSemitones}
              disabled={pitchSupport === "unsupported"}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  pitchShiftSemitones: Number(event.target.value),
                }))
              }
            />
          </Control>

          <Control
            label="Altered voice mix"
            value={`${Math.round(settings.wetMix * 100)}%`}
            hint="0% is immediate microphone sidetone; 100% is only the delayed/pitch-shifted path."
          >
            <input
              className="w-full accent-[#276749]"
              aria-label="Altered voice mix"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={settings.wetMix}
              onChange={(event) =>
                setSettings((current) => ({ ...current, wetMix: Number(event.target.value) }))
              }
            />
          </Control>

          <Control
            label="Monitor level"
            value={`${Math.round(settings.outputGain * 100)}%`}
            hint="The output is capped below full-scale and passes through a fast limiter. Start low and raise only if comfortable."
          >
            <input
              className="w-full accent-[#276749]"
              aria-label="Monitor level"
              type="range"
              min="0.15"
              max="0.8"
              step="0.05"
              value={settings.outputGain}
              onChange={(event) =>
                setSettings((current) => ({ ...current, outputGain: Number(event.target.value) }))
              }
            />
          </Control>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-[#e5ebe7] pt-5">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full bg-[#235d41] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#1b4c35] disabled:cursor-not-allowed disabled:opacity-45"
            onClick={startFeedback}
            disabled={!headphonesConfirmed || isActive || isStopping}
          >
            <Play size={16} fill="currentColor" aria-hidden="true" />
            Start feedback
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full border border-[#cbd6cf] px-4 py-2.5 text-sm font-semibold hover:bg-[#f4f7f5] disabled:cursor-not-allowed disabled:opacity-45"
            onClick={stopFeedback}
            disabled={!isActive || isStopping}
          >
            <Square size={15} fill="currentColor" aria-hidden="true" />
            {isStopping ? "Stopping…" : "Stop & compare"}
          </button>
          <p className="min-w-0 flex-1 text-sm text-[#5d6a62]" role="status" aria-live="polite">
            {status}
          </p>
        </div>

        {(recordingUrls.raw || recordingUrls.processed) && (
          <div className="mt-6 grid grid-cols-2 gap-4 border-t border-[#e5ebe7] pt-5 max-md:grid-cols-1">
            {recordingUrls.raw && (
              <ComparisonRecording
                title="Untouched microphone"
                description="What the microphone captured before the feedback processing graph."
                url={recordingUrls.raw}
              />
            )}
            {recordingUrls.processed && (
              <ComparisonRecording
                title="Monitored feedback"
                description="The dry/altered mix after delay, pitch processing, limiter, and monitor gain."
                url={recordingUrls.processed}
              />
            )}
          </div>
        )}

        <p className="mt-5 text-xs leading-5 text-[#6d786f]">
          This is a practice and measurement aid, not a diagnostic or treatment device. Stop the
          trial if the monitoring is uncomfortable, distracting, or makes speaking harder.
        </p>
      </div>
    </section>
  );
}

function Control({
  label,
  value,
  hint,
  children,
}: {
  label: string;
  value: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label className="text-sm font-semibold">{label}</label>
        <output className="text-sm tabular-nums text-[#4e5d54]">{value}</output>
      </div>
      {children}
      <p className="mt-2 text-xs leading-5 text-[#6a756d]">{hint}</p>
    </div>
  );
}

function ComparisonRecording({
  title,
  description,
  url,
}: {
  title: string;
  description: string;
  url: string;
}) {
  return (
    <div className="rounded-2xl border border-[#e0e7e2] bg-[#fafbfa] p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs leading-5 text-[#68736b]">{description}</p>
      <audio className="mt-3 w-full" controls preload="metadata" src={url} />
    </div>
  );
}

function releaseRecordingUrls(urls: RecordingUrls) {
  if (urls.raw) {
    URL.revokeObjectURL(urls.raw);
  }
  if (urls.processed) {
    URL.revokeObjectURL(urls.processed);
  }
}
