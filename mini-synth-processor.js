/**
 * mini-synth-processor.js
 *
 * This AudioWorkletProcessor is the heart of the synthesizer. It handles:
 * - A pool of voices for polyphony.
 * - A "voice stealing" algorithm to manage note allocation.
 * - A sample-accurate ADSR envelope generator for each voice.
 * - Pitch shifting by adjusting the sample playback rate.
 * - All real-time audio generation, completely off the main UI thread.
 */

// A simple, fast ADSR envelope generator that operates per-sample.
class ADSREnvelope {
  constructor() {
    this.state = 'idle';
    this.attackRate = 0;
    this.decayRate = 0;
    this.sustainLevel = 1.0;
    this.releaseRate = 0;
    this.value = 0;
  }

  // Set parameters, converting from seconds to a per-sample rate.
  setParams(sampleRate, attack, decay, sustain, release) {
    this.attackRate = attack > 0 ? 1 / (attack * sampleRate) : 1;
    this.decayRate = decay > 0 ? 1 / (decay * sampleRate) : 1;
    this.sustainLevel = sustain;
    this.releaseRate = release > 0 ? 1 / (release * sampleRate) : 1;
  }

  noteOn() {
    this.state = 'attack';
  }

  noteOff() {
    if (this.state !== 'idle') {
      this.state = 'release';
    }
  }

  // Process one sample at a time, returning the current envelope gain.
  process() {
    switch (this.state) {
      case 'attack':
        this.value += this.attackRate;
        if (this.value >= 1.0) {
          this.value = 1.0;
          this.state = 'decay';
        }
        break;
      case 'decay':
        this.value -= this.decayRate;
        if (this.value <= this.sustainLevel) {
          this.value = this.sustainLevel;
          this.state = 'sustain';
        }
        break;
      case 'sustain':
        // Value remains at sustainLevel.
        this.value = this.sustainLevel;
        break;
      case 'release':
        this.value -= this.releaseRate;
        if (this.value <= 0) {
          this.value = 0;
          this.state = 'idle';
        }
        break;
      case 'idle':
        this.value = 0;
        break;
    }
    return this.value;
  }

  isIdle() {
      return this.state === 'idle';
  }
}

// Represents a single polyphonic voice, containing an oscillator (sampler) and an envelope.
class Voice {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.midiNote = 0;
    this.playbackRate = 1.0;
    this.samplePosition = 0;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.envelope = new ADSREnvelope();
    this.age = 0; // For voice stealing
  }

  // A4 = 440Hz is our reference for pitch calculation.
  static A4_MIDI = 69;

  start(note, sampleBuffer) {
    this.midiNote = note.midi;
    const freq = MiniSynthProcessor.midiToFreq(note.midi);
    const baseFreq = MiniSynthProcessor.midiToFreq(Voice.A4_MIDI); // Assuming sample is pitched at A4
    this.playbackRate = freq / baseFreq;

    this.samplePosition = 0;
    this.loopStart = 0;
    this.loopEnd = sampleBuffer ? sampleBuffer.length - 1 : 0;
    this.envelope.noteOn();
    this.age = 0;
  }

  stop() {
    this.envelope.noteOff();
  }

  isIdle() {
    return this.envelope.isIdle();
  }

  // Process and return one sample of audio output.
  process(sampleBuffer) {
    if (this.isIdle() || !sampleBuffer || sampleBuffer.length === 0) {
      return 0;
    }

    const envGain = this.envelope.process();

    // Simple linear interpolation for non-integer positions to reduce artifacts.
    const pos = this.samplePosition;
    const i0 = Math.floor(pos);
    const i1 = i0 + 1;
    const frac = pos - i0;

    const v0 = sampleBuffer[i0] || 0;
    const v1 = sampleBuffer[i1] || 0;
    const sampleValue = v0 + (v1 - v0) * frac;

    this.samplePosition += this.playbackRate;
    this.age++;

    // Basic looping.
    if (this.samplePosition >= this.loopEnd) {
      this.samplePosition -= (this.loopEnd - this.loopStart);
    }

    return sampleValue * envGain;
  }
}

class MiniSynthProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sampleRate = sampleRate;
    this.sampleBuffer = null; // A Float32Array holding our mono audio sample.

    this.voices = [];
    const MAX_VOICES = 16;
    for (let i = 0; i < MAX_VOICES; i++) {
      this.voices.push(new Voice(sampleRate));
    }

    this.adsrParams = { attack: 0.05, decay: 0.1, sustain: 0.8, release: 0.5 };
    this.updateAllVoiceEnvelopes();

    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  static midiToFreq(midi) {
    return 440.0 * Math.pow(2, (midi - 69) / 12.0);
  }

  handleMessage(message) {
    if (message.type === 'load-sample-data') {
        // We'll use the first channel for our mono sampler.
        this.sampleBuffer = message.channels[0];
    } else if (message.type === 'noteOn') {
        this.playNote(message);
    } else if (message.type === 'noteOff') {
        this.stopNote(message);
    } else if (message.type === 'param') {
        this.updateParam(message.name, message.value);
    }
  }

  playNote(note) {
    // Find an idle voice first.
    let voice = this.voices.find(v => v.isIdle());

    // If no idle voice, steal the oldest one (longest playing).
    if (!voice) {
      voice = this.voices.reduce((oldest, current) => (current.age > oldest.age ? current : oldest));
    }

    if (voice) {
      voice.start(note, this.sampleBuffer);
    }
  }

  stopNote(note) {
    // Stop all voices playing this specific midi note.
    this.voices.forEach(v => {
      if (v.midiNote === note.midi && !v.isIdle()) {
        v.stop();
      }
    });
  }

  updateParam(name, value) {
    if (this.adsrParams.hasOwnProperty(name)) {
        this.adsrParams[name] = value;
        this.updateAllVoiceEnvelopes();
    }
  }

  updateAllVoiceEnvelopes() {
    this.voices.forEach(v => {
        v.envelope.setParams(
            this.sampleRate,
            this.adsrParams.attack,
            this.adsrParams.decay,
            this.adsrParams.sustain,
            this.adsrParams.release
        );
    });
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    // We will output to both stereo channels.
    const channelLeft = output[0];
    const channelRight = output.length > 1 ? output[1] : null;

    for (let i = 0; i < channelLeft.length; i++) {
      let sampleSum = 0;
      for (const voice of this.voices) {
        sampleSum += voice.process(this.sampleBuffer);
      }
      // Simple limiter to prevent clipping, scaled to avoid harshness.
      const limitedSample = Math.tanh(sampleSum * 0.8);
      channelLeft[i] = limitedSample;
      if (channelRight) {
        channelRight[i] = limitedSample;
      }
    }

    return true; // Keep processor alive.
  }
}

registerProcessor('mini-synth-processor', MiniSynthProcessor);
