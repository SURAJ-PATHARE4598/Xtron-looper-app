// main.js - full replacement (copy-paste)
// Groovestation-Pro - robust UI + AudioWorklet hookup

document.addEventListener('DOMContentLoaded', async () => {
  /* -------------------------
     Globals & DOM refs
     ------------------------- */
  let audioCtx = null;
  let synthNode = null;
  let audioBuffer = null;
  let isReady = false;
  let sampleStart = 0;
  let sampleEnd = 1;

  const audioFile = document.getElementById('audioFile');
  const waveformCanvas = document.getElementById('waveformCanvas');
  const canvasCtx = waveformCanvas ? waveformCanvas.getContext('2d') : null;
  const pianoContainer = document.querySelector('.piano-container');

  // UI params (safe lookup)
  function safeParam(id) {
    const slider = document.getElementById(id);
    return { slider, value: slider ? document.getElementById(id.replace('Slider','Value')) : null };
  }
  const uiParams = {
    attack: safeParam('attackSlider'),
    decay: safeParam('decaySlider'),
    sustain: safeParam('sustainSlider'),
    release: safeParam('releaseSlider'),
    filterCutoff: safeParam('filterCutoffSlider'),
    filterResonance: safeParam('filterResonanceSlider')
  };

  /* -------------------------
     Debug UI
     ------------------------- */
  const debugPanel = document.createElement('div');
  debugPanel.id = 'app-debug';
  Object.assign(debugPanel.style, {
    position: 'fixed',
    left: '12px',
    top: '12px',
    zIndex: 99999,
    background: 'rgba(0,0,0,0.55)',
    color: '#fff',
    padding: '6px 8px',
    borderRadius: '6px',
    fontSize: '12px',
    pointerEvents: 'none'
  });
  debugPanel.textContent = 'debug: init';
  document.body.appendChild(debugPanel);
  const setDebug = (t) => { debugPanel.textContent = 'debug: ' + t; console.log('DEBUG:', t); };

  /* -------------------------
     Toast helper
     ------------------------- */
  let toastTimer = null;
  const createMessageBox = (message, type = 'info') => {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.className = 'toast';
    div.textContent = message;
    document.body.appendChild(div);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { div.remove(); }, 3500);
    console.log('TOAST:', message);
  };

  /* -------------------------
     Audio engine init
     ------------------------- */
  async function initAudioEngine() {
    if (audioCtx) return;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // Add worklet module and create node
      await audioCtx.audioWorklet.addModule('synth-processor.js');
      synthNode = new AudioWorkletNode(audioCtx, 'synth-processor', { outputChannelCount: [2] });
      synthNode.connect(audioCtx.destination);

      // hook messages
      synthNode.port.onmessage = (e) => {
        const d = e.data;
        if (!d) return;
        if (d.type === 'ready') {
          isReady = true;
          setDebug('synth ready');
          createMessageBox('Synth engine ready', 'success');
          // send current params
          Object.entries(uiParams).forEach(([name, el]) => { if (el && el.slider) sendParamToWorklet(name, el.slider.value); });
        } else if (d.type === 'log') {
          console.log('[worklet]', d.msg);
        }
      };

      // try load wasm (optional) - fetch & transfer buffer to worklet so it can instantiate
      try {
        const wasmResp = await fetch('PhaseVocoderModule.wasm');
        if (wasmResp.ok) {
          const wasmBuf = await wasmResp.arrayBuffer();
          // transfer the buffer to worklet; worklet will instantiate or ignore if not needed
          synthNode.port.postMessage({ type: 'init-wasm', wasmBuffer: wasmBuf }, [wasmBuf]);
        } else {
          console.warn('No wasm found or fetch failed:', wasmResp.status);
        }
      } catch (err) {
        console.warn('WASM fetch failed (optional):', err);
      }

      setDebug('audio engine initialized');
    } catch (err) {
      console.error('initAudioEngine error:', err);
      createMessageBox('Failed to initialize audio engine', 'error');
      setDebug('audio engine failed');
    }
  }

  function sendParamToWorklet(name, value) {
    if (!synthNode) return;
    try { synthNode.port.postMessage({ type: 'param', name, value: parseFloat(value) }); }
    catch (e) { console.warn('sendParamToWorklet failed', e); }
  }

  /* -------------------------
     Parameter UI hookup
     ------------------------- */
  function setupParamListeners() {
    try {
      Object.entries(uiParams).forEach(([name, el]) => {
        if (!el || !el.slider) return;
        el.slider.oninput = () => {
          const val = parseFloat(el.slider.value);
          if (el.value) {
            if (name === 'sustain') el.value.textContent = val.toFixed(2);
            else if (name.includes('filterResonance')) el.value.textContent = val.toFixed(1);
            else if (name.includes('filterCutoff')) el.value.textContent = `${Math.round(val)} Hz`;
            else el.value.textContent = `${val.toFixed(2)}s`;
          }
          sendParamToWorklet(name, val);
        };
        // init display
        el.slider.dispatchEvent(new Event('input'));
      });
    } catch (err) {
      console.warn('setupParamListeners error', err);
    }
  }

  /* -------------------------
     Piano creation & handlers
     ------------------------- */
  const noteLayoutLabels = [ 'C4','C#4','D4','D#4','E4','F4','F#4','G4','G#4','A4','A#4','B4','C5','C#5','D5','D#5','E5' ];
  const noteSemitoneOffsets = Object.fromEntries(noteLayoutLabels.map((note,i)=>[note, i-9]));

  function playNote(note) {
    if (!isReady) { createMessageBox('Audio engine not ready', 'error'); setDebug('playNote blocked'); return; }
    if (!audioBuffer) { createMessageBox('Load a sample first', 'error'); setDebug('playNote no sample'); return; }
    const semitoneOffset = noteSemitoneOffsets[note] ?? 0;
    const pitchFactor = Math.pow(2, semitoneOffset / 12);
    synthNode.port.postMessage({
      type: 'noteOn',
      note,
      pitchFactor,
      loopStart: sampleStart,
      loopEnd: sampleEnd
    });
  }

  function stopNote(note) {
    if (!isReady || !audioBuffer) return;
    synthNode.port.postMessage({ type: 'noteOff', note });
  }

  function createPiano() {
    try {
      if (!pianoContainer) {
        console.error('createPiano: no .piano-container in DOM');
        return;
      }
      pianoContainer.innerHTML = '';
      const layout = [
        { note: 'C4', type: 'white' }, { note: 'C#4', type: 'black' },
        { note: 'D4', type: 'white' }, { note: 'D#4', type: 'black' },
        { note: 'E4', type: 'white' }, { note: 'F4', type: 'white' },
        { note: 'F#4', type: 'black' }, { note: 'G4', type: 'white' },
        { note: 'G#4', type: 'black' }, { note: 'A4', type: 'white' },
        { note: 'A#4', type: 'black' }, { note: 'B4', type: 'white' },
        { note: 'C5', type: 'white' }, { note: 'C#5', type: 'black' },
        { note: 'D5', type: 'white' }, { note: 'D#5', type: 'black' },
        { note: 'E5', type: 'white' }
      ];
      const whiteCount = layout.filter(k => k.type === 'white').length || 8;
      let whiteIndex = 0;
      layout.forEach(kinfo => {
        const el = document.createElement('div');
        el.className = `${kinfo.type}-key`;
        el.dataset.note = kinfo.note;
        if (kinfo.type === 'white') {
          const w = 100 / whiteCount;
          el.style.width = `${w}%`;
          el.style.left = `${whiteIndex * w}%`;
          whiteIndex++;
        } else {
          const w = 100 / whiteCount;
          const left = Math.max(0, (whiteIndex - 1) * w + w * 0.65);
          el.style.width = `${w * 0.6}%`;
          el.style.left = `${left}%`;
        }
        const lbl = document.createElement('div');
        lbl.style.position = 'absolute'; lbl.style.bottom='6px'; lbl.style.left='6px';
        lbl.style.fontSize = '11px'; lbl.textContent = kinfo.note;
        lbl.style.pointerEvents = 'none';
        lbl.style.color = kinfo.type === 'white' ? '#123' : '#fff';
        el.appendChild(lbl);
        pianoContainer.appendChild(el);
      });

      // debug badge
      const badge = document.createElement('div');
      badge.className = 'piano-debug-badge';
      Object.assign(badge.style, {
        position: 'absolute', right: '8px', top: '8px', background: 'rgba(0,0,0,0.35)',
        padding: '4px 8px', borderRadius: '8px', fontSize: '12px', color: '#fff', pointerEvents: 'none'
      });
      badge.textContent = `${pianoContainer.children.length} keys`;
      pianoContainer.appendChild(badge);

      // pointer events
      pianoContainer.addEventListener('pointerdown', (ev) => {
        const keyEl = ev.target.closest('[data-note]');
        if (!keyEl) return;
        try { keyEl.setPointerCapture(ev.pointerId); } catch(e){}
        keyEl.classList.add('active');
        playNote(keyEl.dataset.note);
      });
      pianoContainer.addEventListener('pointerup', (ev) => {
        const keyEl = ev.target.closest('[data-note]');
        if (!keyEl) return;
        try { keyEl.releasePointerCapture(ev.pointerId); } catch(e){}
        keyEl.classList.remove('active');
        stopNote(keyEl.dataset.note);
      });
      pianoContainer.addEventListener('pointercancel', (ev) => {
        const keyEl = ev.target.closest('[data-note]');
        if (!keyEl) return;
        keyEl.classList.remove('active');
        stopNote(keyEl.dataset.note);
      });

      setDebug('piano created');
    } catch (err) {
      console.error('createPiano error', err);
      setDebug('piano error');
    }
  }

  /* -------------------------
     Waveform drawing & selection markers
     ------------------------- */
  // Ensure markers exist (create if missing)
  function ensureMarkers() {
    if (!waveformCanvas) return null;
    let ms = document.getElementById('markerStart');
    let me = document.getElementById('markerEnd');
    if (!ms) {
      ms = document.createElement('div');
      ms.id = 'markerStart';
      ms.className = 'note-marker';
      ms.style.left = '0%';
      waveformCanvas.parentElement.appendChild(ms);
    }
    if (!me) {
      me = document.getElementById('markerEnd');
      if (!me) {
        me = document.createElement('div');
        me.id = 'markerEnd';
        me.className = 'note-marker';
        me.style.left = '100%';
        waveformCanvas.parentElement.appendChild(me);
      }
    }
    return { ms, me };
  }

  const drawWaveform = () => {
    try {
      if (!canvasCtx || !waveformCanvas) {
        console.warn('drawWaveform: canvas/context missing');
        return;
      }
      // bounding rect fallback
      let rect = waveformCanvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        rect = { width: waveformCanvas.offsetWidth || 600, height: waveformCanvas.offsetHeight || 160 };
      }
      const cssW = Math.max(1, Math.floor(rect.width));
      const cssH = Math.max(1, Math.floor(rect.height));
      const dpr = window.devicePixelRatio || 1;
      waveformCanvas.width = Math.floor(cssW * dpr);
      waveformCanvas.height = Math.floor(cssH * dpr);
      canvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      canvasCtx.clearRect(0, 0, cssW, cssH);

      // placeholder when no audio
      if (!audioBuffer) {
        // center line
        canvasCtx.fillStyle = 'rgba(255,255,255,0.04)';
        canvasCtx.fillRect(0, cssH/2 - 1, cssW, 2);
        // small wave
        canvasCtx.beginPath();
        for (let x=0; x<cssW; x+=8) {
          const y = cssH/2 + Math.sin(x/18) * (cssH/10);
          if (x===0) canvasCtx.moveTo(x,y); else canvasCtx.lineTo(x,y);
        }
        canvasCtx.strokeStyle = 'rgba(255,255,255,0.06)';
        canvasCtx.lineWidth = 1;
        canvasCtx.stroke();
        canvasCtx.font = '12px Inter, sans-serif';
        canvasCtx.fillStyle = 'rgba(200,200,200,0.7)';
        canvasCtx.fillText('Load an audio file to visualize waveform', 12, cssH/2 - 18);
        return;
      }

      const data = audioBuffer.getChannelData(0);
      if (!data || data.length === 0) return;
      const step = Math.max(1, Math.floor(data.length / cssW));
      canvasCtx.beginPath();
      canvasCtx.moveTo(0, cssH/2);
      for (let x=0, i=0; x < cssW && i < data.length; x++, i += step) {
        const v = data[i];
        const y = cssH/2 + v * (cssH/2) * 0.92;
        canvasCtx.lineTo(x, y);
      }
      canvasCtx.strokeStyle = 'rgba(200,200,200,0.6)';
      canvasCtx.lineWidth = 1;
      canvasCtx.stroke();

      // selection shading
      const sStart = Math.min(sampleStart, sampleEnd);
      const sEnd = Math.max(sampleStart, sampleEnd);
      const selX1 = sStart * cssW;
      const selX2 = sEnd * cssW;
      canvasCtx.fillStyle = 'rgba(59,130,246,0.14)';
      canvasCtx.fillRect(selX1, 0, Math.max(1, selX2 - selX1), cssH);

      // position markers (if present)
      const mk = ensureMarkers();
      if (mk && mk.ms && mk.me) {
        mk.ms.style.left = (sStart * 100).toFixed(2) + '%';
        mk.me.style.left = (sEnd * 100).toFixed(2) + '%';
      }
    } catch (err) {
      console.error('drawWaveform error', err);
    }
  };

  function resizeCanvas() {
    try {
      if (!waveformCanvas) return;
      // ensure minimal visible size in edge cases
      const rect = waveformCanvas.getBoundingClientRect();
      if ((rect.width === 0 || rect.height === 0) && waveformCanvas.offsetWidth === 0) {
        waveformCanvas.style.minWidth = '300px';
        waveformCanvas.style.minHeight = '80px';
      }
      drawWaveform();
      setDebug('canvas resized');
    } catch (err) {
      console.error('resizeCanvas error', err);
    }
  }

  // marker dragging logic
  function setupMarkerDragging() {
    const mk = ensureMarkers();
    if (!mk) return;
    const attachDrag = (marker, isStart) => {
      let dragging = false;
      marker.addEventListener('pointerdown', (ev) => {
        dragging = true;
        try { marker.setPointerCapture(ev.pointerId); } catch(e){}
      });
      marker.addEventListener('pointermove', (ev) => {
        if (!dragging) return;
        const rect = waveformCanvas.getBoundingClientRect();
        if (rect.width === 0) return;
        let pct = (ev.clientX - rect.left) / rect.width;
        pct = Math.max(0, Math.min(1, pct));
        if (isStart) sampleStart = Math.min(pct, sampleEnd); // ensure start <= end visually (can swap if you want)
        else sampleEnd = Math.max(pct, sampleStart);
        drawWaveform();
      });
      ['pointerup','pointercancel','pointerleave'].forEach(evt => {
        marker.addEventListener(evt, () => { dragging = false; });
      });
    };
    attachDrag(mk.ms, true);
    attachDrag(mk.me, false);
    // also allow clicking on waveform to move nearest marker
    waveformCanvas.parentElement.addEventListener('pointerdown', (ev) => {
      const rect = waveformCanvas.getBoundingClientRect();
      if (rect.width === 0) return;
      const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      // choose nearest marker
      if (Math.abs(pct - sampleStart) < Math.abs(pct - sampleEnd)) sampleStart = pct;
      else sampleEnd = pct;
      drawWaveform();
    });
    window.addEventListener('resize', resizeCanvas);
  }

  /* -------------------------
     Redraw loop (throttled)
     ------------------------- */
  let lastDraw = 0;
  function rafLoop(ts) {
    // throttle to ~30fps
    if (ts - lastDraw > 33) {
      drawWaveform();
      lastDraw = ts;
    }
    requestAnimationFrame(rafLoop);
  }

  /* -------------------------
     File loading
     ------------------------- */
  if (audioFile) {
    audioFile.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      await initAudioEngine();
      if (!audioCtx) return;
      setDebug('decoding audio file');
      try {
        const ab = await f.arrayBuffer();
        const decoded = await audioCtx.decodeAudioData(ab);
        audioBuffer = decoded;
        // copy first channel to Float32Array and transfer to worklet
        const ch0 = audioBuffer.numberOfChannels > 0 ? audioBuffer.getChannelData(0).slice(0) : new Float32Array(0);
        // send the channel data as transferable
        if (synthNode) {
          try { synthNode.port.postMessage({ type: 'load-sample', sampleData: ch0 }, [ch0.buffer]); }
          catch (err) { synthNode.port.postMessage({ type: 'load-sample', sampleData: ch0 }); }
        }
        sampleStart = 0; sampleEnd = 1;
        resizeCanvas();
        setDebug('audio loaded');
        createMessageBox('Sample loaded into synth', 'success');
      } catch (err) {
        console.error('File load/decoding error', err);
        createMessageBox('Failed to load audio file', 'error');
        setDebug('audio decode failed');
      }
    });
  } else {
    console.warn('No #audioFile element present');
  }

  /* -------------------------
     Wire up params, piano, markers, start RAF
     ------------------------- */
  try {
    createPiano();
    setupParamListeners();
    setupMarkerDragging();
    resizeCanvas();
    requestAnimationFrame(rafLoop);
  } catch (err) {
    console.error('Initial setup failed', err);
  }

  // helpful ui message
  createMessageBox('Welcome! Load an audio file to begin.', 'info');

  // global error catch to surface in debug panel
  window.addEventListener('error', (ev) => {
    const msg = ev && (ev.message || ev.error && ev.error.message) || String(ev);
    setDebug('JS error: ' + msg);
  });
});
