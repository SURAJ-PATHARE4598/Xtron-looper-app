/* audio/mini-synth-node.js
   MiniSynthNode - convenience wrapper around AudioWorkletNode

   Usage:
     const node = new MiniSynthNode(audioContext, { maxVoices: 12 });
     await node.init(); // loads handshake, not the worklet module itself
     node.connect(audioContext.destination);
     node.setParam('filterCutoff', 2000);
     node.noteOn({ midi: 60, freq: 261.6256, velocity: 0.9 });
     node.postMessage({ type: 'load-sample', id: 'kick', channels: [...] }, [/* transferables */]);
*/

class MiniSynthNode {
  /**
   * @param {BaseAudioContext} audioContext
   * @param {Object} opts - optional config
   * - processorName: name registered in the worklet processor (string)
   * - workletUrl: path to the processor module (string). If provided and not loaded, wrapper will addModule.
   * - maxVoices: (number) - hint for processor initialization
   */
  constructor(audioContext, opts = {}) {
    this.context = audioContext;
    this.processorName = opts.processorName || 'mini-synth-processor';
    this.workletUrl = opts.workletUrl || null; // optional: auto-add module if provided
    this.node = null;
    this._ready = false;
    this._pendingMessages = [];
    this._paramCache = new Map(); // simple cache for non-AudioParam values
    this._defaultOptions = opts;
    this._onmessageHandlers = [];
  }

  /**
   * Initialize: add module (if workletUrl provided), create node, and handshake.
   * Returns a Promise that resolves when the processor sends { ready: true }.
   */
  async init() {
    if (this.workletUrl) {
      // add module only if provided (safe to call multiple times)
      try {
        await this.context.audioWorklet.addModule(this.workletUrl);
      } catch (err) {
        console.error('Failed to add AudioWorklet module:', err);
        throw err;
      }
    }

    // Create the node with some reasonable default options
    const nodeOptions = {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      parameterData: {
        // basic defaults (the processor will expose actual AudioParams)
        filterCutoff: 1000,
        filterQ: 1.0,
        unisonCount: 1,
        unisonDetune: 12.0
      }
    };

    this.node = new AudioWorkletNode(this.context, this.processorName, nodeOptions);

    // hook message port
    this.node.port.onmessage = (ev) => this._handleMessage(ev.data);

    // set up parameter map reference for quick lookups
    this._params = this.node.parameters; // AudioParamMap (may be empty depending on processor)

    // handshake: wait for ready message from the processor
    const readyPromise = new Promise((resolve) => {
      const onReady = (data) => {
        if (data && data.ready) {
          this._ready = true;
          // flush pending messages
          this._pendingMessages.forEach(m => this.node.port.postMessage(m.msg, m.transfer));
          this._pendingMessages = [];
          this._callHandlers('ready', data);
          resolve();
        }
      };
      // temporary listener
      const tempListener = (ev) => onReady(ev.data);
      const prev = this.node.port.onmessage;
      // augment existing handler
      this.node.port.onmessage = (ev) => {
        // call internal handler then original handler logic
        this._handleMessage(ev.data);
        if (typeof prev === 'function') prev(ev);
      };
      // If the processor already posted ready synchronously, our node.port.onmessage will catch it via _handleMessage
      // fallback: set a timeout to resolve to avoid hang (optional)
      setTimeout(() => {
        if (!this._ready) {
          console.warn('MiniSynthNode: no ready message received from worklet after 2s - proceeding anyway.');
          this._ready = true;
          resolve();
        }
      }, 2000);
    });

    return readyPromise;
  }

  /**
   * Internal message dispatcher
   */
  _handleMessage(data) {
    if (!data) return;
    // emit event-like callbacks
    if (data.type) {
      this._callHandlers(data.type, data);
    }
    // example: the processor might post parameter updates or status
    if (data.paramUpdate) {
      // update local cache if needed
      Object.entries(data.paramUpdate).forEach(([k, v]) => this._paramCache.set(k, v));
    }
  }

  /**
   * Register a message-type handler: fn(typeData)
   */
  on(type, fn) {
    this._onmessageHandlers.push({ type, fn });
  }

  _callHandlers(type, data) {
    this._onmessageHandlers.forEach(h => {
      if (h.type === type || h.type === '*') {
        try { h.fn(data); } catch (e) { console.error('MiniSynthNode handler error', e); }
      }
    });
  }

  /**
   * Connect to destination or other AudioNode
   */
  connect(destination) {
    if (!this.node) {
      console.warn('MiniSynthNode: connect called before init');
      return;
    }
    this.node.connect(destination);
  }

