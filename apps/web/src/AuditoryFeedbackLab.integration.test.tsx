import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AuditoryFeedbackRecording,
  AuditoryFeedbackSession,
  AuditoryFeedbackSessionOptions,
} from "./audio/auditoryFeedback";
import { AuditoryFeedbackLab } from "./components/AuditoryFeedbackLab";

const startSession = vi.fn();

vi.mock("./audio/auditoryFeedback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./audio/auditoryFeedback")>()),
  startAuditoryFeedbackSession: (...args: unknown[]) => startSession(...args),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeSession(stopResult: Promise<AuditoryFeedbackRecording>) {
  return {
    capabilities: { pitchShift: true, localCapture: true },
    update: vi.fn(),
    stop: vi.fn(() => stopResult),
  } satisfies AuditoryFeedbackSession;
}

const emptyRecording = { raw: null, processed: null };

beforeEach(() => {
  startSession.mockReset();
});

afterEach(() => {
  cleanup();
});

function startButton() {
  return screen.getByRole("button", { name: /start feedback/i });
}

function confirmHeadphonesAndStart() {
  fireEvent.click(screen.getByRole("checkbox", { name: /headphones/i }));
  fireEvent.click(startButton());
}

describe("AuditoryFeedbackLab lifecycle", () => {
  it("starts only one session for repeated start clicks", async () => {
    const pending = deferred<AuditoryFeedbackSession>();
    startSession.mockReturnValue(pending.promise);
    render(<AuditoryFeedbackLab />);

    confirmHeadphonesAndStart();
    fireEvent.click(startButton());

    expect(startSession).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(fakeSession(Promise.resolve(emptyRecording))));
  });

  it("stops a session that finishes starting after the lab unmounts", async () => {
    const pending = deferred<AuditoryFeedbackSession>();
    startSession.mockReturnValue(pending.promise);
    const { unmount } = render(<AuditoryFeedbackLab />);
    confirmHeadphonesAndStart();
    const options = startSession.mock.calls[0][1] as AuditoryFeedbackSessionOptions;

    unmount();
    expect(options.signal?.aborted).toBe(true);
    const session = fakeSession(Promise.resolve(emptyRecording));
    await act(async () => pending.resolve(session));

    expect(session.stop).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending start from the stop button", async () => {
    const pending = deferred<AuditoryFeedbackSession>();
    startSession.mockReturnValue(pending.promise);
    render(<AuditoryFeedbackLab />);
    confirmHeadphonesAndStart();

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    const session = fakeSession(Promise.resolve(emptyRecording));
    await act(async () => pending.resolve(session));

    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(startButton()).toBeEnabled();
  });

  it("re-enables start as soon as a cancelled start settles", async () => {
    startSession.mockImplementation(
      (_settings: unknown, options: AuditoryFeedbackSessionOptions) =>
        new Promise((_, reject) => {
          options.signal?.addEventListener("abort", () =>
            reject(new DOMException("cancelled", "AbortError")),
          );
        }),
    );
    render(<AuditoryFeedbackLab />);
    confirmHeadphonesAndStart();

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(startButton()).toBeEnabled());
    expect(screen.getByText("Feedback start was cancelled.")).toBeInTheDocument();
  });

  it("calls session.stop once and stops the session on unmount while stopping", async () => {
    const finalizing = deferred<AuditoryFeedbackRecording>();
    const session = fakeSession(finalizing.promise);
    startSession.mockResolvedValue(session);
    const { unmount } = render(<AuditoryFeedbackLab />);
    confirmHeadphonesAndStart();
    const stop = await screen.findByRole("button", { name: /stop & compare/i });

    fireEvent.click(stop);
    fireEvent.click(stop);
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /stopping/i })).toBeDisabled();

    unmount();
    await act(async () => finalizing.resolve(emptyRecording));
    expect(session.stop).toHaveBeenCalledTimes(1);
  });

  it("shows the interruption reason and allows a new start", async () => {
    const session = fakeSession(Promise.resolve(emptyRecording));
    startSession.mockResolvedValue(session);
    render(<AuditoryFeedbackLab />);
    confirmHeadphonesAndStart();
    await screen.findByRole("button", { name: /stop & compare/i });
    const options = startSession.mock.calls[0][1] as AuditoryFeedbackSessionOptions;

    await act(async () => options.onInterrupted?.("Audio devices changed, so feedback stopped."));

    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Audio devices changed/)).toBeInTheDocument();
    await waitFor(() => expect(startButton()).toBeEnabled());
  });
});
