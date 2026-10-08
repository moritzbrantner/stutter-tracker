import { App as TrackerApp } from "./app/TrackerApp";
import { AuditoryFeedbackLab } from "./components/AuditoryFeedbackLab";

export {
  withUnverifiedNote,
  desktopAnalyzer,
  fallbackAnalyze,
  fallbackPredictSpeakerIntent,
  offsetTranscriptSegments,
  resampleSamples,
  staticModelStatuses,
  summarizeTranscriptionChunks,
  formatTime,
} from "./app/TrackerApp";

export function App() {
  return (
    <>
      <TrackerApp />
      <AuditoryFeedbackLab />
    </>
  );
}
