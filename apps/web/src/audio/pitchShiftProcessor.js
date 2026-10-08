class StutterTrackerPitchShiftProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: "semitones",
        defaultValue: 0,
        minValue: -6,
        maxValue: 6,
        automationRate: "k-rate",
      },
    ];
  }

  constructor() {
    super();
    this.buffer = new Float32Array(16384);
    this.writeIndex = 0;
    this.phase = 0;
    // 0 = dry passthrough, 1 = fully shifted; ramps so switching shifting on or off never clicks.
    this.shiftMix = 0;
    // Sign of (ratio - 1) last used, so a direction change can keep the read delay continuous.
    this.direction = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]?.[0];
    const outputChannels = outputs[0] ?? [];
    if (!input || outputChannels.length === 0) {
      return true;
    }

    const semitones = parameters.semitones;

    for (let index = 0; index < input.length; index += 1) {
      // Non-finite input would poison the delay line for its whole length.
      const dry = Number.isFinite(input[index]) ? input[index] : 0;
      this.buffer[this.writeIndex] = dry;
      const rawSemitones = semitones.length === 1 ? semitones[0] : semitones[index];
      const ratio = Number.isFinite(rawSemitones) ? 2 ** (rawSemitones / 12) : 1;
      const shifting = Math.abs(ratio - 1) > 0.0001;
      this.shiftMix = shifting
        ? Math.min(1, this.shiftMix + 1 / SHIFT_RAMP_SAMPLES)
        : Math.max(0, this.shiftMix - 1 / SHIFT_RAMP_SAMPLES);
      let sample = dry;

      if (this.shiftMix > 0) {
        const direction = shifting ? Math.sign(ratio - 1) : this.direction;
        if (direction !== 0 && this.direction !== 0 && direction !== this.direction) {
          // Reflecting the phase maps each grain's delay onto itself under the other direction.
          this.phase = (1 - this.phase) % 1;
        }
        if (direction !== 0) {
          this.direction = direction;
        }
        const phaseA = this.phase;
        const phaseB = (phaseA + 0.5) % 1;
        const delayA = delayForPhase(phaseA, this.direction, MINIMUM_DELAY_SAMPLES, SWEEP_SAMPLES);
        const delayB = delayForPhase(phaseB, this.direction, MINIMUM_DELAY_SAMPLES, SWEEP_SAMPLES);
        const weightA = Math.sin(Math.PI * phaseA) ** 2;
        const weightB = Math.sin(Math.PI * phaseB) ** 2;
        const shifted = this.readDelay(delayA) * weightA + this.readDelay(delayB) * weightB;
        sample = dry * (1 - this.shiftMix) + shifted * this.shiftMix;
        if (shifting) {
          this.phase = (this.phase + Math.abs(1 - ratio) / SWEEP_SAMPLES) % 1;
        }
      }

      for (const channel of outputChannels) {
        channel[index] = sample;
      }
      this.writeIndex = (this.writeIndex + 1) % this.buffer.length;
    }

    return true;
  }

  readDelay(delaySamples) {
    let position = this.writeIndex - delaySamples;
    while (position < 0) {
      position += this.buffer.length;
    }
    const firstIndex = Math.floor(position) % this.buffer.length;
    const secondIndex = (firstIndex + 1) % this.buffer.length;
    const fraction = position - Math.floor(position);
    return this.buffer[firstIndex] * (1 - fraction) + this.buffer[secondIndex] * fraction;
  }
}

const SWEEP_SAMPLES = 2048;
const MINIMUM_DELAY_SAMPLES = 256;
const SHIFT_RAMP_SAMPLES = 512;

function delayForPhase(phase, direction, minimumDelaySamples, sweepSamples) {
  if (direction > 0) {
    return minimumDelaySamples + sweepSamples * (1 - phase);
  }
  return minimumDelaySamples + sweepSamples * phase;
}

registerProcessor("stutter-tracker-pitch-shift", StutterTrackerPitchShiftProcessor);
