import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserRecorderError, createBrowserRecorder } from "./browserRecorder";

const originalMediaDevices = navigator.mediaDevices;
const originalAudioContext = window.AudioContext;
const originalWebkitAudioContext = window.webkitAudioContext;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: originalMediaDevices,
  });
  window.AudioContext = originalAudioContext;
  window.webkitAudioContext = originalWebkitAudioContext;
});

describe("createBrowserRecorder", () => {
  it("returns unavailable when mediaDevices is missing", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });

    await expect(
      createBrowserRecorder({ onSamples: vi.fn(), onLevel: vi.fn() }),
    ).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("maps permission denial to denied", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")),
      },
    });

    await expect(
      createBrowserRecorder({ onSamples: vi.fn(), onLevel: vi.fn() }),
    ).rejects.toBeInstanceOf(BrowserRecorderError);
    await expect(
      createBrowserRecorder({ onSamples: vi.fn(), onLevel: vi.fn() }),
    ).rejects.toMatchObject({
      code: "denied",
    });
  });

  it("stops acquired tracks when later setup fails", async () => {
    const stop = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop }],
        }),
      },
    });
    window.AudioContext = undefined as unknown as typeof AudioContext;
    window.webkitAudioContext = undefined;

    await expect(
      createBrowserRecorder({ onSamples: vi.fn(), onLevel: vi.fn() }),
    ).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
