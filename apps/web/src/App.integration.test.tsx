import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fallbackAnalyze } from "@stutter-tracker/shared";
import { App } from "./App";

type AnalyzeRun =
  import("@stutter-tracker/compute-client").ComputeClient["analyzeSpeechSessionRun"];
// Lets a test control analyzer responses; null passes through to the real client.
let analysisHook: AnalyzeRun | null = null;

vi.mock("@stutter-tracker/compute-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stutter-tracker/compute-client")>();
  return {
    ...actual,
    createComputeClient: (...args: Parameters<typeof actual.createComputeClient>) => {
      const client = actual.createComputeClient(...args);
      return {
        ...client,
        analyzeSpeechSessionRun: (request: Parameters<AnalyzeRun>[0]) =>
          analysisHook ? analysisHook(request) : client.analyzeSpeechSessionRun(request),
      };
    },
  };
});

const STORE_KEY = "stutter-tracker:sessions";
const TRANSCRIPTION_KEY = "stutter-tracker:transcription";
const originalMediaDevices = navigator.mediaDevices;
const originalAudioContext = window.AudioContext;
const originalWebkitAudioContext = window.webkitAudioContext;

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  analysisHook = null;
  localStorage.clear();
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: originalMediaDevices,
  });
  window.AudioContext = originalAudioContext;
  window.webkitAudioContext = originalWebkitAudioContext;
});

