// Acceptance tests for #94: the mobile recorder cleans up on start/stop/cancel, so no late audio
// or result attaches to another session.
//
// Seam contract (new module `./recorder`): `createRecordingController(recorder)` wraps the Expo
// `AudioRecorder` (only `prepareToRecordAsync`, `record`, `stop`, `isRecording`, `uri` and, if the
// controller subscribes to recorder events, `addListener`, are used) and returns:
// - `start(): Promise<string | null>` — the capture id once recording has begun; null when a
//   stop, cancel or newer start superseded it before it began (then nothing records);
// - `stop(): Promise<{ captureId: string; uri: string } | null>` — the finished recording of the
//   current capture, or null when nothing was recording;
// - `cancel(): Promise<void>` — stops and discards the current capture and its pending results;
// - `isRecording(): boolean`;
// - `isCurrent(captureId): boolean` — whether results of that capture (its upload/analysis) may
//   still be shown: true for the latest capture until it is cancelled or another one starts.
// The App's Record/Stop handlers go through this controller and drop results of captures that are
// no longer current.
import { describe, expect, it } from "vitest";
import { createRecordingController } from "./recorder";

type Deferred = { promise: Promise<void>; resolve(): void; reject(error: Error): void };

function deferred(): Deferred {
  let resolve = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Behaves like expo-audio's AudioRecorder; throws where the native recorder would misbehave. */
function fakeRecorder(options: { manualPrepare?: boolean } = {}) {
  const pendingPrepares: Deferred[] = [];
  const listeners = new Set<(event: unknown) => void>();
  const misuse: string[] = [];
  let recordings = 0;
  const recorder = {
    isRecording: false,
    prepared: false,
    uri: null as string | null,
    recordCalls: 0,
    failNextStop: false,
    async prepareToRecordAsync() {
      if (recorder.isRecording) misuse.push("prepare while recording");
      if (options.manualPrepare) {
        const pending = deferred();
        pendingPrepares.push(pending);
        await pending.promise;
      }
      recorder.prepared = true;
    },
    record() {
      recorder.recordCalls += 1;
      if (recorder.isRecording) misuse.push("record while recording");
      if (!recorder.prepared) misuse.push("record without prepare");
      recorder.isRecording = true;
      recorder.prepared = false;
      recordings += 1;
      recorder.uri = `file:///cache/recording-${recordings}.m4a`;
    },
    async stop() {
      if (recorder.failNextStop) {
        recorder.failNextStop = false;
        recorder.isRecording = false;
        throw new Error("native stop failed");
      }
      recorder.isRecording = false;
    },
    addListener(_event: string, listener: (event: unknown) => void) {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  };
  return {
    recorder,
    misuse,
    listeners,
    releasePrepare() {
      pendingPrepares.shift()?.resolve();
    },
    failPrepare() {
      pendingPrepares.shift()?.reject(new Error("prepare failed"));
    },
  };
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("mobile recording controller", () => {
  it("records one capture and returns its file on stop", async () => {
    const fake = fakeRecorder();
    const controller = createRecordingController(fake.recorder);

    const captureId = await controller.start();
    expect(captureId).toEqual(expect.any(String));
    expect(controller.isRecording()).toBe(true);
    expect(fake.recorder.isRecording).toBe(true);

    const stopped = await controller.stop();
    expect(stopped).toEqual({ captureId, uri: "file:///cache/recording-1.m4a" });
    expect(controller.isRecording()).toBe(false);
    expect(fake.recorder.isRecording).toBe(false);
    // The stopped capture's upload and analysis may still be shown.
    expect(controller.isCurrent(captureId!)).toBe(true);
    expect(fake.listeners.size).toBe(0);
    expect(fake.misuse).toEqual([]);
  });

  it("drops a stopped capture's late results once a new capture starts", async () => {
    const fake = fakeRecorder();
    const controller = createRecordingController(fake.recorder);

    const first = await controller.start();
    await controller.stop();
    const second = await controller.start();

    expect(second).not.toBe(first);
    expect(controller.isCurrent(first!)).toBe(false);
    expect(controller.isCurrent(second!)).toBe(true);
    await controller.stop();
    expect(fake.misuse).toEqual([]);
  });

  it("cancel stops the recorder and discards the capture", async () => {
    const fake = fakeRecorder();
    const controller = createRecordingController(fake.recorder);

    const captureId = await controller.start();
    await controller.cancel();

    expect(fake.recorder.isRecording).toBe(false);
    expect(controller.isRecording()).toBe(false);
    expect(controller.isCurrent(captureId!)).toBe(false);
    expect(await controller.stop()).toBeNull();
    expect(fake.listeners.size).toBe(0);
  });

  it("cancel after stop discards the stopped capture's pending results", async () => {
    const fake = fakeRecorder();
    const controller = createRecordingController(fake.recorder);

    const captureId = await controller.start();
    await controller.stop();
    await controller.cancel();

    expect(controller.isCurrent(captureId!)).toBe(false);
    expect(fake.recorder.isRecording).toBe(false);
  });

  it.each(["stop", "cancel"] as const)(
    "never starts recording late when %s arrives while the recorder is still preparing",
    async (action) => {
      const fake = fakeRecorder({ manualPrepare: true });
      const controller = createRecordingController(fake.recorder);

      const starting = controller.start();
      await flush();
      const ending = action === "stop" ? controller.stop() : controller.cancel();
      fake.releasePrepare();
      const [started, ended] = await Promise.all([starting, ending]);

      expect(started).toBeNull();
      if (action === "stop") expect(ended).toBeNull();
      await flush();
      expect(fake.recorder.recordCalls).toBe(0);
      expect(fake.recorder.isRecording).toBe(false);
      expect(controller.isRecording()).toBe(false);
      expect(fake.listeners.size).toBe(0);
    },
  );

  it("a newer start supersedes one that is still preparing", async () => {
    const fake = fakeRecorder({ manualPrepare: true });
    const controller = createRecordingController(fake.recorder);

    const first = controller.start();
    await flush();
    const second = controller.start();
    fake.releasePrepare();
    await flush();
    fake.releasePrepare();
    const [firstId, secondId] = await Promise.all([first, second]);

    expect(firstId).toBeNull();
    expect(secondId).toEqual(expect.any(String));
    expect(fake.recorder.recordCalls).toBe(1);
    expect(controller.isCurrent(secondId!)).toBe(true);
    await controller.stop();
    expect(fake.recorder.isRecording).toBe(false);
    expect(fake.misuse).toEqual([]);
  });

  it("is inactive after a failed prepare or a failed stop", async () => {
    const fake = fakeRecorder({ manualPrepare: true });
    const controller = createRecordingController(fake.recorder);

    const starting = controller.start().catch(() => null);
    await flush();
    fake.failPrepare();
    expect(await starting).toBeNull();
    expect(controller.isRecording()).toBe(false);
    expect(fake.recorder.recordCalls).toBe(0);

    const retry = controller.start();
    await flush();
    fake.releasePrepare();
    expect(await retry).toEqual(expect.any(String));
    fake.recorder.failNextStop = true;
    await controller.stop().catch(() => null);
    expect(controller.isRecording()).toBe(false);
    expect(fake.listeners.size).toBe(0);
  });

  it("leaves no active recording or callback after repeated start/stop/cancel", async () => {
    const fake = fakeRecorder();
    const controller = createRecordingController(fake.recorder);
    const captures: string[] = [];

    for (let round = 0; round < 6; round += 1) {
      const captureId = await controller.start();
      if (captureId) captures.push(captureId);
      if (round % 3 === 0) {
        await controller.stop();
      } else if (round % 3 === 1) {
        await controller.cancel();
      } else {
        // Rapid taps: start again while recording, then stop and cancel back to back.
        const again = await controller.start();
        if (again) captures.push(again);
        await Promise.all([controller.stop(), controller.cancel()]);
      }
      expect(fake.recorder.isRecording).toBe(false);
      expect(controller.isRecording()).toBe(false);
      expect(fake.listeners.size).toBe(0);
    }
    await controller.cancel();
    await controller.stop();

    expect(fake.misuse).toEqual([]);
    expect(fake.recorder.isRecording).toBe(false);
    expect(captures.filter((id) => controller.isCurrent(id))).toEqual([]);
    expect(new Set(captures).size).toBe(captures.length);
  });
});

// Regression for the Codex review of #96 (implementation-authored, not part of the acceptance set).
describe("mobile recording controller after a rejected native stop", () => {
  it("keeps the recording handle while the recorder still records, then retries", async () => {
    let isRecording = false;
    let stopCalls = 0;
    const recorder = {
      async prepareToRecordAsync() {},
      record() {
        isRecording = true;
      },
      async stop() {
        stopCalls += 1;
        if (stopCalls === 1) throw new Error("native stop failed before stopping");
        isRecording = false;
      },
      get isRecording() {
        return isRecording;
      },
      get uri() {
        return "file:///cache/recording.m4a";
      },
    };
    const controller = createRecordingController(recorder);
    await controller.start();
    await expect(controller.stop()).rejects.toThrow("native stop failed");
    expect(controller.isRecording()).toBe(true);
    await controller.cancel();
    expect(stopCalls).toBe(2);
    expect(controller.isRecording()).toBe(false);
  });
});
