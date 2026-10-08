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
  localStorage.clear();
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

describe("AuditoryFeedbackLab controls", () => {
  function field(name: RegExp) {
    return screen.getByRole("spinbutton", { name }) as HTMLInputElement;
  }

  function type(input: HTMLInputElement, text: string) {
    fireEvent.change(input, { target: { value: text } });
    fireEvent.blur(input);
  }

  it("accepts exact numeric entry, clamps to the range and reverts invalid text", () => {
    render(<AuditoryFeedbackLab />);
    const delay = field(/feedback delay \(ms\)/i);

    type(delay, "137");
    expect(delay.value).toBe("137");
    expect(screen.getByRole("slider", { name: "Feedback delay" })).toHaveValue("137");

    type(delay, "999");
    expect(delay.value).toBe("200");
    type(delay, "-5");
    expect(delay.value).toBe("0");
    type(delay, "abc");
    expect(delay.value).toBe("0");
  });

  it("steps with the arrow keys, coarsely with Shift, within bounds", () => {
    render(<AuditoryFeedbackLab />);
    const mix = field(/altered voice mix \(%\)/i);
    expect(mix.value).toBe("100");

    fireEvent.keyDown(mix, { key: "ArrowDown" });
    expect(mix.value).toBe("99");
    fireEvent.keyDown(mix, { key: "ArrowDown", shiftKey: true });
    expect(mix.value).toBe("89");
    fireEvent.keyDown(mix, { key: "ArrowUp", shiftKey: true });
    fireEvent.keyDown(mix, { key: "ArrowUp", shiftKey: true });
    expect(mix.value).toBe("100");
  });

  it("restores exact settings after remounting", () => {
    const { unmount } = render(<AuditoryFeedbackLab />);
    type(field(/feedback delay \(ms\)/i), "137");
    type(field(/pitch shift \(st\)/i), "-2.5");
    type(field(/monitor level \(%\)/i), "42");
    unmount();

    render(<AuditoryFeedbackLab />);
    expect(field(/feedback delay \(ms\)/i).value).toBe("137");
    expect(field(/pitch shift \(st\)/i).value).toBe("-2.5");
    expect(field(/monitor level \(%\)/i).value).toBe("42");
  });

  it("passes exact settings to the running engine", async () => {
    const session = fakeSession(Promise.resolve(emptyRecording));
    startSession.mockResolvedValue(session);
    render(<AuditoryFeedbackLab />);
    confirmHeadphonesAndStart();
    await screen.findByRole("button", { name: /stop & compare/i });

    type(field(/feedback delay \(ms\)/i), "137");

    expect(session.update).toHaveBeenLastCalledWith(expect.objectContaining({ delayMs: 137 }));
  });

  it("applies edits made while the session was starting", async () => {
    const pending = deferred<AuditoryFeedbackSession>();
    startSession.mockReturnValue(pending.promise);
    render(<AuditoryFeedbackLab />);
    confirmHeadphonesAndStart();

    type(field(/feedback delay \(ms\)/i), "137");
    const session = fakeSession(Promise.resolve(emptyRecording));
    await act(async () => pending.resolve(session));

    expect(session.update).toHaveBeenLastCalledWith(expect.objectContaining({ delayMs: 137 }));
  });

  it("keeps sliders on the exact committed value", () => {
    render(<AuditoryFeedbackLab />);
    type(field(/monitor level \(%\)/i), "42");
    type(field(/pitch shift \(st\)/i), "2.5");
    expect(screen.getByRole("slider", { name: "Monitor level" })).toHaveValue("0.42");
    expect(screen.getByRole("slider", { name: "Pitch shift" })).toHaveValue("2.5");
  });

  it("exposes the value being typed to assistive technology", () => {
    render(<AuditoryFeedbackLab />);
    const delay = field(/feedback delay \(ms\)/i);

    fireEvent.change(delay, { target: { value: "150" } });
    expect(delay).toHaveAttribute("aria-valuenow", "150");
    fireEvent.change(delay, { target: { value: "999" } });
    expect(delay).toHaveAttribute("aria-valuenow", "200");
    fireEvent.change(delay, { target: { value: "abc" } });
    expect(delay).not.toHaveAttribute("aria-valuenow");
  });

  it("still renders when browser storage is blocked", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    try {
      render(<AuditoryFeedbackLab />);
      type(field(/feedback delay \(ms\)/i), "120");
      expect(field(/feedback delay \(ms\)/i).value).toBe("120");
    } finally {
      cleanup();
      if (original) {
        Object.defineProperty(window, "localStorage", original);
      } else {
        delete (window as { localStorage?: Storage }).localStorage;
      }
    }
  });

  it("hides the effective-settings line as soon as stopping begins", async () => {
    const finalizing = deferred<AuditoryFeedbackRecording>();
    startSession.mockResolvedValue(fakeSession(finalizing.promise));
    render(<AuditoryFeedbackLab />);
    confirmHeadphonesAndStart();
    const stop = await screen.findByRole("button", { name: /stop & compare/i });
    expect(screen.getByLabelText("Effective feedback settings")).toBeInTheDocument();

    fireEvent.click(stop);

    expect(screen.queryByLabelText("Effective feedback settings")).not.toBeInTheDocument();
    await act(async () => finalizing.resolve(emptyRecording));
  });

  it("keeps a requested pitch shift but shows it is not applied when unsupported", async () => {
    const session = {
      ...fakeSession(Promise.resolve(emptyRecording)),
      capabilities: { pitchShift: false, localCapture: true },
    };
    startSession.mockResolvedValue(session);
    render(<AuditoryFeedbackLab />);
    type(field(/pitch shift \(st\)/i), "2");
    confirmHeadphonesAndStart();
    await screen.findByRole("button", { name: /stop & compare/i });

    expect(field(/pitch shift \(st\)/i)).toBeDisabled();
    expect(field(/pitch shift \(st\)/i).value).toBe("2");
    expect(screen.getByLabelText("Effective feedback settings")).toHaveTextContent(
      "pitch shift off (not available; requested +2 st)",
    );
  });
});
