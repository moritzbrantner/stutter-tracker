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
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]?.[0];
    const outputChannels = outputs[0] ?? [];
    if (!input || outputChannels.length === 0) {
      return true;
    }

    const semitones = parameters.semitones;
    const sweepSamples = 2048;
    const minimumDelaySamples = 256;

    for (let index = 0; index < input.length; index += 1) {
      this.buffer[this.writeIndex] = input[index] ?? 0;
      const currentSemitones = semitones.length === 1 ? semitones[0] : (semitones[index] ?? 0);
      const ratio = 2 ** (currentSemitones / 12);
      let sample = input[index] ?? 0;

      if (Math.abs(ratio - 1) > 0.0001) {
        const phaseA = this.phase;
        const phaseB = (phaseA + 0.5) % 1;
        const delayA = delayForPhase(phaseA, ratio, minimumDelaySamples, sweepSamples);
        const delayB = delayForPhase(phaseB, ratio, minimumDelaySamples, sweepSamples);
        const weightA = Math.sin(Math.PI * phaseA) ** 2;
        const weightB = Math.sin(Math.PI * phaseB) ** 2;
        sample = this.readDelay(delayA) * weightA + this.readDelay(delayB) * weightB;
        this.phase = (this.phase + Math.abs(1 - ratio) / sweepSamples) % 1;
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

function delayForPhase(phase, ratio, minimumDelaySamples, sweepSamples) {
  if (ratio > 1) {
    return minimumDelaySamples + sweepSamples * (1 - phase);
  }
  return minimumDelaySamples + sweepSamples * phase;
}

registerProcessor("stutter-tracker-pitch-shift", StutterTrackerPitchShiftProcessor);