describe("App integration", () => {
  it("loads a saved session and deletes it from persistence and the active workspace", async () => {
    const savedSession = {
      id: "session-1",
      startedAt: "2026-05-19T10:00:00.000Z",
      segments: [
        {
          text: "I I want to start",
          startSeconds: 0,
          endSeconds: 3,
          confidence: 0.91,
          isFinal: true,
        },
      ],
      pauses: [{ startSeconds: 3.2, endSeconds: 4.1, afterText: "start" }],
      report: {
        totalDurationSeconds: 4.1,
        wordCount: 4,
        stutterCount: 2,
        stuttersPerMinute: 29.27,
        severity: "high",
        events: [
          {
            kind: "wordRepetition",
            startSeconds: 0,
            endSeconds: 1.2,
            text: "I I",
            detail: "Repeated word sequence",
            confidence: 0.78,
          },
          {
            kind: "block",
            startSeconds: 3.2,
            endSeconds: 4.1,
            text: "start",
            detail: "0.9s silent pause before speech",
            confidence: 0.62,
            source: "fused",
            acousticEvidence: {
              silenceSeconds: 0.9,
              onsetCount: 1,
            },
          },
        ],
        byKind: { wordRepetition: 1, block: 1 },
      },
    };
    localStorage.setItem(STORE_KEY, JSON.stringify([savedSession]));

    const { container } = renderApp();
    const sessionButton = container.querySelector<HTMLButtonElement>(".session-row");
    expect(sessionButton).not.toBeNull();
    expect(within(sessionButton!).getByText("Analysis origin not recorded")).toBeInTheDocument();

    await userEvent.click(sessionButton!);

    expect(await screen.findAllByText("I I want to start")).toHaveLength(2);
    // The stored report is shown as saved; it has no chunk breakdown and none is computed.
    expect(await screen.findByText("Repeated word sequence")).toBeInTheDocument();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: /Delete saved session from/ }));

    await waitFor(() => expect(container.querySelector(".session-row")).toBeNull());
    expect(JSON.parse(localStorage.getItem(STORE_KEY) ?? "null")).toEqual([]);
    await waitFor(() =>
      expect(screen.queryByText("Repeated word sequence")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Transcript will appear here.")).toBeInTheDocument();
  });

  it("saving an unchanged loaded session makes no copy", async () => {
    const legacy = {
      id: "session-1",
      startedAt: "2026-05-19T10:00:00.000Z",
      segments: [
        {
          text: "I I want to start",
          startSeconds: 0,
          endSeconds: 3,
          confidence: 0.91,
          isFinal: true,
        },
      ],
      pauses: [],
      report: {
        totalDurationSeconds: 3,
        wordCount: 5,
        stutterCount: 1,
        stuttersPerMinute: 20,
        severity: "high",
        events: [],
        byKind: {},
      },
    };
    localStorage.setItem(STORE_KEY, JSON.stringify([legacy]));
    const { container } = renderApp();

    await userEvent.click(container.querySelector<HTMLButtonElement>(".session-row")!);
    await screen.findAllByText("I I want to start");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    // Nothing changed, so nothing is written and no copy is made.
    expect(await screen.findByText("Session is already saved")).toBeInTheDocument();
    const stored = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as { id: string }[];
    expect(stored.map((session) => session.id)).toEqual(["session-1"]);
  });

  it("shows a loaded session's stored analysis even when a pending analysis resolves later", async () => {
    const stored = {
      id: "session-stored",
      startedAt: "2026-05-19T10:00:00.000Z",
      segments: [
        {
          text: "I I want to start",
          startSeconds: 0,
          endSeconds: 3,
          confidence: 0.9,
          isFinal: true,
        },
      ],
      pauses: [],
      report: {
        totalDurationSeconds: 3,
        wordCount: 5,
        stutterCount: 1,
        stuttersPerMinute: 20,
        severity: "high",
        events: [
          {
            kind: "prolongation",
            startSeconds: 0.5,
            endSeconds: 1.5,
            text: "want",
            detail: "Stored marker event",
            confidence: 0.7,
          },
        ],
        byKind: { prolongation: 1 },
      },
    };
    localStorage.setItem(STORE_KEY, JSON.stringify([stored]));
    const requests: Parameters<AnalyzeRun>[0][] = [];
    let resolvePending!: (value: Awaited<ReturnType<AnalyzeRun>>) => void;
    analysisHook = (request) => {
      requests.push(request);
      return new Promise((resolve) => {
        resolvePending = resolve;
      });
    };
    const { container } = renderApp();
    // The initial workspace analysis is in flight when the saved session is loaded.
    await waitFor(() => expect(requests).toHaveLength(1));

    await userEvent.click(container.querySelector<HTMLButtonElement>(".session-row")!);
    expect(await screen.findByText("Stored marker event")).toBeInTheDocument();

    const lateReport = fallbackAnalyze({ segments: [], pauses: [] });
    await act(async () =>
      resolvePending({
        report: {
          ...lateReport,
          events: [
            { ...stored.report.events[0], kind: "prolongation", detail: "Late live result" },
          ],
        },
        analyzer: { producer: "onDevice", algorithm: "test", version: null },
      }),
    );

    expect(screen.getByText("Stored marker event")).toBeInTheDocument();
    expect(screen.queryByText("Late live result")).not.toBeInTheDocument();
    // Loading a saved session runs no analysis of its own.
    expect(requests).toHaveLength(1);
  });

  it("keeps a session when deletion is cancelled or its storage write fails", async () => {
    const stored = {
      id: "session-keep",
      startedAt: "2026-05-19T10:00:00.000Z",
      segments: [],
      pauses: [],
      report: {
        totalDurationSeconds: 1,
        wordCount: 0,
        stutterCount: 0,
        stuttersPerMinute: 0,
        severity: "none",
        events: [],
        byKind: {},
      },
    };
    localStorage.setItem(STORE_KEY, JSON.stringify([stored]));
    const { container } = renderApp();
    const deleteButton = () => screen.getByRole("button", { name: /Delete saved session from/ });

    vi.spyOn(window, "confirm").mockReturnValue(false);
    await userEvent.click(deleteButton());
    expect(container.querySelectorAll(".session-row")).toHaveLength(1);

    vi.spyOn(window, "confirm").mockReturnValue(true);
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === STORE_KEY) {
        throw new DOMException("full", "QuotaExceededError");
      }
      return setItem.call(this, key, value);
    });
    await userEvent.click(deleteButton());

    expect(await screen.findByText(/Delete failed/)).toBeInTheDocument();
    expect(container.querySelectorAll(".session-row")).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]")).toHaveLength(1);
  });

  it("reanalyzes a saved session on request and keeps the earlier run", async () => {
    const legacy = {
      id: "session-re",
      startedAt: "2026-05-19T10:00:00.000Z",
      segments: [
        {
          text: "I I want to start",
          startSeconds: 0,
          endSeconds: 3,
          confidence: 0.9,
          isFinal: true,
        },
      ],
      pauses: [],
      report: {
        totalDurationSeconds: 3,
        wordCount: 5,
        stutterCount: 0,
        stuttersPerMinute: 0,
        severity: "none",
        events: [],
        byKind: {},
      },
    };
    localStorage.setItem(STORE_KEY, JSON.stringify([legacy]));
    renderApp();

    expect(
      await screen.findByText(/1 corpus session has an analysis that is not verified/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Reanalyze saved session from/ }));

    expect(await screen.findByText("Reanalysis added to the session")).toBeInTheDocument();
    const [stored] = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as {
      analysis: { id: string; analyzer: { producer: string } | null };
      priorAnalyses: { id: string }[];
    }[];
    expect(stored.priorAnalyses.map((run) => run.id)).toEqual(["session-re:legacy"]);
    expect(stored.analysis.analyzer?.producer).toBe("onDevice");
    expect(screen.getByText(/2 analysis runs/)).toBeInTheDocument();
    expect(screen.queryByText(/has an analysis that is not verified/)).not.toBeInTheDocument();
  });

  it("does not offer reanalysis for a session with no saved transcript", async () => {
    const acousticOnly = {
      id: "session-acoustic",
      startedAt: "2026-05-19T10:00:00.000Z",
      segments: [],
      pauses: [],
      report: {
        totalDurationSeconds: 3,
        wordCount: 0,
        stutterCount: 1,
        stuttersPerMinute: 20,
        severity: "high",
        events: [
          {
            kind: "block",
            startSeconds: 1,
            endSeconds: 2,
            text: "",
            detail: "Acoustic block",
            confidence: 0.6,
            source: "acoustic",
          },
        ],
        byKind: { block: 1 },
      },
    };
    localStorage.setItem(STORE_KEY, JSON.stringify([acousticOnly]));
    renderApp();

    expect(
      await screen.findByRole("button", { name: /Reanalyze saved session from/ }),
    ).toBeDisabled();
  });

  it("previews and exports only the sessions and content the user chooses", async () => {
    const make = (id: string, startedAt: string, text: string) => ({
      id,
      startedAt,
      segments: [{ text, startSeconds: 0, endSeconds: 2, confidence: 0.9, isFinal: true }],
      pauses: [],
      report: {
        totalDurationSeconds: 60,
        wordCount: 4,
        stutterCount: 1,
        stuttersPerMinute: 1,
        severity: "mild",
        events: [],
        byKind: {},
      },
    });
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify([
        make("chosen", "2026-05-19T10:00:00.000Z", "Shared sentence here"),
        make("other", "2026-05-20T10:00:00.000Z", "Private sentence elsewhere"),
      ]),
    );
    renderApp();

    await userEvent.click(screen.getByRole("button", { name: "Choose sessions" }));
    const panel = screen.getByRole("region", { name: "Export for review" });
    expect(within(panel).getByRole("button", { name: /Download report/ })).toBeDisabled();
    const checkboxes = within(panel).getAllByRole("checkbox");
    await userEvent.click(checkboxes[0]);
    await userEvent.click(within(panel).getByRole("checkbox", { name: "Transcripts" }));

    const preview = within(panel).getByLabelText("Export preview");
    expect(preview).toHaveTextContent("Sessions: 1");
    expect(preview).toHaveTextContent("Shared sentence here");
    expect(preview).not.toHaveTextContent("Private sentence elsewhere");
    expect(preview).toHaveTextContent("Automated estimate (model, not a judgment)");
    await userEvent.click(within(panel).getByRole("checkbox", { name: /I consent to sharing/ }));
    expect(within(panel).getByRole("button", { name: /Download report/ })).toBeEnabled();

    await userEvent.click(within(panel).getByRole("button", { name: "Data (JSON)" }));
    expect(preview).toHaveTextContent('"schema": "vox-evidence-export"');
    expect(preview).not.toHaveTextContent("Private sentence elsewhere");
  });

  it("keeps external-server transcription settings in web mode", async () => {
    localStorage.setItem(
      TRANSCRIPTION_KEY,
      JSON.stringify({ engine: "whisperCpp", model: "small.en" }),
    );

    renderApp();

    const engineSelect = screen.getByLabelText<HTMLSelectElement>("Transcription engine");
    const modelSelect = screen.getByLabelText<HTMLSelectElement>("Transcription model");

    await waitFor(() => expect(engineSelect.value).toBe("whisperCpp"));
    expect(modelSelect.value).toBe("small.en");
    expect(JSON.parse(localStorage.getItem(TRANSCRIPTION_KEY) ?? "{}")).toEqual({
      engine: "whisperCpp",
      model: "small.en",
    });
  });

  it("renders the empty dashboard without microphone permissions", () => {
    renderApp();

    expect(screen.getByRole("button", { name: /record/i })).toBeEnabled();
    expect(screen.getByText("Transcript will appear here.")).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Processing status")).getByText("Recording"),
    ).toBeInTheDocument();
  });

  it("shows denied microphone permission and leaves Record enabled", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")),
      },
    });
    renderApp();

    const recordButton = screen.getByRole("button", { name: /record/i });
    await userEvent.click(recordButton);

    expect(await screen.findByText("Microphone permission was denied")).toBeInTheDocument();
    expect(recordButton).toBeEnabled();
  });

  it("shows unavailable recording when AudioContext is missing", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: vi.fn() }],
        }),
      },
    });
    window.AudioContext = undefined as unknown as typeof AudioContext;
    window.webkitAudioContext = undefined;
    renderApp();

    await userEvent.click(screen.getByRole("button", { name: /record/i }));

    expect(
      await screen.findByText("Microphone recording is unavailable in this browser"),
    ).toBeInTheDocument();
  });
});

