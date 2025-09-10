// main.js - improved main synthesizer logic
// - integrates with MiniSynthNode wrapper (if available) and/or PhaseVocoderBundle
// - robust sample transfer to AudioWorklet using Float32Array Transferables
// - safer WASM handling / cross-origin isolation fallback
// - improved UI wiring and comments

document.addEventListener('DOMContentLoaded', async () => {
  /* -------------------------
     Config / Globals
     ------------------------- */
  let audioCtx = null;
  let synthNode = null;            // MiniSynthNode instance (wrapper)
  let audioBuffer = null;          // decoded AudioBuffer of uploaded file
  let sampleStart = 0;             // 0..1 normalized selection
  let sampleEnd = 1;               // 0..1 normalized selection
  const activeNotes = new Map();   // map note -> { noteId, keyElement }
  const MAX_POLYPHONY = 12;

  // DOM refs
  const audioFile = document.getElementById('audioFile');
  const waveformCanvas = document.getElementById('waveformCanvas');
  const ctx = waveformCanvas.getContext('2d');
  const piano = document.getElementById('piano');

  // ADSR controls
  const attackSlider = document.getElementById('attackSlider');
  const decaySlider = document.getElementById('decaySlider');
  const sustainSlider = document.getElementById('sustainSlider');
  const releaseSlider = document.getElementById('releaseSlider');
  const attackValue = document.getElementById('attackValue');
  const decayValue = document.getElementById('decayValue');
  const sustainValue = document.getElementById('sustainValue');
  const releaseValue = document.getElementById('releaseValue');

  // ADSR UI update
  const updateAdsrDisplays = () => {
    attackValue.textContent = `${parseFloat(attackSlider.value).toFixed(2)}s`;
    decayValue.textContent = `${parseFloat(decaySlider.value).toFixed(2)}s`;
    sustainValue.textContent = `${parseFloat(sustainSlider.value).toFixed(2)}`;
    releaseValue.textContent = `${parseFloat(releaseSlider.value).toFixed(2)}s`;
  };
  attackSlider.oninput = updateAdsrDisplays;
  decaySlider.oninput = updateAdsrDisplays;
  sustainSlider.oninput = updateAdsrDisplays;
  releaseSlider.oninput = updateAdsrDisplays;
  updateAdsrDisplays();

  // semitone offsets used by piano (relative to A4 = 440Hz)
  const noteSemitoneOffsets = {
    'C4': -9, 'C#4': -8, 'D4': -7, 'D#4': -6, 'E4': -5, 'F4': -4, 'F#4': -3,
    'G4': -2, 'G#4': -1, 'A4': 0, 'A#4': 1, 'B4': 2, 'C5': 3, 'C#5': 4
  };

  /* -------------------------
     Small helper functions
     ------------------------- */
  const createMessageBox = (message, type = 'info') => {
    const container = document.createElement('div');
    container.className = `mini-msg ${type}`;
    container.textContent = message;
    document.body.appendChild(container);
    // simple fade in/out
    container.style.transition = 'transform .25s ease, opacity .25s ease';
    container.style.transform = 'translateY(10px)';
    container.style.opacity = '0';
    requestAnimationFrame(() => {
      container.style.transform = 'translateY(0)';
      container.style.opacity = '1';
    });
    setTimeout(() => {
      container.style.transform = 'translateY(10px)';
      container.style.opacity = '0';
      setTimeout(() => container.remove(), 400);
    }, 3500);
  };

  // frequency from semitone offset relative to A4(440Hz)
  const freqFromSemitones = (semitones) => 440 * Math.pow(2, semitones / 12);

  /* -------------------------
     Audio & Worklet initialization
     ------------------------- */
  const ensureAudioContext = async () => {
    if (audioCtx) return audioCtx;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  };

  // Initialize MiniSynthNode wrapper and/or PhaseVocoderBundle
  const initEngine = async () => {
    await ensureAudioContext();

    // If MiniSynthNode wrapper is available, use it.
    // We pass workletUrl so the wrapper will call addModule for the worklet processor.
    if (typeof window.MiniSynthNode !== 'undefined') {
      try {
        synthNode = new window.MiniSynthNode(audioCtx, {
          workletUrl: 'audio/mini-synth-processor.js',
        });
        await synthNode.init();
        synthNode.connect(audioCtx.destination);
        createMessageBox('MiniSynth worklet initialized', 'success');
      } catch (err) {
        console.warn('MiniSynthNode failed to initialize:', err);
        createMessageBox('MiniSynth worklet failed. See console.', 'error');
      }
    } else {
      console.warn('MiniSynthNode wrapper not found; falling back to PhaseVocoderBundle if available.');
    }

    // If the PhaseVocoderBundle exists in the global scope, call its init paths.
    if (typeof PhaseVocoderBundle !== 'undefined') {
      try {
        if (!audioCtx) await ensureAudioContext();
        await PhaseVocoderBundle.init(audioCtx); // some bundles require this pattern
        createMessageBox('PhaseVocoderBundle initialized', 'success');

        // Try load wasm (if the bundle exposes loadWasmFromUrl). Might throw if not present.
        if (typeof PhaseVocoderBundle.loadWasmFromUrl === 'function') {
          try {
            await PhaseVocoderBundle.loadWasmFromUrl('./PhaseVocoderModule.wasm');
            createMessageBox('Phase vocoder WASM loaded', 'success');
          } catch (err) {
            console.warn('WASM load failed:', err);
            createMessageBox('PhaseVocoder WASM load failed (check console).', 'error');
          }
        }
      } catch (err) {
        console.warn('PhaseVocoderBundle init failed or not present:', err);
      }
    } else {
      console.debug('PhaseVocoderBundle not found (it may be optional).');
    }
  };

  // call init but don't block UI
  initEngine().catch(err => {
    console.error('initEngine error', err);
  });

  /* -------------------------
     Waveform drawing utilities
     ------------------------- */
  const drawWaveform = () => {
    if (!audioBuffer) {
      // clear canvas
      ctx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
      return;
    }
    const width = waveformCanvas.width;
    const height = waveformCanvas.height;
    const data = audioBuffer.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / width));
    const amp = height / 2;

    // background
    ctx.fillStyle = '#2b2f33';
    ctx.fillRect(0, 0, width, height);

    // waveform
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#35f29a';
    ctx.beginPath();

    for (let i = 0; i < width; i++) {
      const start = i * step;
      let min = 1.0, max = -1.0;
      for (let j = 0; j < step && (start + j) < data.length; j++) {
        const v = data[start + j];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const y = Math.round((1 + ((min + max) / 2)) * amp);
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
    ctx.stroke();

    // selection overlay
    const sx = Math.round(sampleStart * width);
    const ex = Math.round(sampleEnd * width);
    ctx.fillStyle = 'rgba(15, 185, 129, 0.12)';
    ctx.fillRect(sx, 0, Math.max(2, ex - sx), height);

    // markers
    const startMarker = document.getElementById('startMarker');
    const endMarker = document.getElementById('endMarker');
    if (startMarker) startMarker.style.left = `${sx}px`;
    if (endMarker) endMarker.style.left = `${ex}px`;
  };

  // Resizing handler
  const resizeCanvas = () => {
    waveformCanvas.width = waveformCanvas.clientWidth;
    waveformCanvas.height = waveformCanvas.clientHeight;
    drawWaveform();
  };
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  /* -------------------------
     Marker drag / selection interactions
     ------------------------- */
  let activeMarker = null;
  let dragStartX = 0;
  waveformCanvas.addEventListener('mousedown', (e) => {
    const rect = waveformCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const width = rect.width;
    const sx = sampleStart * width;
    const ex = sampleEnd * width;

    // within 12px of marker -> drag
    if (Math.abs(x - sx) < 12) activeMarker = 'start';
    else if (Math.abs(x - ex) < 12) activeMarker = 'end';
    else {
      // start new selection
      activeMarker = 'new';
      dragStartX = x;
      sampleStart = Math.max(0, Math.min(1, x / width));
      sampleEnd = sampleStart;
    }
    e.preventDefault();
  });

  waveformCanvas.addEventListener('mousemove', (e) => {
    if (!activeMarker) return;
    const rect = waveformCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const width = rect.width;
    let p = Math.max(0, Math.min(1, x / width));
    if (activeMarker === 'start') {
      if (p < sampleEnd) sampleStart = p;
    } else if (activeMarker === 'end') {
      if (p > sampleStart) sampleEnd = p;
    } else if (activeMarker === 'new') {
      const p0 = Math.max(0, Math.min(1, dragStartX / width));
      sampleStart = Math.min(p0, p);
      sampleEnd = Math.max(p0, p);
    }
    drawWaveform();
  });

  const finishDragging = () => {
    if (!activeMarker) return;
    activeMarker = null;
    // optional: notify engine to update sample region if required
  };
  waveformCanvas.addEventListener('mouseup', finishDragging);
  waveformCanvas.addEventListener('mouseleave', finishDragging);

  // touch support for mobile
  waveformCanvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    const rect = waveformCanvas.getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const width = rect.width;
    const sx = sampleStart * width;
    const ex = sampleEnd * width;
    if (Math.abs(x - sx) < 12) activeMarker = 'start';
    else if (Math.abs(x - ex) < 12) activeMarker = 'end';
    else {
      activeMarker = 'new';
      dragStartX = x;
      sampleStart = Math.max(0, Math.min(1, x / width));
      sampleEnd = sampleStart;
    }
  });
  waveformCanvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (!activeMarker) return;
    const touch = e.touches[0];
    const rect = waveformCanvas.getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const width = rect.width;
    let p = Math.max(0, Math.min(1, x / width));
    if (activeMarker === 'start') {
      if (p < sampleEnd) sampleStart = p;
    } else if (activeMarker === 'end') {
      if (p > sampleStart) sampleEnd = p;
    } else if (activeMarker === 'new') {
      const p0 = Math.max(0, Math.min(1, dragStartX / width));
      sampleStart = Math.min(p0, p);
      sampleEnd = Math.max(p0, p);
    }
    drawWaveform();
  });
  waveformCanvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    finishDragging();
  });

  /* -------------------------
     Sample loading and transfer to worklet / WASM
     ------------------------- */
  audioFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await ensureAudioContext();
      const arrayBuffer = await file.arrayBuffer();

      // decodeAudioData - MDN recommended pattern returns a Promise
      // See: https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData
      const buffer = await audioCtx.decodeAudioData(arrayBuffer);
      audioBuffer = buffer;
      sampleStart = 0; sampleEnd = 1;
      resizeCanvas();
      drawWaveform();
      createMessageBox('Sample loaded and decoded', 'success');

      // Prepare selected segment (mono) as Float32Array
      const startFrame = Math.floor(sampleStart * audioBuffer.length);
      const endFrame = Math.floor(sampleEnd * audioBuffer.length);
      const length = Math.max(1, endFrame - startFrame);
      const channels = Math.min(2, audioBuffer.numberOfChannels); // send up to stereo
      const channelArrays = [];
      for (let ch = 0; ch < channels; ch++) {
        const src = audioBuffer.getChannelData(ch).subarray(startFrame, endFrame);
        // Copy into a new Float32Array (transferable)
        const arr = new Float32Array(src.length);
        arr.set(src);
        channelArrays.push(arr);
      }

      // If synthNode exists, use its loadSample helper to transfer
      if (synthNode && typeof synthNode.loadSample === 'function') {
        try {
          synthNode.loadSample('user-sample', channelArrays, audioBuffer.sampleRate);
          createMessageBox('Sample transferred to synth worklet', 'success');
        } catch (err) {
          console.warn('synthNode.loadSample failed, falling back to PhaseVocoderBundle:', err);
          // fallback to PhaseVocoderBundle if available
          if (typeof PhaseVocoderBundle !== 'undefined' && PhaseVocoderBundle.isWasmReady && PhaseVocoderBundle.isWasmReady()) {
            try {
              PhaseVocoderBundle.loadSample(channelArrays[0], audioBuffer.sampleRate);
              createMessageBox('Sample loaded into PhaseVocoderBundle', 'success');
            } catch (e) {
              console.error('PhaseVocoderBundle.loadSample failed', e);
              createMessageBox('Failed to load sample into PhaseVocoderBundle (see console)', 'error');
            }
          }
        }
      } else if (typeof PhaseVocoderBundle !== 'undefined' && PhaseVocoderBundle.isWasmReady && PhaseVocoderBundle.isWasmReady()) {
        // No worklet wrapper; try PhaseVocoder directly
        try {
          PhaseVocoderBundle.loadSample(channelArrays[0], audioBuffer.sampleRate);
          createMessageBox('Sample loaded into PhaseVocoderBundle', 'success');
        } catch (err) {
          console.error('PhaseVocoder load failed', err);
          createMessageBox('PhaseVocoder sample load failed (see console)', 'error');
        }
      } else {
        createMessageBox('No synth or phase vocoder available to receive sample.', 'error');
      }
    } catch (err) {
      console.error('Error loading sample:', err);
      createMessageBox('Failed to load audio file. See console for details.', 'error');
    }
  });

  /* -------------------------
     Piano keyboard play / stop
     - uses synthNode.noteOn/noteOff when available
     - otherwise uses PhaseVocoderBundle.startNote / stopNote if available
     ------------------------- */
  const playNote = (note, keyElement) => {
    if (!audioBuffer) {
      createMessageBox('Upload a sample first.', 'error');
      return;
    }

    keyElement.classList.add('active');
    const semitoneOffset = noteSemitoneOffsets[note];
    const freq = freqFromSemitones(semitoneOffset);

    // If we have a synthNode wrapper, ask it to play the note
    if (synthNode && typeof synthNode.noteOn === 'function') {
      try {
        synthNode.noteOn({ midi: 60 + semitoneOffset, freq, velocity: 1.0 });
        activeNotes.set(note, { keyElement, via: 'synth' });
        return;
      } catch (err) {
        console.warn('synthNode.noteOn error', err);
      }
    }

    // fallback to PhaseVocoderBundle if present
    if (typeof PhaseVocoderBundle !== 'undefined' && PhaseVocoderBundle.isWasmReady && PhaseVocoderBundle.isWasmReady()) {
      try {
        // startNote usually expects semitone offset and optional options
        const noteId = PhaseVocoderBundle.startNote('note-' + note, semitoneOffset, {
          gain: 1.0,
          attack: parseFloat(attackSlider.value),
          decay: parseFloat(decaySlider.value),
          sustain: parseFloat(sustainSlider.value),
          release: parseFloat(releaseSlider.value)
        });
        activeNotes.set(note, { noteId, keyElement, via: 'pv' });
        return;
      } catch (err) {
        console.error('PhaseVocoderBundle.startNote failed', err);
        createMessageBox('Failed to start note with PhaseVocoderBundle (console).', 'error');
      }
    }

    // If no engine is available, warn the user
    createMessageBox('No synthesis engine available — initialize the engine first.', 'error');
  };

  const stopNote = (note) => {
    if (!activeNotes.has(note)) return;
    const info = activeNotes.get(note);
    if (info.via === 'synth' && synthNode && typeof synthNode.noteOff === 'function') {
      synthNode.noteOff({ midi: 60 + noteSemitoneOffsets[note] });
    } else if (info.via === 'pv' && typeof PhaseVocoderBundle !== 'undefined') {
      try {
        PhaseVocoderBundle.stopNote(info.noteId);
      } catch (err) {
        console.warn('PhaseVocoderBundle.stopNote error', err);
      }
    }
    if (info.keyElement) info.keyElement.classList.remove('active');
    activeNotes.delete(note);
  };

  // Mouse / touch events on piano UI
  piano.addEventListener('mousedown', (e) => {
    const targetKey = e.target.closest('.white-key, .black-key');
    if (!targetKey) return;
    const note = targetKey.dataset.note;
    if (!note) return;
    if (!activeNotes.has(note)) playNote(note, targetKey);
  }, false);

  piano.addEventListener('mouseup', (e) => {
    const targetKey = e.target.closest('.white-key, .black-key');
    if (!targetKey) return;
    const note = targetKey.dataset.note;
    if (!note) return;
    stopNote(note);
  }, false);

  // touch support: track each touch separately (simple approach)
  piano.addEventListener('touchstart', (e) => {
    e.preventDefault();
    for (const t of Array.from(e.touches)) {
      const el = document.elementFromPoint(t.clientX, t.clientY);
      const key = el && el.closest && el.closest('.white-key, .black-key');
      if (key) {
        const note = key.dataset.note;
        if (!activeNotes.has(note)) playNote(note, key);
      }
    }
  }, { passive: false });

  piano.addEventListener('touchend', (e) => {
    e.preventDefault();
    // release all notes - a more refined implementation would match touch identifiers
    activeNotes.forEach((v, k) => stopNote(k));
  }, { passive: false });

  /* -------------------------
     Expose a small API to console for testing
     ------------------------- */
  window.miniSynthDebug = {
    getAudioContext: () => audioCtx,
    getSynthNode: () => synthNode,
    loadSampleFromBuffer: async (buffer) => {
      // accepts an AudioBuffer - will transfer its first channel as Float32Array
      if (!buffer || !audioCtx) return;
      const arr = new Float32Array(buffer.getChannelData(0));
      if (synthNode && typeof synthNode.loadSample === 'function') {
        synthNode.loadSample('debug-sample', [arr], buffer.sampleRate);
      } else if (typeof PhaseVocoderBundle !== 'undefined') {
        PhaseVocoderBundle.loadSample(arr, buffer.sampleRate);
      }
    }
  };

  /* -------------------------
     Small info / help on startup
     ------------------------- */
  setTimeout(() => {
    if (!audioCtx) createMessageBox('Click anywhere or load a sample to initialize audio.', 'info');
  }, 1500);

  /* -------------------------
     Notes on implementation & references
     - decodeAudioData usage: MDN. :contentReference[oaicite:3]{index=3}
     - WebAssembly in AudioWorklet: prefer instantiation inside the worklet or using design pattern by Chrome team. :contentReference[oaicite:4]{index=4}
     - Cross-origin isolation needed for SharedArrayBuffer zero-copy transfers: web.dev guide. :contentReference[oaicite:5]{index=5}
     ------------------------- */
});
