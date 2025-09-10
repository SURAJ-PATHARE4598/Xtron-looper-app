/**
 * main.js - Main UI and application logic for the sampler synth.
 *
 * This file handles:
 * - DOM element references and UI event listeners (piano, sliders, file input).
 * - Initializing the AudioContext and the `MiniSynthNode` which wraps our AudioWorklet.
 * - Loading an audio file, decoding it, and transferring the data to the worklet.
 * - Translating UI events (key presses, slider moves) into messages for the AudioWorklet.
 * - Drawing the audio waveform and selection handles on the canvas.
 */
document.addEventListener('DOMContentLoaded', () => {
  /* -------------------------
     Config / Globals
     ------------------------- */
  let audioCtx = null;
  let synthNode = null;
  let audioBuffer = null;
  let sampleStart = 0;
  let sampleEnd = 1;
  const activeNotes = new Map();

  // DOM refs
  const audioFile = document.getElementById('audioFile');
  const waveformCanvas = document.getElementById('waveformCanvas');
  const ctx = waveformCanvas.getContext('2d');
  const pianoContainer = document.getElementById('piano-container');

  // ADSR controls
  const controls = {
    attack: document.getElementById('attackSlider'),
    decay: document.getElementById('decaySlider'),
    sustain: document.getElementById('sustainSlider'),
    release: document.getElementById('releaseSlider'),
  };
  const controlValues = {
    attack: document.getElementById('attackValue'),
    decay: document.getElementById('decayValue'),
    sustain: document.getElementById('sustainValue'),
    release: document.getElementById('releaseValue'),
  };

  const updateAdsrDisplays = () => {
    controlValues.attack.textContent = `${parseFloat(controls.attack.value).toFixed(2)}s`;
    controlValues.decay.textContent = `${parseFloat(controls.decay.value).toFixed(2)}s`;
    controlValues.sustain.textContent = `${parseFloat(controls.sustain.value).toFixed(2)}`;
    controlValues.release.textContent = `${parseFloat(controls.release.value).toFixed(2)}s`;
  };

  // ===================================================================
  // === UPDATED FOR 24 NOTES (C4 to B5) ===============================
  // ===================================================================
  const noteSemitoneOffsets = {
    'C4': -9, 'C#4': -8, 'D4': -7, 'D#4': -6, 'E4': -5, 'F4': -4, 'F#4': -3, 'G4': -2, 'G#4': -1, 'A4': 0, 'A#4': 1, 'B4': 2,
    'C5': 3, 'C#5': 4, 'D5': 5, 'D#5': 6, 'E5': 7, 'F5': 8, 'F#5': 9, 'G5': 10, 'G#5': 11, 'A5': 12, 'A#5': 13, 'B5': 14
  };

  /* -------------------------
     UI Helpers
     ------------------------- */
  const createMessageBox = (message, type = 'info') => {
    const container = document.createElement('div');
    container.className = `fixed bottom-4 right-4 p-4 rounded-lg shadow-xl text-white z-50 transition-all duration-300 transform`;

    const colors = { info: 'bg-blue-500', success: 'bg-emerald-500', error: 'bg-red-500' };
    container.classList.add(colors[type] || 'bg-gray-700');
    container.textContent = message;
    document.body.appendChild(container);

    setTimeout(() => container.style.transform = 'translateY(0)', 10);
    setTimeout(() => {
        container.style.transform = 'translateY(200%)';
        setTimeout(() => container.remove(), 300);
    }, 3500);
  };

  /* -------------------------
     Audio & Worklet Initialization
     ------------------------- */
  const initEngine = async () => {
    if (audioCtx) return;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') await audioCtx.resume();

        // FIX: Corrected path to worklet processor to match file structure.
        synthNode = new window.MiniSynthNode(audioCtx, { workletUrl: 'mini-synth-processor.js' });
        await synthNode.init();
        synthNode.connect(audioCtx.destination);
        createMessageBox('Synth engine initialized!', 'success');
    } catch (err) {
        console.error('Failed to initialize audio engine:', err);
        createMessageBox('Audio engine failed to start. Check console.', 'error');
    }
  };

  document.body.addEventListener('click', initEngine, { once: true });
  document.body.addEventListener('touchend', initEngine, { once: true });

  /* -------------------------
     Waveform Drawing & Selection
     ------------------------- */
  const drawWaveform = () => {
    if (!audioBuffer) {
      ctx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
      return;
    }
    const width = waveformCanvas.width;
    const height = waveformCanvas.height;
    const data = audioBuffer.getChannelData(0);
    const step = Math.ceil(data.length / width);
    const amp = height / 2;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(0, 0, width, height);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#34d399';

    ctx.beginPath();
    for (let i = 0; i < width; i++) {
      let min = 1.0, max = -1.0;
      for (let j = 0; j < step; j++) {
        const datum = data[(i * step) + j];
        if (datum < min) min = datum;
        if (datum > max) max = datum;
      }
      ctx.moveTo(i, (1 + min) * amp);
      ctx.lineTo(i, (1 + max) * amp);
    }
    ctx.stroke();

    const sx = Math.round(sampleStart * width);
    const ex = Math.round(sampleEnd * width);
    ctx.fillStyle = 'rgba(59, 130, 246, 0.25)';
    ctx.fillRect(sx, 0, Math.max(2, ex - sx), height);

    document.getElementById('startMarker').style.left = `${sx}px`;
    document.getElementById('endMarker').style.left = `${ex}px`;
  };

  const resizeCanvas = () => {
    waveformCanvas.width = waveformCanvas.clientWidth;
    waveformCanvas.height = waveformCanvas.clientHeight;
    drawWaveform();
  };
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  let activeMarker = null;
  const handleDragStart = (e) => {
    if (!audioBuffer) return;
    const rect = waveformCanvas.getBoundingClientRect();
    const x = (e.clientX || e.touches[0].clientX) - rect.left;
    const sx = sampleStart * rect.width;
    const ex = sampleEnd * rect.width;
    if (Math.abs(x - sx) < 20) activeMarker = 'start';
    else if (Math.abs(x - ex) < 20) activeMarker = 'end';
    else {
      activeMarker = 'new';
      sampleStart = sampleEnd = Math.max(0, Math.min(1, x / rect.width));
    }
    e.preventDefault();
  };

  const handleDragMove = (e) => {
    if (!activeMarker) return;
    const rect = waveformCanvas.getBoundingClientRect();
    const x = (e.clientX || e.touches[0].clientX) - rect.left;
    const p = Math.max(0, Math.min(1, x / rect.width));

    if (activeMarker === 'start') sampleStart = Math.min(p, sampleEnd);
    else if (activeMarker === 'end') sampleEnd = Math.max(p, sampleStart);
    else if (activeMarker === 'new') {
        sampleEnd = p;
        if (sampleEnd < sampleStart) [sampleStart, sampleEnd] = [sampleEnd, sampleStart];
    }
    drawWaveform();
  };

  const handleDragEnd = () => {
    if (activeMarker) transferSampleToWorklet();
    activeMarker = null;
  };

  waveformCanvas.addEventListener('mousedown', handleDragStart);
  window.addEventListener('mousemove', handleDragMove);
  window.addEventListener('mouseup', handleDragEnd);
  waveformCanvas.addEventListener('touchstart', handleDragStart, { passive: false });
  window.addEventListener('touchmove', handleDragMove, { passive: false });
  window.addEventListener('touchend', handleDragEnd);

  /* -------------------------
     Sample Loading & Transfer
     ------------------------- */
   const transferSampleToWorklet = () => {
     if (!audioBuffer || !synthNode) return;
     const startFrame = Math.floor(sampleStart * audioBuffer.length);
     const endFrame = Math.floor(sampleEnd * audioBuffer.length);
     const segmentLength = endFrame - startFrame;

     if (segmentLength <= 0) return;

     const monoData = new Float32Array(segmentLength);
     audioBuffer.copyFromChannel(monoData, 0, startFrame);
     synthNode.loadSample('user-sample', [monoData], audioBuffer.sampleRate);
   };

  audioFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await initEngine();
    try {
      const arrayBuffer = await file.arrayBuffer();
      audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      sampleStart = 0; sampleEnd = 1;
      resizeCanvas();
      transferSampleToWorklet();
      createMessageBox('Sample loaded!', 'success');
    } catch (err) {
      console.error('Error loading sample:', err);
      createMessageBox('Failed to load audio file.', 'error');
    }
  });

  /* -------------------------
     Piano Keyboard Logic
     ------------------------- */
  const playNote = (note, keyElement) => {
    if (!audioBuffer || !synthNode) {
      createMessageBox('Upload a sample first.', 'error');
      return;
    }
    keyElement.classList.add('active');
    const midi = 69 + noteSemitoneOffsets[note];
    synthNode.noteOn({ midi });
    activeNotes.set(note, { keyElement });
  };

  const stopNote = (note) => {
    if (!activeNotes.has(note) || !synthNode) return;
    const { keyElement } = activeNotes.get(note);
    if (keyElement) keyElement.classList.remove('active');
    activeNotes.delete(note);
    const midi = 69 + noteSemitoneOffsets[note];
    synthNode.noteOff({ midi });
  };

  for (const [name, slider] of Object.entries(controls)) {
    slider.addEventListener('input', () => {
      if (synthNode) synthNode.setParam(name, parseFloat(slider.value));
      updateAdsrDisplays();
    });
  }
  updateAdsrDisplays();

  // ===================================================================
  // === DYNAMIC 2-OCTAVE PIANO RENDERING LOGIC ========================
  // ===================================================================
  const renderPiano = () => {
    pianoContainer.innerHTML = '';
    const notes = Object.keys(noteSemitoneOffsets);
    const whiteNotes = notes.filter(note => !note.includes('#'));
    const whiteKeyCount = whiteNotes.length;
    const whiteKeyWidth = 100 / whiteKeyCount;

    let whiteKeyIndex = 0;
    notes.forEach(note => {
        const key = document.createElement('div');
        key.dataset.note = note;
        const isBlack = note.includes('#');

        if (isBlack) {
            key.className = 'black-key';
            // Position black key halfway between its two surrounding white keys
            const offset = (whiteKeyIndex - 0.5) * whiteKeyWidth;
            key.style.left = `${offset}%`;
        } else {
            key.className = 'white-key';
            key.style.left = `${whiteKeyIndex * whiteKeyWidth}%`;
            whiteKeyIndex++;
        }
        pianoContainer.appendChild(key);
    });
  };
  renderPiano();

  // Mouse/touch events
  pianoContainer.addEventListener('mousedown', (e) => {
    const key = e.target.closest('[data-note]');
    if (key) playNote(key.dataset.note, key);
  });
  pianoContainer.addEventListener('mouseup', (e) => {
    const key = e.target.closest('[data-note]');
    if (key) stopNote(key.dataset.note);
  });
  pianoContainer.addEventListener('mouseleave', () => activeNotes.forEach((v, note) => stopNote(note)));

  pianoContainer.addEventListener('touchstart', (e) => {
    e.preventDefault();
    Array.from(e.changedTouches).forEach(touch => {
        const el = document.elementFromPoint(touch.clientX, touch.clientY);
        const key = el?.closest('[data-note]');
        if (key) playNote(key.dataset.note, key);
    });
  }, { passive: false });

  pianoContainer.addEventListener('touchend', (e) => {
    e.preventDefault();
    activeNotes.forEach((v, note) => stopNote(note));
  }, { passive: false });
});
