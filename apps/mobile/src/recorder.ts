/** The part of expo-audio's `AudioRecorder` the controller drives. */
export type ControlledRecorder = {
  prepareToRecordAsync(): Promise<void>;
  record(): void;
  stop(): Promise<void>;
  readonly isRecording: boolean;
  readonly uri: string | null;
};

export type StoppedCapture = { captureId: string; uri: string };

export type RecordingController = {
  /** The capture id once recording has begun; null when superseded before it began. */
  start(): Promise<string | null>;
  /** The finished recording of the current capture, or null when nothing was recording. */
  stop(): Promise<StoppedCapture | null>;
  /** Stops and discards the current capture and its pending results. */
  cancel(): Promise<void>;
  isRecording(): boolean;
  /** Whether results (upload, analysis) of that capture may still be shown. */
  isCurrent(captureId: string): boolean;
};

/**
 * Serializes start/stop/cancel on one recorder, so a late prepare never starts recording after a
 * stop or cancel, and results of a cancelled or superseded capture are never shown. The latest
 * request wins: a newer start supersedes an older one (discarding its recording), and stop or
 * cancel supersedes a start that has not begun recording yet.
 */
export function createRecordingController(recorder: ControlledRecorder): RecordingController {
  let nextCapture = 0;
  /** The capture the user last asked to record; cleared by stop and cancel. */
  let wanted: string | null = null;
  /** The capture whose results may be shown. */
  let current: string | null = null;
  /** The capture the native recorder is recording. */
  let recording: string | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = queue.then(operation, operation);
    queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Forgets the native recording only once the recorder has really stopped. When `stop()` rejects
   * while the recorder still records, the handle stays so a later stop, cancel or start retries.
   */
  async function stopRecorder() {
    try {
      await recorder.stop();
    } catch (error) {
      if (!recorder.isRecording) recording = null;
      throw error;
    }
    recording = null;
  }

  function abandon(captureId: string) {
    if (wanted === captureId) wanted = null;
    if (current === captureId) current = null;
  }

  return {
    start() {
      nextCapture += 1;
      const captureId = `capture-${nextCapture}`;
      wanted = captureId;
      current = captureId;
      return serialized(async () => {
        if (wanted !== captureId) {
          abandon(captureId);
          return null;
        }
        try {
          // A newer start replaces the running capture; its recording is discarded.
          if (recording) await stopRecorder();
          await recorder.prepareToRecordAsync();
        } catch (error) {
          abandon(captureId);
          throw error;
        }
        if (wanted !== captureId) {
          abandon(captureId);
          return null;
        }
        recorder.record();
        recording = captureId;
        return captureId;
      });
    },
    stop() {
      wanted = null;
      return serialized(async () => {
        const captureId = recording;
        if (!captureId) return null;
        await stopRecorder();
        const uri = recorder.uri;
        if (!uri) throw new Error("Recording did not produce an audio file");
        return { captureId, uri };
      });
    },
    cancel() {
      wanted = null;
      current = null;
      return serialized(async () => {
        if (!recording) return;
        try {
          await stopRecorder();
        } catch {
          // The capture's results are discarded either way. If the recorder is still running, the
          // handle is kept and the next stop, cancel or start stops it again.
        }
      });
    },
    isRecording() {
      return recording !== null;
    },
    isCurrent(captureId) {
      return current === captureId;
    },
  };
}
