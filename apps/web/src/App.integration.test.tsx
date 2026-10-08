import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fallbackAnalyze } from "@stutter-tracker/shared";
import { App } from "./App";
import * as recorderModule from "./audio/browserRecorder";

type AnalyzeRun =
  import("@stutter-tracker/compute-client").ComputeClient["analyzeSpeechSessionRun"];
// Lets a test control analyzer responses; null passes through to the real client.
let analysisHook: AnalyzeRun | null = null;
type DeleteSpeaker =
  import("@stutter-tracker/compute-client").ComputeClient["deleteSpeakerProfile"];
let deleteSpeakerHook: DeleteSpeaker | null = null;
type CreateSpeaker =
  import("@stutter-tracker/compute-client").ComputeClient["createSpeakerProfile"];
let createSpeakerHook: CreateSpeaker | null = null;
type ListSpeakers = import("@stutter-tracker/compute-client").ComputeClient["listSpeakerProfiles"];
let listSpeakersHook: ListSpeakers | null = null;
type IdentifySpeaker = import("@stutter-tracker/compute-client").ComputeClient["identifySpeaker"];
let identifySpeakerHook: IdentifySpeaker | null = null;

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
        identifySpeaker: (request: Parameters<IdentifySpeaker>[0]) =>
          identifySpeakerHook ? identifySpeakerHook(request) : client.identifySpeaker(request),
        listSpeakerProfiles: () =>
          listSpeakersHook ? listSpeakersHook() : client.listSpeakerProfiles(),
        createSpeakerProfile: (request: Parameters<CreateSpeaker>[0]) =>
          createSpeakerHook ? createSpeakerHook(request) : client.createSpeakerProfile(request),
        deleteSpeakerProfile: (id: string) =>
          deleteSpeakerHook ? deleteSpeakerHook(id) : client.deleteSpeakerProfile(id),
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
  deleteSpeakerHook = null;
  createSpeakerHook = null;
  listSpeakersHook = null;
  identifySpeakerHook = null;
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

  it("removes a voiceprint here and on the server, and says when only the local copy went", async () => {
    const speakerProfiles = [
      {
        id: "speaker-a",
        label: "Alex",
        embeddings: [[1, 0]],
        sampleRate: 16_000,
        sampleCount: 16_000,
      },
      {
        id: "speaker-b",
        label: "Blair",
        embeddings: [[0, 1]],
        sampleRate: 16_000,
        sampleCount: 16_000,
      },
    ];
    localStorage.setItem("stutter-tracker:speakers", JSON.stringify(speakerProfiles));
    const deleted: string[] = [];
    deleteSpeakerHook = async (id) => {
      deleted.push(id);
      return "deleted";
    };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderApp();

    await userEvent.click(await screen.findByRole("button", { name: "Remove speaker Alex" }));
    expect(
      await screen.findByText("Removed Alex here and from the compute server"),
    ).toBeInTheDocument();
    expect(deleted).toEqual(["speaker-a"]);
    expect(
      (
        JSON.parse(localStorage.getItem("stutter-tracker:speakers") ?? "[]") as { id: string }[]
      ).map((profile) => profile.id),
    ).toEqual(["speaker-b"]);

    deleteSpeakerHook = async () => {
      throw new Error("server unreachable");
    };
    await userEvent.click(screen.getByRole("button", { name: "Remove speaker Blair" }));
    expect(
      await screen.findByText(
        /Removed Blair on this device only; deleting it from the compute server failed/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove speaker/ })).not.toBeInTheDocument();
  });

  it("removes a legacy voiceprint for good and keeps a speaker whose local removal failed", async () => {
    localStorage.setItem(
      "stutter-tracker:voiceprint",
      JSON.stringify({ embedding: [1, 0], sampleRate: 16_000, sampleCount: 16_000 }),
    );
    deleteSpeakerHook = async () => "noServer";
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { unmount } = renderApp();

    await userEvent.click(
      await screen.findByRole("button", { name: "Remove speaker Enrolled speaker" }),
    );
    expect(await screen.findByText(/Removed Enrolled speaker/)).toBeInTheDocument();
    expect(localStorage.getItem("stutter-tracker:voiceprint")).toBeNull();
    unmount();

    localStorage.setItem(
      "stutter-tracker:speakers",
      JSON.stringify([
        {
          id: "speaker-a",
          label: "Alex",
          embeddings: [[1, 0]],
          sampleRate: 16_000,
          sampleCount: 16_000,
        },
      ]),
    );
    renderApp();
    const button = await screen.findByRole("button", { name: "Remove speaker Alex" });
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === "stutter-tracker:speakers") {
        throw new DOMException("blocked", "SecurityError");
      }
      return setItem.call(this, key, value);
    });
    await userEvent.click(button);

    expect(await screen.findByText(/Could not remove Alex from this browser/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove speaker Alex" })).toBeInTheDocument();
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

it("does not restore a removed voiceprint from a pending re-enrollment", async () => {
  const profile = {
    id: "speaker-a",
    label: "Alex",
    embeddings: [[1, 0]],
    sampleRate: 16000,
    sampleCount: 16000,
  };
  localStorage.setItem("stutter-tracker:speakers", JSON.stringify([profile]));
  let capture: recorderModule.BrowserRecorderOptions | undefined;
  vi.spyOn(recorderModule, "createBrowserRecorder").mockImplementation(async (options) => {
    capture = options;
    return { sampleRate: 16000, stop: async () => {} };
  });
  let finishEnrollment: ((value: typeof profile) => void) | undefined;
  createSpeakerHook = () =>
    new Promise((resolve) => {
      finishEnrollment = resolve;
    });
  let finishDeletion: (() => void) | undefined;
  deleteSpeakerHook = () =>
    new Promise((resolve) => {
      finishDeletion = () => resolve("deleted");
    });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const user = userEvent.setup();
  renderApp();
  await screen.findByRole("button", { name: "Remove speaker Alex" });
  await user.click(screen.getByRole("button", { name: /record/i }));
  act(() => {
    capture!.onSamples(new Float32Array(16000));
    capture!.onLevel(0.1);
  });
  await user.type(screen.getByRole("textbox", { name: "Speaker label" }), "Alex");
  await user.click(screen.getAllByRole("button", { name: "Enroll" }).at(-1)!);
  await waitFor(() => expect(finishEnrollment).toBeDefined());
  await user.click(screen.getByRole("button", { name: "Remove speaker Alex" }));
  await waitFor(() => expect(finishDeletion).toBeDefined());
  await act(async () => {
    finishEnrollment!(profile);
  });
  expect(screen.queryByRole("button", { name: "Remove speaker Alex" })).not.toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem("stutter-tracker:speakers") ?? "[]")).toEqual([]);
  await act(async () => {
    finishDeletion!();
  });
});