  /**
   * Disconnect
   */
  disconnect() {
    if (this.node) this.node.disconnect();
  }

  /**
   * Set a parameter. If the parameter name corresponds to an AudioParam on the worklet
   * (this.node.parameters has it) we set the AudioParam. Otherwise we send via port message.
   *
   * @param {string} name
   * @param {number|string|boolean} value
   * @param {Object} opts - optional: { ramp: 'linear'|'exponential', time: seconds, now: false }
   */
  setParam(name, value, opts = {}) {
    if (!this.node) {
      // cache locally until ready
      this._paramCache.set(name, value);
      this._pendingMessages.push({ msg: { type: 'param', name, value }, transfer: [] });
      return;
    }

    const audioParam = this.node.parameters.get(name);
    if (audioParam) {
      if (opts && opts.ramp && typeof opts.time === 'number') {
        const t = this.context.currentTime;
        if (opts.ramp === 'linear') {
          audioParam.cancelScheduledValues(t);
          audioParam.linearRampToValueAtTime(value, t + opts.time);
        } else if (opts.ramp === 'exponential') {
          audioParam.cancelScheduledValues(t);
          // exponential ramp must use positive values
          audioParam.exponentialRampToValueAtTime(Math.max(0.000001, value), t + opts.time);
        } else {
          audioParam.setValueAtTime(value, t);
        }
      } else {
        audioParam.setValueAtTime(value, this.context.currentTime);
      }
    } else {
      // not an AudioParam, send over message port
      this.postMessage({ type: 'param', name, value });
      this._paramCache.set(name, value);
    }
  }

  /**
   * Get a local cached param value if available.
   */
  getParam(name) {
    const audioParam = this.node && this.node.parameters.get(name);
    if (audioParam) return audioParam.value;
    return this._paramCache.get(name);
  }

  /**
   * Post a message to the processor. If node not ready, enqueue.
   * @param {Object} msg
   * @param {ArrayBuffer[]} transfer - optionally transfer typed arrays
   */
  postMessage(msg, transfer = []) {
    if (!this.node || !this._ready) {
      // queue until ready
      this._pendingMessages.push({ msg, transfer });
      // still update local cache for param-style messages
      if (msg && msg.type === 'param' && msg.name) this._paramCache.set(msg.name, msg.value);
      return;
    }
    try {
      this.node.port.postMessage(msg, transfer);
    } catch (err) {
      console.error('MiniSynthNode.postMessage error:', err, msg);
    }
  }

  /**
   * Convenience: schedule a noteOn
   * @param {Object} note - { midi, freq, velocity, time }
   */
  noteOn(note = {}) {
    const msg = { type: 'noteOn', midi: note.midi, freq: note.freq, velocity: note.velocity ?? 1.0, time: note.time ?? 0 };
    this.postMessage(msg);
  }

  /**
   * Convenience: schedule a noteOff
   */
  noteOff(note = {}) {
    const msg = { type: 'noteOff', midi: note.midi, freq: note.freq, time: note.time ?? 0 };
    this.postMessage(msg);
  }

  /**
   * Convenience: load sample into the processor
   * We recommend transferring Float32Array channel buffers as Transferables.
   * @param {String} sampleId - user key
   * @param {Float32Array[]} channels - array of Float32Array typed arrays (transfer these)
   * @param {Number} sampleRate - sample rate of the buffers
   */
  loadSample(sampleId, channels, sampleRate) {
    // send metadata first
    const meta = { type: 'load-sample-meta', id: sampleId, channels: channels.length, sampleRate };
    const transfer = channels.map(ch => ch.buffer);
    this.postMessage(meta, transfer);
    // then send actual channel data message (some processors expect single message)
    // You can also combine meta + channels in one message if the processor accepts it.
    const payload = { type: 'load-sample-data', id: sampleId, channels };
    this.postMessage(payload, transfer);
  }

  /**
   * Dispose / release
   */
  dispose() {
    if (this.node) {
      try { this.node.port.postMessage({ type: 'dispose' }); } catch {}
      try { this.node.disconnect(); } catch {}
      try { this.node = null; } catch {}
    }
    this._ready = false;
  }
}

// Export to window/global so it can be used in simple script includes
if (typeof window !== 'undefined') {
  window.MiniSynthNode = MiniSynthNode;
}
// FIX: Removed "export default MiniSynthNode;" to prevent SyntaxError with non-module script tag.
