import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserRecorderError, createBrowserRecorder, describeCapture } from "./browserRecorder";

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

  it("describes the delivered stream and releases everything once on repeated stop", async () => {
    const stopTrack = vi.fn();
    const track = {
      stop: stopTrack,
      label: "USB microphone",
      getSettings: () => ({ echoCancellation: true, noiseSuppression: false }),
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [track],
          getAudioTracks: () => [track],
        }),
      },
    });
    const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
    const processor = { ...node(), onaudioprocess: null as unknown };
    const close = vi.fn().mockResolvedValue(undefined);
    window.AudioContext = vi.fn(function FakeAudioContext() {
      return {
        sampleRate: 44_100,
        destination: {},
        audioWorklet: undefined,
        close,
        createMediaStreamSource: () => node(),
        createAnalyser: () => ({ ...node(), fftSize: 0, smoothingTimeConstant: 0 }),
        createGain: () => ({ ...node(), gain: { value: 1 } }),
        createScriptProcessor: () => processor,
      };
    }) as unknown as typeof AudioContext;
    const onLevel = vi.fn();

    const recorder = await createBrowserRecorder({ onSamples: vi.fn(), onLevel });

    expect(recorder.sampleRate).toBe(44_100);
    expect(recorder.capture).toEqual({
      channelCount: 1,
      deviceRoute: "USB microphone",
      preprocessing: {
        echoCancellation: { requested: true, applied: true },
        noiseSuppression: { requested: true, applied: false },
        autoGainControl: { requested: false, applied: undefined },
      },
    });
    expect(processor.onaudioprocess).toBeTypeOf("function");
    await recorder.stop();
    await recorder.stop();
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(processor.onaudioprocess).toBeNull();
    expect(processor.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("describeCapture", () => {
  it("leaves unreported settings and labels unknown", () => {
    expect(describeCapture(undefined)).toEqual({
      channelCount: 1,
      preprocessing: {
        echoCancellation: { requested: true, applied: undefined },
        noiseSuppression: { requested: true, applied: undefined },
        autoGainControl: { requested: false, applied: undefined },
      },
    });
    const track = { label: " ", getSettings: () => ({ autoGainControl: false }) };
    expect(describeCapture(track as unknown as MediaStreamTrack)).toMatchObject({
      preprocessing: { autoGainControl: { requested: false, applied: false } },
    });
    expect(describeCapture(track as unknown as MediaStreamTrack)).not.toHaveProperty("deviceRoute");
  });
});
