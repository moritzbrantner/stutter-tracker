class PCMRecorderProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0] ?? [];
    const output = outputs[0] ?? [];
    for (const channel of output) {
      channel.fill(0);
    }
    const frameCount = input[0]?.length ?? 0;
    if (!frameCount) {
      return true;
    }
    const samples = new Float32Array(frameCount);
    for (let index = 0; index < frameCount; index += 1) {
      let sample = 0;
      for (const channel of input) {
        sample += channel[index] ?? 0;
      }
      samples[index] = sample / Math.max(1, input.length);
    }
    this.port.postMessage(samples, [samples.buffer]);
    return true;
  }
}

registerProcessor("pcm-recorder", PCMRecorderProcessor);
