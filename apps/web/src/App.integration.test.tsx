import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

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
  it("loads a saved session and restores it into the active workspace", async () => {
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