it("reuses the data preview across parent recording renders", async () => {
  const { EvidenceExportPanel } = await import("./components/EvidenceExportPanel");
  const { createSessionRecord } = await import("@stutter-tracker/shared");
  const segments = Array.from({ length: 1000 }, (_, index) => ({
    text: `Transcript ${index} ${"words ".repeat(100)}`,
    startSeconds: index,
    endSeconds: index + 1,
    isFinal: true,
  }));
  const sessions = [
    createSessionRecord({
      id: "preview-test",
      startedAt: "2026-10-01T09:00:00.000Z",
      segments,
      pauses: [],
      report: fallbackAnalyze({ segments, pauses: [] }),
      run: { id: "run", createdAt: null, analyzer: null, usedAudio: null, audioId: null },
    }),
  ];
  const user = userEvent.setup();
  const view = render(<EvidenceExportPanel sessions={sessions} />);
  await user.click(screen.getByRole("button", { name: "Choose sessions" }));
  await user.click(screen.getAllByRole("checkbox")[0]!);
  await user.click(screen.getByRole("checkbox", { name: "Transcripts" }));
  await user.click(screen.getByRole("button", { name: "Data (JSON)" }));
  const previewText = screen.getByLabelText("Export preview").textContent;
  expect(previewText).toContain("Transcript 999");
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    for (let frame = 0; frame < 10; frame++) {
      view.rerender(<EvidenceExportPanel sessions={sessions} />);
    }
    const exports = stringify.mock.calls.filter(
      ([value]) =>
        typeof value === "object" &&
        value !== null &&
        "schema" in value &&
        value.schema === "vox-evidence-export",
    );
    expect(exports).toHaveLength(0);
    expect(screen.getByLabelText("Export preview").textContent).toBe(previewText);
  } finally {
    stringify.mockRestore();
  }
});

