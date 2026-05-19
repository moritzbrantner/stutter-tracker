import { createComputeClient } from "@stutter-tracker/compute-client";
import type {
  AnalysisReport,
  TranscriptionEngineId,
  TranscriptionModelStatus,
} from "@stutter-tracker/shared";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { File } from "expo-file-system";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  mobileErrorMessage,
  recordingFileInfo,
  transcriptionToAnalysisRequest,
} from "./src/recording";

const providers: Array<Exclude<TranscriptionEngineId, "browser">> = [
  "whisperCpp",
  "whisperCli",
  "fasterWhisper",
];

export default function App() {
  const [serverUrl, setServerUrl] = useState("http://127.0.0.1:8787");
  const [apiToken, setApiToken] = useState("");
  const [provider, setProvider] = useState<Exclude<TranscriptionEngineId, "browser">>("whisperCpp");
  const [model, setModel] = useState("base.en");
  const [language, setLanguage] = useState("en-US");
  const [status, setStatus] = useState("Idle");
  const [isUploading, setIsUploading] = useState(false);
  const [permissionGranted, setPermissionGranted] = useState<boolean | null>(null);
  const [transcript, setTranscript] = useState("");
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [lastRecordingUri, setLastRecordingUri] = useState("");
  const [modelStatuses, setModelStatuses] = useState<TranscriptionModelStatus[]>([]);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(audioRecorder);
  const client = useMemo(() => createComputeClient({ serverUrl, apiToken }), [apiToken, serverUrl]);

  useEffect(() => {
    let cancelled = false;
    async function prepareAudio() {
      try {
        const permission = await AudioModule.requestRecordingPermissionsAsync();
        if (cancelled) {
          return;
        }
        setPermissionGranted(permission.granted);
        if (!permission.granted) {
          setStatus("Microphone permission was denied");
          return;
        }
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      } catch (error) {
        if (!cancelled) {
          setStatus(mobileErrorMessage(error));
        }
      }
    }
    void prepareAudio();
    return () => {
      cancelled = true;
    };
  }, []);

  async function checkHealth() {
    setStatus("Checking server");
    try {
      const response = await fetch(`${serverUrl.replace(/\/+$/, "")}/health`, {
        headers: apiToken ? { authorization: `Bearer ${apiToken}` } : undefined,
      });
      setStatus(response.ok ? "Server reachable" : `Server returned ${response.status}`);
    } catch (error) {
      setStatus(mobileErrorMessage(error));
    }
  }

  async function loadModelStatuses() {
    setStatus("Loading models");
    try {
      const statuses = await client.transcriptionModels(provider);
      setModelStatuses(statuses);
      setStatus("Model status loaded");
    } catch (error) {
      setStatus(mobileErrorMessage(error));
    }
  }

  async function downloadSelectedModel() {
    setStatus(`Downloading ${model}`);
    try {
      const status = await client.downloadTranscriptionModel(provider, model);
      setModelStatuses((current) => [status, ...current.filter((item) => item.id !== status.id)]);
      setStatus(`${model} ready`);
    } catch (error) {
      setStatus(mobileErrorMessage(error));
    }
  }

  async function startRecording() {
    if (!permissionGranted) {
      setStatus("Microphone permission was denied");
      return;
    }
    setReport(null);
    setTranscript("");
    setStatus("Recording");
    await audioRecorder.prepareToRecordAsync();
    audioRecorder.record();
  }

  async function stopRecording() {
    try {
      setStatus("Stopping recording");
      await audioRecorder.stop();
      const uri = audioRecorder.uri;
      if (!uri) {
        setStatus("Recording did not produce an audio file");
        return;
      }
      setLastRecordingUri(uri);
      await uploadRecording(uri);
    } catch (error) {
      setStatus(mobileErrorMessage(error));
    }
  }

  async function uploadRecording(uri: string) {
    setIsUploading(true);
    setStatus("Uploading and transcribing");
    try {
      const file = new File(uri);
      const { filename, mimeType } = recordingFileInfo(uri);
      const result = await client.transcribeAudioFile({
        file: file as unknown as Blob,
        filename,
        mimeType,
        provider,
        model,
        language,
      });
      setTranscript(result.segments.map((segment) => segment.text).join(" "));
      setStatus("Analyzing transcript");
      const nextReport = await client.analyzeSpeechSession(transcriptionToAnalysisRequest(result));
      setReport(nextReport);
      setStatus("Complete");
    } catch (error) {
      setStatus(mobileErrorMessage(error));
    } finally {
      setIsUploading(false);
    }
  }

  const selectedModelStatus = modelStatuses.find((item) => item.id === model);
  const busy = isUploading || recorderState.isRecording;

  return (
    <SafeAreaView style={styles.shell}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.eyebrow}>Stutter Tracker</Text>
          <Text style={styles.title}>Mobile Recorder</Text>
        </View>

        <Panel title="Compute server">
          <Field label="Server URL" value={serverUrl} onChangeText={setServerUrl} />
          <Field label="API token" value={apiToken} onChangeText={setApiToken} secureTextEntry />
          <TouchableOpacity style={styles.button} onPress={checkHealth} disabled={busy}>
            <Text style={styles.buttonText}>Health</Text>
          </TouchableOpacity>
        </Panel>

        <Panel title="Transcription">
          <Field
            label="Provider"
            value={provider}
            onChangeText={(value) => {
              if (providers.includes(value as Exclude<TranscriptionEngineId, "browser">)) {
                setProvider(value as Exclude<TranscriptionEngineId, "browser">);
              }
            }}
          />
          <Field label="Model" value={model} onChangeText={setModel} />
          <Field label="Language" value={language} onChangeText={setLanguage} />
          <View style={styles.actions}>
            <TouchableOpacity style={styles.button} onPress={loadModelStatuses} disabled={busy}>
              <Text style={styles.buttonText}>Models</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.button}
              onPress={downloadSelectedModel}
              disabled={busy || !selectedModelStatus?.downloadable || selectedModelStatus.cached}
            >
              <Text style={styles.buttonText}>Download</Text>
            </TouchableOpacity>
          </View>
        </Panel>

        <Panel title="Recording">
          <View style={styles.statusRow}>
            <Text style={styles.status}>{status}</Text>
            {isUploading && <ActivityIndicator />}
          </View>
          <TouchableOpacity
            style={recorderState.isRecording ? styles.stopButton : styles.primaryButton}
            onPress={recorderState.isRecording ? stopRecording : startRecording}
            disabled={isUploading || permissionGranted === false}
          >
            <Text style={styles.primaryButtonText}>
              {recorderState.isRecording ? "Stop" : "Record"}
            </Text>
          </TouchableOpacity>
          {!!lastRecordingUri && <Text style={styles.detail}>{lastRecordingUri}</Text>}
          <Text style={styles.transcript}>{transcript || "Transcript will appear here."}</Text>
        </Panel>

        <Panel title="Metrics">
          {report ? (
            <View style={styles.metrics}>
              <Metric label="Events" value={String(report.stutterCount)} />
              <Metric label="Rate" value={`${report.stuttersPerMinute.toFixed(1)}/min`} />
              <Metric label="Words" value={String(report.wordCount)} />
              <Metric label="Severity" value={report.severity} />
            </View>
          ) : (
            <Text style={styles.detail}>No analysis yet.</Text>
          )}
        </Panel>
      </ScrollView>
    </SafeAreaView>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Field({
  label,
  value,
  onChangeText,
  secureTextEntry,
}: {
  label: string;
  value: string;
  onChangeText(value: string): void;
  secureTextEntry?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secureTextEntry}
        style={styles.input}
      />
    </View>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: "#f6f7f4",
  },
  content: {
    gap: 14,
    padding: 18,
  },
  header: {
    gap: 4,
  },
  eyebrow: {
    color: "#5d6b64",
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  title: {
    color: "#15201a",
    fontSize: 34,
    fontWeight: "800",
  },
  panel: {
    backgroundColor: "#ffffff",
    borderColor: "#d9e1dc",
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
    padding: 14,
  },
  panelTitle: {
    color: "#15201a",
    fontSize: 17,
    fontWeight: "800",
  },
  field: {
    gap: 6,
  },
  label: {
    color: "#15201a",
    fontSize: 13,
    fontWeight: "700",
  },
  input: {
    borderColor: "#c9d4ce",
    borderRadius: 8,
    borderWidth: 1,
    color: "#15201a",
    minHeight: 44,
    paddingHorizontal: 12,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
  },
  button: {
    alignItems: "center",
    borderColor: "#c9d4ce",
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    justifyContent: "center",
    minHeight: 44,
  },
  buttonText: {
    color: "#15201a",
    fontWeight: "700",
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#196d5c",
    borderRadius: 8,
    justifyContent: "center",
    minHeight: 48,
  },
  stopButton: {
    alignItems: "center",
    backgroundColor: "#8b2f34",
    borderRadius: 8,
    justifyContent: "center",
    minHeight: 48,
  },
  primaryButtonText: {
    color: "#ffffff",
    fontWeight: "800",
  },
  statusRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  status: {
    color: "#15201a",
    flex: 1,
    fontSize: 16,
    fontWeight: "700",
  },
  detail: {
    color: "#66746c",
    fontSize: 13,
  },
  transcript: {
    color: "#15201a",
    fontSize: 16,
    lineHeight: 23,
  },
  metrics: {
    gap: 10,
  },
  metric: {
    borderColor: "#d9e1dc",
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
  },
  metricLabel: {
    color: "#66746c",
    fontSize: 13,
  },
  metricValue: {
    color: "#15201a",
    fontSize: 24,
    fontWeight: "800",
    textTransform: "capitalize",
  },
});