it.each(["malformed", "absent"])(
  "removes server-only profiles with %s local data",
  async (kind) => {
    if (kind === "malformed") {
      localStorage.setItem("stutter-tracker:speakers", "{broken");
    }
    listSpeakersHook = async () => [
      {
        id: "server-speaker",
        label: "Server Alex",
        embeddings: [[1, 0]],
        sampleRate: 16000,
        sampleCount: 16000,
      },
    ];
    const deleted: string[] = [];
    deleteSpeakerHook = async (id) => {
      deleted.push(id);
      return "deleted";
    };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderApp();
    const remove = await screen.findByRole("button", { name: "Remove speaker Server Alex" });
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === "stutter-tracker:speakers") {
        throw new DOMException("blocked", "SecurityError");
      }
      return originalSetItem.call(this, key, value);
    });
    await userEvent.click(remove);
    expect(
      await screen.findByText("Removed Server Alex here and from the compute server"),
    ).toBeInTheDocument();
    expect(deleted).toEqual(["server-speaker"]);
    expect(
      screen.queryByRole("button", { name: "Remove speaker Server Alex" }),
    ).not.toBeInTheDocument();
  },
);

it("clears a match accepted immediately before queued profile removal", async () => {
  localStorage.setItem(
    "stutter-tracker:speakers",
    JSON.stringify([
      {
        id: "speaker-a",
        label: "Alex",
        embeddings: [[1, 0]],
        sampleRate: 16000,
        sampleCount: 16000,
      },
      {
        id: "speaker-b",
        label: "Blair",
        embeddings: [[0, 1]],
        sampleRate: 16000,
        sampleCount: 16000,
      },
    ]),
  );
  let capture: recorderModule.BrowserRecorderOptions | undefined;
  vi.spyOn(recorderModule, "createBrowserRecorder").mockImplementation(async (options) => {
    capture = options;
    return { sampleRate: 16000, stop: async () => {} };
  });
  let finishMatch: ((value: Awaited<ReturnType<IdentifySpeaker>>) => void) | undefined;
  identifySpeakerHook = () =>
    new Promise((resolve) => {
      finishMatch = resolve;
    });
  deleteSpeakerHook = async () => "deleted";
  vi.spyOn(window, "confirm").mockReturnValue(true);
  renderApp();
  const remove = await screen.findByRole("button", { name: "Remove speaker Alex" });
  await userEvent.click(screen.getByRole("button", { name: /record/i }));
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
  act(() => {
    capture!.onSamples(new Float32Array(32000).fill(0.1));
    capture!.onLevel(0.1);
  });
  now.mockRestore();
  await waitFor(() => expect(finishMatch).toBeDefined());
  await act(async () => {
    const match = { speakerId: "speaker-a", label: "Alex", score: 1 };
    finishMatch!({ bestMatch: match, matches: [match], isMatch: true });
    // Accept the asynchronous match within the same React batch as the removal gesture.
    for (let microtask = 0; microtask < 5; microtask++) {
      await Promise.resolve();
    }
    fireEvent.click(remove);
  });
  expect(
    await screen.findByText("Removed Alex here and from the compute server"),
  ).toBeInTheDocument();
  expect(screen.queryByText(/Alex 100%/)).not.toBeInTheDocument();
});
