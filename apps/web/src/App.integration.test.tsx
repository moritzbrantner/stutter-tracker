import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { SavedSession, SpeechCorpusAnalysis } from "./types";

const STORE_KEY = "stutter-tracker:sessions";
const TRANSCRIPTION_KEY = "stutter-tracker:transcription";
const originalMediaDevices = navigator.mediaDevices;
const originalAudioContext = window.AudioContext;
const originalWebkitAudioContext = window.webkitAudioContext;
const invokeMock = vi.mocked(invoke);
const isTauriMock = vi.mocked(isTauri);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function testSession(id: string, startedAt: string, text: string): SavedSession {
  return {
    id,
    startedAt,
    segments: [
      {
        text,
        startSeconds: 0,
        endSeconds: 2,
        confidence: 0.9,
        isFinal: true,
      },
    ],
    pauses: [],
    report: {
      totalDurationSeconds: 2,
      wordCount: text.split(/\s+/).length,
      stutterCount: 0,
      stuttersPerMinute: 0,
      severity: "none",
      speechStats: {
        speakingDurationSeconds: 2,
        pauseDurationSeconds: 0,
        wordsPerMinute: 60,
        articulationRateWpm: 60,
        meanChunkWords: 2,
        meanChunkDurationSeconds: 2,
        eventDensityPer100Words: 0,
        fluencyPercentage: 100,
      },
      blockerStats: {
        blockCount: 0,
        totalBlockSeconds: 0,
        averageBlockSeconds: 0,
        longestBlockSeconds: 0,
        blocksPerMinute: 0,
        blockedTimePercentage: 0,
      },
      chunks: [],
      events: [],
      byKind: {},
    },
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

function mockDelayedDesktopDeletion() {
  const deletion = deferred<SpeechCorpusAnalysis>();
  isTauriMock.mockReturnValue(true);
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "delete_speech_corpus_session") {
      return deletion.promise;
    }
    throw new Error(`No test implementation for ${command}`);
  });
  return deletion;
}

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
  localStorage.clear();
  vi.restoreAllMocks();
  isTauriMock.mockReset();
  isTauriMock.mockReturnValue(false);
  invokeMock.mockReset();
  invokeMock.mockRejectedValue(new Error("Tauri invoke is unavailable in tests"));
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

    await userEvent.click(sessionButton!);

    expect(await screen.findAllByText("I I want to start")).toHaveLength(2);
    expect(await screen.findByText("Repeated word sequence")).toBeInTheDocument();
    expect((await screen.findAllByText("Text")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("0:00")).toHaveLength(2);

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: /Delete saved session from/ }));

    await waitFor(() => expect(container.querySelector(".session-row")).toBeNull());
    expect(JSON.parse(localStorage.getItem(STORE_KEY) ?? "null")).toEqual([]);
    await waitFor(() =>
      expect(screen.queryByText("Repeated word sequence")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Transcript will appear here.")).toBeInTheDocument();
  });

  it("serializes session writes and preserves a newer active workspace during desktop deletion", async () => {
    const first = testSession("session-1", "2026-05-19T10:00:00.000Z", "first session text");
    const second = testSession("session-2", "2026-05-20T10:00:00.000Z", "second session text");
    const deletion = mockDelayedDesktopDeletion();
    localStorage.setItem(STORE_KEY, JSON.stringify([first, second]));

    const { container } = renderApp();
    const sessionButtons = () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>(".session-row"));
    await userEvent.click(sessionButtons()[0]);

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await userEvent.click(screen.getAllByRole("button", { name: /Delete saved session from/ })[0]);

    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
    for (const deleteButton of screen.getAllByRole("button", {
      name: /Delete saved session from/,
    })) {
      expect(deleteButton).toBeDisabled();
    }

    await userEvent.click(sessionButtons()[1]);
    expect(await screen.findAllByText("second session text")).toHaveLength(2);

    deletion.resolve(emptyCorpusAnalysis());

    await waitFor(() => expect(sessionButtons()).toHaveLength(1));
    expect(JSON.parse(localStorage.getItem(STORE_KEY) ?? "null")).toEqual([second]);
    expect(screen.getAllByText("second session text")).toHaveLength(2);
    expect(screen.queryByText("first session text")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("clears a session selected while its desktop deletion is pending", async () => {
    const first = testSession("session-1", "2026-05-19T10:00:00.000Z", "first session text");
    const second = testSession("session-2", "2026-05-20T10:00:00.000Z", "second session text");
    const deletion = mockDelayedDesktopDeletion();
    localStorage.setItem(STORE_KEY, JSON.stringify([first, second]));

    const { container } = renderApp();
    const sessionButtons = () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>(".session-row"));
    await userEvent.click(sessionButtons()[1]);

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await userEvent.click(screen.getAllByRole("button", { name: /Delete saved session from/ })[0]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());

    await userEvent.click(sessionButtons()[0]);
    expect(await screen.findAllByText("first session text")).toHaveLength(2);

    deletion.resolve(emptyCorpusAnalysis());

    await waitFor(() => expect(sessionButtons()).toHaveLength(1));
    expect(screen.getByText("Transcript will appear here.")).toBeInTheDocument();
    expect(screen.queryByText("first session text")).not.toBeInTheDocument();
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