it("requires saved clinician-sharing consent and rechecks withdrawal before download", async () => {
  const { EvidenceExportPanel } = await import("./components/EvidenceExportPanel");
  const { CONSENT_LEDGER_KEY, recordConsentDecision } = await import("./storage/localStorage");
  const { createSessionRecord } = await import("@stutter-tracker/shared");
  localStorage.removeItem(CONSENT_LEDGER_KEY);
  const segments = [{ text: "evidence", startSeconds: 0, endSeconds: 1, isFinal: true }];
  const saved = createSessionRecord({
    id: "consent-test",
    startedAt: "2026-10-01T09:00:00Z",
    segments,
    pauses: [],
    report: fallbackAnalyze({ segments, pauses: [] }),
    run: { id: "run", createdAt: null, analyzer: null, usedAudio: null, audioId: null },
  });
  const view = render(
    <EvidenceExportPanel sessions={[saved, { ...saved, id: "same-time-session" }]} />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Choose sessions" }));
  await user.click(screen.getAllByRole("checkbox")[0]!);
  expect(screen.getByRole("checkbox", { name: /Session 1/ })).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: /Session 2/ })).toBeInTheDocument();
  const button = screen.getByRole("button", { name: "Download report" });
  expect(button).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /I consent to sharing/ }));
  expect(JSON.parse(localStorage.getItem(CONSENT_LEDGER_KEY)!)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ purpose: "clinicianSharing", granted: true }),
    ]),
  );
  expect(button).toBeEnabled();
  recordConsentDecision({ purpose: "clinicianSharing", granted: false });
  await user.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent("could not be confirmed");
  expect(button).toBeDisabled();
  const consent = screen.getByRole("checkbox", { name: /I consent to sharing/ });
  await user.click(consent);
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Quota full");
  });
  await user.click(consent);
  expect(localStorage.getItem(CONSENT_LEDGER_KEY)).toBeNull();
  write.mockRestore();
  view.unmount();
  render(<EvidenceExportPanel sessions={[saved]} />);
  await user.click(screen.getByRole("button", { name: "Choose sessions" }));
  await user.click(screen.getByRole("checkbox", { name: /Session 1/ }));
  expect(screen.getByRole("button", { name: "Download report" })).toBeDisabled();
});
