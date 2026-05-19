import type { ReactNode } from "react";
import { Activity, BarChart3, Clock, Sparkles, Waves } from "lucide-react";
import type { AnalysisReport, BlockerStats, SpeechStats } from "../types";
import { titleCase } from "../utils/formatting";
import { mutedTextClass, panelClass } from "./styles";

type StatusMetricsProps = {
  report: AnalysisReport;
  speechStats: SpeechStats;
  blockerStats: BlockerStats;
};

export function StatusMetrics({ report, speechStats, blockerStats }: StatusMetricsProps) {
  return (
    <section className="mb-4 grid grid-cols-5 gap-3 max-lg:grid-cols-2 max-sm:grid-cols-1">
      <Metric icon={<Activity />} label="Events" value={report.stutterCount.toString()} />
      <Metric
        icon={<BarChart3 />}
        label="Rate"
        value={`${report.stuttersPerMinute.toFixed(1)}/min`}
      />
      <Metric
        icon={<Clock />}
        label="Pace"
        value={`${speechStats.wordsPerMinute.toFixed(0)} wpm`}
      />
      <Metric icon={<Waves />} label="Blocks" value={blockerStats.blockCount.toString()} />
      <Metric icon={<Sparkles />} label="Severity" value={titleCase(report.severity)} />
    </section>
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
