/**
 * Voice masking in the browser.
 *
 * The mask runs on the outgoing microphone before it reaches the peer
 * connection, so the switch and the far end only ever receive the disguised
 * audio. It is two effects over one delay line:
 *
 *   pitch   two grains read half a grain apart, cross-faded with sine windows.
 *           Reading faster raises the pitch, slower lowers it. This is what
 *           makes a voice sound like someone else rather than like a tape
 *           played at the wrong speed.
 *   robot   a 55 Hz carrier multiplied into the signal, which flattens the
 *           pitch contour into a buzz — the unmistakably non-human option.
 *
 * Nothing here is a claim of anonymity. A pitch shift changes how you sound; it
 * does not change what you say, and it is not a substitute for a secure line.
 */

const WORKLET = `
class ScifMaskProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 8192;
    this.buffer = new Float32Array(this.size);
    this.write = 0;
    this.grain = 2048;
    this.phase = 0;
    this.ratio = 1;
    this.robot = 0;
    this.carrier = 0;
    this.port.onmessage = (event) => {
      const mode = event.data && event.data.mode;
      const table = {
        off: [1, 0],
        low: [Math.pow(2, -4 / 12), 0],
        high: [Math.pow(2, 5 / 12), 0],
        robot: [1, 1],
      };
      const setting = table[mode] || [1, 0];
      this.ratio = setting[0];
      this.robot = setting[1];
    };
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    if (!input) {
      output.fill(0);
      return true;
    }
    const size = this.size;
    const grain = this.grain;
    for (let i = 0; i < output.length; i += 1) {
      this.buffer[this.write] = input[i];
      const phaseA = this.phase % grain;
      const phaseB = (this.phase + grain / 2) % grain;
      const readA = (this.write - grain + Math.floor(phaseA) + size) % size;
      const readB = (this.write - grain + Math.floor(phaseB) + size) % size;
      const windowA = Math.sin((Math.PI * phaseA) / grain);
      const windowB = Math.sin((Math.PI * phaseB) / grain);
      let sample = this.buffer[readA] * windowA + this.buffer[readB] * windowB;
      if (this.robot) {
        this.carrier = (this.carrier + (2 * Math.PI * 55) / sampleRate) % (2 * Math.PI);
        sample *= Math.cos(this.carrier);
      }
      output[i] = Math.max(-1, Math.min(1, sample));
      this.write = (this.write + 1) % size;
      this.phase += this.ratio;
    }
    return true;
  }
}
registerProcessor('scif-mask', ScifMaskProcessor);
`;

export const MASK_MODES = [
  { value: 'off', label: 'Off — your own voice' },
  { value: 'low', label: 'Lower — deeper than you' },
  { value: 'high', label: 'Higher — lighter than you' },
  { value: 'robot', label: 'Robot — masked carrier' },
];

/**
 * Build a masked copy of one microphone track.
 *
 * Returns the replacement track plus `setMode` (change without renegotiating)
 * and `stop` (tear the graph down). The caller owns the original track and must
 * put it back when masking is switched off — this function never stops it.
 */
export async function createVoiceMask(track, mode = 'off') {
  if (!track) throw new Error('There is no microphone track to mask');
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || !window.AudioWorkletNode) {
    throw new Error('This browser does not support audio worklets');
  }
  const context = new AudioContextClass();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  try {
    await context.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  // A call is a user gesture, so this normally resumes at once; a tab that was
  // suspended in the background may need it explicitly.
  await context.resume().catch(() => {});

  const source = context.createMediaStreamSource(new MediaStream([track]));
  const node = new AudioWorkletNode(context, 'scif-mask', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  const destination = context.createMediaStreamDestination();
  source.connect(node);
  node.connect(destination);
  node.port.postMessage({ mode });

  return {
    track: destination.stream.getAudioTracks()[0],
    setMode(next) {
      node.port.postMessage({ mode: next });
    },
    async stop() {
      try {
        source.disconnect();
        node.disconnect();
        destination.stream.getTracks().forEach((entry) => entry.stop());
        await context.close();
      } catch {
        /* the graph is already gone */
      }
    },
  };
}
