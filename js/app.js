// Sketchtone UI: project state, drawing canvas, layers/timeline tabs,
// quick-action panels (source, ADSR, sound FX, time FX) and the transport.
(function (ST) {
  'use strict';

  const {
    Engine, REGISTER, pitchLines, yToMidi, noteName, strokeSpan, renderWav, loopLength, readPos, sliceOrder,
    DEFAULT_SOUND, PRESETS, PRESET_ORDER, WAVES, REGISTERS, SCALES, READ_MODES, PANELS,
    FX, FX_BY_ID, FX_GROUPS, defaultFx, createKnob, TOOLS, voices, TF_IDENTITY, tfOf, geom,
  } = ST;

  const STORE = 'sketchtone.project.v2';
  const COLORS = ['#5b5bd6', '#e5484d', '#0d9488', '#e2710b', '#8e4ec6', '#0284c7', '#d6409f', '#65a30d'];
  const LAYER_PRESETS = ['keys', 'bass', 'pad', 'bell', 'lead', 'wind'];
  const MAX_LAYERS = 8;
  const LINE_WIDTH = { s: 3, m: 6, l: 11 };
  const TEXT_PX = { s: 20, m: 28, l: 38 }; // text brush: thicker = bigger and louder
  const DIVISIONS = [4, 8, 16];

  const ICON = {
    eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2" opacity=".5"/><path d="M4 4l16 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>',
  };

  const $ = sel => document.querySelector(sel);
  const uid = () => Math.random().toString(36).slice(2, 10);
  const clamp01 = v => Math.min(1, Math.max(0, v));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // ---------- project state ----------
  function presetFx(presetId) {
    const fx = defaultFx(), extra = PRESETS[presetId].fx || {};
    for (const id in extra) fx[id] = { ...fx[id], ...extra[id], on: true };
    return fx;
  }

  function makeLayer(n) {
    const presetId = LAYER_PRESETS[(n - 1) % LAYER_PRESETS.length];
    return {
      id: uid(), name: `Layer ${n}`, color: COLORS[(n - 1) % COLORS.length],
      muted: false, solo: false, hidden: false, volume: 0.8,
      preset: presetId, sound: { ...PRESETS[presetId].sound }, fx: presetFx(presetId),
      read: { mode: 'normal', divisions: 8, seed: 1 + Math.floor(Math.random() * 1e6) },
      send: { room: 0, echo: 0 }, lfo: { ...ST.LFO_DEFAULT },
      strokes: [],
    };
  }

  // Eight macros ready to play: one knob can move several settings at once.
  const SCENES = 8, MACROS = 8;
  function defaultMacros(p) {
    const d = p.drums, m = (name, value, maps) => ({ name, value, maps });
    return [
      m('Filter', 0.5, [{ path: 'master.filter', from: -100, to: 100 }]),
      m('Room', 0, [{ path: 'all.room', from: 0, to: 70 }]),
      m('Echo', 0, [{ path: 'all.echo', from: 0, to: 60 }]),
      m('Energy', (d.energy ?? 50) / 100, [{ path: 'drum.energy', from: 0, to: 100 }]),
      m('Fills', (d.fills ?? 0) / 100, [{ path: 'drum.fills', from: 0, to: 100 }]),
      m('Dirt', (d.dirt ?? 0) / 100, [{ path: 'drum.dirt', from: 0, to: 100 }]),
      m('Swing', (d.swing ?? 0) / 75, [{ path: 'drum.swing', from: 0, to: 75 }]),
      m('Space', 0.3, [{ path: 'master.roomsize', from: 1, to: 6 }, { path: 'master.feedback', from: 20, to: 80 }]),
    ];
  }

  function newProject() {
    const layer = makeLayer(1);
    return { name: 'Untitled sketch', bpm: 122, bars: 4, scale: 'pentatonic', key: 0, snap: 'off', loop: true, layerCount: 1, selected: layer.id, layers: [layer], drums: ST.defaultDrums() };
  }

  function normalize(p) {
    const base = newProject();
    for (const k of ['bpm', 'bars', 'scale', 'key', 'loop', 'name', 'layerCount', 'snap']) if (p[k] === undefined) p[k] = base[k];
    p.drums = ST.migrateDrums(p.drums);
    const md = ST.MASTER_DEFAULT;
    p.master = { filter: 0, ...p.master, room: { ...md.room, ...(p.master || {}).room }, echo: { ...md.echo, ...(p.master || {}).echo } };
    p.drums.send = { room: 0, echo: 0, ...p.drums.send };
    p.drums.lfo = { ...ST.LFO_DEFAULT, target: 'fx.filter.cutoff', ...p.drums.lfo };
    p.drums.motions = Array.isArray(p.drums.motions) ? p.drums.motions : [];
    p.master.motions = Array.isArray(p.master.motions) ? p.master.motions : [];
    p.scenes = Array.from({ length: SCENES }, (_, i) => (p.scenes && p.scenes[i]) || null);
    if (!Array.isArray(p.macros) || p.macros.length !== MACROS) p.macros = defaultMacros(p);
    const fxBase = defaultFx();
    p.layers.forEach(l => {
      l.sound = { ...DEFAULT_SOUND, ...l.sound };
      l.fx = l.fx || {};
      for (const id in fxBase) l.fx[id] = { ...fxBase[id], ...l.fx[id] };
      l.read = { mode: 'normal', divisions: 8, seed: 7, ...l.read };
      l.solo = !!l.solo;
      l.hidden = !!l.hidden;
      l.send = { room: 0, echo: 0, ...l.send };
      l.lfo = { ...ST.LFO_DEFAULT, ...l.lfo };
      l.motions = Array.isArray(l.motions) ? l.motions : [];
      l.strokes.forEach(it => { if (!it.id) it.id = uid(); });
    });
    return p;
  }

  function loadProject() {
    try {
      const p = JSON.parse(localStorage.getItem(STORE));
      if (!p || !Array.isArray(p.layers) || !p.layers.length) return null;
      return normalize(p);
    } catch (e) {
      return null;
    }
  }

  // ?demo opens a ready-made sketch, but never over work you already have.
  function demoProject() {
    const p = newProject(), lead = p.layers[0], keys = makeLayer(2), bass = makeLayer(3);
    const withPreset = (l, id, name) => Object.assign(l, { name, preset: id, sound: { ...PRESETS[id].sound }, fx: presetFx(id) });
    withPreset(lead, 'keys', 'Voice and melody');
    withPreset(keys, 'bell', 'Shapes');
    withPreset(bass, 'pluckbass', 'Bass pattern');
    // the words, sung by the robot along a gently rising line
    lead.strokes.push({ id: uid(), kind: 'text', size: 'l', text: 'I love Sketchtone now!', voice: 'mid', points: [[0.04, 0.3], [0.5, 0.22]] });
    // a hand-drawn answer, a little wobbly like a real pencil line
    const hand = Array.from({ length: 46 }, (_, i) => {
      const x = 0.55 + i * 0.0088;
      return [x, 0.36 - Math.sin(i / 7.5) * 0.1 + Math.sin(i * 1.7) * 0.006];
    });
    lead.strokes.push({ id: uid(), size: 'm', points: hand });
    // a filled shape: a soft chord swelling under the melody
    keys.strokes.push({ id: uid(), kind: 'ellipse', size: 'm', fill: true, box: [0.3, 0.46, 0.46, 0.6] });
    keys.strokes.push({ id: uid(), kind: 'rect', size: 's', fill: false, box: [0.8, 0.44, 0.94, 0.54] });
    // a generated arpeggio pattern for the bass
    const arp = ST.generatePattern({ ...ST.PATTERN_DEFAULT, ...ST.PATTERN_PRESETS.find(x => x.id === 'arp').v, repeats: 16, length: 40, y: 0.95, climb: 3 }, 'm');
    arp.forEach(it => bass.strokes.push({ ...it, id: uid() }));
    p.layers.push(keys, bass);
    p.layerCount = 3;
    p.name = 'Demo sketch';
    p.bpm = 100;
    // a minimal beat over the whole loop
    Object.assign(p.drums, ST.DRUM_STYLES.find(x => x.id === 'minimal').v, { volume: 0.7 });
    p.drums.curve = p.drums.curve.map(() => 0.45);
    return p;
  }
  const wantsDemo = /[?&]demo\b/.test(location.search);
  const saved = loadProject();
  let project = wantsDemo && !(saved && saved.layers.some(l => l.strokes.length)) ? normalize(demoProject()) : saved || normalize(newProject());
  const engine = new Engine(() => project);
  let saveTimer = 0;
  // Autosave, with a visible status so you always know your work is safe.
  const saveStatus = $('#save-status');
  const setSaveStatus = (state, text) => { saveStatus.dataset.state = state; saveStatus.textContent = text; };
  const persist = () => {
    try { localStorage.setItem(STORE, JSON.stringify(project)); setSaveStatus('saved', 'Saved'); }
    catch (e) { setSaveStatus('error', 'Not saved: browser storage is full or blocked'); }
  };
  // Every change goes through save(), so it is also where cached note plans are dropped.
  const save = () => { engine.invalidate(); clearTimeout(saveTimer); setSaveStatus('saving', 'Saving…'); saveTimer = setTimeout(persist, 300); };

  const ui = {
    tool: 'pencil', brush: 'm', fill: false, voice: 'mid', textEntry: null,
    pattern: { ...ST.PATTERN_DEFAULT }, patternOpen: false, draft: null, spray: null, hear: true,
    sel: null, moving: null, brushTf: { waves: 0, amp: 0, tilt: 0, gain: 1 },
    held: [], keyBase: 48, keySel: 48, padFlash: null,
    etch: { on: false, x: 0.05, y: 0.5, id: null, idle: 0 },
    drumTool: 'draw', drumPen: null, drumMpk: false, drumSel: false, dcur: { x: 0 }, panel: null, side: 'layers',
    fxTab: { sound: 'eq', time: 'echo' },
    startPos: 0, pausedAt: null,
    cursor: { x: 0.1, y: 0.5 }, pen: null, penKb: false, erasing: false, erased: false, hover: null,
  };
  const L = () => loopLength(project);
  const beatSec = () => 60 / project.bpm;
  const current = () => project.layers.find(l => l.id === project.selected) || project.layers[0];
  // The cards and panels shape either the selected canvas layer or the drum layer.
  const target = () => (ui.drumSel ? project.drums : current());
  const isDrums = t => t === project.drums;
  const hasStrokes = () => project.layers.some(l => l.strokes.length);
  const hasMusic = () => hasStrokes() || (!project.drums.muted && ST.drumsDrawn(project.drums)); // anything to play or export
  // Your own presets live in this browser: sounds for layers, kits for the drums.
  const MY_SOUNDS = 'sketchtone.mysounds.v1', MY_KITS = 'sketchtone.mykits.v1';
  const myList = key => { try { return JSON.parse(localStorage.getItem(key)) || []; } catch (e) { return []; } };
  const myFind = (key, preset) => (typeof preset === 'string' && preset.startsWith('my:') ? myList(key).find(x => x.id === preset.slice(3)) : null);
  const presetLabel = l => (PRESETS[l.preset] ? PRESETS[l.preset].label : (myFind(MY_SOUNDS, l.preset) || {}).name || 'Custom sound');
  const modeOf = id => READ_MODES.find(m => m.id === id);
  const activeFx = (l, group) => FX_GROUPS[group].filter(id => l.fx[id].on);

  // ---------- undo ----------
  const past = [], future = [];
  function snapshot() {
    past.push(JSON.stringify({ layers: project.layers, drums: project.drums }));
    if (past.length > 80) past.shift();
    future.length = 0;
    updateUndo();
  }
  function restore(from, to, msg) {
    if (!from.length) return;
    to.push(JSON.stringify({ layers: project.layers, drums: project.drums }));
    const snap = JSON.parse(from.pop());
    project.layers = snap.layers;
    project.drums = snap.drums;
    if (!selected()) ui.sel = null;
    if (!project.layers.some(l => l.id === project.selected)) project.selected = project.layers[0].id;
    save();
    engine.updateAll();
    refreshAll();
    announce(msg);
  }
  const undo = () => restore(past, future, 'Undone');
  const redo = () => restore(future, past, 'Redone');
  function updateUndo() {
    $('#undo').disabled = !past.length;
    $('#redo').disabled = !future.length;
  }

  // ---------- announcements ----------
  const statusEl = $('#status'), liveEl = $('#live');
  let statusTimer = 0, liveTimer = 0;
  function announce(msg) {
    clearTimeout(statusTimer);
    statusEl.textContent = '';
    statusTimer = setTimeout(() => { statusEl.textContent = msg; }, 30);
  }
  function speak(msg) { // screen-reader only, throttled (canvas cursor)
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { liveEl.textContent = msg; }, 180);
  }

  // ---------- canvas ----------
  const canvas = $('#canvas'), c2d = canvas.getContext('2d'), wrap = $('.canvas-wrap');
  const tl = $('#timeline'), tlCanvas = $('#timeline-canvas'), t2d = tlCanvas.getContext('2d');
  let W = 0, H = 0, TW = 0, TH = 0, dpr = 1;
  const theme = {};
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['paper', 'grid', 'grid-strong', 'ink-2', 'ink-3', 'accent']) theme[k] = cs.getPropertyValue('--' + k).trim();
  }

  function measure() {
    dpr = window.devicePixelRatio || 1;
    W = wrap.clientWidth; H = wrap.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    TW = tl.clientWidth; TH = tl.clientHeight;
    tlCanvas.width = Math.round(TW * dpr); tlCanvas.height = Math.round(TH * dpr);
    render(); renderTimeline();
  }
  new ResizeObserver(measure).observe(wrap);

  let queued = false;
  function requestRender() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(); renderTimeline(); renderDrums(); });
  }

  const sliced = l => l.read.mode === 'random' || l.read.mode === 'sliced';

  function render() {
    if (!W || !H) return;
    const c = c2d, len = L(), sel = current(), beats = project.bars * 4;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = theme.paper;
    c.fillRect(0, 0, W, H);

    // pitch guides: every scale note, or octaves only in theremin mode
    c.lineWidth = 1;
    c.font = '11px system-ui, -apple-system, sans-serif';
    c.textBaseline = 'bottom';
    for (const line of pitchLines(project.scale)) {
      const y = Math.round(line.y * H) + 0.5;
      c.strokeStyle = line.isC ? theme['grid-strong'] : theme.grid;
      c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke();
      if (line.isC) {
        c.fillStyle = theme['ink-3'];
        c.fillText(noteName(line.midi + (REGISTER[sel.sound.register] || 0)), 6, y - 2);
      }
    }
    // snap grid (finer than beats), then beats, then bars drawn stronger
    const g = snapUnit();
    if (g && g < 1 / beats - 1e-9) {
      c.strokeStyle = theme.grid;
      c.globalAlpha = 0.45;
      c.setLineDash([1, 3]);
      for (let i = 1; i < Math.round(1 / g); i++) {
        const x = Math.round(i * g * W) + 0.5;
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
      }
      c.setLineDash([]);
      c.globalAlpha = 1;
    }
    for (let b = 1; b < beats; b++) {
      const x = Math.round(b / beats * W) + 0.5, bar = b % 4 === 0;
      c.strokeStyle = bar ? theme['grid-strong'] : theme.grid;
      c.lineWidth = bar ? 1.5 : 1;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
    }
    c.lineWidth = 1;
    // slices of the selected layer, numbered as in the Timeline tab
    if (sliced(sel)) {
      const n = sel.read.divisions;
      c.setLineDash([2, 4]);
      c.strokeStyle = sel.color;
      c.globalAlpha = 0.5;
      for (let i = 1; i < n; i++) {
        const x = Math.round(i / n * W) + 0.5;
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
      }
      c.setLineDash([]);
      c.globalAlpha = 1;
      c.fillStyle = sel.color;
      c.textBaseline = 'top';
      for (let i = 0; i < n; i++) c.fillText(String(i + 1), i / n * W + 5, 6);
    }
    c.fillStyle = theme['ink-3'];
    c.textAlign = 'right';
    c.textBaseline = 'top';
    c.fillText('higher ↑', W - 8, sliced(sel) ? 24 : 8);
    c.textBaseline = 'bottom';
    c.fillText('lower ↓', W - 8, H - 6);
    c.textAlign = 'left';

    // strokes: other layers dimmed underneath, selected layer on top
    const pos = engine.position();
    const heads = new Map();
    if (pos) for (const l of project.layers) heads.set(l, readPos(l, pos.t, pos.k, len));
    for (const layer of [...project.layers.filter(l => l !== sel), sel]) {
      if (layer.hidden) continue;
      const alpha = layer.muted ? 0.22 : layer === sel ? 1 : 0.45;
      const head = heads.get(layer);
      for (const st of layer.strokes) {
        const [a, b] = strokeSpan(st);
        drawItem(st, layer.color, alpha, head != null && !layer.muted && head >= a && head <= b);
      }
    }
    if (ui.noteView) drawNoteView(sel);
    if (ui.pen) drawItem(ui.pen, sel.color, 1, false);
    if (ui.draft) drawItem(draftItem(ui.draft), sel.color, 0.85, false);
    if (ui.spray) drawItem(ui.spray.item, sel.color, 1, false);
    const picked = selected();
    if (picked && !picked.layer.hidden && !ui.pen && !ui.draft) {
      const all = selectedItems();
      for (const { item } of all) drawSelection(item, all.length === 1);
    }
    if (ui.marquee) { // box select
      const { a, b } = ui.marquee;
      c2d.strokeStyle = theme.accent;
      c2d.fillStyle = theme.accent;
      c2d.globalAlpha = 0.08;
      c2d.fillRect(Math.min(a[0], b[0]) * W, Math.min(a[1], b[1]) * H, Math.abs(b[0] - a[0]) * W, Math.abs(b[1] - a[1]) * H);
      c2d.globalAlpha = 1;
      c2d.setLineDash([4, 3]);
      c2d.strokeRect(Math.min(a[0], b[0]) * W, Math.min(a[1], b[1]) * H, Math.abs(b[0] - a[0]) * W, Math.abs(b[1] - a[1]) * H);
      c2d.setLineDash([]);
    }

    // read heads of layers that don't read left to right
    if (pos) {
      c.setLineDash([6, 4]);
      c.lineWidth = 2;
      for (const [layer, x] of heads) {
        if (layer.read.mode === 'normal' || layer.hidden || x == null || !layer.strokes.length) continue;
        c.strokeStyle = layer.color;
        const px = Math.round(x * W) + 0.5;
        c.beginPath(); c.moveTo(px, 0); c.lineTo(px, H); c.stroke();
      }
      c.setLineDash([]);
    }
    // main playhead
    const x = Math.round((pos ? pos.t : ui.startPos) / len * W) + 0.5;
    c.strokeStyle = pos ? theme.accent : theme['ink-3'];
    c.lineWidth = pos ? 2 : 1;
    c.setLineDash(pos ? [] : [4, 4]);
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
    c.setLineDash([]);

    // etch pen
    if (ui.etch.on) {
      const ex = ui.etch.x * W, ey = ui.etch.y * H;
      c.fillStyle = sel.color;
      c.strokeStyle = sel.color;
      c.lineWidth = 2;
      c.beginPath(); c.arc(ex, ey, 4, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(ex, ey, 10, 0, Math.PI * 2); c.stroke();
    }
    // keyboard pen cursor
    if (document.activeElement === canvas && canvas.matches(':focus-visible')) {
      const cx = ui.cursor.x * W, cy = ui.cursor.y * H;
      c.strokeStyle = sel.color;
      c.fillStyle = sel.color;
      c.lineWidth = 2;
      c.beginPath(); c.arc(cx, cy, 9, 0, Math.PI * 2); c.stroke();
      if (ui.pen) { c.beginPath(); c.arc(cx, cy, 4, 0, Math.PI * 2); c.fill(); }
    }
    if ((ui.tool === 'erase' || ui.tool === 'spray') && ui.hover) { // footprint of eraser / spray nozzle
      const r = ui.tool === 'erase' ? 14 : SPRAY_RADIUS[ui.brush];
      c.strokeStyle = theme['ink-2'];
      c.lineWidth = 1.5;
      c.setLineDash(ui.tool === 'spray' ? [3, 3] : []);
      c.beginPath(); c.arc(ui.hover[0] * W, ui.hover[1] * H, r, 0, Math.PI * 2); c.stroke();
      c.setLineDash([]);
    }
  }

  // Note view: the current layer's lines read as notes on a grid, like a piano roll.
  // A view only: you still draw and edit on the canvas; Quantize snaps start and end times.
  function drawNoteView(layer) {
    const c = c2d, len = L(), shift = REGISTER[layer.sound.register] || 0, row = H / 36;
    c.globalAlpha = 0.72;
    c.fillStyle = theme.paper;
    c.fillRect(0, 0, W, H);
    c.globalAlpha = 1;
    c.font = '600 10px Inter, system-ui, sans-serif';
    c.textBaseline = 'middle';
    for (const n of ST.collectNotes(layer, 0, len, project.scale)) {
      let segStart = 0, cur = Math.round(n.midis[0]);
      const block = end => {
        const x = (n.start + segStart) / len * W, w = Math.max(2, (end - segStart) / len * W), y = (1 - (cur - shift - 48) / 36) * H - row / 2;
        c.globalAlpha = 0.35 + 0.65 * Math.min(1, n.peak / 0.85);
        c.fillStyle = layer.color;
        c.beginPath();
        c.roundRect ? c.roundRect(x, y, w, Math.max(4, row - 1), 3) : c.rect(x, y, w, Math.max(4, row - 1));
        c.fill();
        c.globalAlpha = 1;
        if (w > 28 && row >= 9) { c.fillStyle = '#fff'; c.fillText(noteName(cur), x + 4, y + row / 2); }
      };
      for (let i = 1; i < n.times.length; i++) {
        const m = Math.round(n.midis[i]);
        if (m !== cur) { block(n.times[i]); segStart = n.times[i]; cur = m; }
      }
      block(n.dur);
    }
  }

  // Text brush: the words sit on their baseline (the pitch line), rotated and
  // stretched so their length on the canvas is how long they are sung.
  function textFrame(it) {
    const pts = geom(it).points, a = pts[0], b = pts[pts.length - 1];
    const ax = a[0] * W, ay = a[1] * H, bx = b[0] * W, by = b[1] * H;
    const px = TEXT_PX[it.size] || TEXT_PX.m;
    return { pts, ax, ay, len: Math.max(1, Math.hypot(bx - ax, by - ay)), ang: Math.atan2(by - ay, bx - ax), px };
  }
  function drawText(it, color, alpha, active) {
    const c = c2d, f = textFrame(it), pts = f.pts.map(([x, y]) => [x * W, y * H]);
    c.globalAlpha = alpha * 0.45;
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.setLineDash([2, 5]);
    c.beginPath();
    pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.stroke();
    c.setLineDash([]);
    // letters spread along the pitch line, each turned with it (follows tilt and wiggles)
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[cum.length - 1] || 1, chars = [...it.text];
    c.font = `700 ${f.px}px Inter, system-ui, sans-serif`;
    const natural = c.measureText(it.text).width || 1;
    const px = natural > total ? Math.max(f.px * 0.45, f.px * total / natural) : f.px;
    c.font = `700 ${px}px Inter, system-ui, sans-serif`;
    c.textAlign = 'center';
    c.fillStyle = color;
    c.globalAlpha = alpha * Math.min(1, 0.55 + 0.45 * tfOf(it).gain);
    if (active) { c.shadowColor = color; c.shadowBlur = 16; }
    const widths = chars.map(ch => c.measureText(ch).width), sumW = widths.reduce((a, w) => a + w, 0) || 1;
    let acc = 0;
    chars.forEach((ch, i) => {
      const d = (acc + widths[i] / 2) / sumW * total; // spaced by real letter widths
      acc += widths[i];
      let k = 1;
      while (k < cum.length - 1 && cum[k] < d) k++;
      const p0 = pts[Math.max(0, k - 1)], p1 = pts[Math.min(pts.length - 1, k)];
      const u = (d - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1);
      const x = p0[0] + (p1[0] - p0[0]) * u, y = p0[1] + (p1[1] - p0[1]) * u;
      c.save();
      c.translate(x, y);
      c.rotate(pts.length > 1 ? Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) : 0);
      c.fillText(ch, 0, -5);
      c.restore();
    });
    c.shadowBlur = 0;
    c.textAlign = 'start';
    c.globalAlpha = 1;
  }

  function drawItem(it, color, alpha, active) {
    if (it.kind === 'text') { drawText(it, color, alpha, active); return; }
    const c = c2d, g = geom(it), width = (LINE_WIDTH[it.size] || LINE_WIDTH.m) * Math.sqrt(tfOf(it).gain);
    c.globalAlpha = alpha;
    c.strokeStyle = color;
    c.fillStyle = color;
    if (g.dots) {
      const r = Math.max(1.5, width * 0.5) + (active ? 1.5 : 0);
      c.beginPath();
      for (const d of g.dots) { c.moveTo(d[0] * W + r, d[1] * H); c.arc(d[0] * W, d[1] * H, r, 0, Math.PI * 2); }
      c.fill();
      c.globalAlpha = 1;
      return;
    }
    c.lineWidth = width;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    if (g.poly) {
      g.poly.forEach(([x, y], i) => (i ? c.lineTo(x * W, y * H) : c.moveTo(x * W, y * H)));
      c.closePath();
      if (it.fill) { c.globalAlpha = alpha * 0.28; c.fill(); c.globalAlpha = alpha; }
    } else {
      const pts = g.points;
      c.moveTo(pts[0][0] * W, pts[0][1] * H);
      if (pts.length === 1) c.lineTo(pts[0][0] * W + 0.1, pts[0][1] * H);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2 * W, my = (pts[i][1] + pts[i + 1][1]) / 2 * H;
        c.quadraticCurveTo(pts[i][0] * W, pts[i][1] * H, mx, my);
      }
      if (pts.length > 1) { const e = pts[pts.length - 1]; c.lineTo(e[0] * W, e[1] * H); }
    }
    c.stroke();
    if (active) { // glow while it is sounding
      c.globalAlpha = alpha * 0.25;
      c.lineWidth += 10;
      c.stroke();
    }
    c.globalAlpha = 1;
  }

  // Timeline strip: bars/beats, and per layer where its notes actually play
  // (after reversing, shuffling or slicing).
  function renderTimeline() {
    if (!TW || !TH) return;
    const c = t2d, len = L(), beats = project.bars * 4, sel = current();
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, TW, TH);
    c.font = '11px system-ui, -apple-system, sans-serif';
    c.textBaseline = 'top';
    c.lineWidth = 1;
    for (let b = 0; b <= beats; b++) {
      const x = Math.min(TW - 0.5, Math.round(b / beats * TW) + 0.5);
      const bar = b % 4 === 0;
      c.strokeStyle = theme['grid-strong'];
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, bar ? 10 : 5); c.stroke();
      if (bar && b < beats) { c.fillStyle = theme['ink-3']; c.fillText(String(b / 4 + 1), x + 4, 3); }
    }
    if (sliced(sel)) {
      const n = sel.read.divisions;
      c.strokeStyle = sel.color;
      c.globalAlpha = 0.5;
      for (let i = 1; i < n; i++) {
        const x = Math.round(i / n * TW) + 0.5;
        c.beginPath(); c.moveTo(x, 18); c.lineTo(x, TH); c.stroke();
      }
      c.globalAlpha = 1;
    }
    const n = project.layers.length, top = 20;
    const lane = Math.max(2, Math.min(5, (TH - top - 4) / n - 1));
    project.layers.forEach((l, i) => {
      c.fillStyle = l.color;
      c.globalAlpha = l.muted ? 0.25 : 0.9;
      const y = top + i * (lane + 1);
      for (const note of engine.notes(l, 0, len, project)) {
        c.fillRect(note.start / len * TW, y, Math.max(2, note.dur / len * TW), lane);
      }
    });
    c.globalAlpha = 1;
    if (ui.padFlash && performance.now() < ui.padFlash.until) {
      c.fillStyle = theme.accent;
      c.globalAlpha = 0.25;
      c.fillRect(ui.padFlash.slice / PAD_SLICES * TW, 0, TW / PAD_SLICES, TH);
      c.globalAlpha = 1;
    }
    const sx = ui.startPos / len * TW;
    c.fillStyle = theme['ink-2'];
    c.beginPath(); c.moveTo(sx - 6, 0); c.lineTo(sx + 6, 0); c.lineTo(sx, 8); c.closePath(); c.fill();
    const pos = engine.position();
    if (pos) {
      c.fillStyle = theme.accent;
      c.fillRect(pos.t / len * TW - 1, 0, 2, TH);
    }
  }

  // ---------- selection + drawing knobs ----------
  // The last drawn (or clicked) item is selected; knobs K1–K8 reshape it through
  // its transform. "Style" knobs also apply to the next lines you draw.
  const beatsFmt = v => { const b = v * project.bars * 4; return `${b > 0 ? '+' : ''}${b.toFixed(2)} beats`; };
  const semisFmt = v => { const st = Math.round(v * 36); return `${st > 0 ? '+' : ''}${st} st`; };
  const DRAW_KNOBS = [
    { key: 'dx', label: 'Time offset', min: -1, max: 1, step: 0.0025, fmt: beatsFmt, info: 'Moves it earlier or later in the loop' },
    { key: 'dy', label: 'Transpose', min: -1, max: 1, step: 1 / 72, fmt: semisFmt, invert: true, info: 'Moves it up or down in pitch' },
    { key: 'waves', label: 'Wave cycles', min: 0, max: 24, step: 1, fmt: v => `${v} ${v === 1 ? 'wave' : 'waves'}`, style: true, info: 'How many wobbles ride along the line' },
    { key: 'amp', label: 'Wave depth', min: 0, max: 0.3, step: 0.002, fmt: v => `±${(v * 36).toFixed(1)} st`, style: true, info: 'How deep the wobbles go, in semitones' },
    { key: 'sx', label: 'Time stretch', min: 0.1, max: 3, step: 0.01, fmt: v => `×${v.toFixed(2)}`, info: 'Makes it last longer or shorter' },
    { key: 'sy', label: 'Pitch stretch', min: -2, max: 3, step: 0.01, fmt: v => `×${v.toFixed(2)}${v < 0 ? ' (flipped)' : ''}`, info: 'Makes its jumps bigger, smaller or upside down' },
    { key: 'tilt', label: 'Slope', min: -1, max: 1, step: 0.01, fmt: v => (Math.round(v * 36) ? `end ${semisFmt(v)}` : 'flat'), invert: true, style: true, info: 'Lifts or lowers the end of the line' },
    { key: 'gain', label: 'Volume', min: 0.2, max: 1.6, step: 0.01, fmt: v => `×${v.toFixed(2)}`, style: true, info: 'Louder or quieter (thickness)' },
  ];

  function selected() {
    if (!ui.sel) return null;
    const layer = project.layers.find(l => l.id === ui.sel.layerId);
    const item = layer && layer.strokes.find(it => it.id === ui.sel.id);
    return item ? { layer, item } : null;
  }

  // Items are replaced, never mutated, so cached geometry and notes stay valid.
  // Everything selected: the primary item plus any extras (box select, Shift-click), same layer.
  function selectedItems() {
    const s = selected();
    if (!s) return [];
    const ids = new Set([s.item.id, ...(ui.extraFor === s.item.id ? ui.extra || [] : [])]); // extras belong to this primary only
    return s.layer.strokes.filter(it => ids.has(it.id)).map(item => ({ layer: s.layer, item }));
  }
  function replaceSelected(fn) {
    for (const { layer, item } of selectedItems()) layer.strokes[layer.strokes.indexOf(item)] = fn(item);
  }
  const boundsOf = it => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of ST.itemPoints(it)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { x0, x1, y0, y1 };
  };

  function hitItem(it, p) {
    const toPx = q => [q[0] * W, q[1] * H], P = toPx(p);
    const reach = 14 + (LINE_WIDTH[it.size] || 6) / 2;
    if (it.kind === 'spray') return ST.geom(it).dots.some(d => Math.hypot(d[0] * W - P[0], d[1] * H - P[1]) < reach);
    if (it.kind === 'text') {
      const f = textFrame(it), dx = P[0] - f.ax, dy = P[1] - f.ay;
      const u = dx * Math.cos(f.ang) + dy * Math.sin(f.ang), v = -dx * Math.sin(f.ang) + dy * Math.cos(f.ang);
      if (u > -8 && u < f.len + 8 && v > -f.px - 10 && v < 12) return true;
    }
    const line = ST.outline(it);
    return ST.inside(it, p) || line.some((q, i) => segDist(P, toPx(line[Math.max(0, i - 1)]), toPx(q)) < reach);
  }

  // Topmost first: selected layer, newest item first.
  function itemAt(p) {
    for (const l of [current(), ...project.layers.filter(x => x !== current())]) {
      if (l.hidden) continue;
      for (let i = l.strokes.length - 1; i >= 0; i--) if (hitItem(l.strokes[i], p)) return { layer: l, item: l.strokes[i] };
    }
    return null;
  }

  function selectAt(p, add) {
    const hit = itemAt(p);
    if (add && hit && ui.sel && hit.layer.id === ui.sel.layerId) { // Shift-click: add or remove
      const extra = new Set(ui.extra || []);
      if (hit.item.id === ui.sel.id) { if (extra.size) { ui.sel = { layerId: hit.layer.id, id: [...extra][0] }; extra.delete(ui.sel.id); } }
      else if (extra.has(hit.item.id)) extra.delete(hit.item.id); else extra.add(hit.item.id);
      ui.extra = [...extra];
      ui.extraFor = ui.sel.id;
      announce(`${selectedItems().length} selected`);
      renderKnobStrip();
      requestRender();
      return hit;
    }
    ui.extra = [];
    if (!hit) {
      if (ui.sel) announce('Nothing selected: the knobs now shape new lines');
      ui.sel = null;
    } else {
      if (hit.layer !== current()) selectLayer(hit.layer.id);
      ui.sel = { layerId: hit.layer.id, id: hit.item.id };
      announce(`Selected ${toolOf(itemTool(hit.item)).label.toLowerCase()} on ${hit.layer.name}: ${describe(hit.item, hit.layer)}`);
    }
    renderKnobStrip();
    requestRender();
    return hit;
  }

  // Box select: every visible item of the current layer that touches the box.
  function finishMarquee() {
    const { a, b } = ui.marquee, layer = current();
    ui.marquee = null;
    const bx0 = Math.min(a[0], b[0]), bx1 = Math.max(a[0], b[0]), by0 = Math.min(a[1], b[1]), by1 = Math.max(a[1], b[1]);
    if ((bx1 - bx0) * W < 4 && (by1 - by0) * H < 4) { requestRender(); return; }
    const inside = layer.hidden ? [] : layer.strokes.filter(it => { const r = boundsOf(it); return r.x1 >= bx0 && r.x0 <= bx1 && r.y1 >= by0 && r.y0 <= by1; });
    if (!inside.length) { ui.sel = null; ui.extra = []; announce('Nothing in the box'); }
    else {
      ui.sel = { layerId: layer.id, id: inside[0].id };
      ui.extra = inside.slice(1).map(it => it.id);
      ui.extraFor = ui.sel.id;
      announce(`${inside.length} selected on ${layer.name}: move, copy, duplicate, nudge or delete them together`);
    }
    renderKnobStrip();
    requestRender();
  }

  function moveSelected(p) {
    const m = ui.moving;
    if (!m.moved) { snapshot(); m.moved = true; }
    const dx = snapUnit() ? snapX(m.x0 + p[0] - m.start[0]) - m.x0 : p[0] - m.start[0]; // the start lands on the grid
    replaceSelected(it => { const tf0 = m.tf0s.get(it.id) || tfOf(it); return { ...it, tf: { ...tf0, dx: tf0.dx + dx, dy: tf0.dy + p[1] - m.start[1] } }; });
    save();
    syncLineBar();
    requestRender();
  }

  function deleteSelected() {
    const all = selectedItems();
    if (!all.length) return;
    snapshot();
    const gone = new Set(all.map(x => x.item));
    all[0].layer.strokes = all[0].layer.strokes.filter(it => !gone.has(it));
    ui.sel = null;
    ui.extra = [];
    refreshAfterEdit();
    renderKnobStrip();
    announce(`${gone.size === 1 ? 'Deleted' : `${gone.size} deleted`}. Undo brings it back.`);
  }

  let knobUndoAt = 0;
  // One target at a time: the selected drawing, or (with nothing selected) the defaults for new lines.
  function setDraw(key, v, style) {
    if (!selected() && style) ui.brushTf[key] = v;
    if (selected()) {
      if (performance.now() - knobUndoAt > 1200) snapshot(); // one undo step per knob gesture
      knobUndoAt = performance.now();
      replaceSelected(it => ({ ...it, tf: { ...tfOf(it), [key]: v } }));
      save();
    }
    syncLineBar();
    requestRender();
  }

  // Line controls: the drawing knobs on screen, always at hand (K1–K8 on the MPK).
  const lineKnobs = {};
  const isStyleDefault = () => !ui.brushTf.waves && !ui.brushTf.amp && !ui.brushTf.tilt && ui.brushTf.gain === 1;
  function buildLineBar() {
    const host = $('#line-bar');
    host.innerHTML = `
      <div class="lb-head">
        <span class="lb-kicker" id="lb-title"></span>
        <span class="lb-target" id="lb-target"></span>
        <div class="lb-actions">
          <button type="button" class="dev-btn lb-reset" id="lb-reset">Reset</button>
          <button type="button" class="dev-btn lb-switch" id="lb-switch"></button>
        </div>
      </div>
      <div class="lb-knobs"></div>`;
    for (const d of DRAW_KNOBS) {
      const sign = d.invert ? -1 : 1;
      const k = createKnob({
        label: d.label, min: d.min, max: d.max, step: d.step, value: sign * TF_IDENTITY[d.key], reset: sign * TF_IDENTITY[d.key], fmt: d.fmt,
        hint: d.info,
        onInput: v => {
          if (!selected() && !d.style) { announce('Select a line first (press V and click it), then turn this knob'); syncLineBar(); return; }
          setDraw(d.key, sign * v, d.style);
        },
      });
      k.el.dataset.path = `draw.${d.key}`;
      k.el.title = d.info;
      lineKnobs[d.key] = k;
      host.querySelector('.lb-knobs').append(k.el);
    }
    syncLineBar();
    $('#lb-switch').addEventListener('click', () => {
      if (selected()) {
        ui.sel = null;
        ui.extra = [];
        renderKnobStrip();
        requestRender();
        announce('Now editing the defaults for new lines');
      } else {
        setTool('select');
        canvas.focus({ preventScroll: true });
      }
    });
    $('#lb-reset').addEventListener('click', () => {
      const s = selected();
      if (s) {
        snapshot();
        replaceSelected(it => { const { tf, ...rest } = it; return rest; });
        save();
        announce('Line back to how you drew it');
      } else {
        ui.brushTf = { waves: 0, amp: 0, tilt: 0, gain: 1 };
        announce('New lines: no wiggle, no tilt, normal loudness');
      }
      syncLineBar();
      requestRender();
    });
  }
  function syncLineBar() {
    if (!lineKnobs.dx) return;
    const s = selected(), tf = s ? tfOf(s.item) : { ...TF_IDENTITY, ...ui.brushTf };
    $('#line-bar').dataset.target = s ? 'selected' : 'defaults';
    $('#lb-title').textContent = s ? 'Editing selected' : 'Defaults for new lines';
    const many = s ? selectedItems().length : 0;
    $('#lb-target').textContent = s ? (many > 1 ? `${many} items on ${s.layer.name}` : `${toolOf(itemTool(s.item)).label} on ${s.layer.name}`) : 'Wave, slope and volume of the next lines you draw';
    $('#lb-switch').textContent = s ? 'Edit defaults' : 'Select a line (V)';
    for (const d of DRAW_KNOBS) {
      lineKnobs[d.key].set((d.invert ? -1 : 1) * tf[d.key]);
      lineKnobs[d.key].el.classList.toggle('is-idle', !s && !d.style);
    }
    $('#lb-reset').disabled = s ? !ST.hasTf(s.item) : isStyleDefault();
  }

  // Side handles of the selection box (screen pixels): left/right stretch time, top/bottom pitch.
  function selectionHandles(it) {
    const { x0, x1, y0, y1 } = boundsOf(it), pad = 8 + (LINE_WIDTH[it.size] || 6) / 2;
    const X0 = x0 * W - pad, Y0 = y0 * H - pad, X1 = x1 * W + pad, Y1 = y1 * H + pad;
    return { l: [X0, (Y0 + Y1) / 2], r: [X1, (Y0 + Y1) / 2], t: [(X0 + X1) / 2, Y0], b: [(X0 + X1) / 2, Y1] };
  }
  function handleAt(p) {
    const all = selectedItems();
    if (all.length !== 1 || all[0].layer.hidden) return null;
    const hs = selectionHandles(all[0].item), P = [p[0] * W, p[1] * H];
    for (const k in hs) if (Math.abs(hs[k][0] - P[0]) <= 9 && Math.abs(hs[k][1] - P[1]) <= 9) return k;
    return null;
  }
  function drawSelection(it, handles) {
    const c = c2d;
    const { x0, x1, y0, y1 } = boundsOf(it);
    const pad = 8 + (LINE_WIDTH[it.size] || 6) / 2;
    const X0 = x0 * W - pad, Y0 = y0 * H - pad, X1 = x1 * W + pad, Y1 = y1 * H + pad;
    c.strokeStyle = theme.accent;
    c.fillStyle = theme.accent;
    c.lineWidth = 1.5;
    c.setLineDash([5, 4]);
    c.strokeRect(X0, Y0, X1 - X0, Y1 - Y0);
    c.setLineDash([]);
    if (!handles) return;
    c.fillStyle = theme.paper;
    c.lineWidth = 2;
    for (const [x, y] of Object.values(selectionHandles(it))) { c.fillRect(x - 5, y - 5, 10, 10); c.strokeRect(x - 5, y - 5, 10, 10); }
    c.lineWidth = 1;
  }

  // Drag a side handle: stretch in time (left/right) or pitch (top/bottom); the other side stays put.
  function resizeSelected(p) {
    const r = ui.resizing, b0 = r.b0, tf0 = r.tf0;
    if (!r.moved) { snapshot(); r.moved = true; }
    let { sx, sy } = tf0;
    if (r.edge === 'l' || r.edge === 'r') {
      const x = snapX(p[0]), w0 = Math.max(0.002, b0.x1 - b0.x0), w = r.edge === 'r' ? x - b0.x0 : b0.x1 - x;
      sx = Math.max(0.1, Math.min(3, tf0.sx * Math.max(0.004, w) / w0));
    } else {
      const h0 = Math.max(0.002, b0.y1 - b0.y0), h = r.edge === 'b' ? p[1] - b0.y0 : b0.y1 - p[1];
      sy = Math.max(-2, Math.min(3, tf0.sy * Math.max(0.004, h) / h0));
    }
    const trial = { ...r.item0, tf: { ...tf0, sx, sy } }, nb = boundsOf(trial);
    const dx = r.edge === 'r' ? b0.x0 - nb.x0 : r.edge === 'l' ? b0.x1 - nb.x1 : 0;
    const dy = r.edge === 'b' ? b0.y0 - nb.y0 : r.edge === 't' ? b0.y1 - nb.y1 : 0;
    replaceSelected(it => ({ ...it, tf: { ...tf0, sx, sy, dx: tf0.dx + dx, dy: tf0.dy + dy } }));
    save();
    syncLineBar();
    requestRender();
  }

  // ---------- drawing input ----------
  // Pencil draws freehand; Line/Rectangle/Ellipse drag a "draft" from a start
  // point; Spray scatters dots while held; Eraser removes what it touches.
  const SPRAY_RADIUS = { s: 14, m: 24, l: 38 }; // px
  const SPRAY_MAX = 160;
  const isShapeTool = t => t === 'line' || t === 'rect' || t === 'ellipse';
  const toolOf = id => TOOLS.find(t => t.id === id);

  function unhideForDrawing() {
    const layer = current();
    if (!layer.hidden) return;
    layer.hidden = false;
    renderLayers();
    announce(`${layer.name} is visible again`);
  }

  function startPen(p, kb) {
    unhideForDrawing();
    snapshot();
    ui.pen = { size: ui.brush, points: [p] };
    ui.penKb = kb;
    if (ui.hear) engine.monitorStart(current(), p[1]);
    updateEmpty();
    requestRender();
  }

  // Time snap: Off, or the start and end of what you draw land on 1/4, 1/8 or 1/16 notes.
  const SNAPS = { off: 0, '1/4': 4, '1/8': 8, '1/16': 16 };
  const snapUnit = () => (SNAPS[project.snap] ? 1 / (project.bars * SNAPS[project.snap]) : 0);
  const snapX = x => { const g = snapUnit(); return g ? clamp01(Math.round(x / g) * g) : x; };
  function snapItem(it) {
    const g = snapUnit();
    if (!g) return it;
    if (it.box) {
      const [x0, y0, x1, y1] = it.box, a = snapX(Math.min(x0, x1));
      const b = Math.max(Math.min(1, a + g), snapX(Math.max(x0, x1)));
      return { ...it, box: [a, y0, b, y1] };
    }
    if (it.dots) return { ...it, dots: it.dots.map(([x, y]) => [snapX(x), y]) };
    if (!it.points) return it;
    const xs = it.points.map(q => q[0]), x0 = Math.min(...xs), x1 = Math.max(...xs), a = snapX(x0);
    if (x1 - x0 < 1e-6) return { ...it, points: it.points.map(([, y]) => [a, y]) };
    const b = Math.max(Math.min(1, a + g), snapX(x1));
    return { ...it, points: it.points.map(([x, y]) => [a + (x - x0) / (x1 - x0) * (b - a), y]) };
  }
  function setSnap(v) {
    project.snap = v;
    $('#snap').value = v;
    save();
    updateCanvasPos();
    requestRender();
  }

  function commitItem(item) {
    const layer = current(), style = ui.brushTf;
    item = Object.assign(item, snapItem(item));
    item.id = uid();
    if (style.waves || style.amp || style.tilt || style.gain !== 1) item.tf = { ...style };
    layer.strokes.push(item);
    ui.sel = { layerId: layer.id, id: item.id };
    refreshAfterEdit();
    renderKnobStrip();
    announce(`${toolOf(itemTool(item)).label} added to ${layer.name}: ${describe(item, layer)}`);
  }

  function commitPen() {
    const st = ui.pen;
    ui.pen = null;
    engine.monitorEnd();
    commitItem(st);
  }

  function cancelPen() {
    ui.pen = null;
    ui.draft = null;
    engine.monitorEnd();
    past.pop();
    updateUndo();
    updateEmpty();
    requestRender();
  }

  // Line / rectangle / ellipse drafts
  function startDraft(p, kb) {
    unhideForDrawing();
    snapshot();
    p = [snapX(p[0]), p[1]];
    ui.draft = { tool: ui.tool, size: ui.brush, fill: ui.fill, a: p, b: p, kb };
    if (ui.hear && ui.tool === 'line') engine.monitorStart(current(), p[1]);
    updateEmpty();
    requestRender();
  }

  // Shift: flat/vertical/45° lines, squares and circles (in screen pixels).
  function constrain(a, b, shift, tool) {
    if (!shift) return b;
    let dx = (b[0] - a[0]) * W, dy = (b[1] - a[1]) * H;
    if (tool === 'line' || tool === 'text') {
      if (Math.abs(dx) > Math.abs(dy) * 2) dy = 0;
      else if (Math.abs(dy) > Math.abs(dx) * 2) dx = 0;
      else { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx) * m; dy = Math.sign(dy) * m; }
    } else {
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * m;
      dy = Math.sign(dy || 1) * m;
    }
    return [clamp01(a[0] + dx / W), clamp01(a[1] + dy / H)];
  }

  function moveDraft(p, shift) {
    const d = ui.draft;
    d.b = constrain(d.a, p, shift, d.tool);
    d.b = [snapX(d.b[0]), d.b[1]];
    if (d.tool === 'line') engine.monitorMove(d.b[1]);
    requestRender();
  }

  function draftItem(d) {
    if (d.tool === 'line' || d.tool === 'text') return { size: d.size, points: [d.a, d.b].sort((p, q) => p[0] - q[0]) };
    return { kind: d.tool, size: d.size, fill: d.fill, box: [d.a[0], d.a[1], d.b[0], d.b[1]] };
  }

  function commitDraft() {
    const d = ui.draft;
    ui.draft = null;
    engine.monitorEnd();
    if (d.tool === 'text') { openTextEntry({ a: d.a, b: d.b, dragged: Math.abs(d.b[0] - d.a[0]) * W > 12 }); return; }
    const item = draftItem(d);
    if (d.tool !== 'line' && Math.abs(d.b[0] - d.a[0]) * W < 3) { // a click, not a drag: make a small shape
      item.box = [d.a[0] - 0.03, d.a[1] - 0.05, d.a[0] + 0.03, d.a[1] + 0.05].map(clamp01);
    }
    if (ui.hear && item.kind) engine.blip(current(), voices(item).map(v => v.points[Math.floor(v.points.length / 2)][1]), 0.35);
    commitItem(item);
  }

  // Spray: dots appear around the pointer while it is held, even standing still.
  function startSpray(p) {
    unhideForDrawing();
    snapshot();
    ui.spray = { item: { kind: 'spray', size: ui.brush, dots: [] }, at: p };
    sprayTick();
    ui.spray.timer = setInterval(sprayTick, 45);
    updateEmpty();
  }

  function sprayTick(count) {
    const s = ui.spray;
    if (!s || s.item.dots.length >= SPRAY_MAX) return;
    const r = SPRAY_RADIUS[s.item.size] || SPRAY_RADIUS.m, fresh = [];
    for (let i = 0; i < (count || 3); i++) {
      const a = Math.random() * Math.PI * 2, d = r * Math.sqrt(Math.random());
      fresh.push([clamp01(s.at[0] + Math.cos(a) * d / W), clamp01(s.at[1] + Math.sin(a) * d / H)]);
    }
    s.item.dots.push(...fresh);
    if (ui.hear) engine.blip(current(), [fresh[0][1]], 0.08);
    requestRender();
  }

  function commitSpray() {
    const s = ui.spray;
    clearInterval(s.timer);
    ui.spray = null;
    if (!s.item.dots.length) { past.pop(); updateUndo(); return; }
    commitItem(s.item);
  }

  const itemTool = it => (it.kind || (it.points && it.points.length === 2 ? 'line' : 'pencil'));

  function describe(it, layer) {
    const r = layer.sound.register, name = y => noteName(yToMidi(y, project.scale, r));
    const pts = ST.itemPoints(it);
    let a = pts[0], b = a;
    for (const p of pts) { if (p[0] < a[0]) a = p; if (p[0] > b[0]) b = p; }
    const when = `${barBeat(a[0] * L())} to ${barBeat(b[0] * L())}`;
    if (it.kind === 'spray') return `${it.dots.length} short notes, ${when}`;
    if (it.kind === 'text') { const n1 = name(a[1]), n2 = name(b[1]); return `“${it.text}”, ${when}, ${n1}${n1 !== n2 ? ` to ${n2}` : ''}`; }
    if (it.kind) {
      const [, y0, , y1] = ST.shapeBox(it), n = voices(it).length;
      return `${it.fill ? 'filled, ' : ''}${when}, ${n} ${n === 1 ? 'voice' : 'voices'} from ${name(y1)} to ${name(y0)}`;
    }
    const n1 = name(a[1]), n2 = name(b[1]);
    return `${when}, ${n1}${n1 !== n2 ? ` to ${n2}` : ''}`;
  }

  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }

  // Eraser: whole strokes and shapes go; spray loses only the dots it touches.
  function eraseAt(p) {
    const layer = current(), toPx = q => [q[0] * W, q[1] * H], P = toPx(p);
    if (layer.hidden) return;
    let changed = false;
    const next = [];
    for (const it of layer.strokes) {
      const reach = 14 + (LINE_WIDTH[it.size] || 6) / 2;
      if (it.kind === 'spray' && !ST.hasTf(it)) {
        const dots = it.dots.filter(d => Math.hypot(d[0] * W - P[0], d[1] * H - P[1]) >= reach);
        if (dots.length !== it.dots.length) { changed = true; if (dots.length) next.push({ ...it, dots }); }
        else next.push(it);
        continue;
      }
      if (hitItem(it, p)) changed = true; else next.push(it);
    }
    if (!changed) return;
    layer.strokes = next;
    ui.erased = true;
    save();
    renderLayers();
    updateEmpty();
    requestRender();
  }

  const norm = e => {
    const r = canvas.getBoundingClientRect();
    return [clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height)];
  };

  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    if (!W || !H) measure(); // resize callback may not have run yet
    canvas.focus({ preventScroll: true });
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    if (ui.drumSel) selectLayer(project.selected); // drawing is always on a canvas layer
    const p = norm(e);
    if (ui.tool === 'select') {
      const edge = handleAt(p);
      if (edge) {
        const it = selected().item;
        ui.resizing = { edge, item0: it, tf0: tfOf(it), b0: boundsOf(it), moved: false };
        return;
      }
      const already = ui.sel && selectedItems().some(x => x.item === (itemAt(p) || {}).item);
      const hit = already && !e.shiftKey ? itemAt(p) : selectAt(p, e.shiftKey);
      if (hit && !e.shiftKey) {
        const all = selectedItems();
        ui.moving = { start: p, tf0s: new Map(all.map(x => [x.item.id, tfOf(x.item)])), x0: Math.min(...all.flatMap(x => ST.itemPoints(x.item).map(q => q[0]))), moved: false };
      } else if (!hit) ui.marquee = { a: p, b: p };
    } else if (ui.tool === 'erase') {
      snapshot();
      ui.erasing = true;
      ui.erased = false;
      eraseAt(p);
    } else if (ui.tool === 'spray') {
      startSpray(p);
    } else if (isShapeTool(ui.tool) || ui.tool === 'text') {
      if (ui.textEntry) commitTextEntry();
      startDraft(p, false);
    } else {
      startPen(p, false);
    }
  });
  canvas.addEventListener('dblclick', e => { // double-click words to change them
    const hit = itemAt(norm(e));
    if (hit && hit.item.kind === 'text') editText(hit);
  });

  canvas.addEventListener('pointermove', e => {
    const p = norm(e);
    ui.hover = p;
    if (ui.tool === 'select' && !ui.moving && !ui.resizing) {
      const h = handleAt(p);
      canvas.style.cursor = h ? (h === 'l' || h === 'r' ? 'ew-resize' : 'ns-resize') : '';
    }
    updateCanvasPos();
    if (ui.pen && !ui.penKb) {
      const pts = ui.pen.points, last = pts[pts.length - 1];
      if (Math.hypot((p[0] - last[0]) * W, (p[1] - last[1]) * H) >= 2) {
        pts.push(p);
        engine.monitorMove(p[1]);
      }
    } else if (ui.draft && !ui.draft.kb) {
      moveDraft(p, e.shiftKey);
    } else if (ui.resizing) {
      resizeSelected(p);
    } else if (ui.marquee) {
      ui.marquee.b = p;
    } else if (ui.moving) {
      moveSelected(p);
    } else if (ui.spray) {
      ui.spray.at = p;
    } else if (ui.erasing) {
      eraseAt(p);
    }
    requestRender();
  });

  function endPointer() {
    if (ui.resizing) {
      const r = ui.resizing;
      ui.resizing = null;
      if (r.moved) { refreshAfterEdit(); announce(r.edge === 'l' || r.edge === 'r' ? 'Stretched in time' : 'Stretched in pitch'); }
    }
    if (ui.marquee) finishMarquee();
    if (ui.moving) {
      const m = ui.moving;
      ui.moving = null;
      if (m.moved) { refreshAfterEdit(); announce('Moved'); }
    }
    if (ui.pen && !ui.penKb) commitPen();
    if (ui.draft && !ui.draft.kb) commitDraft();
    if (ui.spray) commitSpray();
    if (ui.erasing) {
      ui.erasing = false;
      if (ui.erased) { refreshAfterEdit(); announce('Erased'); } else { past.pop(); updateUndo(); }
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => { ui.hover = null; updateCanvasPos(); requestRender(); });

  // Where am I? Bar.beat and the note under the pointer; otherwise the key, scale and snap.
  const posEl = $('#canvas-pos');
  function updateCanvasPos() {
    const p = ui.hover, scale = SCALES.find(x => x.id === project.scale);
    const scaleName = project.scale === 'theremin' ? 'continuous pitch' : `${ST.KEY_NAMES[project.key || 0]} ${scale.label.split('·').pop().trim()}`;
    if (!p) {
      posEl.textContent = `${scaleName}${project.snap && project.snap !== 'off' ? ` · snap ${project.snap}` : ''}`;
      return;
    }
    const t = p[0] * L(), beat = Math.floor(t / beatSec() + 1e-6), sixteenth = Math.floor((t / beatSec() - beat) * 4 + 1e-6);
    posEl.textContent = `${Math.floor(beat / 4) + 1}.${beat % 4 + 1}.${sixteenth + 1} · ${noteName(yToMidi(p[1], project.scale, current().sound.register))}`;
  }

  // Keyboard drawing: arrows move the cursor, Enter acts with the current tool (Space always plays).
  function describeCursor() {
    const { x, y } = ui.cursor;
    const note = noteName(yToMidi(y, project.scale, current().sound.register));
    return `${barBeat(x * L())}, ${note}${ui.pen || ui.draft ? ', drawing' : ''}`;
  }

  canvas.addEventListener('keydown', e => {
    if (e.altKey && e.key.startsWith('Arrow') && !ui.pen && !ui.draft) return; // nudge, handled globally
    const cur = ui.cursor;
    const dx = e.shiftKey ? 1 / 16 : 1 / 80, dy = e.shiftKey ? 4 / 36 : 1 / 36;
    const moves = { ArrowLeft: [-dx, 0], ArrowRight: [dx, 0], ArrowUp: [0, -dy], ArrowDown: [0, dy] };
    if (moves[e.key]) {
      e.preventDefault();
      cur.x = clamp01(cur.x + moves[e.key][0]);
      cur.y = clamp01(cur.y + moves[e.key][1]);
      if (ui.pen && ui.penKb) { ui.pen.points.push([cur.x, cur.y]); engine.monitorMove(cur.y); }
      if (ui.draft && ui.draft.kb) moveDraft([cur.x, cur.y], false);
      speak(describeCursor());
      requestRender();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.repeat) return;
      const p = [cur.x, cur.y];
      const picked = selected();
      if (ui.tool === 'select' && e.key === 'Enter' && picked && picked.item.kind === 'text') {
        editText(picked);
      } else if (ui.tool === 'select') {
        selectAt(p);
      } else if (ui.tool === 'text') {
        unhideForDrawing();
        snapshot();
        openTextEntry({ a: p, b: p, dragged: false });
      } else if (ui.tool === 'erase') {
        snapshot();
        ui.erased = false;
        eraseAt(p);
        if (ui.erased) { refreshAfterEdit(); announce('Erased'); } else { past.pop(); updateUndo(); announce('Nothing here to erase'); }
      } else if (ui.tool === 'spray') {
        startSpray(p);
        sprayTick(9);
        commitSpray();
      } else if (isShapeTool(ui.tool)) {
        if (ui.draft) commitDraft();
        else { startDraft(p, true); speak('Start point set. Move with the arrow keys, press Enter to finish, Escape to cancel.'); }
      } else if (ui.pen) {
        commitPen();
      } else {
        startPen(p, true);
        speak('Pen down. Move with the arrow keys, press Enter to finish, Escape to cancel.');
      }
    } else if (e.key === 'Escape' && ui.sel && !ui.pen && !ui.draft) {
      e.stopPropagation();
      ui.sel = null;
      renderKnobStrip();
      requestRender();
      announce('Nothing selected: the knobs now shape new lines');
    } else if (e.key === 'Escape' && (ui.pen || ui.draft)) {
      e.preventDefault();
      e.stopPropagation();
      cancelPen();
      announce('Cancelled');
    }
  });
  canvas.addEventListener('focus', () => { requestRender(); if (canvas.matches(':focus-visible')) speak(describeCursor()); });
  canvas.addEventListener('blur', () => {
    if (ui.pen && ui.penKb) commitPen();
    if (ui.draft && ui.draft.kb) commitDraft();
    requestRender();
  });

  // ---------- pattern generator ----------
  // Repeat a motif across the loop (presets for a quick start), preview it as a
  // ghost on the canvas, try it, then add it as normal items: one undo removes it.
  const PATTERN_KNOBS = [
    { key: 'repeats', label: 'Repeats', min: 1, max: 32, step: 1, fmt: v => `×${v}`, hint: 'How many times the motif repeats across the loop' },
    { key: 'length', label: 'Length', min: 10, max: 100, step: 1, fmt: v => `${Math.round(v)}%`, hint: 'How much of its slot each motif fills: short and bouncy to legato' },
    { key: 'rows', label: 'Rows', min: 1, max: 4, step: 1, fmt: v => (v === 1 ? 'Single' : `${v} rows`), hint: 'Stack copies in pitch: chords' },
    { key: 'rowGap', label: 'Row gap', min: 1, max: 12, step: 1, fmt: v => `${v} st`, hint: 'Distance between the rows, in semitones' },
    { key: 'climb', label: 'Climb', min: -7, max: 7, step: 1, fmt: v => (v ? `${v > 0 ? '+' : ''}${v} st` : 'Flat'), hint: 'Each repeat goes up or down: staircases and arpeggios' },
    { key: 'cycle', label: 'Cycle', min: 0, max: 8, step: 1, fmt: v => (v ? `every ${v}` : 'Never'), hint: 'The climb starts again every few repeats, like an arpeggiator' },
    { key: 'height', label: 'Height', min: 0, max: 24, step: 1, fmt: v => `${v} st`, hint: 'How tall each motif is' },
    { key: 'offset', label: 'Brick', min: 0, max: 50, step: 1, fmt: v => (v ? `${Math.round(v)}%` : 'Off'), hint: 'Shift every other row in time, like bricks: off-beats' },
    { key: 'random', label: 'Random', min: 0, max: 100, step: 1, fmt: v => (v ? `${Math.round(v)}%` : 'Off'), hint: 'Scatter the repeats a little in time and pitch' },
    { key: 'y', label: 'Pitch', min: 0, max: 1, step: 1 / 72, fmt: v => noteName(yToMidi(1 - v, project.scale, current().sound.register)), hint: 'Where the pattern starts in pitch' },
  ];
  const PATTERN_MPK = ['repeats', 'length', 'rows', 'climb', 'height', 'offset', 'random', 'y'];
  const patternKnobs = {};
  let patternCache = { key: '', items: [] };
  function patternItems() {
    const key = JSON.stringify(ui.pattern) + ui.brush;
    if (patternCache.key !== key) patternCache = { key, items: ST.generatePattern(ui.pattern, ui.brush) };
    return patternCache.items;
  }
  const patternMatches = v => Object.entries(v).every(([k, x]) => ui.pattern[k] === x);

  function buildPatternBar() {
    const bar = $('#pattern-bar');
    bar.innerHTML = `
      <div class="pb-head">
        <h2 class="pb-title" id="pb-title">Patterns</h2>
        <p class="pb-intro">Pick a preset or a motif and shape it. The preview shows it over ${esc(current().name)}.</p>
        <button type="button" class="icon-btn" data-pb="close" aria-label="Close patterns">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
      </div>
      <canvas class="pb-preview" id="pb-preview" role="img" aria-label="Preview: the pattern drawn over the current layer"></canvas>
      <div class="pb-row">
        <span class="field-label" id="pb-presets">Presets</span>
        <div class="chips" role="group" aria-labelledby="pb-presets">${ST.PATTERN_PRESETS.map(pr =>
          `<button type="button" class="chip" data-preset-pattern="${pr.id}" aria-pressed="false">${pr.label}</button>`).join('')}</div>
      </div>
      <div class="pb-row">
        <span class="field-label" id="pb-motif">Motif</span>
        <div class="pb-motifs" role="radiogroup" aria-labelledby="pb-motif">${ST.PATTERN_MOTIFS.map(m => `
          <label class="pb-motif"><input type="radio" name="pmotif" value="${m.id}">
            <span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${m.icon}"/></svg>${m.label}</span></label>`).join('')}
        </div>
        <label class="check"><input type="checkbox" id="pb-mirror">Mirror every other</label>
      </div>
      <div class="pb-knobs" role="group" aria-label="Pattern shape"></div>
      <div class="pb-foot">
        <button type="button" class="dev-btn" data-pb="dice" title="New random scatter (turns Random on if it is off)">Roll dice</button>
        <button type="button" class="dev-btn" data-pb="try">${ICON.play}Try</button>
        <span class="toolbar-spacer"></span>
        <button type="button" class="btn pb-add" data-pb="add">Add to layer</button>
      </div>`;
    const host = bar.querySelector('.pb-knobs');
    for (const k of PATTERN_KNOBS) {
      const kn = createKnob({ ...k, value: k.key === 'y' ? 1 - ui.pattern.y : ui.pattern[k.key], reset: k.key === 'y' ? 0.5 : ST.PATTERN_DEFAULT[k.key],
        onInput: v => setPattern(k.key, k.key === 'y' ? 1 - v : v) });
      kn.el.dataset.path = `pattern.${k.key}`;
      patternKnobs[k.key] = kn;
      host.append(kn.el);
    }
    syncPatternBar();
  }
  function syncPatternBar() {
    const bar = $('#pattern-bar');
    for (const k of PATTERN_KNOBS) patternKnobs[k.key].set(k.key === 'y' ? 1 - ui.pattern.y : ui.pattern[k.key]);
    bar.querySelectorAll('[data-preset-pattern]').forEach(b => b.setAttribute('aria-pressed', String(patternMatches(ST.PATTERN_PRESETS.find(x => x.id === b.dataset.presetPattern).v))));
    const radio = bar.querySelector(`input[name="pmotif"][value="${ui.pattern.motif}"]`);
    if (radio) radio.checked = true;
    $('#pb-mirror').checked = !!ui.pattern.mirror;
    const n = patternItems().reduce((a, it) => a + (it.dots ? it.dots.length : 1), 0);
    bar.querySelector('.pb-add').textContent = `Add ${n} to ${current().name}`;
    drawPatternPreview();
  }
  // The pattern in the layer's colour over a faint copy of what the layer already has.
  function drawPatternPreview() {
    const cv = $('#pb-preview');
    if (!cv) return;
    const w = cv.clientWidth, h = cv.clientHeight, r = window.devicePixelRatio || 1, c = cv.getContext('2d'), layer = current();
    if (!w || !h) return;
    cv.width = Math.round(w * r);
    cv.height = Math.round(h * r);
    c.setTransform(r, 0, 0, r, 0, 0);
    c.fillStyle = theme.paper;
    c.fillRect(0, 0, w, h);
    const beats = project.bars * 4;
    for (let b = 1; b < beats; b++) {
      c.fillStyle = b % 4 ? theme.grid : theme['grid-strong'];
      c.fillRect(Math.round(b / beats * w), 0, 1, h);
    }
    const paint = (it, alpha) => {
      const g = geom(it);
      c.globalAlpha = alpha;
      c.strokeStyle = c.fillStyle = layer.color;
      c.lineWidth = 3;
      c.lineCap = c.lineJoin = 'round';
      if (g.dots) { for (const [x, y] of g.dots) { c.beginPath(); c.arc(x * w, y * h, 2.5, 0, Math.PI * 2); c.fill(); } return; }
      const pts = g.points || g.poly;
      c.beginPath();
      pts.forEach(([x, y], i) => (i ? c.lineTo(x * w, y * h) : c.moveTo(x * w, y * h)));
      if (pts.length === 1) c.lineTo(pts[0][0] * w + 0.5, pts[0][1] * h);
      c.stroke();
    };
    for (const it of layer.strokes) paint(it, 0.18);
    for (const it of patternItems()) paint(it, 0.95);
    c.globalAlpha = 1;
  }
  function setPattern(key, value) {
    if (ui.pattern[key] === value) return;
    ui.pattern = { ...ui.pattern, [key]: value };
    syncPatternBar();
    requestRender();
  }
  const patternDlg = $('#pattern-dialog');
  function setPatternOpen(open) {
    if (open === ui.patternOpen) return;
    ui.patternOpen = open;
    $('#pattern-toggle').setAttribute('aria-pressed', String(open));
    if (open) {
      buildPatternBar();
      patternDlg.showModal();
      requestAnimationFrame(drawPatternPreview); // the canvas has a size once the popup is open
    } else if (patternDlg.open) patternDlg.close();
    renderKnobStrip();
  }
  patternDlg.addEventListener('cancel', () => setPatternOpen(false)); // Esc, at once
  patternDlg.addEventListener('close', () => setPatternOpen(false));
  patternDlg.addEventListener('click', e => { if (e.target === patternDlg) setPatternOpen(false); });
  $('#pattern-toggle').addEventListener('click', () => setPatternOpen(!ui.patternOpen));
  $('#pattern-bar').addEventListener('change', e => {
    if (e.target.name === 'pmotif') { setPattern('motif', e.target.value); engine.audition(current(), patternItems().slice(0, 4), 1.2); }
    else if (e.target.id === 'pb-mirror') setPattern('mirror', e.target.checked);
  });
  $('#pattern-bar').addEventListener('click', e => {
    const pr = e.target.closest('[data-preset-pattern]'), act = e.target.closest('[data-pb]');
    if (pr) {
      const preset = ST.PATTERN_PRESETS.find(x => x.id === pr.dataset.presetPattern);
      ui.pattern = { ...ST.PATTERN_DEFAULT, ...preset.v, seed: ui.pattern.seed };
      syncPatternBar();
      requestRender();
      engine.audition(current(), patternItems());
      announce(`Pattern preset: ${preset.label}`);
      return;
    }
    if (!act) return;
    const a = act.dataset.pb;
    if (a === 'dice') {
      setPattern('seed', 1 + Math.floor(Math.random() * 1e6));
      if (!ui.pattern.random) setPattern('random', 40);
      announce('New random pattern');
    } else if (a === 'try') {
      engine.audition(current(), patternItems());
    } else if (a === 'close') {
      setPatternOpen(false);
      $('#pattern-toggle').focus();
    } else if (a === 'add') {
      const items = patternItems(), layer = current();
      if (!items.length) { announce('Nothing to add: the pattern is outside the loop'); return; }
      unhideForDrawing();
      snapshot();
      for (const it of items) layer.strokes.push({ ...JSON.parse(JSON.stringify(it)), id: uid() });
      ui.sel = null;
      setPatternOpen(false);
      refreshAfterEdit();
      announce(`Pattern added to ${layer.name}. Undo removes it in one step.`);
    }
  });

  // ---------- text brush ----------
  // A small box opens where you clicked; Enter places the words, Escape cancels.
  const textEntry = $('#text-entry');
  function openTextEntry(entry) {
    ui.textEntry = entry;
    const x = entry.a[0] * W, y = entry.a[1] * H;
    textEntry.style.left = `${Math.min(Math.max(8, x), W - 228)}px`;
    textEntry.style.top = `${Math.min(Math.max(8, y - 44), H - 44)}px`;
    textEntry.value = entry.edit ? entry.edit.item.text : '';
    textEntry.hidden = false;
    textEntry.focus();
    textEntry.select();
    updateEmpty();
    requestRender();
  }
  function closeTextEntry() {
    ui.textEntry = null;
    textEntry.hidden = true;
    canvas.focus({ preventScroll: true });
    updateEmpty();
    requestRender();
  }
  // How long a word lasts when you just click: about a syllable per beat-ish.
  const textSpan = (text, x) => {
    const secs = ST.toPhones(text).length * 0.16 + 0.15;
    return Math.min(1 - x, Math.max(0.03, secs / L()));
  };
  function commitTextEntry() {
    const entry = ui.textEntry, text = textEntry.value.trim().slice(0, 60);
    if (!entry) return;
    closeTextEntry();
    if (!text) { past.pop(); updateUndo(); announce('No words: nothing added'); return; }
    if (entry.edit) {
      ui.sel = { layerId: entry.edit.layer.id, id: entry.edit.item.id };
      replaceSelected(it => ({ ...it, text }));
      refreshAfterEdit();
      const s = selected();
      if (ui.hear && s) engine.say(s.layer, s.item);
      announce(`Words changed to “${text}”`);
      return;
    }
    const a = entry.a, b = entry.dragged ? entry.b : [a[0] + textSpan(text, a[0]), a[1]];
    const item = { kind: 'text', size: ui.brush, text, voice: ui.voice, points: [a, b].sort((p, q) => p[0] - q[0]) };
    commitItem(item);
    const s = selected();
    if (ui.hear && s) engine.say(s.layer, s.item);
  }
  function cancelTextEntry() {
    const entry = ui.textEntry;
    closeTextEntry();
    if (entry) { past.pop(); updateUndo(); announce('Cancelled'); }
  }
  function editText(hit) {
    if (hit.layer !== current()) selectLayer(hit.layer.id);
    ui.sel = { layerId: hit.layer.id, id: hit.item.id };
    snapshot();
    openTextEntry({ a: ST.itemPoints(hit.item)[0], edit: hit });
  }
  textEntry.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commitTextEntry(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelTextEntry(); }
  });
  textEntry.addEventListener('blur', () => { if (ui.textEntry) commitTextEntry(); });

  // Voice: the size of the singer's mouth. Applies to new words and the selected ones.
  document.querySelectorAll('input[name="voice"]').forEach(r => r.addEventListener('change', () => {
    ui.voice = r.value;
    const s = selected();
    if (s && s.item.kind === 'text') {
      snapshot();
      replaceSelected(it => ({ ...it, voice: ui.voice }));
      refreshAfterEdit();
      const now = selected();
      if (ui.hear && now) engine.say(now.layer, now.item);
    }
    announce(`${r.value === 'low' ? 'Low' : r.value === 'high' ? 'High' : 'Middle'} voice`);
  }));

  // ---------- toolbar ----------
  $('#toolbox').innerHTML = TOOLS.map(t => `
    <label class="tool" title="${t.label} (${t.key.toUpperCase()})">
      <input type="radio" name="tool" value="${t.id}"${t.id === ui.tool ? ' checked' : ''} aria-keyshortcuts="${t.key.toUpperCase()}">
      <span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${t.icon}"/></svg><span class="tool-name">${t.label}</span></span>
    </label>`).join('');

  let hintTimer = 0;
  function setTool(id, quiet) {
    const t = toolOf(id);
    ui.tool = id;
    const radio = document.querySelector(`#toolbox input[value="${id}"]`);
    if (radio) radio.checked = true;
    $('#fill-seg').hidden = !(id === 'rect' || id === 'ellipse');
    $('#voice-seg').hidden = id !== 'text';
    canvas.dataset.tool = id;
    const hint = $('#tool-hint');
    hint.innerHTML = `<b>${t.label}</b> ${t.hint}`;
    if (!quiet) { // not on page load: no tip over the drawing
      hint.classList.add('is-visible');
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => hint.classList.remove('is-visible'), 3200);
      announce(`${t.label}: ${t.hint}`);
    }
    requestRender();
  }
  function setFill(filled) {
    ui.fill = filled;
    document.querySelector(`#fill-seg input[value="${filled ? 'filled' : 'outline'}"]`).checked = true;
  }
  $('#toolbox').addEventListener('change', e => setTool(e.target.value));
  $('#fill-seg').addEventListener('change', e => { setFill(e.target.value === 'filled'); announce(ui.fill ? 'Filled shapes play a chord' : 'Outline shapes play their edges'); });
  document.querySelectorAll('input[name="brush"]').forEach(r => r.addEventListener('change', () => { ui.brush = r.value; }));
  $('#snap').addEventListener('change', e => setSnap(e.target.value));
  $('#note-view').addEventListener('click', () => {
    ui.noteView = !ui.noteView;
    $('#note-view').setAttribute('aria-pressed', String(ui.noteView));
    $('#quantize').hidden = !ui.noteView;
    requestRender();
    announce(ui.noteView ? `Note view: ${current().name} as notes on a grid. Quantize snaps them to the beat.` : 'Drawing view');
  });
  $('#quantize').addEventListener('click', () => {
    const layer = current();
    if (!layer.strokes.length) { announce('Nothing to quantize on this layer'); return; }
    const was = project.snap;
    if (!snapUnit()) project.snap = '1/16'; // quantize needs a grid: 1/16 when snap is off
    snapshot();
    layer.strokes = layer.strokes.map(it => {
      if (it.kind === 'text' || !ST.hasTf(it)) return { ...snapItem(it), id: it.id };
      const tf = tfOf(it), b = boundsOf(it), g = snapUnit(); // keep transforms: move the whole item so its start lands on the grid
      return { ...it, tf: { ...tf, dx: tf.dx + (Math.round(b.x0 / g) * g - b.x0) } };
    });
    project.snap = was;
    refreshAfterEdit();
    announce(`${layer.name} quantized to ${was && was !== 'off' ? was : '1/16'} notes. Undo brings the free timing back.`);
  });
  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
  $('#clear-layer').addEventListener('click', () => {
    const layer = current();
    if (!layer.strokes.length) { announce(`${layer.name} is already empty`); return; }
    snapshot();
    layer.strokes = [];
    refreshAfterEdit();
    announce(`${layer.name} cleared. Undo brings it back.`);
  });

  // ---------- side tabs ----------
  const tabs = [$('#tab-layers'), $('#tab-timeline')];
  function setSide(which, focus) {
    ui.side = which;
    tabs.forEach(t => {
      const on = t.id === `tab-${which}`;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(`#${t.getAttribute('aria-controls')}`).hidden = !on;
      if (on && focus) t.focus();
    });
    if (which === 'timeline') renderReadPanel();
  }
  tabs.forEach(t => {
    t.addEventListener('click', () => setSide(t.id.replace('tab-', '')));
    t.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const ids = tabs.map(x => x.id.replace('tab-', '')), i = ids.indexOf(ui.side);
      const next = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: ids.length - 1 }[e.key];
      setSide(ids[(next + ids.length) % ids.length], true);
    });
  });

  // ---------- layers ----------
  const layerList = $('#layer-list');
  const panText = v => (Math.abs(v) < 0.01 ? 'Centre' : `${Math.round(Math.abs(v) * 100)}% ${v < 0 ? 'left' : 'right'}`);

  function renderLayers() {
    const focusKey = document.activeElement && document.activeElement.dataset.focusKey;
    layerList.innerHTML = project.layers.map(l => {
      const sel = !ui.drumSel && l.id === project.selected, name = esc(l.name), n = l.strokes.length;
      const mode = l.read.mode !== 'normal' ? ` · ${modeOf(l.read.mode).label}` : '';
      return `<li class="layer${sel ? ' is-selected' : ''}${l.muted ? ' is-muted' : ''}${l.hidden ? ' is-hidden' : ''}" style="--layer:${l.color}">
        <button type="button" class="layer-select" data-act="select" data-id="${l.id}" data-focus-key="select-${l.id}" aria-pressed="${sel}">
          <span class="swatch" aria-hidden="true"></span>
          <span class="layer-text"><span class="layer-name">${name}</span><span class="layer-meta">${esc(presetLabel(l))} · ${n} ${n === 1 ? 'line' : 'lines'}${mode}</span></span>
        </button>
        <div class="layer-controls">
          <div class="msv" role="group" aria-label="${name} switches">
            <button type="button" class="msv-btn msv-m" data-act="mute" data-id="${l.id}" data-focus-key="mute-${l.id}" aria-pressed="${l.muted}" aria-label="Mute ${name}" title="Mute">M</button>
            <button type="button" class="msv-btn msv-s" data-act="solo" data-id="${l.id}" data-focus-key="solo-${l.id}" aria-pressed="${l.solo}" aria-label="Solo ${name}" title="Solo: hear only this layer">S</button>
            <button type="button" class="msv-btn msv-v" data-act="hide" data-id="${l.id}" data-focus-key="hide-${l.id}" aria-pressed="${l.hidden}" aria-label="Hide ${name} on the canvas" title="Show or hide on the canvas">${l.hidden ? ICON.eyeOff : ICON.eye}</button>
          </div>
          <input type="range" class="pan" min="-100" max="100" step="1" value="${Math.round((l.pan || 0) * 100)}" data-act="pan" data-id="${l.id}" data-focus-key="pan-${l.id}" aria-label="${name} pan" aria-valuetext="${panText(l.pan || 0)}" title="Pan: ${panText(l.pan || 0)} (double-click to centre)">
          <input type="range" class="vol" min="0" max="100" value="${Math.round(l.volume * 100)}" data-act="volume" data-id="${l.id}" data-focus-key="vol-${l.id}" aria-label="${name} volume">
          <button type="button" class="icon-btn" data-act="delete" data-id="${l.id}" data-focus-key="del-${l.id}" aria-label="Delete ${name}" title="Delete layer"${project.layers.length === 1 ? ' disabled' : ''}>${ICON.trash}</button>
        </div>
      </li>`;
    }).join('') + drumRow();
    if (focusKey) {
      const el = layerList.querySelector(`[data-focus-key="${focusKey}"]`);
      if (el) el.focus();
    }
    $('#add-layer').disabled = project.layers.length >= MAX_LAYERS;
    updateDrumState();
    renderMixer();
    if (ui.dock) updateDockHint();
  }

  const drumKitLabel = d => (d.preset === 'custom' ? 'Custom kit' : (myFind(MY_KITS, d.preset) || {}).name || (ST.DRUM_KITS.find(k => k.id === d.preset) || { label: 'Kit' }).label);
  function drumMeta() {
    const d = project.drums, style = ST.DRUM_STYLES.find(s => Object.entries(s.v).every(([k, v]) => d[k] === v));
    return `${drumKitLabel(d)} · ${d.muted ? 'Muted' : ST.drumsDrawn(d) ? (style ? style.label : 'your groove') : 'no pattern yet'}`;
  }
  function drumRow() {
    const d = project.drums, sel = ui.drumSel, hidden = $('#drum-body').hidden;
    return `<li class="layer drum-layer${sel ? ' is-selected' : ''}${d.muted ? ' is-muted' : ''}" style="--layer:${ST.DRUM_COLOR}">
        <button type="button" class="layer-select" data-act="select" data-id="drums" data-focus-key="select-drums" aria-pressed="${sel}">
          <span class="swatch" aria-hidden="true"></span>
          <span class="layer-text"><span class="layer-name">Drum layer</span><span class="layer-meta">${esc(drumMeta())}</span></span>
        </button>
        <div class="layer-controls">
          <div class="msv" role="group" aria-label="Drum layer switches">
            <button type="button" class="msv-btn msv-m" data-act="mute" data-id="drums" data-focus-key="mute-drums" aria-pressed="${d.muted}" aria-label="Mute drums" title="Mute">M</button>
            <button type="button" class="msv-btn msv-s" data-act="solo" data-id="drums" data-focus-key="solo-drums" aria-pressed="${d.solo}" aria-label="Solo drums" title="Solo: hear only the drums">S</button>
            <button type="button" class="msv-btn msv-v" data-act="hide" data-id="drums" data-focus-key="hide-drums" aria-pressed="${hidden}" aria-label="Hide the drum strip" title="Show or hide the drum strip">${hidden ? ICON.eyeOff : ICON.eye}</button>
          </div>
          <input type="range" class="pan" min="-100" max="100" step="1" value="${Math.round((d.pan || 0) * 100)}" data-act="pan" data-id="drums" data-focus-key="pan-drums" aria-label="Drums pan" aria-valuetext="${panText(d.pan || 0)}" title="Pan: ${panText(d.pan || 0)} (double-click to centre)">
          <input type="range" class="vol" min="0" max="100" value="${Math.round(d.volume * 100)}" data-act="volume" data-id="drums" data-focus-key="vol-drums" aria-label="Drums volume">
        </div>
      </li>`;
  }
  // "Playing", "Enabled · no pattern yet" or "Muted": never "off" when it is only empty.
  function drumState() {
    const d = project.drums;
    if (d.muted) return 'Muted';
    if (d.frozen) return `${engine.playing ? 'Playing' : 'On'} · frozen`;
    if (!ST.drumsDrawn(d)) return 'Enabled · no pattern yet';
    return engine.playing ? 'Playing' : 'On';
  }
  function updateDrumState() {
    const el = $('#drum-state'), d = project.drums;
    el.textContent = drumState();
    el.dataset.state = d.muted ? 'muted' : ST.drumsDrawn(d) ? 'on' : 'empty';
  }
  const updateDrumMeta = () => { const m = layerList.querySelector('.drum-layer .layer-meta'); if (m) m.textContent = drumMeta(); updateDrumState(); };

  // Selecting the drum layer points the sound cards (Source, ADSR, FX) at the drums.
  function selectDrums() {
    ui.drumSel = true;
    if (ui.dock) updateDockHint();
    if (ui.panel === 'voice') setPanel(null);
    renderLayers();
    updateCards();
    buildQuick();
    if (ui.panel) buildPanel();
    else renderKnobStrip();
    announce('Drum layer selected: the sound cards now shape the drums');
  }
  function drumRowAct(act) {
    const d = project.drums;
    if (act === 'select') { selectDrums(); return; }
    if (act === 'mute') {
      d.muted = !d.muted;
      $('#drum-on').checked = !d.muted;
      announce(`Drums ${d.muted ? 'muted' : 'on'}`);
    } else if (act === 'solo') {
      d.solo = !d.solo;
      announce(d.solo ? 'Drums solo: only soloed layers play' : 'Drums solo off');
    } else if (act === 'hide') {
      $('#drum-toggle').click();
      return;
    }
    engine.updateAll();
    renderLayers();
    requestRender();
    save();
  }

  function selectLayer(id) {
    project.selected = id;
    ui.drumSel = false;
    ui.etch.id = null;
    if (ui.patternOpen) buildPatternBar(); // "Add to <layer>" follows the selection
    renderLayers();
    updateCards();
    buildQuick();
    if (ui.panel) buildPanel();
    else renderKnobStrip();
    renderReadPanel();
    if (ui.dock === 'perform') syncPerformControls();
    requestRender();
    save();
    const l = current();
    announce(`${l.name} selected: ${presetLabel(l)}`);
  }

  layerList.addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (btn.dataset.id === 'drums') { drumRowAct(btn.dataset.act); return; }
    const layer = project.layers.find(l => l.id === btn.dataset.id);
    if (!layer) return;
    const act = btn.dataset.act;
    if (act === 'select') {
      selectLayer(layer.id);
    } else if (act === 'mute' || act === 'solo') {
      layer[act === 'mute' ? 'muted' : 'solo'] = !layer[act === 'mute' ? 'muted' : 'solo'];
      engine.updateAll();
      renderLayers();
      requestRender();
      save();
      const soloed = project.layers.filter(l => l.solo).length;
      announce(act === 'mute'
        ? `${layer.name} ${layer.muted ? 'muted' : 'unmuted'}`
        : layer.solo ? `${layer.name} solo: only soloed layers play` : `${layer.name} solo off${soloed ? '' : ', all layers play'}`);
    } else if (act === 'hide') {
      layer.hidden = !layer.hidden;
      renderLayers();
      requestRender();
      save();
      announce(`${layer.name} ${layer.hidden ? 'hidden on the canvas (still plays)' : 'visible'}`);
    } else if (act === 'delete') {
      snapshot();
      const i = project.layers.indexOf(layer);
      project.layers.splice(i, 1);
      if (project.selected === layer.id) project.selected = project.layers[Math.max(0, i - 1)].id;
      save();
      engine.updateAll();
      refreshAll();
      const next = layerList.querySelector(`[data-focus-key="select-${project.selected}"]`);
      if (next) next.focus();
      announce(`${layer.name} deleted. Undo brings it back.`);
    }
  });
  function setPan(id, v) {
    const target = id === 'drums' ? project.drums : project.layers.find(l => l.id === id);
    if (!target) return;
    target.pan = Math.max(-1, Math.min(1, v));
    if (id === 'drums') engine.updateDrums(); else engine.updateLayer(target);
    const input = layerList.querySelector(`.pan[data-id="${id}"]`);
    if (input) {
      input.value = Math.round(target.pan * 100);
      input.setAttribute('aria-valuetext', panText(target.pan));
      input.title = `Pan: ${panText(target.pan)} (double-click to centre)`;
    }
    save();
  }
  layerList.addEventListener('dblclick', e => { if (e.target.dataset.act === 'pan') setPan(e.target.dataset.id, 0); });
  layerList.addEventListener('input', e => {
    if (e.target.dataset.act === 'pan') { setPan(e.target.dataset.id, e.target.value / 100); return; }
    if (e.target.dataset.act !== 'volume') return;
    if (e.target.dataset.id === 'drums') { setDrum('volume', e.target.value / 100); return; }
    const layer = project.layers.find(l => l.id === e.target.dataset.id);
    layer.volume = e.target.value / 100;
    engine.updateLayer(layer);
    save();
  });

  $('#add-layer').addEventListener('click', () => {
    if (project.layers.length >= MAX_LAYERS) return;
    snapshot();
    project.layerCount += 1;
    const layer = makeLayer(project.layerCount);
    project.layers.push(layer);
    selectLayer(layer.id);
    announce(`${layer.name} added with ${presetLabel(layer)}. Draw to use it.`);
  });

  // ---------- timeline tab: read modes ----------
  function renderReadPanel() {
    const l = current(), r = l.read, mode = modeOf(r.mode);
    $('#read-layer').textContent = l.name;
    $('#read-mode-name').textContent = mode.label;
    $('#read-desc').textContent = mode.desc;
    $('#read-modes').innerHTML = READ_MODES.map(m => `
      <label class="read-opt"><input type="radio" name="readmode" value="${m.id}"${m.id === r.mode ? ' checked' : ''}>
        <span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${m.icon}"/></svg>${m.label}</span>
      </label>`).join('');
    const on = sliced(l);
    $('#divisions').innerHTML = DIVISIONS.map(n => `
      <label><input type="radio" name="divisions" value="${n}"${n === r.divisions ? ' checked' : ''}${on ? '' : ' disabled'}><span>${n}</span></label>`).join('');
    $('#reshuffle').disabled = !on;
    $('.slice-wrap').hidden = !on;
    if (on) {
      $('#slice-map').innerHTML = sliceOrder(r).map((src, j) =>
        `<li class="${src < 0 ? 'is-silent' : ''}" style="--layer:${l.color}"><span class="sr-only">Slot ${j + 1} plays </span>${src < 0 ? '–' : src + 1}${src < 0 ? '<span class="sr-only">silence</span>' : ''}</li>`).join('');
    }
  }

  $('#read-modes').addEventListener('change', e => {
    const l = current();
    l.read.mode = e.target.value;
    readChanged(`${l.name} reads ${modeOf(l.read.mode).label.toLowerCase()}`);
    const el = document.querySelector(`#read-modes input[value="${l.read.mode}"]`);
    if (el) el.focus();
  });
  $('#divisions').addEventListener('change', e => {
    const l = current();
    l.read.divisions = Number(e.target.value);
    readChanged(`${l.name}: ${l.read.divisions} slices`);
    const el = document.querySelector(`#divisions input[value="${l.read.divisions}"]`);
    if (el) el.focus();
  });
  $('#reshuffle').addEventListener('click', () => {
    const l = current();
    l.read.seed = 1 + Math.floor(Math.random() * 1e6);
    readChanged('Slices reshuffled');
  });
  function readChanged(msg) {
    save();
    renderReadPanel();
    renderLayers();
    requestRender();
    announce(msg);
  }

  // ---------- quick actions ----------
  function envPath(s, w, h) {
    const A = s.attack, D = s.decay, R = s.release, S = s.sustain / 100, pad = 2;
    const hold = Math.max(0.3, (A + D + R) * 0.3), total = A + D + hold + R;
    const x = t => (pad + t / total * (w - pad * 2)).toFixed(1);
    const y = v => (pad + (1 - v) * (h - pad * 2)).toFixed(1);
    return `M${x(0)} ${y(0)} L${x(A)} ${y(1)} L${x(A + D)} ${y(S)} L${x(A + D + hold)} ${y(S)} L${x(total)} ${y(0)}`;
  }
  const envWords = s => `${s.attack < 0.08 ? 'Quick' : 'Slow'} start, ${s.release < 0.4 ? 'short' : 'long'} fade`;

  // A drum hit's shape: attack, hold, then the fade that Length stretches.
  function hitPath(s, w, h) {
    const pad = 2, dec = 0.35 * s.length, total = s.attack + s.hold + dec * 1.1 + 0.02;
    const x = t => (pad + t / total * (w - pad * 2)).toFixed(1), y = v => (pad + (1 - v) * (h - pad * 2)).toFixed(1);
    const t0 = s.attack + s.hold + 0.002;
    let d = `M${x(0)} ${y(0)} L${x(s.attack + 0.002)} ${y(1)} L${x(t0)} ${y(1)}`;
    for (let i = 1; i <= 12; i++) d += ` L${x(t0 + dec * i / 11)} ${y(Math.exp(-4.5 * i / 11))}`;
    return d;
  }
  const hitWords = s => `${s.attack > 0.008 ? 'Soft' : 'Hard'} hit, ${s.length < 0.8 ? 'tight' : s.length > 1.6 ? 'ringing' : 'natural'} tail`;

  function summary(id, l) {
    const s = l.sound;
    if (id === 'lfo') {
      const f = { ...ST.LFO_DEFAULT, ...l.lfo };
      const more = (l.motions || []).filter(m => m.on).length;
      return esc(`${f.on ? `${lfoTargetLabel(f.target)} · ${rateLabel(f.rate)} · ${(LFO_SHAPES.find(x => x[0] === f.shape) || ['', ''])[1].toLowerCase()}` : 'Off'}${more ? ` · +${more} moving` : ''}`);
    }
    if (id === 'voice') {
      if (isDrums(l)) return 'Only for words on canvas layers';
      const v = voxOf(l), h = ST.VOX_CHOICES.harmony.options.find(o => o[0] === v.harmony)[1];
      const tune = v.tune > 85 ? 'Hard autotune' : v.tune < 5 ? 'Loose pitch' : 'Autotune';
      return esc([tune, v.harmony !== 'off' ? `harmony ${h.toLowerCase()}` : '', v.robot ? 'robot' : '', v.whisper > 40 ? 'whisper' : ''].filter(Boolean).join(' · '));
    }
    if (isDrums(l) && id === 'source') return `${esc(drumKitLabel(l))} · ${s.tune > 0 ? '+' : ''}${s.tune} st`;
    if (isDrums(l) && id === 'envelope') return `<svg class="qa-env" viewBox="0 0 120 26" aria-hidden="true"><path d="${hitPath(s, 120, 26)}"/></svg>${hitWords(s)}`;
    if (id === 'source') return `${WAVES.find(w => w.id === s.wave).label} · ${esc(presetLabel(l))}`;
    if (id === 'envelope') return `<svg class="qa-env" viewBox="0 0 120 26" aria-hidden="true"><path d="${envPath(s, 120, 26)}"/></svg>${envWords(s)}`;
    const on = activeFx(l, id === 'soundfx' ? 'sound' : 'time').map(fid => FX_BY_ID[fid].label);
    return on.length ? esc(on.join(', ')) : 'All off';
  }

  function buildCards() {
    $('#qa-cards').innerHTML = PANELS.map(p => `
      <div class="qa-card" data-panel="${p.id}">
        <button type="button" class="qa-open" data-panel="${p.id}" aria-expanded="false" aria-controls="panel">
          <span class="qa-tag">${p.tag}</span>
          <span class="qa-title">${p.title}</span>
          <span class="qa-summary"></span>
        </button>
        <div class="qa-quick" role="group" aria-label="Quick ${p.title} controls"></div>
      </div>`).join('');
  }

  function updateCards() {
    const l = target();
    document.querySelectorAll('.qa-card').forEach(card => {
      const off = card.dataset.panel === 'voice' && isDrums(l);
      card.classList.toggle('is-disabled', off);
      card.querySelector('.qa-open').disabled = off;
      const open = ui.panel === card.dataset.panel;
      card.querySelector('.qa-open').setAttribute('aria-expanded', String(open));
      card.classList.toggle('is-open', open);
      card.querySelector('.qa-summary').innerHTML = summary(card.dataset.panel, l);
    });
    for (const [key, k] of quickControls) { // an effect's quick knob looks dimmed while it is off
      const [kind, id] = key.split('.');
      if (kind === 'lfo') {
        const on = !!(l.lfo && l.lfo.on), sw = k.el.querySelector('.qk-power');
        k.el.classList.toggle('is-off', !on);
        if (sw) { sw.textContent = on ? 'On' : 'Off'; sw.setAttribute('aria-pressed', String(on)); sw.setAttribute('aria-label', `LFO ${on ? 'on' : 'off'} (${l.name})`); }
        continue;
      }
      if (kind !== 'fx') continue;
      const on = !!l.fx[id].on, sw = k.el.querySelector('.qk-power');
      k.el.classList.toggle('is-off', !on);
      sw.textContent = on ? 'On' : 'Off';
      sw.setAttribute('aria-pressed', String(on));
      sw.setAttribute('aria-label', `${FX_BY_ID[id].label} ${on ? 'on' : 'off'} (${l.name})`);
    }
  }

  // Three quick knobs on every card, always the same ones (like the fixed MPK map).
  const QUICK = {
    source: () => (ui.drumSel ? ['tune', 'tone', 'punch'] : ['brightness', 'sub', 'noise']).map(k => ['sound', k]),
    envelope: () => (ui.drumSel ? ['attack', 'hold', 'length'] : ['attack', 'decay', 'release']).map(k => ['sound', k]),
    soundfx: () => [['fx', 'filter', 'cutoff'], ['fx', 'drive', 'amount'], ['fx', 'comp', 'amount']],
    timefx: () => [['fx', 'echo', 'amount'], ['fx', 'reverb', 'amount'], ['fx', 'chorus', 'amount']],
    voice: () => (ui.drumSel ? [] : ['tune', 'formant', 'robot'].map(k => ['vox', k])),
    lfo: () => [['lfo', 'rate'], ['lfo', 'depth']],
  };
  const quickControls = new Map();
  function buildQuick() {
    quickControls.clear();
    const who = target().name;
    document.querySelectorAll('.qa-card').forEach(card => {
      const host = card.querySelector('.qa-quick');
      host.innerHTML = '';
      for (const path of QUICK[card.dataset.panel]()) {
        const d = paramDef(path);
        if (!d || d.idle) continue;
        const fx = path[0] === 'fx' && FX_BY_ID[path[1]], lfo = path[0] === 'lfo';
        const reset = fx ? fx.defaults[path[2]] : lfo ? (path[1] === 'rate' ? ST.LFO_RATES.indexOf(ST.LFO_DEFAULT.rate) : ST.LFO_DEFAULT.depth) : (ui.drumSel ? ST.DRUM_SOUND : DEFAULT_SOUND)[path[1]];
        const k = createKnob({
          label: fx ? fx.label : lfo ? (path[1] === 'rate' ? 'Speed' : 'Depth') : d.short || d.label, min: d.min, max: d.max, step: d.step, value: d.get(), reset, fmt: d.fmt,
          hint: `${d.hint || ''}${fx ? ' Turning it switches the effect on.' : ''} (${who})`, onInput: v => d.set(v),
        });
        k.el.classList.add('knob-mini');
        k.el.dataset.path = pathKey(path);
        if (fx || (lfo && path[1] === 'depth')) { // a visible switch: the amount stays when the effect is off
          const sw = document.createElement('button');
          sw.type = 'button';
          sw.className = 'qk-power';
          if (fx) sw.dataset.fx = path[1]; else sw.dataset.lfo = '1';
          k.el.append(sw);
        }
        quickControls.set(pathKey(path), k);
        host.append(k.el);
      }
    });
    updateCards();
  }
  const refreshQuick = () => { for (const [key, k] of quickControls) k.set(paramDef(key.split('.')).get()); };

  function setPanel(id) {
    ui.panel = id;
    if (id && ui.dock !== 'sound') setDockTab('sound');
    document.body.classList.toggle('panel-open', !!id);
    $('#panel').hidden = !id;
    updateCards();
    if (id) buildPanel();
    else { panelControls.clear(); renderKnobStrip(); }
  }

  $('#qa-cards').addEventListener('click', e => {
    const sw = e.target.closest('.qk-power');
    if (sw && sw.dataset.lfo) { toggleLfo(); return; }
    if (sw) {
      const l = target(), id = sw.dataset.fx;
      l.fx[id].on = !l.fx[id].on;
      if (!isDrums(l)) markCustom(l);
      engine.updateLayer(l);
      refreshFxState(id);
      updateCards();
      save();
      announce(`${FX_BY_ID[id].label} ${l.fx[id].on ? 'on' : 'off'}`);
      return;
    }
    const card = e.target.closest('.qa-open');
    if (card) setPanel(ui.panel === card.dataset.panel ? null : card.dataset.panel);
  });

  const radioGroup = (name, legend, items, value) => `
    <fieldset class="field" data-path="sound.${name}"><legend>${legend}</legend>
      <div class="${name === 'wave' ? 'wave-row' : 'seg seg-dev'}">${items.map(it => `
        <label class="${name === 'wave' ? 'wave-opt' : ''}"><input type="radio" name="${name}" value="${it.id}"${it.id === value ? ' checked' : ''}>
          <span>${it.path ? `<svg viewBox="0 0 24 12" aria-hidden="true"><path d="${it.path}"/></svg>` : ''}<b>${it.label}</b>${it.hint ? `<small>${it.hint}</small>` : ''}</span>
        </label>`).join('')}
      </div>
    </fieldset>`;

  function myPresetsBlock(key, l, title, noun) {
    const list = myList(key);
    return `
        <div class="field my-presets" data-my-key="${key}">
          <span class="field-label" id="my-${noun}-label">${title}</span>
          <div class="chips" role="group" aria-labelledby="my-${noun}-label">${list.length ? list.map(x => `
            <span class="my-chip"><button type="button" class="chip" data-my="${x.id}" aria-pressed="${l.preset === `my:${x.id}`}">${esc(x.name)}</button><button type="button" class="my-del" data-my-del="${x.id}" aria-label="Delete ${esc(x.name)}" title="Delete">×</button></span>`).join('')
            : `<span class="fx-note">Shape a ${noun} you like, then save it here to reuse it in every project.</span>`}
          </div>
          <div class="my-save">
            <input type="text" maxlength="30" placeholder="Name this ${noun}" aria-label="Name for your ${noun}" data-my-name>
            <button type="button" class="dev-btn" data-my-save>Save as my ${noun}</button>
          </div>
        </div>`;
  }

  const DRUM_INTRO = {
    source: 'The kit and its character: every drum follows these.',
    envelope: 'How every hit starts, holds and rings out.',
    soundfx: 'Change the tone and colour of the drums.',
    timefx: 'Echoes, rooms and movement for the drums.',
  };

  function buildPanel() {
    const def = PANELS.find(p => p.id === ui.panel), l = target(), panel = $('#panel'), drums = isDrums(l);
    panel.style.setProperty('--layer', l.color);
    panel.dataset.kind = def.id; // section hue
    let top = '';
    if (drums && def.id === 'source') {
      top = `
        <div class="field">
          <span class="field-label" id="preset-label">Start from a kit</span>
          <div class="chips" role="group" aria-labelledby="preset-label">${ST.DRUM_KITS.map(k =>
            `<button type="button" class="chip" data-kit="${k.id}" aria-pressed="${l.preset === k.id}">${k.label}</button>`).join('')}
          </div>
        </div>
        ${myPresetsBlock(MY_KITS, l, 'My kits', 'kit')}`;
    } else if (def.vox) {
      const v = voxOf(l);
      top = `<div class="vox-choices">${Object.entries(ST.VOX_CHOICES).map(([key, c]) => `
        <div class="field">
          <span class="field-label" id="vox-${key}-label">${c.label}</span>
          <div class="chips" role="group" aria-labelledby="vox-${key}-label">${c.options.map(([val, lab]) =>
            `<button type="button" class="chip" data-vox="${key}" data-val="${val}" aria-pressed="${v[key] === val}">${lab}</button>`).join('')}
          </div>
        </div>`).join('')}</div>
        ${l.strokes.some(it => it.kind === 'text') ? '' : '<p class="fx-note">No words on this layer yet: pick the Text tool (T) and click the canvas.</p>'}`;
    } else if (drums && def.id === 'envelope') {
      top = `<svg class="env-graph" viewBox="0 0 320 80" role="img" aria-label="Shape of every drum hit"><path d="${hitPath(l.sound, 320, 80)}"/></svg>`;
    } else if (def.id === 'source') {
      top = `
        <div class="field">
          <span class="field-label" id="preset-label">Start from a preset</span>
          <div class="preset-groups">${ST.PRESET_GROUPS.map((g, gi) => `
            <div class="preset-group" role="group" aria-labelledby="pg-${gi}">
              <span class="preset-group-label" id="pg-${gi}">${g.label}</span>
              <div class="chips">${g.ids.map(id =>
                `<button type="button" class="chip" data-preset="${id}" aria-pressed="${l.preset === id}">${PRESETS[id].label}</button>`).join('')}
              </div>
            </div>`).join('')}
          </div>
        </div>
        ${myPresetsBlock(MY_SOUNDS, l, 'My sounds', 'sound')}
        <div class="source-row">
          ${radioGroup('wave', 'Waveform', WAVES, l.sound.wave)}
          ${radioGroup('register', 'Pitch range', REGISTERS, l.sound.register)}
        </div>`;
    } else if (def.id === 'envelope') {
      top = `<svg class="env-graph" viewBox="0 0 320 80" role="img" aria-label="Envelope shape"><path d="${envPath(l.sound, 320, 80)}"/></svg>`;
    }
    panel.innerHTML = `
      <div class="device-head">
        <div class="device-title">
          <span class="swatch" aria-hidden="true"></span>
          <h3 id="panel-title">${def.title} <span class="device-sub">for ${esc(l.name)}</span></h3>
        </div>
        <p class="device-intro">${drums ? DRUM_INTRO[def.id] : def.intro}</p>
        <div class="device-actions">
          <button type="button" class="dev-btn" data-act="preview">${ICON.play}Try sound</button>
          <button type="button" class="dev-btn" data-act="close" aria-label="Close ${def.title} panel">Close</button>
        </div>
      </div>
      <div class="device-body">${top}${def.group ? '<div class="fx-layout"></div>' : '<div class="knob-row"></div>'}</div>`;
    if (def.group) {
      buildFx(def.group);
      return;
    }
    const row = panel.querySelector('.knob-row');
    panelControls.clear();
    if (def.lfo) { buildLfoPanel(l, row); return; }
    if (def.vox) {
      const v = voxOf(l);
      for (const k of def.knobs) {
        const kn = createKnob({ ...k, value: v[k.key], reset: ST.VOX_DEFAULT[k.key], onInput: x => setVox(k.key, x) });
        kn.el.dataset.path = pathKey(['vox', k.key]);
        panelControls.set(kn.el.dataset.path, kn);
        row.append(kn.el);
      }
      renderKnobStrip();
      return;
    }
    for (const k of drums ? ST.DRUM_PANELS[def.id] : def.knobs) {
      const kn = createKnob({ ...k, value: l.sound[k.key], reset: (drums ? ST.DRUM_SOUND : DEFAULT_SOUND)[k.key], onInput: v => setSound(k.key, v) });
      kn.el.dataset.path = pathKey(['sound', k.key]);
      panelControls.set(kn.el.dataset.path, kn);
      row.append(kn.el);
    }
    renderKnobStrip();
  }

  // FX panels: a tab per effect, the selected one shows its switch and controls.
  function buildFx(group) {
    const l = target(), host = document.querySelector('#panel .fx-layout'), sel = ui.fxTab[group];
    const label = group === 'sound' ? 'Sound effects' : 'Time effects';
    host.innerHTML = `
      <div class="fx-tabs" role="tablist" aria-label="${label}">${FX_GROUPS[group].map(id => {
        const f = FX_BY_ID[id], on = l.fx[id].on;
        return `<button type="button" role="tab" class="fx-tab${on ? ' is-on' : ''}" id="fx-tab-${id}" data-fx="${id}" aria-controls="fx-detail"
          aria-selected="${id === sel}" tabindex="${id === sel ? 0 : -1}"><span class="fx-dot" aria-hidden="true"></span>${f.label}<span class="sr-only fx-state">${on ? ', on' : ''}</span></button>`;
      }).join('')}</div>
      <div class="fx-detail" id="fx-detail" role="tabpanel" aria-labelledby="fx-tab-${sel}"></div>`;
    buildFxDetail(sel);
  }

  function buildFxDetail(id) {
    const f = FX_BY_ID[id], l = target(), p = l.fx[id], host = $('#fx-detail');
    host.setAttribute('aria-labelledby', `fx-tab-${id}`);
    host.innerHTML = `
      <div class="fx-head">
        <div><h4>${f.label}</h4><p>${f.hint}</p></div>
        <button type="button" role="switch" class="fx-switch" id="fx-switch" aria-checked="${p.on}" aria-label="${f.label}">
          <span class="fx-switch-track" aria-hidden="true"><span class="fx-switch-thumb"></span></span>
          <span class="fx-switch-text" aria-hidden="true">${p.on ? 'On' : 'Off'}</span>
        </button>
      </div>
      <div class="fx-controls"></div>`;
    const controls = host.querySelector('.fx-controls');
    const opts = document.createElement('div');
    opts.className = 'fx-options';
    const knobs = document.createElement('div');
    knobs.className = 'knob-row';
    panelControls.clear();
    for (const c of f.params) {
      const path = pathKey(['fx', id, c.key]);
      if (c.kind === 'knob') {
        const kn = createKnob({ ...c, value: p[c.key], reset: f.defaults[c.key], onInput: v => setFx(id, c.key, v, c.sets) });
        kn.el.dataset.path = path;
        panelControls.set(path, kn);
        knobs.append(kn.el);
      } else if (c.kind === 'choice') {
        const fs = document.createElement('fieldset');
        fs.className = 'field';
        fs.dataset.path = path;
        fs.innerHTML = `<legend>${c.label}</legend><div class="seg seg-dev">${c.options.map(([v, lab]) =>
          `<label><input type="radio" name="fx-${id}-${c.key}" value="${v}"${String(p[c.key]) === v ? ' checked' : ''}><span>${lab}</span></label>`).join('')}</div>`;
        fs.addEventListener('change', e => setFx(id, c.key, e.target.value));
        opts.append(fs);
      } else if (c.kind === 'toggle') {
        const lab = document.createElement('label');
        lab.className = 'check check-dev';
        lab.dataset.path = path;
        lab.innerHTML = `<input type="checkbox"${p[c.key] ? ' checked' : ''}>${c.label}`;
        lab.querySelector('input').addEventListener('change', e => setFx(id, c.key, e.target.checked));
        opts.append(lab);
      }
    }
    if (opts.children.length) controls.append(opts);
    if (knobs.children.length) controls.append(knobs);
    if (id === 'vibrato' || id === 'tapestop') {
      const note = document.createElement('p');
      note.className = 'fx-note';
      note.textContent = id === 'vibrato' ? 'Applies to new notes as they start.' : 'Happens at the end of every loop pass.';
      controls.append(note);
    }
    renderKnobStrip();
  }

  function refreshFxState(id) {
    const l = target(), on = l.fx[id].on;
    const tab = document.getElementById(`fx-tab-${id}`);
    if (tab) {
      tab.classList.toggle('is-on', on);
      tab.querySelector('.fx-state').textContent = on ? ', on' : '';
    }
    const sw = $('#fx-switch');
    if (sw && document.getElementById('fx-detail').getAttribute('aria-labelledby') === `fx-tab-${id}`) {
      sw.setAttribute('aria-checked', String(on));
      sw.querySelector('.fx-switch-text').textContent = on ? 'On' : 'Off';
    }
  }

  function markCustom(l) {
    if (l.preset === 'custom') return;
    l.preset = 'custom';
    if (isDrums(l)) updateDrumMeta(); else renderLayers();
    document.querySelectorAll('#panel [data-preset], #panel [data-kit]').forEach(c => c.setAttribute('aria-pressed', 'false'));
  }

  // Touching any control of an effect switches it on: no hunting for the power button.
  function setFx(id, key, value, sets, l = target()) {
    const p = l.fx[id], shown = l === target();
    p[key] = value;
    const q = shown && quickControls.get(`fx.${id}.${key}`);
    if (q) q.set(value);
    if (sets) {
      Object.assign(p, sets);
      for (const k in sets) {
        const r = document.querySelector(`#panel input[name="fx-${id}-${k}"][value="${sets[k]}"]`);
        if (r) r.checked = true;
      }
    }
    if (!p.on) { p.on = true; if (shown) refreshFxState(id); announce(`${FX_BY_ID[id].label} on`); }
    if (!isDrums(l)) markCustom(l); // drum kits only set the sound, not the FX
    engine.updateLayer(l);
    updateCards();
    save();
  }

  // ---------- LFO (Motion card) ----------
  const LFO_SHAPES = [['sine', 'Smooth'], ['triangle', 'Even'], ['saw', 'Falling'], ['square', 'On / off'], ['random', 'Random steps']];
  const rateLabel = r => (r < 1 ? `1/${Math.round(4 / r)} note` : r === 1 ? '1 beat' : r < 4 ? `${r} beats` : r === 4 ? '1 bar' : `${r / 4} bars`);
  function lfoTargets() {
    const out = [['Mix', [['volume', 'Volume'], ['pan', 'Pan'], ['send.room', 'Room send'], ['send.echo', 'Echo send']]]];
    for (const group of ['sound', 'time']) {
      for (const id of FX_GROUPS[group]) {
        const f = FX_BY_ID[id], knobs = f.params.filter(c => c.kind === 'knob');
        if (knobs.length) out.push([f.label, knobs.map(c => [`fx.${id}.${c.key}`, c.label.toLowerCase() === f.label.toLowerCase() ? f.label : `${f.label} ${c.label.toLowerCase()}`])]);
      }
    }
    return out;
  }
  const lfoTargetLabel = t => (lfoTargets().flatMap(g => g[1]).find(x => x[0] === t) || [t, t])[1];
  function setLfo(key, value, l = target()) {
    l.lfo = { ...ST.LFO_DEFAULT, ...l.lfo, [key]: value };
    if (key !== 'on' && !l.lfo.on) { l.lfo.on = true; announce('LFO on'); }
    if (l.lfo.on && (key === 'target' || key === 'on') && l.lfo.target.startsWith('fx.')) { // the effect it moves must be on to be heard
      const id = l.lfo.target.split('.')[1];
      if (!l.fx[id].on) { l.fx[id].on = true; announce(`LFO on, and ${FX_BY_ID[id].label} switched on`); }
    }
    if (!isDrums(l)) markCustom(l);
    engine.updateLayer(l);
    if (l === target()) {
      const q = quickControls.get(`lfo.${key}`);
      if (q) q.set(key === 'rate' ? ST.LFO_RATES.indexOf(value) : value);
      if (ui.panel === 'lfo' && (key === 'on' || key === 'target' || key === 'shape')) buildPanel();
    }
    updateCards();
    save();
  }
  function toggleLfo() {
    const l = target(), on = !(l.lfo && l.lfo.on);
    setLfo('on', on, l);
    if (!on) engine.updateLayer(l); // back to the knob's own value
    announce(`LFO ${on ? 'on' : 'off'} on ${l.name}`);
  }
  function buildLfoPanel(l, row) {
    const f = { ...ST.LFO_DEFAULT, ...l.lfo };
    const top = document.createElement('div');
    top.className = 'lfo-top';
    top.innerHTML = `
      <button type="button" role="switch" class="fx-switch" id="lfo-switch" aria-checked="${f.on}" aria-label="LFO">
        <span class="fx-switch-track" aria-hidden="true"><span class="fx-switch-thumb"></span></span>
        <span class="fx-switch-text" aria-hidden="true">${f.on ? 'On' : 'Off'}</span>
      </button>
      <label class="ad-field lfo-target"><span>Moves</span>
        <select id="lfo-target">${lfoTargets().map(([g, opts]) => `<optgroup label="${esc(g)}">${opts.map(([v, lab]) => `<option value="${v}"${v === f.target ? ' selected' : ''}>${esc(lab)}</option>`).join('')}</optgroup>`).join('')}</select>
      </label>
      <div class="field"><span class="field-label" id="lfo-shape-label">Shape</span>
        <div class="chips" role="group" aria-labelledby="lfo-shape-label">${LFO_SHAPES.map(([v, lab]) => `<button type="button" class="chip" data-lfo-shape="${v}" aria-pressed="${v === f.shape}">${lab}</button>`).join('')}</div>
      </div>`;
    row.before(top);
    for (const key of ['rate', 'depth']) {
      const d = paramDef(['lfo', key]);
      const kn = createKnob({ ...d, label: key === 'rate' ? 'Speed' : 'Depth', value: d.get(), reset: key === 'rate' ? ST.LFO_RATES.indexOf(ST.LFO_DEFAULT.rate) : ST.LFO_DEFAULT.depth,
        hint: key === 'rate' ? 'One full wave every…, locked to the tempo' : 'How far it moves the knob, either side of where you set it', onInput: v => d.set(v) });
      kn.el.dataset.path = `lfo.${key}`;
      panelControls.set(kn.el.dataset.path, kn);
      row.append(kn.el);
    }
    const note = document.createElement('p');
    note.className = 'fx-note';
    note.textContent = 'It moves while the loop plays, around the value the knob is set to. Export includes it. Tip: right-click any knob to make it move too.';
    row.after(note);
    const more = (l.motions || []).filter(m => m.on);
    if (more.length) {
      const box = document.createElement('div');
      box.className = 'field lfo-more';
      box.innerHTML = `<span class="field-label" id="lfo-more-label">Also moving</span><div class="chips" role="group" aria-labelledby="lfo-more-label">${more.map(m => {
        const pr = motionPresetOf(m), name = `${motionTargetLabel(m.target, l)} · ${pr ? pr.label : 'custom'} ${rateLabel(m.rate)}`;
        return `<span class="my-chip"><span class="chip" aria-pressed="true">${esc(name)}</span><button type="button" class="my-del" data-motion-stop="${esc(m.target)}" aria-label="Stop ${esc(name)}" title="Stop moving">×</button></span>`;
      }).join('')}</div>`;
      note.after(box);
    }
    renderKnobStrip();
  }

  const voxOf = l => ({ ...ST.VOX_DEFAULT, ...l.sound.vox });
  // Voice FX live on the layer; a word that is sounding restarts with the new voice.
  function setVox(key, value, l = target()) {
    if (isDrums(l)) return;
    l.sound.vox = { ...voxOf(l), [key]: value };
    const q = l === target() && quickControls.get(`vox.${key}`);
    if (q) q.set(value);
    updateCards();
    save();
  }

  function setSound(key, value, l = target()) {
    l.sound[key] = value;
    const q = l === target() && quickControls.get(`sound.${key}`);
    if (q) q.set(value);
    markCustom(l);
    engine.updateLayer(l);
    updateCards();
    const graph = l === target() && document.querySelector('#panel .env-graph path');
    if (graph) graph.setAttribute('d', isDrums(l) ? hitPath(l.sound, 320, 80) : envPath(l.sound, 320, 80));
    if (key === 'register' && !isDrums(l)) requestRender();
    save();
  }

  const panelEl = $('#panel');
  panelEl.addEventListener('click', e => {
    const chip = e.target.closest('[data-preset]');
    const act = e.target.closest('[data-act]');
    const fxTab = e.target.closest('.fx-tab');
    const sw = e.target.closest('#fx-switch');
    const kit = e.target.closest('[data-kit]');
    const voxChip = e.target.closest('[data-vox]');
    const myBox = e.target.closest('[data-my-key]');
    if (e.target.closest('#lfo-switch')) { toggleLfo(); return; }
    const mstop = e.target.closest('[data-motion-stop]');
    if (mstop) { stopMotion({ owner: target(), target: mstop.dataset.motionStop }); return; }
    const shape = e.target.closest('[data-lfo-shape]');
    if (shape) { setLfo('shape', shape.dataset.lfoShape); announce(`LFO shape: ${shape.textContent}`); return; }
    if (myBox) {
      const key = myBox.dataset.myKey, l = target(), list = myList(key), isKit = key === MY_KITS;
      const apply = e.target.closest('[data-my]'), del = e.target.closest('[data-my-del]'), saveBtn = e.target.closest('[data-my-save]');
      if (apply) {
        const x = list.find(y => y.id === apply.dataset.my);
        if (!x) return;
        snapshot();
        l.sound = isKit ? JSON.parse(JSON.stringify(x.sound)) : { ...JSON.parse(JSON.stringify(x.sound)), vox: l.sound.vox };
        l.fx = JSON.parse(JSON.stringify(x.fx));
        l.preset = `my:${x.id}`;
        engine.ensure();
        engine.updateLayer(l);
        buildPanel();
        updateCards();
        refreshQuick();
        if (isKit) updateDrumMeta(); else renderLayers();
        save();
        engine.preview(l);
        announce(`${l.name} now uses ${x.name}`);
      } else if (del) {
        const x = list.find(y => y.id === del.dataset.myDel);
        if (!x || !window.confirm(`Delete “${x.name}” from your ${isKit ? 'kits' : 'sounds'}?`)) return;
        writeJSON(key, list.filter(y => y !== x));
        buildPanel();
        announce(`${x.name} deleted`);
      } else if (saveBtn) {
        const input = myBox.querySelector('[data-my-name]'), name = input.value.trim() || `${isKit ? 'My kit' : 'My sound'} ${list.length + 1}`;
        const x = { id: uid(), name, sound: JSON.parse(JSON.stringify(l.sound)), fx: JSON.parse(JSON.stringify(l.fx)) };
        if (!isKit) delete x.sound.vox;
        if (!writeJSON(key, [...list, x])) { announce('Could not save: browser storage is full or blocked'); return; }
        l.preset = `my:${x.id}`;
        buildPanel();
        if (isKit) updateDrumMeta(); else renderLayers();
        save();
        announce(`Saved “${name}”. Find it under ${isKit ? 'My kits' : 'My sounds'} in every project.`);
      }
      return;
    }
    if (voxChip) {
      const key = voxChip.dataset.vox, val = voxChip.dataset.val;
      setVox(key, val);
      panelEl.querySelectorAll(`[data-vox="${key}"]`).forEach(c => c.setAttribute('aria-pressed', String(c === voxChip)));
      sayPreview();
      announce(`${ST.VOX_CHOICES[key].label}: ${voxChip.textContent}`);
    } else if (kit) {
      const d = project.drums, k = ST.DRUM_KITS.find(x => x.id === kit.dataset.kit);
      snapshot();
      d.sound = { ...k.sound };
      d.preset = k.id;
      engine.ensure();
      engine.updateDrums();
      buildPanel();
      updateCards();
      refreshQuick();
      updateDrumMeta();
      save();
      const same = panelEl.querySelector(`[data-kit="${k.id}"]`);
      if (same) same.focus();
      engine.previewDrums();
      announce(`Drums now use the ${k.label} kit`);
    } else if (chip) {
      const l = target(), id = chip.dataset.preset;
      snapshot();
      l.sound = { ...PRESETS[id].sound, vox: l.sound.vox }; // presets keep the voice
      l.fx = presetFx(id);
      l.preset = id;
      engine.ensure();
      engine.updateLayer(l);
      buildPanel();
      updateCards();
      renderLayers();
      requestRender();
      save();
      const same = panelEl.querySelector(`[data-preset="${id}"]`);
      if (same) same.focus();
      engine.preview(l);
      refreshQuick();
      announce(`${l.name} now uses ${PRESETS[id].label}`);
    } else if (fxTab) {
      selectFxTab(fxTab.dataset.fx);
    } else if (sw) {
      const l = target(), id = ui.fxTab[PANELS.find(p => p.id === ui.panel).group];
      l.fx[id].on = !l.fx[id].on;
      refreshFxState(id);
      if (!isDrums(l)) markCustom(l);
      engine.updateLayer(l);
      updateCards();
      save();
      announce(`${FX_BY_ID[id].label} ${l.fx[id].on ? 'on' : 'off'}`);
    } else if (act && act.dataset.act === 'preview') {
      if (ui.panel === 'voice') sayPreview(); else engine.preview(target());
    } else if (act && act.dataset.act === 'close') {
      const id = ui.panel;
      setPanel(null);
      document.querySelector(`.qa-open[data-panel="${id}"]`).focus();
    }
  });

  // Hear the voice: the layer's first words, or a hello.
  function sayPreview() {
    const l = current(), words = l.strokes.find(it => it.kind === 'text');
    const item = { kind: 'text', size: 'm', text: words ? words.text : 'Hello there', voice: words ? words.voice : ui.voice, points: [[0, 0.5], [Math.min(1, 1.4 / L()), 0.42]] };
    engine.say(l, item);
  }

  function selectFxTab(id, focus) {
    const group = FX_BY_ID[id].group;
    ui.fxTab[group] = id;
    document.querySelectorAll('#panel .fx-tab').forEach(t => {
      const on = t.dataset.fx === id;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    });
    buildFxDetail(id);
  }

  panelEl.addEventListener('keydown', e => {
    const tab = e.target.closest('.fx-tab');
    if (!tab) return;
    const ids = [...document.querySelectorAll('#panel .fx-tab')].map(t => t.dataset.fx);
    const i = ids.indexOf(tab.dataset.fx);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: ids.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    selectFxTab(ids[(next + ids.length) % ids.length], true);
  });

  panelEl.addEventListener('change', e => {
    const { name, value } = e.target;
    if (e.target.id === 'lfo-target') { setLfo('target', value); announce(`LFO moves ${lfoTargetLabel(value)}`); $('#lfo-target').focus(); return; }
    if (name === 'wave' || name === 'register') {
      setSound(name, value);
      engine.preview(target());
    }
  });

  // ---------- dock: Drums | Sound | Mix under the canvas ----------
  const dockTabs = [...document.querySelectorAll('.dock-tab')];
  const DOCK_KEY = 'sketchtone.dock';
  const dockPref = (() => { try { return JSON.parse(localStorage.getItem(DOCK_KEY)) || {}; } catch (e) { return {}; } })();
  function setDockTab(id, focus) {
    dockTabs.forEach(t => {
      const on = t.id === `dt-${id}`;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(`#${t.getAttribute('aria-controls')}`).hidden = !on;
      if (on && focus) t.focus();
    });
    ui.dock = id;
    document.body.dataset.dock = id;
    if (id === 'mix') renderMixer();
    if (id === 'perform') renderPerform();
    updateDockHint();
    if (dockCollapsed()) setDockCollapsed(false);
    try { localStorage.setItem(DOCK_KEY, JSON.stringify({ tab: id, collapsed: dockCollapsed() })); } catch (e) { /* storage unavailable */ }
  }
  const dockCollapsed = () => $('#dock-toggle').getAttribute('aria-expanded') === 'false';
  function setDockCollapsed(c) {
    const btn = $('#dock-toggle');
    btn.setAttribute('aria-expanded', String(!c));
    btn.title = c ? 'Show the panel' : 'Hide the panel (more room to draw)';
    btn.setAttribute('aria-label', c ? 'Show the panel' : 'Hide the panel');
    $('#dock-body').hidden = c;
    document.body.classList.toggle('dock-collapsed', c);
    try { localStorage.setItem(DOCK_KEY, JSON.stringify({ tab: ui.dock, collapsed: c })); } catch (e) { /* storage unavailable */ }
  }
  function updateDockHint() {
    const t = target();
    $('#dock-hint').textContent = ui.dock === 'sound' ? `Sound of ${t.name}` : ui.dock === 'drums' ? `Drums · ${drumState()}` : ui.dock === 'perform' ? 'Scenes, macros and keys for playing live' : 'Volume, pan, sends and levels';
  }
  dockTabs.forEach(t => {
    t.addEventListener('click', () => setDockTab(t.id.slice(3)));
    t.addEventListener('keydown', e => {
      const i = dockTabs.indexOf(t), n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: dockTabs.length - 1 }[e.key];
      if (n === undefined) return;
      e.preventDefault();
      setDockTab(dockTabs[(n + dockTabs.length) % dockTabs.length].id.slice(3), true);
    });
  });
  $('#dock-toggle').addEventListener('click', () => { setDockCollapsed(!dockCollapsed()); announce(dockCollapsed() ? 'Panel hidden: more room to draw' : 'Panel shown'); });

  // Mix: one strip per layer, the drums and the master. Same values as the layer rows.
  const mixChannels = () => [
    ...project.layers.map(l => ({ id: l.id, name: l.name, color: l.color, vol: l.volume, pan: l.pan || 0, send: l.send, muted: l.muted, solo: l.solo, meta: presetLabel(l) })),
    { id: 'drums', name: 'Drums', color: ST.DRUM_COLOR, vol: project.drums.volume, pan: project.drums.pan || 0, send: project.drums.send, muted: project.drums.muted, solo: project.drums.solo, meta: drumKitLabel(project.drums) },
  ];
  const filterText = v => (Math.abs(v) < 1 ? 'Open' : v < 0 ? `Darker ${Math.round(-v)}%` : `Thinner ${Math.round(v)}%`);
  const ECHO_SYNCS = [['1/4', '1/4'], ['1/8', '1/8'], ['3/16', '1/8 dotted'], ['1/16', '1/16']];
  // One send to the shared Room or Echo, per channel.
  function setSend(id, which, v) {
    const owner = id === 'drums' ? project.drums : project.layers.find(l => l.id === id);
    if (!owner) return;
    owner.send = { room: 0, echo: 0, ...owner.send, [which]: Math.max(0, Math.min(100, v)) };
    engine.updateLayer(owner);
    const el = mixEl.querySelector(`[data-path="mix.${id}.${which}"]`);
    if (el) el.value = Math.round(owner.send[which]);
    save();
  }
  function setMaster(key, v) {
    const m = project.master;
    if (key === 'filter') m.filter = Math.max(-100, Math.min(100, v));
    else if (key === 'roomlevel') m.room.level = v;
    else if (key === 'roomsize') m.room.size = v;
    else if (key === 'echolevel') m.echo.level = v;
    else if (key === 'feedback') m.echo.feedback = v;
    else if (key === 'sync') m.echo.sync = v;
    engine.updateMaster();
    const el = mixEl.querySelector(`[data-path="master.${key}"]`);
    if (el) el.value = key === 'roomsize' ? v * 10 : v;
    if (key === 'filter') { const t = mixEl.querySelector('.mix-filter-val'); if (t) t.textContent = filterText(m.filter); }
    save();
  }
  function renderMixer() {
    if (ui.dock !== 'mix') return;
    const strip = ch => `
      <div class="mix-strip${ch.muted ? ' is-muted' : ''}" style="--layer:${ch.color}" role="group" aria-label="${esc(ch.name)} channel">
        <span class="mix-name"><span class="swatch" aria-hidden="true"></span>${esc(ch.name)}</span>
        <span class="mix-meta">${esc(ch.meta)}</span>
        <div class="mix-fader-row">
          <input type="range" class="mix-fader" min="0" max="100" value="${Math.round(ch.vol * 100)}" data-mix="volume" data-id="${ch.id}" data-path="mix.${ch.id}.volume" aria-label="${esc(ch.name)} volume" aria-orientation="vertical">
          <div class="mix-meter" aria-hidden="true"><i data-meter="${ch.id}"></i></div>
        </div>
        <span class="mix-vol">${Math.round(ch.vol * 100)}%</span>
        <input type="range" class="pan mix-pan" min="-100" max="100" value="${Math.round(ch.pan * 100)}" data-mix="pan" data-id="${ch.id}" data-path="mix.${ch.id}.pan" aria-label="${esc(ch.name)} pan" aria-valuetext="${panText(ch.pan)}" title="Pan: ${panText(ch.pan)} (double-click to centre)">
        <div class="mix-sends">
          <label class="mix-send" title="Send to the shared Room"><span>Room</span><input type="range" min="0" max="100" value="${Math.round(ch.send.room || 0)}" data-mix="room" data-id="${ch.id}" data-path="mix.${ch.id}.room" aria-label="${esc(ch.name)} send to Room"></label>
          <label class="mix-send" title="Send to the shared Echo"><span>Echo</span><input type="range" min="0" max="100" value="${Math.round(ch.send.echo || 0)}" data-mix="echo" data-id="${ch.id}" data-path="mix.${ch.id}.echo" aria-label="${esc(ch.name)} send to Echo"></label>
        </div>
        <div class="msv" role="group" aria-label="${esc(ch.name)} switches">
          <button type="button" class="msv-btn msv-m" data-mix="mute" data-id="${ch.id}" aria-pressed="${ch.muted}" aria-label="Mute ${esc(ch.name)}">M</button>
          <button type="button" class="msv-btn msv-s" data-mix="solo" data-id="${ch.id}" aria-pressed="${ch.solo}" aria-label="Solo ${esc(ch.name)}">S</button>
        </div>
      </div>`;
    const m = project.master;
    const returns = `
      <div class="mix-strip mix-return" style="--layer:var(--hue-timefx)" role="group" aria-label="Room, shared reverb">
        <span class="mix-name">Room</span>
        <span class="mix-meta">Shared reverb</span>
        <div class="mix-fader-row">
          <input type="range" class="mix-fader" min="0" max="100" value="${Math.round(m.room.level)}" data-mix="master" data-key="roomlevel" data-path="master.roomlevel" aria-label="Room level" aria-orientation="vertical">
        </div>
        <span class="mix-vol">${Math.round(m.room.level)}%</span>
        <label class="mix-send"><span>Size</span><input type="range" min="5" max="60" value="${Math.round(m.room.size * 10)}" data-mix="master" data-key="roomsize" data-path="master.roomsize" aria-label="Room size"></label>
      </div>
      <div class="mix-strip mix-return" style="--layer:var(--hue-timefx)" role="group" aria-label="Echo, shared delay">
        <span class="mix-name">Echo</span>
        <span class="mix-meta">Shared delay</span>
        <div class="mix-fader-row">
          <input type="range" class="mix-fader" min="0" max="100" value="${Math.round(m.echo.level)}" data-mix="master" data-key="echolevel" data-path="master.echolevel" aria-label="Echo level" aria-orientation="vertical">
        </div>
        <span class="mix-vol">${Math.round(m.echo.level)}%</span>
        <label class="mix-send"><span>Repeats</span><input type="range" min="0" max="90" value="${Math.round(m.echo.feedback)}" data-mix="master" data-key="feedback" data-path="master.feedback" aria-label="Echo repeats"></label>
        <select class="mix-sync" data-mix="sync" aria-label="Echo time">${ECHO_SYNCS.map(([v, lab]) => `<option value="${v}"${v === m.echo.sync ? ' selected' : ''}>${lab}</option>`).join('')}</select>
      </div>`;
    $('#mix-strips').innerHTML = mixChannels().map(strip).join('') + returns + `
      <div class="mix-strip mix-master" role="group" aria-label="Master">
        <span class="mix-name">Master</span>
        <span class="mix-meta">Speakers</span>
        <div class="mix-fader-row">
          <input type="range" class="mix-fader" min="0" max="100" value="${Math.round(prefs.volume / 0.9 * 100)}" data-mix="master" aria-label="Speaker volume" aria-orientation="vertical">
          <div class="mix-meter" aria-hidden="true"><i data-meter="master"></i></div>
        </div>
        <span class="mix-vol">${Math.round(prefs.volume / 0.9 * 100)}%</span>
        <label class="mix-send" title="DJ filter: left darker, right thinner (double-click to open)"><span>Filter</span><input type="range" class="pan" min="-100" max="100" value="${Math.round(m.filter)}" data-mix="master" data-key="filter" data-path="master.filter" aria-label="Master filter" aria-valuetext="${filterText(m.filter)}"></label>
        <span class="mix-meta mix-filter-val">${filterText(m.filter)}</span>
      </div>`;
    renderKnobStrip(); // learned-control badges
  }
  const mixEl = $('#mix-strips');
  mixEl.addEventListener('input', e => {
    const el = e.target, id = el.dataset.id, v = Number(el.value);
    if (el.dataset.mix === 'pan') { setPan(id, v / 100); el.setAttribute('aria-valuetext', panText(v / 100)); return; }
    if (el.dataset.mix === 'room' || el.dataset.mix === 'echo') { setSend(id, el.dataset.mix, v); return; }
    if (el.dataset.mix === 'master' && el.dataset.key) {
      setMaster(el.dataset.key, el.dataset.key === 'roomsize' ? v / 10 : v);
      if (el.dataset.key === 'filter') el.setAttribute('aria-valuetext', filterText(v));
      const vol = el.closest('.mix-strip').querySelector('.mix-vol');
      if (vol && /level$/.test(el.dataset.key)) vol.textContent = `${v}%`;
      return;
    }
    if (el.dataset.mix === 'master') { prefs.volume = v / 100 * 0.9; writeJSON(PREFS_KEY, prefs); applyPrefs(); el.closest('.mix-strip').querySelector('.mix-vol').textContent = `${v}%`; return; }
    if (el.dataset.mix !== 'volume') return;
    el.closest('.mix-strip').querySelector('.mix-vol').textContent = `${v}%`;
    if (id === 'drums') { setDrum('volume', v / 100); return; }
    const l = project.layers.find(x => x.id === id);
    l.volume = v / 100;
    engine.updateLayer(l);
    const row = layerList.querySelector(`.vol[data-id="${id}"]`);
    if (row) row.value = v;
    save();
  });
  mixEl.addEventListener('dblclick', e => {
    if (e.target.dataset.mix === 'pan') { setPan(e.target.dataset.id, 0); renderMixer(); }
    if (e.target.dataset.key === 'filter') { setMaster('filter', 0); renderMixer(); }
  });
  mixEl.addEventListener('change', e => { if (e.target.dataset.mix === 'sync') { setMaster('sync', e.target.value); announce(`Echo every ${e.target.selectedOptions[0].textContent}`); } });
  mixEl.addEventListener('click', e => {
    const b = e.target.closest('button[data-mix]');
    if (!b) return;
    const id = b.dataset.id, act = b.dataset.mix;
    if (id === 'drums') { drumRowAct(act); renderMixer(); return; }
    const l = project.layers.find(x => x.id === id), flag = act === 'mute' ? 'muted' : 'solo';
    l[flag] = !l[flag];
    engine.updateAll();
    renderLayers();
    requestRender();
    save();
    announce(`${l.name} ${flag === 'muted' ? (l.muted ? 'muted' : 'unmuted') : (l.solo ? 'solo' : 'solo off')}`);
  });

  // ---------- master meter ----------
  // Peak level after the master limiter; the clip light stays on until you click it.
  const meterBar = $('#meter-bar'), clipLight = $('#meter-clip');
  let meterLevel = 0;
  function meterTick() {
    const pk = engine.ctx ? engine.peak() : 0;
    const db = pk > 0 ? 20 * Math.log10(pk) : -96, frac = Math.max(0, Math.min(1, (db + 48) / 48));
    meterLevel = Math.max(frac, meterLevel - 0.03); // quick rise, slow fall
    meterBar.style.width = `${(meterLevel * 100).toFixed(1)}%`;
    meterBar.dataset.zone = meterLevel > 0.9 ? 'hot' : meterLevel > 0.7 ? 'warm' : 'ok';
    if (pk >= 0.985 && clipLight.hidden) { clipLight.hidden = false; announce('Clipping: the output is too loud. Lower a layer or the drums.'); }
    if (ui.dock === 'mix' && !dockCollapsed()) {
      for (const el of mixEl.querySelectorAll('[data-meter]')) {
        const id = el.dataset.meter, v = id === 'master' ? pk : engine.channelPeak(id);
        const f = v > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(v) + 48) / 48)) : 0;
        el.style.height = `${(f * 100).toFixed(1)}%`;
        el.dataset.zone = f > 0.9 ? 'hot' : f > 0.7 ? 'warm' : 'ok';
      }
    }
    requestAnimationFrame(meterTick);
  }
  clipLight.addEventListener('click', () => { clipLight.hidden = true; });
  requestAnimationFrame(meterTick);

  // ---------- transport ----------
  const playBtn = $('#play');
  function barBeat(t) {
    const beat = Math.floor(t / beatSec() + 1e-6);
    return `bar ${Math.floor(beat / 4) + 1} beat ${beat % 4 + 1}`;
  }
  function updateTransport() {
    updateDrumState();
    const state = engine.playing ? 'playing' : ui.pausedAt != null ? 'paused' : 'stopped';
    if (state !== 'playing') clearMotionDots();
    playBtn.classList.toggle('is-playing', state === 'playing');
    playBtn.innerHTML = `${state === 'playing' ? ICON.pause : ICON.play}<span>${state === 'playing' ? 'Pause' : state === 'paused' ? 'Resume' : 'Play'}</span>`;
    const mini = $('#mini-play'); // the phone bar mirrors the transport
    mini.classList.toggle('is-playing', state === 'playing');
    mini.innerHTML = playBtn.innerHTML;
    if (ui.dock) updateDockHint();
  }
  function updateReadout(t) {
    const beat = Math.floor(t / beatSec() + 1e-6);
    $('#readout').textContent = $('#mini-readout').textContent = `${Math.floor(beat / 4) + 1}.${beat % 4 + 1} / ${project.bars}`;
  }

  function frame() {
    if (!engine.playing) return;
    const p = engine.position();
    if (p.done) { finishPlayback(); return; }
    if (ui.scenePending && p.u >= ui.scenePending.u - 0.005) { ui.scenePending = null; renderScenes(); }
    if (movingEls.length) animateMotions(p.u);
    render();
    renderTimeline();
    renderDrums();
    updateReadout(p.t);
    requestAnimationFrame(frame);
  }

  function playFrom(u) {
    engine.play(u);
    ui.pausedAt = null;
    updateTransport();
    requestAnimationFrame(frame);
  }
  function pause() {
    const p = engine.position();
    ui.pausedAt = p ? p.u : null;
    engine.stop();
    if (ui.scenePending) { ui.scenePending = null; renderScenes(); }
    updateTransport();
    requestRender();
  }
  function stopAll() { // the panic button: everything silent, nothing left held
    stopRecording();
    engine.stop();
    engine.monitorEnd();
    engine.setBend(0);
    releaseNotes();
    ui.held = [];
    ui.latched = null;
    applyHeld(); // drops any key FX at once (nothing is playing, so no beat to wait for)
    if (ui.scenePending) { ui.scenePending = null; renderScenes(); }
    ui.pausedAt = null;
    updateTransport();
    updateReadout(ui.startPos);
    requestRender();
  }
  function finishPlayback() {
    engine.stop(true);
    ui.pausedAt = null;
    updateTransport();
    updateReadout(ui.startPos);
    requestRender();
    announce('Finished');
  }
  function togglePlay() {
    if (engine.playing) { pause(); announce('Paused'); return; }
    if (!hasMusic()) { announce('Nothing to play yet. Draw a line first.'); return; }
    playFrom(ui.pausedAt != null ? ui.pausedAt : ui.startPos);
    announce(project.loop ? 'Playing on loop' : 'Playing');
  }
  playBtn.addEventListener('click', togglePlay);
  $('#stop').addEventListener('click', () => { stopAll(); announce('Stopped'); });
  $('#mini-play').addEventListener('click', () => playBtn.click());
  $('#mini-stop').addEventListener('click', () => $('#stop').click());

  // Tempo change: keep the same musical position (bar/beat), not the same second.
  function setBpm(v) {
    const bpm = Math.round(Math.min(240, Math.max(40, Number(v) || project.bpm)));
    $('#bpm').value = bpm;
    if (bpm === project.bpm) return;
    const p = engine.position(), ratio = project.bpm / bpm;
    project.bpm = bpm;
    ui.startPos *= ratio;
    save();
    engine.updateAll();
    if (p) playFrom(p.t * ratio);
    else if (ui.pausedAt != null) ui.pausedAt *= ratio;
    updateTransport();
    updateTimelineAria();
    if (!p) updateReadout(ui.pausedAt != null ? ui.pausedAt % L() : ui.startPos);
    requestRender();
  }
  $('#bpm').addEventListener('change', e => setBpm(e.target.value));
  $('#bpm-down').addEventListener('click', () => setBpm(project.bpm - 1));
  $('#bpm-up').addEventListener('click', () => setBpm(project.bpm + 1));
  $('#scale').innerHTML = SCALES.map(s => `<option value="${s.id}">${s.label}</option>`).join('');
  $('#key').innerHTML = ST.KEY_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join('');
  $('#key').addEventListener('change', e => {
    project.key = Number(e.target.value);
    ST.setRootKey(project.key);
    save();
    updateCanvasPos();
    requestRender();
    announce(`Key of ${ST.KEY_NAMES[project.key]}: every scale now starts on ${ST.KEY_NAMES[project.key]}`);
  });
  $('#scale').addEventListener('change', e => {
    project.scale = e.target.value;
    save();
    updateCanvasPos();
    requestRender();
    announce(project.scale === 'theremin' ? 'Theremin: pitch follows your line exactly' : `Notes snap to the ${project.scale} scale`);
  });
  $('#loop').addEventListener('change', e => { project.loop = e.target.checked; save(); });
  const metroBtn = $('#metro');
  function setMetronome(on) {
    engine.metronome = on;
    metroBtn.setAttribute('aria-pressed', String(on));
    prefs.metronome = on;
    writeJSON(PREFS_KEY, prefs);
  }
  metroBtn.addEventListener('click', () => {
    setMetronome(!engine.metronome);
    announce(engine.metronome ? 'Metronome on' : 'Metronome off');
  });
  $('#bars').addEventListener('change', e => {
    const p = engine.position();
    project.bars = Number(e.target.value);
    save();
    engine.updateAll();
    if (p) playFrom(Math.min(p.t, L() - 0.01));
    ui.startPos = Math.min(ui.startPos, L() - beatSec() / 4);
    ui.pausedAt = null;
    updateTransport();
    updateTimelineAria();
    updateReadout(ui.startPos);
    requestRender();
    announce(`Loop is ${project.bars} ${project.bars === 1 ? 'bar' : 'bars'}`);
  });

  function setStart(sec) {
    const q = beatSec() / 4; // snap to sixteenth notes
    ui.startPos = Math.round(Math.min(L() - q, Math.max(0, sec)) / q) * q;
    ui.pausedAt = null;
    updateTransport();
    updateTimelineAria();
    if (!engine.playing) updateReadout(ui.startPos);
    requestRender();
  }
  function updateTimelineAria() {
    tl.setAttribute('aria-valuemax', L().toFixed(2));
    tl.setAttribute('aria-valuenow', ui.startPos.toFixed(2));
    tl.setAttribute('aria-valuetext', `Start at ${barBeat(ui.startPos)} of ${project.bars} ${project.bars === 1 ? 'bar' : 'bars'}`);
  }
  let tlDrag = false;
  const tlSec = e => (e.clientX - tl.getBoundingClientRect().left) / TW * L();
  tl.addEventListener('pointerdown', e => { tlDrag = true; tl.setPointerCapture(e.pointerId); setStart(tlSec(e)); });
  tl.addEventListener('pointermove', e => { if (tlDrag) setStart(tlSec(e)); });
  tl.addEventListener('pointerup', () => { if (!tlDrag) return; tlDrag = false; if (engine.playing) playFrom(ui.startPos); });
  tl.addEventListener('pointercancel', () => { tlDrag = false; });
  tl.addEventListener('keydown', e => {
    const b = beatSec();
    const steps = { ArrowLeft: -b, ArrowDown: -b, ArrowRight: b, ArrowUp: b, PageDown: -4 * b, PageUp: 4 * b };
    if (e.key in steps) setStart(ui.startPos + steps[e.key]);
    else if (e.key === 'Home') setStart(0);
    else if (e.key === 'End') setStart(L());
    else return;
    e.preventDefault();
    if (engine.playing) playFrom(ui.startPos);
  });

  // ---------- record / export ----------
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  let recording = null, takes = 0;
  const recBtn = $('#record');
  function updateRecUI() {
    recBtn.setAttribute('aria-pressed', String(!!recording));
    recBtn.classList.toggle('is-recording', !!recording);
    let label = 'Record audio';
    if (recording) {
      const s = Math.floor((performance.now() - recording.started) / 1000);
      label = `Recording ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
    recBtn.querySelector('.rec-label').textContent = label;
  }
  async function startRecording() {
    if (!window.MediaRecorder) { announce('Recording is not supported in this browser. Use Export instead.'); return; }
    const done = engine.startRecording();
    recording = { started: performance.now(), timer: setInterval(updateRecUI, 250) };
    if (!engine.playing && hasMusic()) playFrom(ui.pausedAt != null ? ui.pausedAt : ui.startPos);
    updateRecUI();
    announce('Recording everything you hear, including live drawing. Press Record again to finish.');
    const blob = await done;
    const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
    const name = `${slug(project.name) || 'sketch'}-take-${++takes}.${ext}`;
    download(blob, name);
    announce(`Saved ${name}`);
  }
  function stopRecording() {
    if (!recording) return;
    clearInterval(recording.timer);
    recording = null;
    engine.stopRecording();
    updateRecUI();
  }
  recBtn.addEventListener('click', () => { if (recording) stopRecording(); else startRecording(); });

  const hearBtn = $('#hear');
  hearBtn.addEventListener('click', () => {
    ui.hear = !ui.hear;
    hearBtn.setAttribute('aria-pressed', String(ui.hear));
    announce(ui.hear ? 'You will hear lines while drawing' : 'Drawing is silent until you press Play');
  });

  $('#export').addEventListener('click', () => openAppDialog('export'));
  // ---------- settings window: project, export, settings, privacy, credits ----------
  const APP_VERSION = '1.3.0';
  const VERSIONS_KEY = 'sketchtone.versions.v1', PREFS_KEY = 'sketchtone.prefs.v1';
  const appDlg = $('#app-dialog'), adTabs = [...appDlg.querySelectorAll('.ad-tab')];
  const readJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
  const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
  const prefs = { volume: 0.9, reduceMotion: false, ...readJSON(PREFS_KEY, {}) };
  const applyPrefs = () => {
    document.body.classList.toggle('reduce-motion', !!prefs.reduceMotion);
    engine.setMasterVolume(prefs.volume);
  };
  $('#ad-version').textContent = `Version ${APP_VERSION}`;

  function openAppDialog(tab) {
    renderProjectPane();
    renderExportInfo();
    syncSettingsPane();
    setAdTab(tab || 'project');
    if (!appDlg.open) appDlg.showModal();
  }
  function setAdTab(id, focus) {
    adTabs.forEach(t => {
      const on = t.id === `adt-${id}`;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(`#${t.getAttribute('aria-controls')}`).hidden = !on;
      if (on && focus) t.focus();
    });
  }
  adTabs.forEach(t => {
    t.addEventListener('click', () => setAdTab(t.id.slice(4)));
    t.addEventListener('keydown', e => {
      const i = adTabs.indexOf(t), n = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: adTabs.length - 1 }[e.key];
      if (n === undefined) return;
      e.preventDefault();
      setAdTab(adTabs[(n + adTabs.length) % adTabs.length].id.slice(4), true);
    });
  });
  $('#settings-btn').addEventListener('click', () => openAppDialog('project'));
  $('#ad-close').addEventListener('click', () => appDlg.close());
  appDlg.addEventListener('click', e => { if (e.target === appDlg) appDlg.close(); }); // click outside

  // Project: name, summary, versions, file
  function projectSummary() {
    const lines = project.layers.reduce((a, l) => a + l.strokes.length, 0);
    const secs = L();
    return `${project.layers.length} ${project.layers.length === 1 ? 'layer' : 'layers'}, ${lines} ${lines === 1 ? 'item' : 'items'} · ${project.bars} ${project.bars === 1 ? 'bar' : 'bars'} at ${project.bpm} BPM (${secs.toFixed(1)} s loop) · drums: ${drumState().toLowerCase()}`;
  }
  const versions = () => readJSON(VERSIONS_KEY, []);
  function renderProjectPane() {
    $('#ad-name').value = project.name;
    $('#ad-summary').textContent = projectSummary();
    const list = versions(), fmt = iso => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    $('#ad-versions').innerHTML = list.length ? list.map(v => `
      <li><span class="ad-v-name">${esc(v.name)}</span><span class="ad-meta">${fmt(v.at)}</span>
        <button type="button" class="dev-btn" data-v-restore="${v.id}">Restore</button>
        <button type="button" class="icon-btn" data-v-delete="${v.id}" aria-label="Delete version ${esc(v.name)}">${ICON.trash}</button></li>`).join('')
      : '<li class="ad-empty">No versions yet. Save one before trying something bold.</li>';
  }
  $('#ad-name').addEventListener('input', e => { project.name = e.target.value; nameInput.value = project.name; save(); });
  function saveVersion(name) {
    const list = versions();
    list.unshift({ id: uid(), name: name || `${project.name} · version ${list.length + 1}`, at: new Date().toISOString(), data: JSON.parse(JSON.stringify(project)) });
    while (list.length > 20) list.pop();
    return writeJSON(VERSIONS_KEY, list);
  }
  $('#ad-save-version').addEventListener('click', () => {
    const name = $('#ad-version-name').value.trim();
    if (!saveVersion(name)) { announce('Could not save: browser storage is full or blocked'); return; }
    $('#ad-version-name').value = '';
    renderProjectPane();
    announce(`Version saved${name ? `: ${name}` : ''}`);
  });
  // Replace the whole project (from a version or a file). Undo history starts fresh.
  function loadWholeProject(data, msg) {
    stopAll();
    project = normalize(data);
    past.length = 0;
    future.length = 0;
    ui.startPos = 0;
    ui.sel = null;
    ui.drumSel = false;
    save();
    engine.updateAll();
    setPanel(null);
    refreshAll();
    persist();
    renderProjectPane();
    announce(msg);
  }
  $('#ad-versions').addEventListener('click', e => {
    const r = e.target.closest('[data-v-restore]'), d = e.target.closest('[data-v-delete]');
    const list = versions();
    if (r) {
      const v = list.find(x => x.id === r.dataset.vRestore);
      if (!v) return;
      saveVersion(`Before restoring “${v.name}”`); // nothing is ever lost
      loadWholeProject(JSON.parse(JSON.stringify(v.data)), `Restored ${v.name}. Your previous sketch was saved as a version.`);
    } else if (d) {
      const v = list.find(x => x.id === d.dataset.vDelete);
      if (!v || !window.confirm(`Delete the version “${v.name}”?`)) return;
      writeJSON(VERSIONS_KEY, list.filter(x => x !== v));
      renderProjectPane();
      announce('Version deleted');
    }
  });
  $('#ad-download').addEventListener('click', () => {
    const file = { app: 'sketchtone', format: 1, version: APP_VERSION, savedAt: new Date().toISOString(), project };
    download(new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' }), `${slug(project.name) || 'sketch'}.sketchtone`);
    announce('Project file downloaded');
  });
  $('#ad-open').addEventListener('click', () => $('#ad-file').click());
  $('#ad-file').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const obj = JSON.parse(await f.text()), data = obj && obj.app === 'sketchtone' ? obj.project : obj;
      if (!data || !Array.isArray(data.layers) || !data.layers.length) throw new Error('not a sketch');
      if (hasMusic() && !window.confirm('Open this file? Your current sketch will be saved as a version first.')) return;
      if (hasMusic()) saveVersion(`Before opening ${f.name}`);
      loadWholeProject(data, `Opened ${f.name}`);
    } catch (err) {
      announce('That file is not a Sketchtone project');
    }
  });

  // Export: any length, rendered offline with the project's settings
  const LENGTHS = [['loop', '1 loop'], [0.5, '30 s'], [1, '1 min'], [3, '3 min'], [5, '5 min'], [10, '10 min']];
  let exportMinutes = 1;
  $('#ad-lengths').innerHTML = LENGTHS.map(([v, lab]) => `<button type="button" class="chip" data-len="${v}" aria-pressed="false">${lab}</button>`).join('');
  const exportSeconds = () => (exportMinutes === 'loop' ? L() : exportMinutes * 60);
  function renderExportInfo() {
    const secs = exportSeconds(), loops = secs / L(), mb = secs * 44100 * 4 / 1048576;
    $('#ad-minutes').value = exportMinutes === 'loop' ? (L() / 60).toFixed(2) : exportMinutes;
    document.querySelectorAll('#ad-lengths [data-len]').forEach(b => b.setAttribute('aria-pressed', String(String(exportMinutes) === b.dataset.len)));
    const m = Math.floor(secs / 60), sec = Math.round(secs % 60);
    $('#ad-export-info').textContent = `${[m ? `${m} min` : '', sec ? `${sec} s` : ''].filter(Boolean).join(' ')} = ${loops < 10 ? loops.toFixed(1) : Math.round(loops)} ${Math.abs(loops - 1) < 0.05 ? 'loop' : 'loops'} at ${project.bpm} BPM · WAV, 44.1 kHz stereo, about ${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }
  $('#ad-lengths').addEventListener('click', e => {
    const b = e.target.closest('[data-len]');
    if (!b) return;
    exportMinutes = b.dataset.len === 'loop' ? 'loop' : Number(b.dataset.len);
    renderExportInfo();
  });
  $('#ad-minutes').addEventListener('change', e => {
    const v = Math.min(10, Math.max(0.1, Number(e.target.value) || 1));
    exportMinutes = Math.round(v * 10) / 10;
    renderExportInfo();
  });
  let exporting = false;
  $('#ad-export').addEventListener('click', async () => {
    if (exporting) return;
    if (!hasMusic()) { $('#ad-export-status').textContent = 'Nothing to export yet: draw something first.'; return; }
    exporting = true;
    const btn = $('#ad-export'), bar = $('#ad-progress'), status = $('#ad-export-status');
    const secs = exportSeconds(), fade = Number($('#ad-fade').value);
    btn.disabled = true;
    bar.hidden = false;
    bar.value = 0;
    status.textContent = 'Rendering…';
    try {
      const blob = await renderWav(project, { seconds: secs, fade, onProgress: f => { bar.value = f; status.textContent = `Rendering… ${Math.round(f * 100)}%`; } });
      const label = exportMinutes === 'loop' ? '1-loop' : `${exportMinutes}min`;
      const name = `${slug(project.name) || 'sketch'}-${label}.wav`;
      download(blob, name);
      status.textContent = `Saved ${name}`;
      announce(`Saved ${name}`);
    } catch (err) {
      console.error(err);
      status.textContent = 'Could not create the file. Try a shorter length.';
    } finally {
      exporting = false;
      btn.disabled = false;
      bar.hidden = true;
    }
  });

  // Stems: one WAV per layer and drums, aligned, packed into a .zip written by the app.
  $('#ad-stems').addEventListener('click', async () => {
    if (exporting) return;
    if (!hasMusic()) { $('#ad-export-status').textContent = 'Nothing to export yet: draw something first.'; return; }
    exporting = true;
    const btns = ['#ad-export', '#ad-stems', '#ad-midi'].map(q => $(q)), bar = $('#ad-progress'), status = $('#ad-export-status');
    btns.forEach(b => { b.disabled = true; });
    bar.hidden = false;
    bar.value = 0;
    status.textContent = 'Rendering stems…';
    try {
      const stems = await ST.renderStems(project, { seconds: exportSeconds(), fade: Number($('#ad-fade').value), onProgress: f => { bar.value = f; status.textContent = `Rendering stems… ${Math.round(f * 100)}%`; } });
      const base = slug(project.name) || 'sketch', files = [];
      for (const [i, st] of stems.entries()) files.push({ name: `${base}-stems/${String(i + 1).padStart(2, '0')}-${slug(st.name) || 'layer'}.wav`, data: new Uint8Array(await st.blob.arrayBuffer()) });
      const name = `${base}-stems.zip`;
      download(ST.makeZip(files), name);
      status.textContent = `Saved ${name}: ${stems.length} stems`;
      announce(`Saved ${name} with ${stems.length} stems`);
    } catch (err) {
      console.error(err);
      status.textContent = 'Could not create the stems. Try a shorter length.';
    } finally {
      exporting = false;
      btns.forEach(b => { b.disabled = false; });
      bar.hidden = true;
    }
  });
  // MIDI: notes and drum hits, for the same length, ready for any DAW.
  $('#ad-midi').addEventListener('click', () => {
    if (!hasMusic()) { $('#ad-export-status').textContent = 'Nothing to export yet: draw something first.'; return; }
    const name = `${slug(project.name) || 'sketch'}.mid`;
    download(ST.buildMidi(project, exportSeconds()), name);
    $('#ad-export-status').textContent = `Saved ${name}`;
    announce(`Saved ${name}`);
  });

  // Settings
  function syncSettingsPane() {
    const theme = document.documentElement.dataset.theme || 'light';
    document.querySelectorAll('input[name="ad-theme"]').forEach(r => { r.checked = r.value === theme; });
    $('#ad-volume').value = Math.round(prefs.volume / 0.9 * 100);
    $('#ad-hear').checked = ui.hear;
    $('#ad-motion').checked = !!prefs.reduceMotion;
  }
  document.querySelectorAll('input[name="ad-theme"]').forEach(r => r.addEventListener('change', () => setTheme(r.value)));
  $('#ad-volume').addEventListener('input', e => { prefs.volume = e.target.value / 100 * 0.9; writeJSON(PREFS_KEY, prefs); applyPrefs(); });
  $('#ad-hear').addEventListener('change', e => { if (e.target.checked !== ui.hear) hearBtn.click(); });
  $('#ad-motion').addEventListener('change', e => { prefs.reduceMotion = e.target.checked; writeJSON(PREFS_KEY, prefs); applyPrefs(); });
  $('#ad-midi').addEventListener('click', () => { appDlg.close(); $('#midi-btn').click(); });
  $('#ad-wipe').addEventListener('click', () => {
    if (!window.confirm('Delete everything Sketchtone saved in this browser: the sketch, versions, MIDI setup and settings? This cannot be undone.')) return;
    window.removeEventListener('pagehide', persist);
    clearTimeout(saveTimer);
    try { Object.keys(localStorage).filter(k => k.startsWith('sketchtone.')).forEach(k => localStorage.removeItem(k)); } catch (e) { /* storage unavailable */ }
    location.reload();
  });

  // ---------- navbar ----------
  const nameInput = $('#project-name');
  nameInput.addEventListener('input', () => { project.name = nameInput.value; save(); });
  nameInput.addEventListener('blur', () => {
    if (!nameInput.value.trim()) { project.name = 'Untitled sketch'; nameInput.value = project.name; save(); }
  });
  $('#new-project').addEventListener('click', () => {
    if (hasMusic() && !window.confirm('Start a new project? Your current drawing will be cleared.')) return;
    stopAll();
    project = normalize(newProject());
    past.length = 0;
    future.length = 0;
    ui.startPos = 0;
    save();
    engine.updateAll();
    setPanel(null);
    refreshAll();
    persist();
    announce('New project started');
  });

  // ---------- MIDI knobs ----------
  // K1–K8 follow what is on screen; K8 flips pages, K7 picks the effect in FX pages.
  // Pinned knobs override that with one fixed setting everywhere.
  const midi = ST.midi;
  const PAGES = [[null, 'Home'], ['source', 'Sound'], ['envelope', 'Shape'], ['soundfx', 'Sound FX'], ['timefx', 'Time FX']];
  const SOUND_KNOBS = Object.fromEntries(PANELS.filter(p => p.knobs && !p.vox).flatMap(p => p.knobs).map(k => [k.key, k]));
  const VOX_KNOBS = Object.fromEntries(PANELS.find(p => p.vox).knobs.map(k => [k.key, k]));
  const pathKey = path => path.join('.');
  const panelControls = new Map(); // pathKey -> on-screen knob, kept in sync with MIDI moves
  const choiceDef = (label, options, get, set) => ({ discrete: true, label, options, get, set });
  const groupOf = panel => (PANELS.find(p => p.id === panel) || {}).group;

  function setVolume(v, l = current()) {
    l.volume = v;
    engine.updateLayer(l);
    const input = layerList.querySelector(`.vol[data-id="${l.id}"]`);
    if (input) input.value = Math.round(v * 100);
    save();
  }

  function syncControl(path, v) {
    const key = pathKey(path), knob = panelControls.get(key);
    if (knob) { knob.set(v); return; }
    const host = document.querySelector(`#panel [data-path="${key}"]`);
    if (!host) return;
    const box = host.querySelector('input[type="checkbox"]');
    if (box) { box.checked = !!v; return; }
    const radio = host.querySelector(`input[type="radio"][value="${v}"]`);
    if (radio) radio.checked = true;
  }

  // owner: a fixed layer (or the drums) instead of the selected one (macros, layer-specific MIDI).
  function paramDef(path, owner) {
    const [kind, a, b] = path, t = owner || target(), l = owner && !isDrums(owner) ? owner : current(), shown = t === target();
    const sync = (p, v) => { if (shown) syncControl(p, v); };
    if (kind === 'etch') {
      return a === 'x'
        ? { label: 'Etch: time', min: 0, max: 1, step: 0.002, fmt: v => barBeat(v * L()), get: () => ui.etch.x, set: v => { etchTo(v, ui.etch.y); etchX.set(v); } }
        : { label: 'Etch: pitch', min: 0, max: 1, step: 0.005, fmt: etchPitch, get: () => 1 - ui.etch.y, set: v => { etchTo(ui.etch.x, 1 - v); etchY.set(v); } };
    }
    if (kind === 'drum') {
      const m = drumDef(a);
      return { label: `Drums: ${m.label.toLowerCase()}`, min: 0, max: m.max || 100, step: m.step || 1, fmt: DRUM_FMT[a], get: () => project.drums[a], set: v => setDrum(a, v) };
    }
    if (kind === 'draw') {
      const d = DRAW_KNOBS.find(x => x.key === a), s = selected(), sign = d.invert ? -1 : 1;
      if (!s && !d.style) return { ...d, idle: 'select a line first' };
      return { ...d, get: () => sign * (s ? tfOf(s.item)[a] : ui.brushTf[a]), set: v => setDraw(a, sign * v, d.style) };
    }
    if (kind === 'volume') return { label: 'Volume', min: 0, max: 1, step: 0.01, fmt: v => `${Math.round(v * 100)}%`, get: () => l.volume, set: v => setVolume(v, l) };
    if (kind === 'lfo') {
      const lfo = () => ({ ...ST.LFO_DEFAULT, ...t.lfo });
      if (a === 'rate') return { label: 'LFO speed', min: 0, max: ST.LFO_RATES.length - 1, step: 1, fmt: i => rateLabel(ST.LFO_RATES[i]), get: () => Math.max(0, ST.LFO_RATES.indexOf(lfo().rate)), set: i => { setLfo('rate', ST.LFO_RATES[i], t); sync(path, i); } };
      return { label: 'LFO depth', min: 0, max: 100, step: 1, fmt: v => `${Math.round(v)}%`, get: () => lfo().depth, set: v => { setLfo('depth', v, t); sync(path, v); } };
    }
    if (kind === 'layer') return choiceDef('Layer', project.layers.map(x => [x.id, x.name]), () => project.selected, selectLayer);
    if (kind === 'page') return choiceDef('Page', PAGES, () => ui.panel, setPanel);
    if (kind === 'fxsel') {
      return choiceDef('Effect', FX_GROUPS[a].map(id => [id, FX_BY_ID[id].label]), () => ui.fxTab[a], id => {
        if (groupOf(ui.panel) === a) selectFxTab(id);
        else { ui.fxTab[a] = id; renderKnobStrip(); }
      });
    }
    if (kind === 'pattern') {
      const k = PATTERN_KNOBS.find(x => x.key === a), get = () => (a === 'y' ? 1 - ui.pattern.y : ui.pattern[a]);
      return { ...k, label: `Pattern ${k.label.toLowerCase()}`, get, set: v => setPattern(a, a === 'y' ? 1 - v : v) };
    }
    if (kind === 'vox') {
      const k = VOX_KNOBS[a];
      if (isDrums(t)) return { label: `Voice ${k.label.toLowerCase()}`, idle: 'the drum layer has no voice' };
      return { ...k, short: k.label, label: `Voice ${k.label.toLowerCase()}`, get: () => voxOf(t)[a], set: v => { setVox(a, v, t); sync(path, v); } };
    }
    if (kind === 'sound' && isDrums(t)) {
      const k = ST.DRUM_PANELS.source.concat(ST.DRUM_PANELS.envelope).find(x => x.key === a);
      if (!k) return { label: (SOUND_KNOBS[a] || { label: a }).label, idle: 'not used by the drum layer' };
      return { ...k, short: k.label, label: `Drums ${k.label.toLowerCase()}`, get: () => project.drums.sound[a], set: v => { setSound(a, v, t); sync(path, v); } };
    }
    if (kind === 'sound') {
      const set = v => { setSound(a, v, l); sync(path, v); };
      if (a === 'wave') return choiceDef('Waveform', WAVES.map(w => [w.id, w.label]), () => l.sound.wave, set);
      if (a === 'register') return choiceDef('Pitch range', REGISTERS.map(r => [r.id, r.label]), () => l.sound.register, set);
      return { ...SOUND_KNOBS[a], get: () => l.sound[a], set };
    }
    if (kind === 'fx') {
      const l = t, f = FX_BY_ID[a], c = f.params.find(p => p.key === b);
      const label = c.label.toLowerCase() === f.label.toLowerCase() ? f.label : `${f.label} ${c.label.toLowerCase()}`;
      const set = v => { setFx(a, b, v, c.sets, l); sync(path, v); };
      if (c.kind === 'choice') return choiceDef(label, c.options, () => String(l.fx[a][b]), set);
      if (c.kind === 'toggle') return choiceDef(label, [[false, 'Off'], [true, 'On']], () => !!l.fx[a][b], set);
      return { ...c, label, get: () => l.fx[a][b], set };
    }
    return null;
  }

  function knobTargets() {
    if (ui.drumMpk) return DRUM_MACROS.map(m => ['drum', m.key]);
    if (ui.patternOpen) return PATTERN_MPK.map(k => ['pattern', k]);
    const t = DRAW_KNOBS.map(d => ['draw', d.key]);
    for (const k in midi.settings.pins) t[k] = midi.settings.pins[k];
    if (ui.etch.on) { t[0] = ['etch', 'x']; t[1] = ['etch', 'y']; }
    return t;
  }

  // Smooth mode keeps an unrounded value per knob so coarse steps still move.
  const raw = new Map(), acc = new Map();
  function applyMove(k, move) {
    const path = knobTargets()[k];
    if (!path) { showHud(k, 'Not used on this page', '', null); return; }
    turn(k, k, paramDef(path), move, pathKey(path) + (path[0] === 'draw' && ui.sel ? `:${ui.sel.id}` : ''));
    const cell = document.querySelector(`#ks-list li[data-k="${k}"]`);
    if (cell) { cell.classList.add('is-hot'); clearTimeout(cell._t); cell._t = setTimeout(() => cell.classList.remove('is-hot'), 350); }
  }
  // One controller move on one control (a K-knob, or any learned CC).
  function turn(slot, hudLabel, d, move, key = slot) {
    if (d.idle) { showHud(hudLabel, d.label, d.idle, null); return; }
    if (d.discrete) {
      const opts = d.options, i = Math.max(0, opts.findIndex(o => o[0] === d.get()));
      let n = i;
      if (move.abs != null) {
        n = Math.round(move.abs * (opts.length - 1));
      } else {
        const ticks = d.label === 'Page' ? 10 : 6; // pages need a firmer turn
        let a = (acc.get(slot) || 0) + move.delta * 127;
        while (a >= ticks) { n++; a -= ticks; }
        while (a <= -ticks) { n--; a += ticks; }
        acc.set(slot, a);
        n = Math.max(0, Math.min(opts.length - 1, n));
      }
      if (n !== i) d.set(opts[n][0]);
      if (opts.length < 2) showHud(hudLabel, d.label, `${opts[n][1]} (only one: add more)`, null);
      else showHud(hudLabel, d.label, opts[n][1], n / (opts.length - 1));
      return;
    }
    const range = d.max - d.min, cur = d.get(), r = raw.get(slot);
    let v = r && r.key === key && Math.abs(r.v - cur) <= d.step ? r.v : cur;
    v = move.abs != null ? d.min + move.abs * range : v + move.delta * range;
    v = Math.min(d.max, Math.max(d.min, v));
    raw.set(slot, { key, v });
    const snapped = snapDef(d, v);
    if (snapped !== cur) d.set(snapped);
    showHud(hudLabel, d.label, d.fmt(snapped), (snapped - d.min) / range);
  }

  const hud = $('#knob-hud');
  let hudTimer = 0;
  function showHud(k, label, value, frac) {
    $('#hud-k').textContent = typeof k === 'number' ? `K${k + 1}` : k;
    $('#hud-label').textContent = label;
    $('#hud-value').textContent = value;
    $('#hud-bar').style.width = frac == null ? '0' : `${Math.round(frac * 100)}%`;
    hud.classList.add('is-visible');
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => hud.classList.remove('is-visible'), 1100);
    speak(`${label} ${value}`);
  }

  function renderKnobStrip() {
    const on = midi.status.connected && midi.status.inputs.length > 0;
    document.body.classList.toggle('midi-on', on);
    // The line bar already shows K1–K8 for drawing; the strip is for the other knob modes.
    const special = ui.drumMpk || ui.patternOpen || ui.etch.on;
    $('#knob-strip').hidden = !on || !special;
    syncLineBar();
    const targets = knobTargets();
    const picked = selected();
    $('#ks-page').textContent = ui.drumMpk ? 'Drum mode · K1–K8 generate the drums' : ui.patternOpen ? 'Pattern generator · K1–K8 shape the pattern' : ui.etch.on ? 'Etch mode · K1 time, K2 pitch' : picked ? `${toolOf(itemTool(picked.item)).label} on ${picked.layer.name}` : 'new lines';
    $('#ks-list').innerHTML = targets.map((path, k) => {
      const pinned = !!midi.settings.pins[k];
      return `<li data-k="${k}" class="${pinned ? 'is-pinned' : ''}${path ? '' : ' is-empty'}"><b>K${k + 1}</b><span>${path ? esc(paramDef(path).label) : '—'}</span>${pinned ? '<span class="sr-only">, pinned</span>' : ''}</li>`;
    }).join('');
    document.querySelectorAll('.k-badge').forEach(b => b.remove());
    const badge = (el, text, learned) => {
      const b = document.createElement('span');
      b.className = `k-badge${learned ? ' is-pinned' : ''}`;
      b.textContent = text;
      b.setAttribute('aria-hidden', 'true');
      if (el.tagName === 'INPUT') (el.closest('label') || el.parentElement).append(b);
      else (el.querySelector(':scope > .knob-label, :scope > legend, :scope > .scene-num') || el).append(b);
    };
    markMotions();
    if (!on) return;
    targets.forEach((path, k) => {
      if (!path) return;
      const el = document.querySelector(`#panel [data-path="${pathKey(path)}"], #drum-card [data-path="${pathKey(path)}"], #line-bar [data-path="${pathKey(path)}"]`);
      if (el) badge(el, `K${k + 1}`, false);
    });
    for (const path of Object.values(midi.settings.learned)) { // learned controls show their controller input
      const lab = midi.learnedFor(path);
      for (const el of document.querySelectorAll(`[data-learn="${path}"], [data-path="${path}"]`)) if (lab) badge(el, lab.label, true);
    }
  }

  // Settings dialog
  const dlg = $('#midi-dialog');
  function renderMidiStatus() {
    const s = midi.status, btn = $('#midi-btn');
    let label = 'Connect MIDI', text = 'Press Connect to look for your controller.', state = 'off';
    if (s.error === 'unsupported') { label = 'MIDI unavailable'; text = 'This browser cannot use MIDI. Open Sketchtone in Chrome or Edge (Safari has no MIDI support).'; }
    else if (s.error === 'denied') { label = 'MIDI blocked'; text = 'MIDI permission was blocked. Allow it from the site settings next to the address bar, then press Connect MIDI again.'; state = 'warn'; }
    else if (s.connected && !s.inputs.length) { label = 'MIDI · no device'; text = 'No controller found. Plug in your MPK Mini over USB; it appears here automatically.'; state = 'warn'; }
    else if (s.connected) { label = `MIDI · ${s.inputs[0]}`; text = `Connected: ${s.inputs.join(', ')}.`; state = 'on'; }
    $('#midi-label').textContent = label;
    btn.dataset.state = state;
    $('#md-status').textContent = text;
  }
  function renderSetup(active) {
    $('#md-setup').innerHTML = midi.settings.ccs.map((cc, k) => `
      <li class="${k === active ? 'is-active' : ''}${cc != null && active == null ? ' is-done' : ''}"><b>K${k + 1}</b><span>${active != null ? (k < active ? '✓' : k === active ? 'turn' : '') : cc != null ? `CC ${cc}` : '—'}</span></li>`).join('');
  }
  function renderDialog() {
    renderMidiStatus();
    renderSetup(null);
    renderLearned();
    const st = midi.settings;
    dlg.querySelector(`input[name="md-mode"][value="${st.mode}"]`).checked = true;
    dlg.querySelector(`input[name="md-speed"][value="${st.speed}"]`).checked = true;
    renderPadSetup(null);
  }
  $('#midi-btn').addEventListener('click', async () => {
    if (!midi.status.connected) await midi.connect();
    renderDialog();
    dlg.showModal();
  });
  dlg.addEventListener('close', () => { midi.cancelSetup(); $('#midi-btn').focus(); });
  $('#md-learn-help').textContent = 'To learn: focus any knob, slider or scene pad and press L (or Alt-click it), then turn a knob or press a pad on your controller.';
  dlg.addEventListener('change', e => {
    const st = midi.settings;
    if (e.target.name === 'md-mode') st.mode = e.target.value;
    else if (e.target.name === 'md-speed') st.speed = Number(e.target.value);
    else return;
    midi.save();
    renderKnobStrip();
  });
  dlg.addEventListener('click', e => {
    const unpin = e.target.closest('[data-unlearn]');
    if (!unpin) return;
    delete midi.settings.learned[unpin.dataset.unlearn];
    midi.save();
    renderLearned();
    renderKnobStrip();
    const next = $('#md-pins').querySelector('button');
    (next || $('#md-setup-btn')).focus();
  });
  $('#md-setup-btn').addEventListener('click', () => {
    const btn = $('#md-setup-btn');
    if (midi.isSetup()) { midi.cancelSetup(); return; }
    btn.textContent = 'Cancel setup';
    renderSetup(0);
    $('#md-status').textContent = 'Turn K1 a little.';
    midi.startSetup(step => {
      renderSetup(step);
      if (step < midi.KNOBS) $('#md-status').textContent = `Turn K${step + 1} a little.`;
    }, done => {
      btn.textContent = 'Start setup';
      renderSetup(null);
      $('#md-status').textContent = done ? 'All 8 knobs learned.' : 'Setup cancelled, the previous knobs are kept.';
      renderKnobStrip();
    });
  });

  midi.on('status', () => { renderMidiStatus(); renderKnobStrip(); });
  midi.on('message', m => {
    if (!dlg.open) return;
    if (m.note != null) {
      $('#md-monitor').textContent = `Last message: note ${m.note} on channel ${m.ch + 1} → ${m.pad >= 0 ? `Pad ${m.pad + 1}` : `Key ${noteName(m.note)}`}`;
      return;
    }
    const k = midi.knobOf(m.cc);
    $('#md-monitor').textContent = `Last message: CC ${m.cc}, value ${m.val}${k >= 0 ? ` → K${k + 1}` : midi.isSetup() ? '' : ' (not assigned yet)'}`;
  });
  midi.on('move', applyMove);
  midi.on('assign', (k, cc, expected) => {
    if (!expected) announce(`New knob (CC ${cc}) is now K${k + 1}. Use Setup in MIDI settings to change the order.`);
    if (dlg.open && !midi.isSetup()) renderSetup(null);
  });

  // ---------- MPK pads, keys, joystick ----------
  // Pads jump playback to one of 8 slices of the loop. Keys hold FX presets:
  // while a key is held every layer uses that key's FX. Joystick X bends pitch.
  const PAD_SLICES = 8;
  midi.on('pad', (i, vel, on) => {
    if (!on) return;
    if (perf.pads === 'scenes') { sceneButton(i % SCENES); showHud(`P${i + 1}`, 'Scene', project.scenes[i % SCENES] ? project.scenes[i % SCENES].name : 'saved', null); return; }
    const slice = i % PAD_SLICES, len = L(), at = slice * len / PAD_SLICES, p = engine.position();
    playFrom(p ? Math.floor(p.u / len) * len + at : at); // keep the pass, so ping-pong stays in step
    ui.padFlash = { slice, until: performance.now() + 450 };
    showHud(`P${i + 1}`, 'Jump to', barBeat(at), slice / PAD_SLICES);
    requestRender();
  });
  midi.on('bend', v => engine.setBend(v));

  const KEYFX_STORE = 'sketchtone.keyfx.v1';
  const keyFx = (() => { try { return JSON.parse(localStorage.getItem(KEYFX_STORE)) || {}; } catch (e) { return {}; } })();
  const saveKeyFx = () => { try { localStorage.setItem(KEYFX_STORE, JSON.stringify(keyFx)); } catch (e) { /* storage unavailable */ } };
  const fxNames = fx => FX.filter(f => fx[f.id] && fx[f.id].on).map(f => f.label).join(', ') || 'dry, no effects';

  // A key plays its own FX, or the default when it has none. The newest held key wins.
  const fxForKey = n => (keyFx[n] || keyFx.default || null);
  const keyLockPref = () => { try { return localStorage.getItem('sketchtone.keylock') || 'beat'; } catch (e) { return 'beat'; } };
  let keyLock = keyLockPref(), keyTimer = 0;
  // Seconds until the next beat or bar of the playing loop (0 when stopped or unlocked).
  function untilBoundary() {
    const pos = engine.position();
    if (!pos || keyLock === 'off') return 0;
    const unit = 60 / project.bpm * (keyLock === 'bar' ? 4 : 1);
    const next = Math.ceil((pos.u + 0.004) / unit) * unit;
    return next - pos.u;
  }
  function applyHeld() {
    const latched = perf.keys === 'fx' && perf.latch;
    const top = latched ? (ui.latched != null && fxForKey(ui.latched) ? ui.latched : null) : perf.keys === 'fx' ? [...ui.held].reverse().find(n => fxForKey(n)) : undefined;
    const fx = top != null ? fxForKey(top).fx : null;
    const label = top != null ? `Key ${noteName(top)}${keyFx[top] ? '' : ' (default)'}: ${fxNames(fx)}` : '';
    const badge = $('#keyfx-badge'), wait = untilBoundary();
    clearTimeout(keyTimer);
    const commit = () => {
      engine.setFxOverride(fx);
      badge.hidden = top == null;
      badge.textContent = label;
    };
    if (wait > 0.01) { // lock to the grid: switch on the next beat or bar, timed by the audio clock
      if (top != null) { badge.hidden = false; badge.textContent = `${label} · on the next ${keyLock}`; }
      const ctx = engine.ctx, due = ctx.currentTime + wait;
      const check = () => {
        const left = due - ctx.currentTime;
        if (left <= 0.004 || !engine.playing) commit();
        else keyTimer = setTimeout(check, Math.max(1, Math.min(40, (left - 0.004) * 700)));
      };
      check();
    } else commit();
    renderPiano();
  }
  function keyDown(note, vel = 100) {
    if (perf.keys === 'notes') { playNoteOn(note, vel); return; }
    if (perf.latch) ui.latched = ui.latched === note ? null : note; // press again to let go
    if (!ui.held.includes(note)) ui.held.push(note);
    ui.keySel = note;
    if (note < ui.keyBase || note > ui.keyBase + 24) ui.keyBase = Math.max(0, Math.floor(note / 12) * 12);
    const p = fxForKey(note);
    showHud(noteName(note), keyFx[note] ? 'Key FX' : p ? 'Default FX' : 'Empty key', p ? fxNames(p.fx) : 'save FX to it, or a default, in the Keys tab', null);
    applyHeld();
    renderKeyDetail();
  }
  function keyUp(note) {
    if (perf.keys === 'notes') { playNoteOff(note); return; }
    ui.held = ui.held.filter(n => n !== note);
    if (perf.latch) renderPiano(); else applyHeld();
  }
  midi.on('key', (note, vel, on) => (on ? keyDown(note, vel) : keyUp(note)));

  // On-screen keyboard (Keys tab): one tab stop, arrows move between keys.
  const BLACK = [1, 3, 6, 8, 10];
  function renderPiano() {
    const base = ui.keyBase, whites = 15, out = [];
    let wi = 0;
    for (let n = base; n <= base + 24; n++) {
      const black = BLACK.includes(n % 12), has = !!keyFx[n], sel = n === ui.keySel;
      const left = black ? (wi / whites) * 100 - 100 / whites * 0.32 : (wi / whites) * 100;
      out.push(`<button type="button" class="pk ${black ? 'pk-black' : 'pk-white'}${has && perf.keys === 'fx' ? ' has-fx' : ''}${ui.held.includes(n) || (perf.keys === 'fx' && perf.latch && ui.latched === n) ? ' is-held' : ''}"
        data-note="${n}" tabindex="${sel ? 0 : -1}" aria-pressed="${sel}" style="left:${left.toFixed(3)}%"
        aria-label="${noteName(n)}${perf.keys === 'notes' ? '' : has ? `, ${esc(fxNames(keyFx[n].fx))}` : ', empty'}">${n % 12 === 0 ? `<span>${noteName(n)}</span>` : ''}</button>`);
      if (!black) wi++;
    }
    $('#piano').innerHTML = out.join('');
    $('#oct-label').textContent = `${noteName(base)} to ${noteName(base + 24)}`;
  }
  function renderKeyDetail() {
    const n = ui.keySel, p = keyFx[n], d = keyFx.default;
    $('#key-title').textContent = `Key ${noteName(n)}`;
    $('#key-fx').textContent = p ? fxNames(p.fx) : d ? `Uses the default: ${fxNames(d.fx)}` : 'Empty. Set up Sound FX and Time FX on a layer, then save them here or as the default.';
    $('#key-save').textContent = `Save FX of ${current().name}`;
    $('#key-clear').disabled = !p;
    $('#key-try').disabled = !p && !d;
    $('#key-default-fx').textContent = d ? fxNames(d.fx) : 'none yet';
    $('#key-default-save').textContent = `Save FX of ${current().name} as default`;
    $('#key-default-clear').disabled = !d;
    document.querySelectorAll('input[name="keylock"]').forEach(r => { r.checked = r.value === keyLock; });
  }
  $('#key-default-save').addEventListener('click', () => {
    keyFx.default = { fx: JSON.parse(JSON.stringify(current().fx)) };
    saveKeyFx();
    applyHeld();
    renderKeyDetail();
    announce(`Default key FX: ${fxNames(keyFx.default.fx)}. Every key without its own FX now plays these.`);
  });
  $('#key-default-clear').addEventListener('click', () => {
    delete keyFx.default;
    saveKeyFx();
    applyHeld();
    renderKeyDetail();
    announce('Default key FX cleared');
  });
  document.querySelectorAll('input[name="keylock"]').forEach(r => r.addEventListener('change', () => {
    keyLock = r.value;
    try { localStorage.setItem('sketchtone.keylock', keyLock); } catch (e) { /* storage unavailable */ }
    announce(keyLock === 'off' ? 'Key FX switch at once' : `Key FX switch on the next ${keyLock}`);
  }));
  function selectKey(n, focus) {
    ui.keySel = n;
    renderPiano();
    renderKeyDetail();
    if (focus) $(`#piano [data-note="${n}"]`).focus();
  }
  $('#piano').addEventListener('click', e => {
    const k = e.target.closest('.pk');
    if (k && perf.keys === 'fx') selectKey(Number(k.dataset.note));
  });
  let pianoNote = null; // Play notes: the mouse or finger plays the keys
  $('#piano').addEventListener('pointerdown', e => {
    const k = e.target.closest('.pk');
    if (!k || perf.keys !== 'notes') return;
    engine.ensure();
    pianoNote = Number(k.dataset.note);
    playNoteOn(pianoNote);
  });
  const pianoUp = () => { if (pianoNote != null) { playNoteOff(pianoNote); pianoNote = null; } };
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(t => $('#piano').addEventListener(t, pianoUp));
  $('#piano').addEventListener('keydown', e => {
    if (perf.keys !== 'notes' || (e.key !== 'Enter' && e.key !== ' ') || e.repeat) return;
    e.preventDefault();
    e.stopPropagation();
    playNoteOn(ui.keySel);
  });
  $('#piano').addEventListener('keyup', e => { if (perf.keys === 'notes' && (e.key === 'Enter' || e.key === ' ')) playNoteOff(ui.keySel); });
  $('#piano').addEventListener('keydown', e => {
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const n = Math.min(ui.keyBase + 24, Math.max(ui.keyBase, ui.keySel + step));
    selectKey(n, true);
  });
  $('#oct-down').addEventListener('click', () => { ui.keyBase = Math.max(0, ui.keyBase - 12); selectKey(ui.keyBase); });
  $('#oct-up').addEventListener('click', () => { ui.keyBase = Math.min(96, ui.keyBase + 12); selectKey(ui.keyBase); });
  $('#key-save').addEventListener('click', () => {
    const n = ui.keySel, l = current();
    keyFx[n] = { fx: JSON.parse(JSON.stringify(l.fx)) };
    saveKeyFx();
    renderPiano();
    renderKeyDetail();
    announce(`Key ${noteName(n)} now holds ${fxNames(keyFx[n].fx)}. Hold it on your MPK to use it on every layer.`);
  });
  $('#key-clear').addEventListener('click', () => {
    const n = ui.keySel;
    delete keyFx[n];
    saveKeyFx();
    applyHeld();
    renderKeyDetail();
    announce(`Key ${noteName(n)} cleared`);
  });
  // "Hold to try": same as holding the key on the MPK.
  const tryBtn = $('#key-try');
  const tryOn = () => { engine.ensure(); keyDown(ui.keySel); };
  const tryOff = () => keyUp(ui.keySel);
  tryBtn.addEventListener('pointerdown', tryOn);
  tryBtn.addEventListener('pointerup', tryOff);
  tryBtn.addEventListener('pointerleave', tryOff);
  tryBtn.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); tryOn(); } });
  tryBtn.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') tryOff(); });
  tryBtn.addEventListener('blur', tryOff);

  // Pad setup in the MIDI dialog
  function renderPadSetup(active) {
    const pads = midi.settings.pads;
    $('#md-pads').innerHTML = Array.from({ length: 8 }, (_, i) => {
      const id = pads[i];
      const label = active != null ? (i < active ? '✓' : i === active ? 'hit' : '') : id ? `n${id.split(':')[1]}` : 'auto';
      return `<li class="${i === active ? 'is-active' : ''}${id && active == null ? ' is-done' : ''}"><b>P${i + 1}</b><span>${label}</span></li>`;
    }).join('');
  }
  $('#md-pads-btn').addEventListener('click', () => {
    const btn = $('#md-pads-btn');
    if (midi.isPadSetup()) { midi.cancelPadSetup(); return; }
    btn.textContent = 'Cancel pad setup';
    renderPadSetup(0);
    $('#md-status').textContent = 'Hit pad 1.';
    midi.startPadSetup(step => {
      renderPadSetup(step);
      if (step < 8) $('#md-status').textContent = `Hit pad ${step + 1}.`;
    }, done => {
      btn.textContent = 'Start pad setup';
      renderPadSetup(null);
      $('#md-status').textContent = done ? 'All 8 pads learned.' : 'Pad setup cancelled.';
    });
  });
  dlg.addEventListener('close', () => midi.cancelPadSetup());

  // ---------- perform: scenes, macros, controls by name ----------
  // Every control that macros and MIDI learn can reach, by a path string:
  // mix.<layer|drums>.volume|pan|room|echo, master.*, all.room|echo, macro.<n>,
  // at.<layer|drums>.<sound/fx/vox/lfo path> (one fixed layer), or a path that follows the selection.
  const ownerOf = id => (id === 'drums' ? project.drums : project.layers.find(l => l.id === id));
  const ownerName = o => (isDrums(o) ? 'Drums' : o.name);
  const pct100 = v => `${Math.round(v * 100)}%`;
  function reflect(path, v) { // keep an on-screen range input in step with MIDI and macros
    for (const el of document.querySelectorAll(`input[type="range"][data-path="${path}"]`)) {
      el.value = path.endsWith('.volume') ? Math.round(v * 100) : path.endsWith('.pan') ? Math.round(v * 100) : path === 'master.roomsize' ? v * 10 : v;
    }
  }
  function controlDef(str) {
    const p = String(str).split('.');
    if (p[0] === 'mix') {
      const o = ownerOf(p[1]);
      if (!o) return { label: 'A deleted layer', idle: 'its layer is gone' };
      const name = ownerName(o);
      if (p[2] === 'volume') return { label: `${name} volume`, min: 0, max: 1, step: 0.01, fmt: pct100, get: () => o.volume, set: v => { if (isDrums(o)) setDrum('volume', v); else setVolume(v, o); reflect(str, v); } };
      if (p[2] === 'pan') return { label: `${name} pan`, min: -1, max: 1, step: 0.01, fmt: panText, get: () => o.pan || 0, set: v => { setPan(p[1], v); reflect(str, v); } };
      return { label: `${name} ${p[2] === 'room' ? 'Room' : 'Echo'} send`, min: 0, max: 100, step: 1, fmt: v => `${Math.round(v)}%`, get: () => (o.send || {})[p[2]] || 0, set: v => setSend(p[1], p[2], v) };
    }
    if (p[0] === 'master') {
      const m = project.master, defs = {
        filter: ['Master filter', -100, 100, 1, filterText, () => m.filter],
        roomlevel: ['Room level', 0, 100, 1, v => `${Math.round(v)}%`, () => m.room.level],
        roomsize: ['Room size', 0.5, 6, 0.1, v => `${v.toFixed(1)} s`, () => m.room.size],
        echolevel: ['Echo level', 0, 100, 1, v => `${Math.round(v)}%`, () => m.echo.level],
        feedback: ['Echo repeats', 0, 90, 1, v => `${Math.round(v)}%`, () => m.echo.feedback],
      }[p[1]];
      if (!defs) return null;
      const [label, min, max, step, fmt, get] = defs;
      return { label, min, max, step, fmt, get, set: v => setMaster(p[1], v) };
    }
    if (p[0] === 'all') { // the same send on every layer and the drums
      const all = () => [...project.layers, project.drums], word = p[1] === 'room' ? 'Room' : 'Echo';
      return { label: `${word} send, all layers`, min: 0, max: 100, step: 1, fmt: v => `${Math.round(v)}%`,
        get: () => Math.max(...all().map(o => (o.send || {})[p[1]] || 0)),
        set: v => { for (const o of all()) setSend(isDrums(o) ? 'drums' : o.id, p[1], v); } };
    }
    if (p[0] === 'macro') {
      const i = Number(p[1]), m = project.macros[i];
      return m && { label: `Macro ${i + 1}: ${m.name}`, min: 0, max: 100, step: 1, fmt: v => `${Math.round(v)}%`, get: () => m.value * 100, set: v => setMacro(i, v / 100) };
    }
    if (p[0] === 'at') {
      const o = ownerOf(p[1]);
      if (!o) return { label: 'A deleted layer', idle: 'its layer is gone' };
      const d = paramDef(p.slice(2), o);
      return d && { ...d, label: `${ownerName(o)}: ${d.label}` };
    }
    return paramDef(p);
  }
  const snapDef = (d, v) => {
    const c = Math.min(d.max, Math.max(d.min, v)), dec = (String(d.step).split('.')[1] || '').length;
    return +(Math.round((c - d.min) / d.step) * d.step + d.min).toFixed(dec);
  };

  // Macros: one knob moves several settings, each between its own two values.
  const macroKnobs = [];
  function setMacro(i, x) {
    const m = project.macros[i];
    m.value = clamp01(x);
    for (const map of m.maps) {
      const d = controlDef(map.path);
      if (!d || d.idle || d.discrete) continue;
      const v = snapDef(d, map.from + (map.to - map.from) * m.value);
      if (v !== d.get()) d.set(v);
    }
    if (macroKnobs[i]) macroKnobs[i].set(Math.round(m.value * 100));
    save();
  }
  const macroSummary = m => (m.maps.length ? m.maps.map(x => (controlDef(x.path) || { label: x.path }).label).join(', ') : 'Nothing mapped yet');
  function renderMacros() {
    const host = $('#macro-row');
    host.innerHTML = '';
    macroKnobs.length = 0;
    project.macros.forEach((m, i) => {
      const k = createKnob({ label: esc(m.name), min: 0, max: 100, step: 1, value: Math.round(m.value * 100), reset: 0, fmt: v => `${Math.round(v)}%`,
        hint: `Moves: ${esc(macroSummary(m))}`, onInput: v => setMacro(i, v / 100) });
      k.el.dataset.path = `macro.${i}`;
      k.el.classList.toggle('is-idle', !m.maps.length);
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'macro-edit-btn';
      edit.dataset.macroEdit = i;
      edit.textContent = ui.macroSel === i ? 'Editing' : 'Edit';
      edit.setAttribute('aria-pressed', String(ui.macroSel === i));
      edit.setAttribute('aria-label', `Edit macro ${i + 1}, ${m.name}`);
      k.el.append(edit);
      macroKnobs[i] = k;
      host.append(k.el);
    });
    renderMacroEdit();
  }
  // Ready-made targets for the picker (any other knob: map it by turning it).
  function macroChoices() {
    const out = [['Master', ['filter', 'roomlevel', 'roomsize', 'echolevel', 'feedback'].map(k => `master.${k}`)], ['All layers', ['all.room', 'all.echo']],
      ['Drums', ['energy', 'fills', 'gaps', 'dirt', 'evolve', 'swing'].map(k => `drum.${k}`).concat(['mix.drums.volume', 'mix.drums.room', 'mix.drums.echo'])]];
    for (const l of project.layers) out.push([l.name, ['volume', 'pan', 'room', 'echo'].map(k => `mix.${l.id}.${k}`).concat([`at.${l.id}.sound.brightness`, `at.${l.id}.fx.filter.cutoff`, `at.${l.id}.fx.drive.amount`, `at.${l.id}.lfo.depth`])]);
    return out;
  }
  function renderMacroEdit() {
    const box = $('#macro-edit'), i = ui.macroSel, m = project.macros[i];
    box.hidden = i == null;
    if (i == null) return;
    const val = (d, v) => (d && !d.idle ? d.fmt(v) : String(v));
    box.innerHTML = `
      <div class="me-head">
        <label class="me-name"><span class="sr-only">Macro name</span><input type="text" id="me-name" maxlength="16" value="${esc(m.name)}"></label>
        <button type="button" class="btn btn-small me-map" id="me-map" aria-pressed="${ui.macroMap === i}">${ui.macroMap === i ? 'Turn any knob now… (Esc)' : 'Map: turn a knob'}</button>
        <label class="me-add"><span class="sr-only">Add a target</span><select id="me-add"><option value="">Add a target…</option>${macroChoices().map(([g, paths]) =>
          `<optgroup label="${esc(g)}">${paths.map(pth => `<option value="${pth}">${esc((controlDef(pth) || { label: pth }).label)}</option>`).join('')}</optgroup>`).join('')}</select></label>
        <button type="button" class="icon-btn" id="me-close" aria-label="Close macro editor">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
      </div>
      <ul class="me-list">${m.maps.length ? m.maps.map((x, j) => { const d = controlDef(x.path); return `
        <li><span class="me-target">${esc(d ? d.label : x.path)}</span><span class="me-range">${esc(val(d, x.from))} → ${esc(val(d, x.to))}</span>
          <button type="button" class="dev-btn" data-me-flip="${j}">Flip</button>
          <button type="button" class="icon-btn" data-me-del="${j}" aria-label="Remove ${esc(d ? d.label : x.path)}">${ICON.trash}</button></li>`; }).join('')
        : '<li class="me-empty">Press Map, then turn any knob or slider in Sound, Drums or Mix: the macro will move it from where it was to where you leave it.</li>'}</ul>`;
  }
  function addMacroMap(i, path, from, to) {
    const m = project.macros[i];
    m.maps = m.maps.filter(x => x.path !== path).concat({ path, from, to });
    m.maps.length = Math.min(m.maps.length, 8);
    save();
    renderMacros();
  }
  // Map by turning: remember where the knob was when you grabbed it, and where you left it.
  function macroPathFor(path) {
    const k = path.split('.')[0], owner = ui.drumSel ? 'drums' : current().id;
    if (['mix', 'master', 'all', 'drum', 'at'].includes(k)) return path;
    if (['sound', 'fx', 'vox', 'lfo'].includes(k)) return `at.${owner}.${path}`;
    if (k === 'volume') return `mix.${current().id}.volume`;
    return null;
  }
  function setMacroMap(i) {
    ui.macroMap = i;
    document.body.classList.toggle('macro-mapping', i != null);
    $('#map-toast').hidden = i == null;
    if (i != null) $('#map-toast').textContent = `Mapping macro ${i + 1} “${project.macros[i].name}”: turn any knob or slider. Esc cancels.`;
    renderMacroEdit();
  }
  function grabForMacro(e) {
    if (ui.macroMap == null || ui.macroGrab) return;
    const host = e.target.closest && e.target.closest('[data-path]');
    if (!host || host.closest('#macro-row') || host.closest('#macro-edit')) return;
    const path = macroPathFor(host.dataset.path), d = path && controlDef(path);
    if (!d || d.idle || d.discrete) { announce('A macro cannot move that one. Try a knob or a slider.'); return; }
    ui.macroGrab = { path, from: d.get() };
  }
  function releaseForMacro() {
    const g = ui.macroGrab, i = ui.macroMap;
    if (!g || i == null) return;
    ui.macroGrab = null;
    setTimeout(() => {
      const d = controlDef(g.path);
      let to = d.get();
      if (Math.abs(to - g.from) < 1e-9) to = g.from < (d.min + d.max) / 2 ? d.max : d.min; // a click: the whole way
      project.macros[i].value = 1;
      setMacroMap(null);
      addMacroMap(i, g.path, g.from, to);
      announce(`Macro ${i + 1} now moves ${d.label} from ${d.fmt(g.from)} to ${d.fmt(to)}`);
    }, 0);
  }
  document.addEventListener('pointerdown', grabForMacro, true);
  document.addEventListener('pointerup', releaseForMacro, true);
  document.addEventListener('keydown', e => { if (/^(Arrow|Page|Home|End)/.test(e.key)) grabForMacro(e); }, true);
  document.addEventListener('keyup', e => { if (/^(Arrow|Page|Home|End)/.test(e.key)) releaseForMacro(); }, true);

  const performEl = $('#perform');
  performEl.addEventListener('click', e => {
    const ed = e.target.closest('[data-macro-edit]');
    if (ed) { const i = Number(ed.dataset.macroEdit); ui.macroSel = ui.macroSel === i ? null : i; if (ui.macroSel == null) setMacroMap(null); renderMacros(); return; }
    if (e.target.closest('#me-close')) { ui.macroSel = null; setMacroMap(null); renderMacros(); return; }
    if (e.target.closest('#me-map')) { setMacroMap(ui.macroMap === ui.macroSel ? null : ui.macroSel); if (ui.macroMap != null) announce('Now turn any knob or slider, in Sound, Drums or Mix'); return; }
    const flip = e.target.closest('[data-me-flip]'), del = e.target.closest('[data-me-del]');
    if (flip || del) {
      const m = project.macros[ui.macroSel], j = Number((flip || del).dataset[flip ? 'meFlip' : 'meDel']);
      if (flip) { const x = m.maps[j]; [x.from, x.to] = [x.to, x.from]; } else m.maps.splice(j, 1);
      save();
      renderMacros();
      return;
    }
    const sc = e.target.closest('[data-scene]'), scSave = e.target.closest('[data-scene-save]'), scDel = e.target.closest('[data-scene-del]');
    if (scSave) { saveScene(Number(scSave.dataset.sceneSave)); return; }
    if (scDel) {
      const i = Number(scDel.dataset.sceneDel);
      if (!window.confirm(`Clear ${project.scenes[i].name}?`)) return;
      project.scenes[i] = null;
      if (ui.sceneActive === i) ui.sceneActive = null;
      save();
      renderScenes();
      announce(`Scene ${i + 1} cleared`);
      return;
    }
    if (sc) sceneButton(Number(sc.dataset.scene));
  });
  performEl.addEventListener('change', e => {
    if (e.target.id === 'me-add' && e.target.value) {
      const d = controlDef(e.target.value), from = d.get();
      addMacroMap(ui.macroSel, e.target.value, from, from < (d.min + d.max) / 2 ? d.max : d.min);
      announce(`Macro ${ui.macroSel + 1} now moves ${d.label}`);
      $('#me-add').focus();
    } else if (e.target.id === 'me-name') {
      project.macros[ui.macroSel].name = e.target.value.trim() || `Macro ${ui.macroSel + 1}`;
      save();
      renderMacros();
    } else if (e.target.name === 'pf-launch' || e.target.name === 'pf-pads' || e.target.name === 'pf-keys' || e.target.name === 'pf-hold' || e.target.id === 'pf-inkey') {
      if (e.target.name === 'pf-launch') perf.launch = e.target.value;
      if (e.target.name === 'pf-pads') perf.pads = e.target.value;
      if (e.target.name === 'pf-keys') { perf.keys = e.target.value; releaseNotes(); ui.held = []; ui.latched = null; applyHeld(); }
      if (e.target.name === 'pf-hold') { perf.latch = e.target.value === 'latch'; ui.latched = null; applyHeld(); }
      if (e.target.id === 'pf-inkey') perf.inKey = e.target.checked;
      writeJSON(PERF_KEY, perf);
      syncPerformControls();
    }
  });

  // Scenes: a snapshot of every layer's drawing (and the drum line), launched in time.
  const sceneSnap = () => ({
    layers: Object.fromEntries(project.layers.map(l => [l.id, JSON.parse(JSON.stringify(l.strokes))])),
    drums: JSON.parse(JSON.stringify({ curve: project.drums.curve, pattern: project.drums.pattern || [], frozen: !!project.drums.frozen, seed: project.drums.seed, muted: project.drums.muted })),
  });
  function saveScene(i) {
    const old = project.scenes[i];
    project.scenes[i] = { name: old ? old.name : `Scene ${i + 1}`, ...sceneSnap() };
    ui.sceneActive = i;
    save();
    renderScenes();
    announce(`${project.scenes[i].name} saved: the drawing of every layer${old ? ', replacing what it had' : ''}. Click it to come back to it.`);
  }
  function applyScene(sc) {
    snapshot();
    for (const l of project.layers) if (sc.layers[l.id]) l.strokes = JSON.parse(JSON.stringify(sc.layers[l.id])); // layers added later keep theirs
    if (sc.drums) Object.assign(project.drums, JSON.parse(JSON.stringify(sc.drums)));
    if (!selected()) { ui.sel = null; ui.extra = []; }
  }
  function sceneBoundary() {
    const pos = engine.position();
    if (!pos || perf.launch === 'now') return null;
    const unit = perf.launch === 'loop' ? L() : beatSec() * 4;
    return Math.ceil((pos.u + 0.02) / unit) * unit;
  }
  // A pad: launch its scene, or keep the drawing in it when it is empty.
  function sceneButton(i) {
    if (!project.scenes[i]) { saveScene(i); return; }
    launchScene(i);
  }
  function launchScene(i) {
    const sc = project.scenes[i];
    if (!sc) return;
    const done = () => {
      applyScene(sc);
      ui.sceneActive = i;
      const pos = engine.position(), p = ui.scenePending; // the scheduler runs a little ahead: light the pad on the beat
      if (p && p.i === i) setTimeout(() => { if (ui.scenePending === p) { ui.scenePending = null; renderScenes(); } }, pos ? Math.max(0, (p.u - pos.u) * 1000) : 0);
      save();
      renderLayers();
      refreshDrums();
      updateEmpty();
      renderKnobStrip();
      requestRender();
    };
    const at = sceneBoundary();
    if (at == null) { ui.scenePending = null; done(); renderScenes(); announce(`${sc.name}`); return; }
    ui.scenePending = { i, u: at };
    engine.at(at, done);
    renderScenes();
    announce(`${sc.name} starts on the next ${perf.launch === 'loop' ? 'loop' : 'bar'}`);
  }
  function renderScenes() {
    $('#scene-grid').innerHTML = project.scenes.map((sc, i) => {
      const pending = ui.scenePending && ui.scenePending.i === i, active = !pending && ui.sceneActive === i && sc;
      return `<div class="scene${sc ? '' : ' is-empty'}${active ? ' is-active' : ''}${pending ? ' is-pending' : ''}">
        <button type="button" class="scene-pad" data-scene="${i}" data-learn="scene.${i}" aria-pressed="${!!active}"
          aria-label="${sc ? `Launch ${esc(sc.name)}${pending ? ', starting soon' : ''}` : `Scene ${i + 1}, empty: save the drawing here`}">
          <span class="scene-num">${i + 1}</span><span class="scene-name">${sc ? esc(sc.name) : 'Save here'}</span>${pending ? '<span class="scene-wait">next ' + (perf.launch === 'loop' ? 'loop' : 'bar') + '</span>' : ''}
        </button>
        ${sc ? `<div class="scene-tools"><button type="button" class="scene-tool" data-scene-save="${i}" title="Save the drawing over this scene" aria-label="Save the drawing over ${esc(sc.name)}">Save</button><button type="button" class="scene-tool" data-scene-del="${i}" aria-label="Clear ${esc(sc.name)}">×</button></div>` : ''}
      </div>`;
    }).join('');
    renderKnobStrip();
  }

  // Perform settings: kept for this browser.
  const PERF_KEY = 'sketchtone.perform.v1';
  const perf = { launch: 'bar', pads: 'scenes', keys: 'fx', latch: false, inKey: true, ...readJSON(PERF_KEY, {}) };
  function syncPerformControls() {
    for (const [name, v] of [['pf-launch', perf.launch], ['pf-pads', perf.pads], ['pf-keys', perf.keys], ['pf-hold', perf.latch ? 'latch' : 'hold']]) {
      document.querySelectorAll(`input[name="${name}"]`).forEach(r => { r.checked = r.value === v; });
    }
    $('#pf-inkey').checked = perf.inKey;
    const notes = perf.keys === 'notes';
    $('#keys-fx').hidden = notes;
    $('#keys-notes').hidden = !notes;
    $('#keys-notes-layer').textContent = current().name;
    renderPiano();
  }
  function renderPerform() {
    renderScenes();
    renderMacros();
    syncPerformControls();
    renderKeyDetail();
  }

  // Keys in "Play notes" mode: the picked layer plays them, kept in the key unless you say no.
  const noteVoices = new Map();
  function playNoteOn(note, vel = 100) {
    const l = current(), m = perf.inKey ? ST.snapMidi(note, project.scale) : note;
    if (noteVoices.has(note)) engine.noteOff(noteVoices.get(note));
    noteVoices.set(note, engine.noteOn(l, m, vel / 127));
    if (!ui.held.includes(note)) ui.held.push(note);
    renderPiano();
    speak(`${noteName(m)} on ${l.name}`);
  }
  function playNoteOff(note) {
    engine.noteOff(noteVoices.get(note));
    noteVoices.delete(note);
    ui.held = ui.held.filter(n => n !== note);
    renderPiano();
  }
  function releaseNotes() { for (const n of [...noteVoices.keys()]) playNoteOff(n); }

  // ---------- MIDI learn: any knob, slider or pad on screen ----------
  let learning = null;
  const learnLabel = path => (path.startsWith('scene.') ? `scene ${Number(path.split('.')[1]) + 1}` : path === 'transport.play' ? 'Play' : path === 'transport.stop' ? 'Stop' : ((controlDef(path) || {}).label || path));
  function startLearn(el) {
    const host = el.closest('[data-learn], [data-path]');
    if (!host) return;
    const path = host.dataset.learn || host.dataset.path;
    if (!path.startsWith('scene.') && !path.startsWith('transport.')) {
      const d = controlDef(path);
      if (!d || d.discrete === undefined && d.min === undefined) { announce('This control cannot be learned'); return; }
    }
    cancelLearn();
    if (!midi.status.connected) midi.connect();
    learning = { path, el: host };
    host.classList.add('is-learning');
    midi.startLearn(finishLearn);
    announce(`Turn a knob, or press a pad or key, on your controller to control ${learnLabel(path)}. Escape cancels.`);
  }
  function finishLearn(id, inLabel) {
    if (!learning) return;
    const path = learning.path, learned = midi.settings.learned;
    for (const k in learned) if (learned[k] === path) delete learned[k];
    learned[id] = path;
    midi.save();
    cancelLearn();
    renderKnobStrip();
    renderLearned();
    showHud(inLabel, learnLabel(path), 'learned', null);
    announce(`${inLabel} now controls ${learnLabel(path)}`);
  }
  function cancelLearn() {
    if (!learning) return;
    learning.el.classList.remove('is-learning');
    learning = null;
    midi.cancelLearn();
  }
  document.addEventListener('keydown', e => {
    if ((e.key !== 'l' && e.key !== 'L') || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (!(t.closest && (t.closest('.knob') || t.closest('[data-learn]') || (t.matches('input[type="range"]') && t.dataset.path)))) return;
    e.preventDefault();
    e.stopPropagation();
    startLearn(t);
  }, true);
  document.addEventListener('pointerdown', e => {
    if (!e.altKey || !e.target.closest) return;
    const t = e.target.closest('.knob, [data-learn], input[type="range"][data-path]');
    if (!t || t.closest('#drum-canvas')) return;
    e.preventDefault();
    e.stopPropagation();
    startLearn(t);
  }, true);
  midi.on('learned', (id, move) => {
    const path = midi.settings.learned[id];
    if (path.startsWith('scene.') || path.startsWith('transport.')) { if ((move.abs != null ? move.abs : move.delta) > 0.4) learnedPress(path); return; }
    const d = controlDef(path);
    if (d) turn(id, midi.learnedFor(path).label, d, move);
  });
  midi.on('learnedNote', (id, vel, on) => { if (on) learnedPress(midi.settings.learned[id]); });
  function learnedPress(path) {
    if (path.startsWith('scene.')) sceneButton(Number(path.split('.')[1]));
    else if (path === 'transport.play') togglePlay();
    else if (path === 'transport.stop') { stopAll(); announce('Stopped'); }
  }
  function renderLearned() {
    const list = Object.entries(midi.settings.learned);
    $('#md-pins').innerHTML = list.length
      ? list.map(([id, path]) => `<li><b>${esc(midi.learnedFor(path) ? midi.learnedFor(path).label : id)}</b><span>${esc(learnLabel(path))}</span><button type="button" class="btn btn-small" data-unlearn="${esc(id)}">Forget</button></li>`).join('')
      : '<li class="md-empty">Nothing learned yet.</li>';
  }

  // ---------- knob menu: right-click any knob or slider ----------
  // Make it move by itself (motion presets, in time with the beat) or link it to a MIDI controller.
  const MOTION_PRESETS = [
    { id: 'slow', label: 'Slow wave', shape: 'sine', rate: 16, depth: 40 },
    { id: 'breathe', label: 'Breathing', shape: 'triangle', rate: 8, depth: 30 },
    { id: 'sweep', label: 'Sweep', shape: 'saw', rate: 4, depth: 50 },
    { id: 'pulse', label: 'Pulse', shape: 'square', rate: 1, depth: 50 },
    { id: 'wobble', label: 'Wobble', shape: 'sine', rate: 0.5, depth: 35 },
    { id: 'stutter', label: 'Stutter', shape: 'square', rate: 0.25, depth: 60 },
    { id: 'random', label: 'Random steps', shape: 'random', rate: 1, depth: 40 },
  ];
  // Where a control's motion lives: a layer (or the drums) and its target, or the master.
  function motionSlot(path) {
    const p = path.split('.'), layerSlot = (o, tg) => (o && ST.lfoRange(tg, isDrums(o)) ? { owner: o, target: tg } : { reason: 'This knob cannot move by itself.' });
    if (p[0] === 'fx' || p[0] === 'sound') return layerSlot(target(), path);
    if (p[0] === 'volume') return layerSlot(current(), 'volume');
    if (p[0] === 'mix') return layerSlot(ownerOf(p[1]), p[2] === 'room' || p[2] === 'echo' ? `send.${p[2]}` : p[2]);
    if (path === 'drum.volume') return layerSlot(project.drums, 'volume');
    if (p[0] === 'master') return ST.MASTER_RANGES[p[1]] ? { owner: project.master, master: true, target: p[1] } : { reason: 'Room size cannot move by itself: it would click.' };
    if (p[0] === 'drum') return { reason: 'Drum generator knobs write the groove: they cannot move by themselves yet. Link them to MIDI to play them live.' };
    if (p[0] === 'draw') return { reason: 'Line knobs reshape the drawing. Link them to MIDI to play them live.' };
    if (p[0] === 'macro') return { reason: 'Macros cannot move by themselves yet. Link one to MIDI to play it live.' };
    if (p[0] === 'vox') return { reason: 'Voice knobs apply to whole words: they cannot move by themselves.' };
    return { reason: 'This knob cannot move by itself.' };
  }
  function findMotion(slot) {
    if (!slot || !slot.owner) return null;
    if (slot.master) return (slot.owner.motions || []).find(m => m.target === slot.target && m.on) || null;
    const o = slot.owner;
    if (o.lfo && o.lfo.on && o.lfo.target === slot.target) return o.lfo; // the Motion card's own LFO
    return (o.motions || []).find(m => m.target === slot.target && m.on) || null;
  }
  function motionChanged(slot) {
    if (slot.master) engine.updateMaster(); else engine.updateLayer(slot.owner);
    save();
    markMotions();
    updateCards();
    if (ui.panel === 'lfo') buildPanel();
  }
  function applyMotion(slot, preset) {
    const o = slot.owner, m = findMotion(slot), v = { shape: preset.shape, rate: preset.rate, depth: m ? m.depth : preset.depth, on: true };
    if (m) Object.assign(m, v);
    else { o.motions = [...(o.motions || []).filter(x => x.target !== slot.target), { target: slot.target, ...v }].slice(-12); }
    if (!slot.master && slot.target.startsWith('fx.')) { // the effect must be on to be heard
      const id = slot.target.split('.')[1];
      if (!o.fx[id].on) { o.fx[id].on = true; if (o === target()) refreshFxState(id); }
    }
    motionChanged(slot);
    announce(`${motionLabel(slot)} now moves by itself: ${preset.label}, ${rateLabel(preset.rate)}. It moves while the loop plays.`);
  }
  function stopMotion(slot) {
    const m = findMotion(slot);
    if (!m) return;
    if (!slot.master && m === slot.owner.lfo) slot.owner.lfo.on = false;
    else slot.owner.motions = slot.owner.motions.filter(x => x !== m);
    motionChanged(slot);
    announce(`${motionLabel(slot)} stays still again`);
  }
  function motionTargetLabel(t, owner) {
    if (t.startsWith('sound.')) {
      const k = isDrums(owner) ? [...ST.DRUM_PANELS.source, ...ST.DRUM_PANELS.envelope].find(x => x.key === t.slice(6)) : SOUND_KNOBS[t.slice(6)];
      return k ? k.label : t;
    }
    return lfoTargetLabel(t);
  }
  const masterLabels = { filter: 'Master filter', roomlevel: 'Room level', echolevel: 'Echo level', feedback: 'Echo repeats' };
  const motionLabel = slot => (slot.master ? masterLabels[slot.target] : `${ownerName(slot.owner)} ${motionTargetLabel(slot.target, slot.owner).toLowerCase()}`);
  const motionPresetOf = m => MOTION_PRESETS.find(p => p.shape === m.shape && p.rate === m.rate);
  // The stored value a motion moves around, in the knob's own units.
  function motionBase(slot) {
    const o = slot.owner, t = slot.target;
    if (slot.master) return { filter: o.filter, roomlevel: o.room.level, echolevel: o.echo.level, feedback: o.echo.feedback }[t];
    if (t === 'volume') return o.volume;
    if (t === 'pan') return o.pan || 0;
    if (t.startsWith('send.')) return (o.send || {})[t.slice(5)] || 0;
    if (t.startsWith('sound.')) return o.sound[t.slice(6)];
    const [, id, key] = t.split('.');
    return o.fx[id][key];
  }

  // Knobs that move get a mark, and a dot that follows the movement while playing.
  let movingEls = [];
  function markMotions() {
    movingEls = [];
    for (const el of document.querySelectorAll('.knob-ctl[data-path], input[type="range"][data-path]')) {
      if (el.closest('dialog')) continue;
      const slot = motionSlot(el.dataset.path), m = slot.owner && findMotion(slot);
      el.classList.toggle('is-moving', !!m);
      if (m) movingEls.push({ el, slot, m });
      else if (el._knob) el._knob.setMod(null);
    }
  }
  function animateMotions(u) {
    for (const { el, slot, m } of movingEls) {
      if (!el._knob) continue;
      const r = slot.master ? ST.MASTER_RANGES[slot.target] : ST.lfoRange(slot.target, isDrums(slot.owner));
      if (r) el._knob.setMod(ST.motionValue(m, motionBase(slot), r, u, project.bpm));
    }
  }
  const clearMotionDots = () => { for (const { el } of movingEls) if (el._knob) el._knob.setMod(null); };

  const ctxMenu = $('#ctx-menu');
  let ctxFor = null;
  function openCtxMenu(host, x, y) {
    const path = host.dataset.path || host.dataset.learn, button = !host.dataset.path;
    const slot = button ? null : motionSlot(path), m = slot && findMotion(slot), link = midi.learnedFor(path);
    const who = slot && slot.owner ? (slot.master ? 'Master' : ownerName(slot.owner)) : '';
    ctxFor = { host, path, slot };
    let html = `<div class="ctx-head"><b>${esc(slot && slot.owner ? motionTargetLabelFor(slot) : learnLabel(path))}</b>${who ? `<span>${esc(who)}</span>` : ''}</div>`;
    if (slot) {
      html += '<div class="ctx-sec" id="ctx-move-label">Move by itself</div>';
      if (slot.owner) {
        html += `<div role="group" aria-labelledby="ctx-move-label">${MOTION_PRESETS.map(p => `
          <button type="button" role="menuitemradio" class="ctx-item" data-ctx-preset="${p.id}" aria-checked="${!!(m && motionPresetOf(m) === p)}">
            <span class="ctx-check" aria-hidden="true"></span>${p.label}<span class="ctx-meta">${rateLabel(p.rate)}</span></button>`).join('')}</div>`;
        if (m) {
          html += `<label class="ctx-depth"><span>Depth</span><input type="range" min="5" max="100" step="1" value="${Math.round(m.depth)}" data-ctx="depth" aria-label="How far it moves"><output>${Math.round(m.depth)}%</output></label>
            <button type="button" role="menuitem" class="ctx-item" data-ctx="stop"><span class="ctx-check" aria-hidden="true"></span>Stop moving</button>`;
        }
      } else html += `<p class="ctx-note">${esc(slot.reason)}</p>`;
      html += '<div class="ctx-sep" role="separator"></div>';
    }
    html += '<div class="ctx-sec">MIDI controller</div>';
    if (!midi.status.supported) html += '<p class="ctx-note">MIDI needs Chrome or Edge.</p>';
    else {
      if (link) html += `<p class="ctx-note">Linked to <b>${esc(link.label)}</b></p>`;
      html += `<button type="button" role="menuitem" class="ctx-item" data-ctx="learn"><span class="ctx-check" aria-hidden="true"></span>${link ? 'Link to another control…' : 'Link to MIDI…'}<span class="ctx-meta">L</span></button>`;
      if (link) html += '<button type="button" role="menuitem" class="ctx-item" data-ctx="unlink"><span class="ctx-check" aria-hidden="true"></span>Unlink</button>';
    }
    ctxMenu.innerHTML = html;
    ctxMenu.hidden = false;
    const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
    ctxMenu.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
    ctxMenu.style.top = `${y + h > innerHeight - 8 ? Math.max(8, y - h) : y}px`;
    const first = ctxMenu.querySelector('[aria-checked="true"]') || ctxMenu.querySelector('.ctx-item');
    if (first) first.focus();
  }
  const motionTargetLabelFor = slot => (slot.master ? masterLabels[slot.target] : motionTargetLabel(slot.target, slot.owner));
  function closeCtxMenu(refocus) {
    if (ctxMenu.hidden) return;
    ctxMenu.hidden = true;
    const f = ctxFor;
    ctxFor = null;
    if (refocus && f) { const k = f.host.querySelector('.knob') || f.host; if (k.focus) k.focus(); }
  }
  ctxMenu.addEventListener('click', e => {
    if (!ctxFor) return;
    const pr = e.target.closest('[data-ctx-preset]'), act = e.target.closest('[data-ctx]');
    const { slot, host, path } = ctxFor;
    if (pr) { applyMotion(slot, MOTION_PRESETS.find(p => p.id === pr.dataset.ctxPreset)); closeCtxMenu(true); return; }
    if (!act || act.dataset.ctx === 'depth') return;
    if (act.dataset.ctx === 'stop') { stopMotion(slot); closeCtxMenu(true); }
    else if (act.dataset.ctx === 'learn') { closeCtxMenu(true); startLearn(host.querySelector('.knob') || host); }
    else if (act.dataset.ctx === 'unlink') {
      for (const k in midi.settings.learned) if (midi.settings.learned[k] === path) delete midi.settings.learned[k];
      midi.save();
      renderKnobStrip();
      renderLearned();
      closeCtxMenu(true);
      announce(`${learnLabel(path)} is no longer linked to MIDI`);
    }
  });
  ctxMenu.addEventListener('input', e => {
    if (e.target.dataset.ctx !== 'depth' || !ctxFor) return;
    const m = findMotion(ctxFor.slot);
    if (!m) return;
    m.depth = Number(e.target.value);
    e.target.nextElementSibling.textContent = `${m.depth}%`;
    motionChanged(ctxFor.slot);
  });
  ctxMenu.addEventListener('keydown', e => {
    const items = [...ctxMenu.querySelectorAll('.ctx-item, input')], i = items.indexOf(document.activeElement);
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closeCtxMenu(true); return; }
    if (document.activeElement.tagName === 'INPUT' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    const n = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (n === undefined) return;
    e.preventDefault();
    items[(n + items.length) % items.length].focus();
  });
  document.addEventListener('pointerdown', e => { if (!ctxMenu.hidden && !ctxMenu.contains(e.target)) closeCtxMenu(false); }, true);
  window.addEventListener('resize', () => closeCtxMenu(false));
  document.addEventListener('scroll', e => { if (!ctxMenu.contains(e.target)) closeCtxMenu(false); }, true);
  const ctxHost = t => t.closest && !t.closest('dialog') && t.closest('.knob-ctl[data-path], input[type="range"][data-path], [data-learn]');
  document.addEventListener('contextmenu', e => {
    const host = ctxHost(e.target);
    if (!host) return;
    e.preventDefault();
    openCtxMenu(host, e.clientX, e.clientY);
  });
  document.addEventListener('keydown', e => { // the menu key, or Shift F10, on a focused knob
    if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
    const host = ctxHost(e.target);
    if (!host) return;
    e.preventDefault();
    const r = (host.querySelector('.knob') || host).getBoundingClientRect();
    openCtxMenu(host, r.left, r.bottom + 4);
  }, true);

  // ---------- drum strip ----------
  // A generative drummer. The red energy line (same time axis as the canvas) says
  // how busy the drums are; eight macro knobs say what they play; the lanes show
  // the hits the engine (drums.js) generates for the pass being played.
  const { DRUMS, DRUM_MACROS, DRUM_STYLES, DRUM_CURVE } = ST;
  const drumCanvas = $('#drum-canvas'), d2d = drumCanvas.getContext('2d'), drumWrap = $('.drum-wrap');
  const DRUM_LINE = '#e5484d';
  let DW = 0, DH = 0;

  function measureDrums() {
    DW = drumWrap.clientWidth; DH = drumWrap.clientHeight;
    drumCanvas.width = Math.round(DW * dpr); drumCanvas.height = Math.round(DH * dpr);
    renderDrums();
  }
  new ResizeObserver(measureDrums).observe(drumWrap);

  const curveAt = x => project.drums.curve[Math.min(DRUM_CURVE - 1, Math.floor(x * DRUM_CURVE))];

  // Frozen drums: a step grid of fixed hits. Bigger = louder, dashed = plays only sometimes.
  function drawFrozen(c, hits, pos, lh) {
    const steps = project.bars * 16, sw = DW / steps, len = L();
    c.strokeStyle = theme.grid;
    c.globalAlpha = 0.6;
    for (let i = 1; i < steps; i++) { if (i % 4) { const x = Math.round(i * sw) + 0.5; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, DH); c.stroke(); } }
    c.globalAlpha = 1;
    for (const h of project.drums.pattern || []) {
      const x = h.step * sw, y = h.lane * lh, w = Math.max(3, sw - 3), hh = Math.max(3, lh - 3) * (0.45 + 0.55 * h.vel);
      const near = pos && Math.abs(pos.t - h.step * len / steps) < len / steps * 0.6;
      c.fillStyle = near ? theme.accent : 'rgba(244, 81, 30, 1)';
      c.globalAlpha = (near ? 1 : 0.35 + 0.6 * h.vel) * (project.drums.muted ? 0.4 : 1);
      c.fillRect(x + 1.5, y + (lh - hh) / 2, w, hh);
      if (h.prob < 1) { c.globalAlpha = 1; c.setLineDash([2, 2]); c.strokeStyle = theme['ink-2']; c.strokeRect(x + 1.5, y + 1.5, w, lh - 3); c.setLineDash([]); }
    }
    c.globalAlpha = 1;
    if (document.activeElement === drumCanvas && drumCanvas.matches(':focus-visible')) {
      c.strokeStyle = theme.accent;
      c.lineWidth = 2;
      c.strokeRect(frozenCursorStep() * sw + 1, (ui.dcur.lane ?? 10) * lh + 1, sw - 2, lh - 2);
      c.lineWidth = 1;
    }
  }
  const frozenCursorStep = () => Math.min(project.bars * 16 - 1, Math.floor(ui.dcur.x * project.bars * 16 + 1e-6));
  const VEL_STEPS = [0.35, 0.65, 1];
  const hitAt = (lane, step) => (project.drums.pattern || []).find(h => h.lane === lane && h.step === step);
  // Click: add or remove a hit. Shift: louder in three steps. Alt: always <-> half the time.
  function editFrozen(lane, step, mode) {
    const d = project.drums, h = hitAt(lane, step), name = `${DRUMS[lane].label}, ${barBeat(step / (project.bars * 16) * L())}`;
    if (mode === 'vel' && h) {
      const up = VEL_STEPS.findIndex(v => v > h.vel + 0.01); // the next louder level, then back to soft
      h.vel = VEL_STEPS[up < 0 ? 0 : up];
      speak(`${name}: ${h.vel < 0.5 ? 'soft' : h.vel < 0.9 ? 'medium' : 'loud'}`);
    } else if (mode === 'prob' && h) {
      h.prob = h.prob < 1 ? 1 : 0.5;
      speak(`${name}: ${h.prob < 1 ? 'plays half the time' : 'always plays'}`);
    } else if (mode === 'add' && !h) {
      d.pattern.push({ lane, step, vel: 0.8, prob: 1 });
      engine.drumNow(DRUMS[lane].id, 0.8);
      speak(`${name} added`);
    } else if (mode === 'remove' && h) {
      d.pattern = d.pattern.filter(x => x !== h);
      speak(`${name} removed`);
    } else return false;
    save();
    requestRender();
    return true;
  }
  function setFrozen(on) {
    const d = project.drums;
    snapshot();
    if (on) {
      const pos = engine.position(), seen = new Map();
      for (const h of engine.drums(pos ? pos.k : 0)) {
        const key = `${h.lane}:${h.step}`, prev = seen.get(key);
        if (!prev || h.vel > prev.vel) seen.set(key, { lane: h.lane, step: h.step, vel: Math.round(h.vel * 100) / 100, prob: 1, tune: h.tune !== 1 ? h.tune : undefined });
      }
      d.pattern = [...seen.values()];
      d.frozen = true;
    } else d.frozen = false;
    save();
    refreshDrums();
    requestRender();
    announce(on ? `Frozen: ${d.pattern.length} hits are now fixed. Click a lane to add or remove hits, Shift-click for louder, Alt-click for sometimes. Unfreeze to generate again.` : 'Unfrozen: the drummer generates again');
  }

  function renderDrums() {
    if (!DW || !DH) return;
    const c = d2d, d = project.drums, n = DRUMS.length, lh = DH / n, beats = project.bars * 4, len = L();
    const X = t => t / len * DW;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = theme.paper;
    c.fillRect(0, 0, DW, DH);
    c.fillStyle = theme.grid;
    for (let i = 1; i < n; i += 2) c.fillRect(0, i * lh, DW, lh);
    c.lineWidth = 1;
    for (let b = 1; b < beats; b++) {
      const x = Math.round(b / beats * DW) + 0.5;
      c.strokeStyle = b % 4 === 0 ? theme['grid-strong'] : theme.grid;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, DH); c.stroke();
    }
    const pos = engine.position(), hits = engine.drums(pos ? pos.k : 0), off = d.muted ? 0.35 : 1;
    if (d.frozen) drawFrozen(c, hits, pos, lh);
    else {
      // gaps in the energy line: nothing plays there
      c.fillStyle = theme['ink-3'];
      c.globalAlpha = 0.12;
      for (let i = 0; i < DRUM_CURVE; i++) if (d.curve[i] < 0) c.fillRect(i / DRUM_CURVE * DW, 0, DW / DRUM_CURVE + 0.5, DH);
      // fills and stops the drummer planned for this pass
      c.font = '600 10px system-ui, -apple-system, sans-serif';
      c.textBaseline = 'top';
      for (const [a, b] of hits.fills) {
        c.globalAlpha = 0.14; c.fillStyle = theme.accent; c.fillRect(X(a), 0, X(b) - X(a), DH);
        c.globalAlpha = 0.9; c.fillText('FILL', X(a) + 4, 3);
      }
      for (const [a, b] of hits.stops) {
        c.globalAlpha = 0.22; c.fillStyle = theme['ink-2']; c.fillRect(X(a), 0, X(b) - X(a), DH);
        c.globalAlpha = 0.9; c.fillText('STOP', X(a) + 4, 15);
      }
      // generated hits: they light up as they play, dirty ones glow red
      for (const h of hits) {
        const x = X(h.t), y = (h.lane + 0.5) * lh, r = 1.8 + h.vel * 2.6;
        const near = pos && pos.t >= h.t - 0.02 && pos.t - h.t < 0.12;
        c.globalAlpha = (near ? 1 : 0.3 + h.vel * 0.45) * off;
        c.fillStyle = near ? theme.accent : h.dirt > 0.45 ? '#f5a524' : theme['ink-2'];
        c.beginPath(); c.arc(x, y, near ? r + 2 : r, 0, Math.PI * 2); c.fill();
      }
      // the energy line, broken at the gaps, with a soft area under it
      const runs = [];
      for (let i = 0; i < DRUM_CURVE; i++) {
        if (d.curve[i] < 0) continue;
        if (!runs.length || runs[runs.length - 1].end !== i) runs.push({ start: i, end: i, pts: [] });
        const run = runs[runs.length - 1], y = (1 - d.curve[i]) * DH;
        if (i === run.start) run.pts.push([i / DRUM_CURVE * DW, y]);
        run.pts.push([(i + 0.5) / DRUM_CURVE * DW, y]);
        run.end = i + 1;
        run.lastY = y;
      }
      c.lineWidth = 3;
      c.lineJoin = 'round';
      c.lineCap = 'round';
      for (const run of runs) {
        run.pts.push([run.end / DRUM_CURVE * DW, run.lastY]);
        c.beginPath();
        run.pts.forEach(([x, y], j) => (j ? c.lineTo(x, y) : c.moveTo(x, y)));
        c.globalAlpha = 0.1 * off;
        c.fillStyle = DRUM_LINE;
        c.lineTo(run.pts[run.pts.length - 1][0], DH); c.lineTo(run.pts[0][0], DH); c.closePath(); c.fill();
        c.globalAlpha = off;
        c.strokeStyle = DRUM_LINE;
        c.beginPath();
        run.pts.forEach(([x, y], j) => (j ? c.lineTo(x, y) : c.moveTo(x, y)));
        c.stroke();
      }
    }
    // lane names
    c.font = '11px system-ui, -apple-system, sans-serif';
    c.textBaseline = 'middle';
    DRUMS.forEach((dr, i) => {
      const w = c.measureText(dr.label).width + 8, y = (i + 0.5) * lh;
      c.globalAlpha = 0.8;
      c.fillStyle = theme.paper;
      c.fillRect(2, y - 6.5, w, 13);
      c.globalAlpha = 0.85;
      c.fillStyle = theme['ink-2'];
      c.fillText(dr.label, 6, y);
    });
    c.globalAlpha = 1;
    // playhead
    const x = Math.round(X(pos ? pos.t : ui.startPos)) + 0.5;
    c.strokeStyle = pos ? theme.accent : theme['ink-3'];
    c.lineWidth = pos ? 2 : 1;
    c.setLineDash(pos ? [] : [4, 4]);
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, DH); c.stroke();
    c.setLineDash([]);
    // keyboard cursor
    if (document.activeElement === drumCanvas && drumCanvas.matches(':focus-visible')) {
      const cx = ui.dcur.x * DW, v = curveAt(ui.dcur.x);
      c.strokeStyle = DRUM_LINE;
      c.lineWidth = 2;
      c.setLineDash([3, 3]);
      c.beginPath(); c.moveTo(cx, 0); c.lineTo(cx, DH); c.stroke();
      c.setLineDash([]);
      if (v >= 0) { c.beginPath(); c.arc(cx, (1 - v) * DH, 6, 0, Math.PI * 2); c.stroke(); }
    }
  }

  const updateDrumEmpty = () => { $('#drum-empty').hidden = ST.drumsDrawn(project.drums) || !!ui.drumPen; };

  // Draw (or gap) the energy line between two points, 0..1 on both axes.
  function paintCurve(a, b, gap) {
    const d = project.drums, N = DRUM_CURVE;
    if (b[0] < a[0]) [a, b] = [b, a];
    const i0 = Math.max(0, Math.floor(a[0] * N)), i1 = Math.min(N - 1, Math.floor(b[0] * N));
    for (let i = i0; i <= i1; i++) {
      const u = i1 === i0 ? 1 : (i - i0) / (i1 - i0);
      d.curve[i] = gap ? -1 : Math.round(clamp01(1 - (a[1] + (b[1] - a[1]) * u)) * 100) / 100;
    }
  }
  const dnorm = e => {
    const r = drumCanvas.getBoundingClientRect();
    return [clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height)];
  };
  drumCanvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    if (!DW || !DH) measureDrums();
    drumCanvas.focus({ preventScroll: true });
    try { drumCanvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    const p = dnorm(e);
    if (project.drums.frozen) {
      const lane = Math.min(DRUMS.length - 1, Math.floor(p[1] * DRUMS.length)), step = Math.min(project.bars * 16 - 1, Math.floor(p[0] * project.bars * 16));
      snapshot();
      const mode = e.shiftKey ? 'vel' : e.altKey ? 'prob' : hitAt(lane, step) ? 'remove' : 'add';
      if (!editFrozen(lane, step, mode)) { past.pop(); updateUndo(); return; }
      ui.frozenPaint = mode === 'add' || mode === 'remove' ? { mode, last: `${lane}:${step}` } : null;
      return;
    }
    snapshot();
    ui.drumPen = { last: p, x0: p[0], x1: p[0] };
    paintCurve(p, p, ui.drumTool === 'gap');
    save();
    updateDrumEmpty();
    requestRender();
  });
  drumCanvas.addEventListener('pointermove', e => {
    if (ui.frozenPaint && project.drums.frozen) {
      const p = dnorm(e), lane = Math.min(DRUMS.length - 1, Math.floor(p[1] * DRUMS.length)), step = Math.min(project.bars * 16 - 1, Math.floor(p[0] * project.bars * 16));
      if (`${lane}:${step}` !== ui.frozenPaint.last) { ui.frozenPaint.last = `${lane}:${step}`; editFrozen(lane, step, ui.frozenPaint.mode); }
      return;
    }
    const pen = ui.drumPen;
    if (!pen) return;
    const p = dnorm(e);
    paintCurve(pen.last, p, ui.drumTool === 'gap');
    pen.last = p;
    pen.x0 = Math.min(pen.x0, p[0]);
    pen.x1 = Math.max(pen.x1, p[0]);
    save();
    requestRender();
  });
  const endDrumPointer = () => {
    ui.frozenPaint = null;
    const pen = ui.drumPen;
    if (!pen) return;
    ui.drumPen = null;
    updateDrumEmpty();
    updateStyles();
    announce(`${ui.drumTool === 'gap' ? 'Drum gap' : 'Energy line'} from ${barBeat(pen.x0 * L())} to ${barBeat(pen.x1 * L())}`);
  };
  drumCanvas.addEventListener('pointerup', endDrumPointer);
  drumCanvas.addEventListener('pointercancel', endDrumPointer);

  // Keyboard: Left/Right move one 16th (Shift: a beat), Up/Down change the energy
  // there, Delete makes a gap, Enter puts the line back (Space always plays).
  const energyText = v => (v < 0 ? 'gap, silent' : `energy ${Math.round(v * 100)}%`);
  const drumCursorText = () => `${barBeat(ui.dcur.x * L())}, ${energyText(curveAt(ui.dcur.x))}`;
  let kbEditAt = 0;
  function setCurveStep(v) {
    const steps = project.bars * 16, s = Math.min(steps - 1, Math.floor(ui.dcur.x * steps));
    if (Date.now() - kbEditAt > 1200) snapshot(); // one undo per burst of key presses
    kbEditAt = Date.now();
    const i0 = Math.floor(s / steps * DRUM_CURVE), i1 = Math.max(i0 + 1, Math.floor((s + 1) / steps * DRUM_CURVE));
    for (let i = i0; i < i1; i++) project.drums.curve[i] = v;
    save();
    updateDrumEmpty();
    requestRender();
    speak(drumCursorText());
  }
  drumCanvas.addEventListener('keydown', e => {
    const cur = ui.dcur, steps = project.bars * 16;
    if (project.drums.frozen) {
      if (cur.lane == null) cur.lane = DRUMS.length - 1;
      const mv = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (mv) {
        e.preventDefault();
        const st = Math.min(steps - 1, Math.max(0, frozenCursorStep() + mv[0] * (e.shiftKey ? 4 : 1)));
        cur.x = st / steps;
        cur.lane = Math.min(DRUMS.length - 1, Math.max(0, cur.lane + mv[1]));
        const h = hitAt(cur.lane, st);
        speak(`${DRUMS[cur.lane].label}, ${barBeat(st / steps * L())}, ${h ? (h.vel < 0.5 ? 'soft hit' : h.vel < 0.9 ? 'hit' : 'loud hit') : 'empty'}`);
        renderDrums();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const st = frozenCursorStep(), mode = e.shiftKey ? 'vel' : e.altKey ? 'prob' : hitAt(cur.lane, st) ? 'remove' : 'add';
        snapshot();
        if (!editFrozen(cur.lane, st, mode)) { past.pop(); updateUndo(); }
      }
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const s = Math.floor(cur.x * steps + 1e-6) + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 4 : 1);
      cur.x = Math.min(steps - 1, Math.max(0, s)) / steps;
      speak(drumCursorText());
      renderDrums();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const v = curveAt(cur.x), base = v < 0 ? 0.5 : v;
      setCurveStep(Math.round(clamp01(base + (e.key === 'ArrowUp' ? 0.1 : -0.1)) * 10) / 10);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      setCurveStep(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.repeat) return;
      if (curveAt(cur.x) < 0) setCurveStep(0.6); else speak(drumCursorText());
    }
  });
  drumCanvas.addEventListener('focus', () => { renderDrums(); if (drumCanvas.matches(':focus-visible')) speak(drumCursorText()); });
  drumCanvas.addEventListener('blur', () => renderDrums());

  // Knobs: eight macros that generate (K1..K8 in MPK drum mode) and the feel.
  const pct = v => `${Math.round(v)}%`;
  const DRUM_FMT = {
    kicks: v => (v < 1 ? 'Off' : `~${Math.max(1, Math.round(v / 100 * 8))} / bar`),
    snares: v => (v < 5 ? 'Off' : v <= 30 ? 'Backbeat' : v <= 55 ? '+ ghosts' : v <= 70 ? '+ claps' : '+ rims'),
    hats: v => (v < 5 ? 'Off' : v < 20 ? 'Offbeats' : v < 45 ? 'Eighths' : v < 80 ? 'Sixteenths' : 'Rolls'),
    percs: v => (v < 5 ? 'Off' : v <= 15 ? 'Congas' : v <= 60 ? '+ shaker' : '+ toms'),
    fills: v => (v < 1 ? 'Off' : v <= 33 ? 'Every 8' : v <= 66 ? 'Every 4' : 'Every 2'),
    gaps: v => (v < 1 ? 'Off' : pct(v)),
    dirt: v => (v < 1 ? 'Clean' : pct(v)),
    evolve: v => (v < 1 ? 'Locked' : v > 85 ? 'Improvise' : pct(v)),
    energy: pct,
    listen: v => (v < 1 ? 'Off' : pct(v)),
    swing: pct,
    morph: v => (project.drums.seedB == null ? 'Keep first' : v < 1 ? 'New groove' : v > 99 ? 'Kept groove' : `${Math.round(v)}% kept`),
    volume: v => `${Math.round(v * 100)}%`,
  };
  const DRUM_FEEL = [
    { key: 'energy', label: 'Energy', hint: 'Everything at once: sparse at the bottom, a full drop at the top' },
    { key: 'listen', label: 'Listen', hint: 'Drums follow your drawing: busier where the melody is loud or high, space where it rests' },
    { key: 'swing', label: 'Swing', max: 75, hint: 'Straight to shuffled' },
    { key: 'morph', label: 'Morph', hint: 'Blend from the new groove back to the kept one' },
    { key: 'volume', label: 'Volume', max: 1, step: 0.01, hint: 'Drum level' },
  ];
  const drumDef = key => DRUM_MACROS.find(m => m.key === key) || DRUM_FEEL.find(m => m.key === key);
  const drumKnobs = {};

  function setDrum(key, v) {
    const d = project.drums;
    if (d[key] === v) return;
    d[key] = v;
    save();
    if (key === 'dirt' || key === 'volume') engine.updateDrums();
    if (drumKnobs[key]) drumKnobs[key].set(v);
    if (key === 'volume') { const row = layerList.querySelector('.vol[data-id="drums"]'); if (row) row.value = Math.round(v * 100); }
    updateStyles();
    requestRender();
  }

  function buildDrumKnobs() {
    const base = ST.defaultDrums();
    for (const [host, defs] of [[$('#drum-macros'), DRUM_MACROS], [$('#drum-feel'), DRUM_FEEL]]) {
      host.innerHTML = '';
      for (const m of defs) {
        const k = createKnob({
          label: m.label, min: 0, max: m.max || 100, step: m.step || 1, value: project.drums[m.key], reset: base[m.key],
          fmt: DRUM_FMT[m.key], hint: m.hint, onInput: v => setDrum(m.key, v),
        });
        k.el.dataset.path = `drum.${m.key}`;
        drumKnobs[m.key] = k;
        host.append(k.el);
      }
    }
  }

  // Styles set every knob in one tap (and draw a flat line if there is none).
  $('#drum-styles').innerHTML = DRUM_STYLES.map(s => `<button type="button" class="tile tile-style" data-style="${s.id}" aria-pressed="false">${s.label}</button>`).join('');
  function updateStyles() {
    const d = project.drums;
    document.querySelectorAll('#drum-styles [data-style]').forEach(b => {
      const s = DRUM_STYLES.find(x => x.id === b.dataset.style);
      b.setAttribute('aria-pressed', String(Object.entries(s.v).every(([k, v]) => d[k] === v)));
    });
    updateDrumMeta();
  }
  $('#drum-styles').addEventListener('click', e => {
    const b = e.target.closest('[data-style]');
    if (!b) return;
    const s = DRUM_STYLES.find(x => x.id === b.dataset.style), d = project.drums;
    snapshot();
    Object.assign(d, s.v);
    const fresh = !ST.drumsDrawn(d);
    if (fresh) d.curve.fill(0.6);
    save();
    syncDrumKnobs();
    updateStyles();
    updateDrumEmpty();
    engine.updateDrums();
    requestRender();
    announce(`${s.label}${fresh ? ', with a flat energy line across the loop' : ''}. Press Play.`);
  });

  function syncDrumKnobs() {
    for (const key in drumKnobs) drumKnobs[key].set(project.drums[key]);
  }
  function updateKeep() {
    const kept = project.drums.seedB != null;
    $('#drum-keep').textContent = kept ? 'Keep again' : 'Keep groove';
    drumKnobs.morph.el.classList.toggle('is-idle', !kept);
    drumKnobs.morph.set(project.drums.morph);
  }

  document.querySelectorAll('input[name="drumtool"]').forEach(r => r.addEventListener('change', () => {
    ui.drumTool = r.value;
    drumCanvas.dataset.tool = r.value;
  }));
  $('#drum-flat').addEventListener('click', () => {
    snapshot();
    project.drums.curve.fill(0.6);
    save();
    updateDrumEmpty();
    requestRender();
    announce('Flat energy line across the whole loop');
  });
  $('#drum-dice').addEventListener('click', () => {
    snapshot();
    project.drums.seed = 1 + Math.floor(Math.random() * 1e6);
    save();
    requestRender();
    announce(project.drums.seedB != null ? 'New groove. Turn Morph to blend back to the kept one.' : 'New groove, same knobs');
  });
  $('#drum-keep').addEventListener('click', () => {
    const d = project.drums;
    snapshot();
    d.seedB = d.seed;
    d.seed = 1 + Math.floor(Math.random() * 1e6);
    d.morph = 100;
    save();
    updateKeep();
    requestRender();
    announce('Groove kept, and still playing. Roll the dice or turn Morph down to hear new grooves; Morph at the top brings the kept one back.');
  });
  $('#drum-clear').addEventListener('click', () => {
    if (!ST.drumsDrawn(project.drums)) return;
    snapshot();
    project.drums.curve.fill(-1);
    save();
    updateDrumEmpty();
    requestRender();
    announce('Energy line cleared, drums are silent. Undo brings it back.');
  });
  $('#drum-freeze').addEventListener('click', () => setFrozen(!project.drums.frozen));
  $('#drum-on').addEventListener('change', e => {
    project.drums.muted = !e.target.checked;
    engine.updateDrums();
    renderLayers();
    save();
    requestRender();
  });
  $('#drum-toggle').addEventListener('click', () => {
    const btn = $('#drum-toggle'), open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    btn.title = open ? 'Hide drums' : 'Show drums';
    $('#drum-body').hidden = !open;
    if (open) measureDrums();
    renderLayers();
    announce(open ? 'Drum strip shown' : 'Drum strip hidden (the drums still play)');
  });

  // MPK drum mode: K1..K8 become the eight macros while it is on.
  function setDrumMpk(on) {
    ui.drumMpk = on;
    if (on && ui.etch.on) setEtch(false);
    $('#drum-mpk').setAttribute('aria-pressed', String(on));
    document.body.classList.toggle('drum-mpk-on', on);
    renderKnobStrip();
    if (on) announce(`Drum mode: ${DRUM_MACROS.map((m, i) => `K${i + 1} ${m.label}`).join(', ')}.`);
    else announce('Drum mode off: the knobs draw again');
  }
  $('#drum-mpk').addEventListener('click', () => setDrumMpk(!ui.drumMpk));

  function refreshDrums() {
    const frozen = !!project.drums.frozen;
    $('#drum-on').checked = !project.drums.muted;
    $('#drum-freeze').setAttribute('aria-pressed', String(frozen));
    $('#drum-freeze').textContent = frozen ? 'Unfreeze' : 'Freeze';
    $('#drum-card').classList.toggle('is-frozen', frozen);
    for (const id of ['#drum-flat', '#drum-dice', '#drum-keep', '#drum-clear']) { $(id).disabled = frozen; $(id).title = frozen ? 'Unfreeze to generate again' : ''; }
    document.querySelectorAll('input[name="drumtool"]').forEach(r => { r.disabled = frozen; });
    $('#drum-empty').hidden = frozen || ST.drumsDrawn(project.drums);
    syncDrumKnobs();
    updateKeep();
    updateStyles();
    updateDrumEmpty();
    engine.updateDrums();
  }

  // ---------- etch mode ----------
  // Like the red drawing toy: two knobs draw one continuous line. Left knob moves
  // in time, right knob in pitch (K1 and K2 on the MPK). You hear the pen as it moves.
  let etchX = null, etchY = null;
  const etchPitch = v => noteName(yToMidi(1 - v, project.scale, current().sound.register));

  function buildEtchKnobs() {
    etchX = createKnob({ label: 'Left · time', min: 0, max: 1, step: 0.002, value: ui.etch.x, reset: 0.05,
      fmt: v => barBeat(v * L()), hint: 'Turn to draw left or right', onInput: v => etchTo(v, ui.etch.y) });
    etchY = createKnob({ label: 'Right · pitch', min: 0, max: 1, step: 0.005, value: 1 - ui.etch.y, reset: 0.5,
      fmt: etchPitch, hint: 'Turn to draw up or down', onInput: v => etchTo(ui.etch.x, 1 - v) });
    $('#etch-x').append(etchX.el);
    $('#etch-y').append(etchY.el);
  }

  function etchTo(x, y) {
    const e = ui.etch, layer = current(), from = [e.x, e.y];
    e.x = clamp01(x);
    e.y = clamp01(y);
    let item = e.id && layer.strokes.find(it => it.id === e.id);
    if (!item) { // first turn: start a new line, selected, with the current knob style
      unhideForDrawing();
      snapshot();
      item = { id: uid(), size: ui.brush, points: [from, [e.x, e.y]] }; // the line starts where the pen was
      const style = ui.brushTf;
      if (style.waves || style.amp || style.tilt || style.gain !== 1) item.tf = { ...style };
      layer.strokes.push(item);
      e.id = item.id;
      ui.sel = { layerId: layer.id, id: item.id };
      renderLayers();
      updateEmpty();
      renderKnobStrip();
    } else {
      const last = item.points[item.points.length - 1];
      if (Math.hypot((e.x - last[0]) * W, (e.y - last[1]) * H) < 1.5) return;
      layer.strokes[layer.strokes.indexOf(item)] = { ...item, points: [...item.points, [e.x, e.y]] };
    }
    if (ui.hear) { // the pen sings while it moves, and stops shortly after you let go
      if (engine.monitor) engine.monitorMove(e.y); else engine.monitorStart(layer, e.y);
      clearTimeout(e.idle);
      e.idle = setTimeout(() => engine.monitorEnd(), 350);
    }
    save();
    requestRender();
  }

  function setEtch(on) {
    const e = ui.etch;
    if (on && ui.drumMpk) setDrumMpk(false);
    e.on = on;
    e.id = null;
    document.body.classList.toggle('etch-on', on);
    $('#etch-bar').hidden = !on;
    $('#etch-toggle').setAttribute('aria-pressed', String(on));
    if (on) {
      etchX.set(e.x);
      etchY.set(1 - e.y);
      announce('Etch mode: turn the left knob for time and the right knob for pitch. On your MPK: K1 and K2.');
    } else {
      engine.monitorEnd();
      announce('Etch mode off');
    }
    renderKnobStrip();
    requestRender();
  }

  $('#etch-toggle').addEventListener('click', () => setEtch(!ui.etch.on));
  $('#etch-lift').addEventListener('click', () => {
    ui.etch.id = null;
    announce('Pen lifted: the next turn starts a new line');
  });
  $('#etch-shake').addEventListener('click', () => {
    const layer = current();
    ui.etch.id = null;
    if (!layer.strokes.length) { announce(`${layer.name} is already clean`); return; }
    snapshot();
    layer.strokes = [];
    ui.sel = null;
    const card = $('.canvas-card');
    card.classList.remove('is-shaking');
    void card.offsetWidth; // restart the animation
    card.classList.add('is-shaking');
    refreshAfterEdit();
    renderKnobStrip();
    announce(`Shaken clean: ${layer.name} is empty. Undo brings it back.`);
  });

  // ---------- shortcuts ----------
  // One list drives both the key handler below and the shortcuts popup (press ?).
  const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const SHORTCUTS = [
    ['Play', [['Space', 'Play or pause (also on the canvas)'], ['Shift Space', 'Play or pause from anywhere'], ['Home', 'Stop all sound, back to the start'],
      ['+  −', 'Faster or slower (Shift: by 10 BPM)'], ['Shift L', 'Loop on or off'], ['Shift R', 'Record on or off'], ['C', 'Metronome on or off'], ['H', 'Hear lines while drawing']]],
    ['Draw', [['V P L R O T S E', 'Select, Pencil, Line, Rectangle, Ellipse, Text, Spray, Eraser'], ['F', 'Shapes: outline or filled'],
      ['[  ]', 'Quieter or louder lines'], ['Q', 'Time snap: off, 1/16, 1/8, 1/4'], ['G', 'Patterns'], ['Arrows', 'Move the pen on the canvas'], ['Enter', 'Start or finish a line on the canvas'], ['Esc', 'Cancel, or deselect']]],
    ['Edit', [[`${MOD} Z`, 'Undo'], [`Shift ${MOD} Z`, 'Redo'], [`${MOD} C`, 'Copy the selected line'], [`${MOD} V`, 'Paste it on the picked layer'], [`${MOD} D`, 'Duplicate the selected line'], ['Alt arrows', 'Nudge the selected line (Shift: bigger steps)'],
      ['Delete', 'Remove the selected line'], ['Double-click', 'Change the words of a text']]],
    ['Layers', [['1 … 8', 'Pick a layer'], ['D', 'Pick the drum layer'], ['N', 'New layer'], ['M', 'Mute the picked layer'], ['Shift S', 'Solo the picked layer']]],
    ['Perform', [['W', 'Perform tab: scenes, macros, keys'], ['Shift 1 … 8', 'Launch a scene (an empty one saves the drawing)'], ['L', 'Learn: link the focused knob, slider or scene to your controller'], ['Right-click', 'On a knob: make it move by itself, or link it to MIDI (also the menu key or Shift F10)'], ['Esc', 'Stop learning or mapping']]],
    ['Windows', [['?', 'These shortcuts'], [`${MOD} ,`, 'Settings'], [`${MOD} S`, 'Save a version'], [`${MOD} E`, 'Export'], ['K', 'MIDI setup']]],
    ['Knobs', [['Arrows', 'Turn the focused knob (Shift: bigger steps)'], ['Home  End', 'Minimum or maximum'], ['L', 'Learn: link the focused knob to a controller knob']]],
  ];
  const keysDlg = $('#keys-dialog');
  $('#keys-body').innerHTML = SHORTCUTS.map(([group, rows]) => `
    <section class="kd-group"><h3>${group}</h3><dl>${rows.map(([k, what]) =>
      `<div class="kd-row"><dt>${k.split(/\s{2}|\s(?=\S)/).filter(Boolean).map(x => `<kbd>${esc(x)}</kbd>`).join(' ')}</dt><dd>${esc(what)}</dd></div>`).join('')}</dl></section>`).join('');
  const openShortcuts = () => { if (!keysDlg.open) keysDlg.showModal(); };
  document.querySelectorAll('[data-open-shortcuts]').forEach(b => b.addEventListener('click', openShortcuts));
  $('#keys-close').addEventListener('click', () => keysDlg.close());
  keysDlg.addEventListener('click', e => { if (e.target === keysDlg) keysDlg.close(); });

  // Nudge the selected item: a 16th in time or a semitone in pitch (Shift: a beat / 4 semitones).
  function nudgeSelected(key, big) {
    const s = selected();
    if (!s) return false;
    const steps = snapUnit() ? Math.round(1 / snapUnit()) : project.bars * 16, n = big ? 4 : 1;
    const d = { ArrowLeft: [-n / steps, 0], ArrowRight: [n / steps, 0], ArrowUp: [0, -n / 36], ArrowDown: [0, n / 36] }[key];
    if (performance.now() - knobUndoAt > 1200) snapshot();
    knobUndoAt = performance.now();
    replaceSelected(it => { const tf = tfOf(it); return { ...it, tf: { ...tf, dx: tf.dx + d[0], dy: tf.dy + d[1] } }; });
    save();
    syncLineBar();
    requestRender();
    speak(describe(selected().item, s.layer));
    return true;
  }
  // Put copies of items on a layer and select them (duplicate, paste).
  function placeCopies(layer, items, shift) {
    const copies = items.map(it => { const tf = tfOf(it); return { ...JSON.parse(JSON.stringify(it)), id: uid(), tf: { ...tf, dx: tf.dx + shift } }; });
    layer.strokes.push(...copies);
    ui.sel = { layerId: layer.id, id: copies[0].id };
    ui.extra = copies.slice(1).map(c => c.id);
    ui.extraFor = ui.sel.id;
    return copies.length;
  }
  function duplicateSelected() {
    const all = selectedItems();
    if (!all.length) { announce('Select a line first, then duplicate it'); return; }
    snapshot();
    const n = placeCopies(all[0].layer, all.map(x => x.item), 1 / (project.bars * 4));
    refreshAfterEdit();
    renderKnobStrip();
    announce(`${n === 1 ? 'Duplicated' : `${n} duplicated`}, one beat later`);
  }
  let clipboard = null;
  function copySelected() {
    const all = selectedItems();
    if (!all.length) { announce('Select a line first, then copy it'); return; }
    clipboard = JSON.parse(JSON.stringify(all.map(x => x.item)));
    announce(`${clipboard.length === 1 ? 'Copied' : `${clipboard.length} copied`}. Pick any layer and paste.`);
  }
  function pasteClipboard() {
    if (!clipboard) { announce('Nothing copied yet'); return; }
    const layer = current();
    unhideForDrawing();
    snapshot();
    placeCopies(layer, clipboard, 0);
    refreshAfterEdit();
    renderKnobStrip();
    announce(`Pasted on ${layer.name}`);
  }
  function toggleLayerFlag(flag) {
    if (ui.drumSel) { drumRowAct(flag === 'muted' ? 'mute' : 'solo'); return; }
    const l = current();
    l[flag] = !l[flag];
    engine.updateAll();
    renderLayers();
    requestRender();
    save();
    announce(`${l.name} ${flag === 'muted' ? (l.muted ? 'muted' : 'unmuted') : (l.solo ? 'solo' : 'solo off')}`);
  }

  // ---------- global keys ----------
  document.addEventListener('keydown', e => {
    const t = e.target, typing = (t.tagName === 'INPUT' && (t.type === 'text' || t.type === 'number')) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
    if (dlg.open || appDlg.open || keysDlg.open || patternDlg.open) return;
    if (e.key === 'Escape' && learning) { cancelLearn(); announce('Learning cancelled'); return; }
    if (e.key === 'Escape' && ui.macroMap != null) { setMacroMap(null); announce('Macro mapping cancelled'); return; }
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    const drawing = ui.pen || ui.draft || ui.spray;
    // letters work anywhere except while typing or on a focused knob (it uses its own keys)
    const free = !typing && !(t.getAttribute && t.getAttribute('role') === 'slider') && !drawing;
    if (mod && k === 'z' && !typing) {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    } else if (mod && k === 'd' && !typing) {
      e.preventDefault();
      duplicateSelected();
    } else if (mod && k === 'c' && !typing && selected() && !window.getSelection().toString()) {
      e.preventDefault();
      copySelected();
    } else if (mod && k === 'v' && !typing && clipboard) {
      e.preventDefault();
      pasteClipboard();
    } else if (mod && k === 's') {
      e.preventDefault();
      if (saveVersion()) announce('Version saved. Find it in Settings, Project.'); else announce('Could not save a version: browser storage is full or blocked');
    } else if (mod && k === 'e') {
      e.preventDefault();
      openAppDialog('export');
    } else if (mod && e.key === ',') {
      e.preventDefault();
      openAppDialog('settings');
    } else if (mod || e.altKey && !e.key.startsWith('Arrow')) {
      // leave other browser shortcuts alone
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && (t === document.body || t === canvas) && selected()) {
      e.preventDefault();
      deleteSelected();
    } else if (e.key === 'Escape' && ui.panel) {
      const id = ui.panel;
      setPanel(null);
      document.querySelector(`.qa-open[data-panel="${id}"]`).focus();
    } else if (e.altKey && e.key.startsWith('Arrow') && free) {
      if (nudgeSelected(e.key, e.shiftKey)) e.preventDefault();
    } else if (e.key === ' ' && (e.shiftKey ? free : t === document.body || t === tl || t === canvas || t === drumCanvas)) {
      e.preventDefault();
      togglePlay();
    } else if (!free) {
      // typing, drawing or on a knob
    } else if (e.key === '?') {
      e.preventDefault();
      openShortcuts();
    } else if (e.key === 'Home' && t !== canvas) {
      e.preventDefault();
      stopAll();
      announce('Stopped, back to the start');
    } else if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
      e.preventDefault();
      setBpm(project.bpm + (e.key === '+' || e.key === '=' ? 1 : -1) * (e.shiftKey ? 10 : 1));
      announce(`${project.bpm} BPM`);
    } else if (e.key === '[' || e.key === ']') {
      const sizes = ['s', 'm', 'l'], i = Math.max(0, Math.min(2, sizes.indexOf(ui.brush) + (e.key === ']' ? 1 : -1)));
      const r = document.querySelector(`input[name="brush"][value="${sizes[i]}"]`);
      r.checked = true;
      r.dispatchEvent(new Event('change'));
      announce(['Quiet', 'Medium', 'Loud'][i]);
    } else if (e.shiftKey && /^Digit[1-8]$/.test(e.code)) {
      e.preventDefault();
      sceneButton(Number(e.code.slice(5)) - 1);
    } else if (k === 'w') {
      setDockTab(ui.dock === 'perform' ? 'drums' : 'perform');
      announce(ui.dock === 'perform' ? 'Perform: scenes, macros and keys' : 'Drums');
    } else if (/^[1-8]$/.test(e.key)) {
      const l = project.layers[Number(e.key) - 1];
      if (l) selectLayer(l.id); else announce(`There is no layer ${e.key}`);
    } else if (e.shiftKey && k === 's') {
      toggleLayerFlag('solo');
    } else if (e.shiftKey && k === 'l') {
      $('#loop').click();
      announce(project.loop ? 'Loop on' : 'Loop off');
    } else if (e.shiftKey && k === 'r') {
      $('#record').click();
    } else if (k === 'd') {
      selectDrums();
    } else if (k === 'm') {
      toggleLayerFlag('muted');
    } else if (k === 'n') {
      $('#add-layer').click();
    } else if (k === 'h') {
      hearBtn.click();
    } else if (k === 'g') {
      setPatternOpen(true);
    } else if (k === 'k') {
      $('#midi-btn').click();
    } else if (k === 'c') {
      metroBtn.click();
    } else if (k === 'q') {
      const order = ['off', '1/16', '1/8', '1/4'], next = order[(order.indexOf(project.snap || 'off') + 1) % order.length];
      setSnap(next);
      announce(next === 'off' ? 'Snap off: draw freely in time' : `Snap to ${next} notes`);
    } else if (TOOLS.some(x => x.key === k) || k === 'f') {
      if (k === 'f') {
        setFill(!ui.fill);
        if (ui.tool !== 'rect' && ui.tool !== 'ellipse') setTool('rect', true);
        announce(ui.fill ? 'Filled shapes' : 'Outline shapes');
      } else {
        setTool(TOOLS.find(x => x.key === k).id);
      }
    }
  });

  // ---------- refresh ----------
  function updateEmpty() {
    $('#empty-hint').hidden = hasStrokes() || !!ui.pen || ui.patternOpen || !!ui.textEntry;
  }
  function refreshAfterEdit() {
    save();
    renderLayers();
    updateEmpty();
    updateUndo();
    requestRender();
  }
  function refreshAll() {
    nameInput.value = project.name;
    $('#bpm').value = project.bpm;
    $('#scale').value = project.scale;
    $('#key').value = String(project.key || 0);
    ST.setRootKey(project.key || 0);
    $('#loop').checked = project.loop;
    $('#bars').value = String(project.bars);
    $('#snap').value = project.snap || 'off';
    updateCanvasPos();
    renderLayers();
    renderReadPanel();
    updateCards();
    if (ui.panel) buildPanel();
    updateEmpty();
    updateUndo();
    updateTransport();
    updateTimelineAria();
    updateReadout(ui.startPos);
    refreshDrums();
    buildQuick();
    if (ui.dock === 'perform') renderPerform();
    requestRender();
  }

  // Light by default; the moon button switches to dark and remembers it.
  const themeBtn = $('#theme-btn');
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    themeBtn.setAttribute('aria-pressed', String(t === 'dark'));
    themeBtn.title = t === 'dark' ? 'Light mode' : 'Dark mode';
    try { localStorage.setItem('sketchtone.theme', t); } catch (e) { /* storage unavailable */ }
    readTheme();
    requestRender();
  }
  themeBtn.setAttribute('aria-pressed', String(document.documentElement.dataset.theme === 'dark'));
  themeBtn.addEventListener('click', () => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    announce(document.documentElement.dataset.theme === 'dark' ? 'Dark mode' : 'Light mode');
  });
  window.addEventListener('pagehide', persist);

  readTheme();
  applyPrefs();
  setDockTab(['drums', 'sound', 'mix', 'perform'].includes(dockPref.tab) ? dockPref.tab : 'drums');
  if (dockPref.collapsed) setDockCollapsed(true);
  setMetronome(!!prefs.metronome);
  setSaveStatus('saved', hasMusic() ? 'Saved' : '');
  buildCards();
  buildEtchKnobs();
  buildDrumKnobs();
  buildLineBar();
  setTool(ui.tool, true);
  refreshAll();
  renderMidiStatus();
  midi.autoConnect();
})(window.ST);
