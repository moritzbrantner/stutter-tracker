import type { MeasuredCaptureMetrics } from "@stutter-tracker/shared";

type CaptureKernel = typeof import("@moritzbrantner/audio-analysis-core-wasm");

let kernel: Promise<CaptureKernel> | null = null;

/**
 * Loads the audio-analysis WASM kernel (vox#89) and compiles its inlined `.wasm` on first use, so
 * neither is part of the initial bundle. A failed load is retried on the next call.
 */
function loadCaptureKernel(): Promise<CaptureKernel> {
  kernel ??= import("@moritzbrantner/audio-analysis-core-wasm").then(async (module) => {
    await module.init();
    return module;
  });
  kernel.catch(() => {
    kernel = null;
  });
  return kernel;
}

/** Starts loading the kernel ahead of the first measurement, for example when a capture starts. */
export function preloadCaptureKernel(): void {
  loadCaptureKernel().catch(() => undefined);
}

/**
 * Measures capture quality of mono audio analyzed on this device with the audio-analysis WASM
 * kernel. Resolves to `undefined` when the kernel cannot load or run: the run then stays
 * unmeasured instead of failing the analysis.
 */
export async function measureCaptureOnDevice(
  samples: ArrayLike<number>,
  sampleRate: number,
): Promise<MeasuredCaptureMetrics | undefined> {
  try {
    const { captureMetrics } = await loadCaptureKernel();
    return await captureMetrics(samples, sampleRate, 1);
  } catch {
    return undefined;
  }
}
