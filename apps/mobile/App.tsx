import { createComputeClient } from "@stutter-tracker/compute-client";
import { type AnalysisReport, type AnalyzeSpeechRequest } from "@stutter-tracker/shared";
import { useMemo, useState } from "react";
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

const sampleRequest: AnalyzeSpeechRequest = {
  segments: [
    {
      text: "I I want to sssstart now",
      startSeconds: 0,
      endSeconds: 3,
      isFinal: true,
    },
  ],
  pauses: [{ startSeconds: 3.2, endSeconds: 4.1, afterText: "now" }],
};

export default function App() {
  const [serverUrl, setServerUrl] = useState("http://127.0.0.1:8787");
  const [apiToken, setApiToken] = useState("");
  const [status, setStatus] = useState("Idle");
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [busy, setBusy] = useState(false);
  const client = useMemo(() => createComputeClient({ serverUrl, apiToken }), [apiToken, serverUrl]);

  async function analyzeSample() {
    setBusy(true);
    setStatus("Calling compute server");
    try {
      const nextReport = await client.analyzeSpeechSession(sampleRequest);
      setReport(nextReport);
      setStatus("Server analysis complete");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function checkHealth() {
    setBusy(true);
    setStatus("Checking server");
    try {
      const response = await fetch(`${serverUrl.replace(/\/+$/, "")}/health`);
      setStatus(response.ok ? "Server reachable" : `Server returned ${response.status}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.shell}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.eyebrow}>Stutter Tracker</Text>
          <Text style={styles.title}>Mobile</Text>
        </View>

        <View style={styles.panel}>
          <Text style={styles.label}>Compute server</Text>
          <TextInput
            value={serverUrl}
            onChangeText={setServerUrl}
            autoCapitalize="none"
            autoCorrect={false}
            inputMode="url"
            style={styles.input}
          />
          <Text style={styles.label}>API token</Text>
          <TextInput
            value={apiToken}
            onChangeText={setApiToken}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={styles.input}
          />
          <View style={styles.actions}>
            <TouchableOpacity style={styles.button} onPress={checkHealth} disabled={busy}>
              <Text style={styles.buttonText}>Health</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.primaryButton} onPress={analyzeSample} disabled={busy}>
              <Text style={styles.primaryButtonText}>Analyze Sample</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.panel}>
          <View style={styles.statusRow}>
            <Text style={styles.status}>{status}</Text>
            {busy && <ActivityIndicator />}
          </View>
          {report && (
            <View style={styles.metrics}>
              <Metric label="Events" value={String(report.stutterCount)} />
              <Metric label="Rate" value={`${report.stuttersPerMinute.toFixed(1)}/min`} />
              <Metric label="Words" value={String(report.wordCount)} />
              <Metric label="Severity" value={report.severity} />
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
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
    backgroundColor: "#f5f7f5",
  },
  content: {
    gap: 16,
    padding: 20,
  },
  header: {
    gap: 4,
  },
  eyebrow: {
    color: "#647169",
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  title: {
    color: "#17201b",
    fontSize: 42,
    fontWeight: "800",
  },
  panel: {
    backgroundColor: "#ffffff",
    borderColor: "#dae2dd",
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
    padding: 16,
  },
  label: {
    color: "#17201b",
    fontSize: 14,
    fontWeight: "700",
  },
  input: {
    borderColor: "#cbd6cf",
    borderRadius: 8,
    borderWidth: 1,
    color: "#17201b",
    minHeight: 44,
    paddingHorizontal: 12,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
  },
  button: {
    alignItems: "center",
    borderColor: "#cbd6cf",
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    justifyContent: "center",
    minHeight: 44,
  },
  buttonText: {
    color: "#17201b",
    fontWeight: "700",
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#1c6b5a",
    borderRadius: 8,
    flex: 1,
    justifyContent: "center",
    minHeight: 44,
  },
  primaryButtonText: {
    color: "#ffffff",
    fontWeight: "700",
  },
  statusRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  status: {
    color: "#17201b",
    flex: 1,
    fontSize: 16,
    fontWeight: "700",
  },
  metrics: {
    gap: 10,
  },
  metric: {
    borderColor: "#dae2dd",
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
  },
  metricLabel: {
    color: "#647169",
    fontSize: 13,
  },
  metricValue: {
    color: "#17201b",
    fontSize: 24,
    fontWeight: "800",
    textTransform: "capitalize",
  },
});
