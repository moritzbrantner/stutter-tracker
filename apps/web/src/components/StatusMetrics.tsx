import type { ReactNode } from "react";
import { Activity, BarChart3, Clock, Sparkles, Waves } from "lucide-react";
import { isScoreWithheld } from "../audio/captureQuality";
import type { AnalysisReport, BlockerStats, SpeechStats } from "../types";
import { titleCase } from "../utils/formatting";
import { mutedTextClass, panelClass } from "./styles";

type StatusMetricsProps = {
  report: AnalysisReport;
  speechStats: SpeechStats;
  blockerStats: BlockerStats;
};

export function StatusMetrics({ report, speechStats, blockerStats }: StatusMetricsProps) {
  const quality = report.captureQuality;
  // A capture that failed the quality gate gets no score: neither fluent nor severe.
  const withheld = isScoreWithheld(report);
  const score = (value: string) => (withheld ? "Unknown" : value);
  return (
    <>
      <section className="mb-4 grid grid-cols-5 gap-3 max-lg:grid-cols-2 max-sm:grid-cols-1">
        <Metric icon={<Activity />} label="Events" value={score(report.stutterCount.toString())} />
        <Metric
          icon={<BarChart3 />}
          label="Rate"
          value={score(`${report.stuttersPerMinute.toFixed(1)}/min`)}
        />
        <Metric
          icon={<Clock />}
          label="Pace"
          value={`${speechStats.wordsPerMinute.toFixed(0)} wpm`}
        />
        <Metric icon={<Waves />} label="Blocks" value={score(blockerStats.blockCount.toString())} />
        <Metric icon={<Sparkles />} label="Severity" value={score(titleCase(report.severity))} />
      </section>
      {quality?.state === "unknown" ? (
        <p
          className="mt-0 mb-4 rounded-md border border-[#e3c9a8] bg-[#fbf3e8] p-3 text-sm text-[#7a4a12]"
          role="status"
          aria-label="Capture quality"
        >
          {quality.explanation}
        </p>
      ) : quality?.state === "unmeasured" ? (
        <p
          className={`${mutedTextClass} mt-0 mb-4 text-sm`}
          role="status"
          aria-label="Capture quality"
        >
          Capture quality was not checked on this processing path.
        </p>
      ) : null}
    </>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className={`${panelClass} flex min-h-[5.25rem] items-center gap-3 p-4`}>
      <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-[#e7f2ee] text-[#1c6b5a] [&_svg]:size-5">
        {icon}
      </div>
      <div>
        <span className={mutedTextClass}>{label}</span>
        <strong className="block text-2xl leading-tight">{value}</strong>
      </div>
    </div>
  );
}
