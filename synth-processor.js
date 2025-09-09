// synth-processor.js - one-shot version (no echo/looping by default)

const RENDER_QUANTUM = 128; // Standard block size for audio processing

class ADSREnvelope {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.attackTime = 0.05;
    this.decayTime = 0.1;
    this.sustainLevel = 0.8;
    this.releaseTime = 0.5;
    this.state = 'idle';
    this.level = 0.0;
  }

  setParams(attack, decay, sustain, release) {
    this.attackTime = Math.max(0.001, attack);
    this.decayTime = Math.max(0.001, decay);
    this.sustainLevel = sustain;
    this.releaseTime = Math.max(0.001, release);
  }

  noteOn() {
    this.state = 'attack';
    this.level = 0.0;
  }

  noteOff() {
    this.state = 'release';
  }

  process() {
    switch (this.state) {
      case 'attack':
        this.level += 1.0 / (this.attackTime * this.sampleRate);
        if (this.level >= 1.0) {
          this.level = 1.0;
          this.state = 'decay';
        }
        break;
      case 'decay':
        this.level -= (1.0 - this.sustainLevel) / (this.decayTime * this.sampleRate);
        if (this.level <= this.sustainLevel) {
          this.level = this.sustainLevel;
          this.state = 'sustain';
        }
        break;
      case 'sustain':
        break;
      case 'release':
        this.level -= (this.level) / (this.releaseTime * this.sampleRate);
        if (this.level <= 0.00001) {
          this.level = 0.0;
          this.state = 'idle';
        }
        break;
    }
    return this.level;
  }
}

class BiquadFilter {
  constructor() { this.reset(); }
  reset() { this.x1 = this.x2 = this.y1 = this.y2 = 0.0; }
  process(input, a0, a1, a2, b1, b2) {
    const result = a0 * input + a1 * this.x1 + a2 * this.x2 - b1 * this.y1 - b2 * this.y2;
    this.x2 = this.x1; this.x1 = input;
    this.y2 = this.y1; this.y1 = result;
    return result;
  }
}

class Voice {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.envelope = new ADSREnvelope(sampleRate);
    this.filter = new BiquadFilter();
    this.reset();
  }

  reset() {
    this.isActive = false;
    this.note = -1;
    this.pitchFactor = 1.0;
    this.samplePtr = 0.0;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.envelope.state = 'idle';
    this.filter.reset();
  }

  noteOn(note, pitchFactor, loopStart, loopEnd) {
    this.note = note;
    this.pitchFactor = pitchFactor;
    this.loopStart = loopStart;
    this.loopEnd = loopEnd;
    this.samplePtr = this.loopStart;
    this.isActive = true;
    this.envelope.noteOn();
    this.filter.reset();
  }

  noteOff() {
    this.envelope.noteOff();
  }

  process(sampleData, filterCoeffs) {
    if (!this.isActive) return 0.0;

    const ptr_int = Math.floor(this.samplePtr);
    const ptr_frac = this.samplePtr - ptr_int;
    const s1 = sampleData[ptr_int] || 0;
    const s2 = sampleData[ptr_int + 1] || 0;
    let sampleValue = s1 + (s2 - s1) * ptr_frac; // linear interpolation

    const envValue = this.envelope.process();
    sampleValue *= envValue;

    sampleValue = this.filter.process(sampleValue, ...filterCoeffs);

    this.samplePtr += this.pitchFactor;

    // 🔧 one-shot: stop voice instead of looping
    if (this.samplePtr >= this.loopEnd) {
      this.isActive = false;
      return 0.0;
    }

    if (this.envelope.state === 'idle') {
      this.isActive = false;
    }

    return sampleValue;
  }
}

class SynthProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._isReady = false;
    this._sampleData = null;

    this.voices = [];
    for (let i = 0; i < 16; i++) {
      this.voices.push(new Voice(sampleRate));
    }

    this.params = {
      attack: 0.05, decay: 0.1, sustain: 0.8, release: 0.5,
      filterCutoff: 20000, filterResonance: 0.0
    };
    this.filterCoeffs = [1,0,0,0,0];

    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  recalculateFilterCoeffs() {
    const frequency = Math.max(20, Math.min(this.params.filterCutoff, sampleRate * 0.45));
    const Q = Math.max(0.001, (this.params.filterResonance || 0.0001));
    const omega = 2.0 * Math.PI * frequency / sampleRate;
    const alpha = Math.sin(omega) / (2.0 * Q);
    const cos_omega = Math.cos(omega);

    const b0 = (1.0 - cos_omega) / 2.0;
    const b1 = 1.0 - cos_omega;
    const b2 = (1.0 - cos_omega) / 2.0;
    const a0 = 1.0 + alpha;
    const a1 = -2.0 * cos_omega;
    const a2 = 1.0 - alpha;

    this.filterCoeffs = [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }

  handleMessage(data) {
    if (!data || !data.type) return;
    if (data.type === 'load-sample') {
      this._sampleData = data.sampleData;
      if (this._sampleData && !(this._sampleData instanceof Float32Array)) {
        this._sampleData = new Float32Array(this._sampleData);
      }
      this.port.postMessage({ type: 'log', msg: `Sample loaded (${this._sampleData ? this._sampleData.length : 0} frames)` });
    } else if (data.type === 'param') {
      this.params[data.name] = data.value;
      if (data.name.startsWith('filter')) {
        this.recalculateFilterCoeffs();
      } else {
        this.voices.forEach(v => v.envelope.setParams(this.params.attack, this.params.decay, this.params.sustain, this.params.release));
      }
    } else if (data.type === 'noteOn') {
      let voice = this.voices.find(v => !v.isActive);
      if (!voice) voice = this.voices[0]; // steal first
      if (!this._sampleData) return;
      const loopStartInSamples = Math.max(0, Math.floor((data.loopStart || 0) * this._sampleData.length));
      const loopEndInSamples = Math.min(this._sampleData.length - 1, Math.floor((data.loopEnd || 1) * this._sampleData.length));
      voice.noteOn(data.note, data.pitchFactor || 1.0, loopStartInSamples, Math.max(loopStartInSamples+1, loopEndInSamples));
    } else if (data.type === 'noteOff') {
      const voice = this.voices.find(v => v.isActive && v.note === data.note);
      if (voice) voice.noteOff();
    } else if (data.type === 'init-wasm') {
      // optional WASM init
      WebAssembly.instantiate(data.wasmBuffer).then(result => {
        this._wasmExports = result.instance ? result.instance.exports : result.exports;
        this._isReady = true;
        this.port.postMessage({ type: 'ready' });
      }).catch(() => {
        this._isReady = true;
        this.port.postMessage({ type: 'ready' });
      });
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];

    if (!this._isReady || !this._sampleData) {
      for (let i = 0; i < left.length; i++) {
        left[i] = 0; right[i] = 0;
      }
      return true;
    }

    for (let i = 0; i < left.length; i++) {
      let val = 0.0;
      for (const v of this.voices) {
        if (v.isActive) val += v.process(this._sampleData, this.filterCoeffs);
      }
      const out = Math.max(-1, Math.min(1, val * 0.25));
      left[i] = out;
      right[i] = out;
    }

    return true;
  }
}

registerProcessor('synth-processor', SynthProcessor);
