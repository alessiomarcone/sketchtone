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
      strokes: [],
    };
  }

  function newProject() {
    const layer = makeLayer(1);
    return { name: 'Untitled sketch', bpm: 122, bars: 4, scale: 'pentatonic', loop: true, layerCount: 1, selected: layer.id, layers: [layer], drums: ST.defaultDrums() };
  }

  function normalize(p) {
    const base = newProject();
    for (const k of ['bpm', 'bars', 'scale', 'loop', 'name', 'layerCount']) if (p[k] === undefined) p[k] = base[k];
    p.drums = ST.migrateDrums(p.drums);
    const fxBase = defaultFx();
    p.layers.forEach(l => {
      l.sound = { ...DEFAULT_SOUND, ...l.sound };
      l.fx = l.fx || {};
      for (const id in fxBase) l.fx[id] = { ...fxBase[id], ...l.fx[id] };
      l.read = { mode: 'normal', divisions: 8, seed: 7, ...l.read };
      l.solo = !!l.solo;
      l.hidden = !!l.hidden;
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
  let project = wantsDemo && !(saved && saved.layers.some(l => l.strokes.length)) ? normalize(demoProject()) : saved || newProject();
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
  const presetLabel = l => (PRESETS[l.preset] ? PRESETS[l.preset].label : 'Custom sound');
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
    // beat and bar lines
    for (let b = 1; b < beats; b++) {
      const x = Math.round(b / beats * W) + 0.5;
      c.strokeStyle = b % 4 === 0 ? theme['grid-strong'] : theme.grid;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
    }
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
    if (ui.pen) drawItem(ui.pen, sel.color, 1, false);
    if (ui.draft) drawItem(draftItem(ui.draft), sel.color, 0.85, false);
    if (ui.spray) drawItem(ui.spray.item, sel.color, 1, false);
    const picked = selected();
    if (picked && !picked.layer.hidden && !ui.pen && !ui.draft) drawSelection(picked.item);

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
    { key: 'dx', label: 'X', min: -1, max: 1, step: 0.0025, fmt: beatsFmt },
    { key: 'dy', label: 'Y', min: -1, max: 1, step: 1 / 72, fmt: semisFmt, invert: true },
    { key: 'waves', label: 'Sub num', min: 0, max: 24, step: 1, fmt: v => `${v} ${v === 1 ? 'wave' : 'waves'}`, style: true },
    { key: 'amp', label: 'Amplitude', min: 0, max: 0.3, step: 0.002, fmt: v => `±${(v * 36).toFixed(1)} st`, style: true },
    { key: 'sx', label: 'Stretch X', min: 0.1, max: 3, step: 0.01, fmt: v => `×${v.toFixed(2)}` },
    { key: 'sy', label: 'Stretch Y', min: -2, max: 3, step: 0.01, fmt: v => `×${v.toFixed(2)}${v < 0 ? ' (flipped)' : ''}` },
    { key: 'tilt', label: 'Tilt', min: -1, max: 1, step: 0.01, fmt: v => (Math.round(v * 36) ? `end ${semisFmt(v)}` : 'flat'), invert: true, style: true },
    { key: 'gain', label: 'Loudness', min: 0.2, max: 1.6, step: 0.01, fmt: v => `×${v.toFixed(2)}`, style: true },
  ];

  function selected() {
    if (!ui.sel) return null;
    const layer = project.layers.find(l => l.id === ui.sel.layerId);
    const item = layer && layer.strokes.find(it => it.id === ui.sel.id);
    return item ? { layer, item } : null;
  }

  // Items are replaced, never mutated, so cached geometry and notes stay valid.
  function replaceSelected(fn) {
    const s = selected();
    if (!s) return;
    s.layer.strokes[s.layer.strokes.indexOf(s.item)] = fn(s.item);
  }

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

  function selectAt(p) {
    const hit = itemAt(p);
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

  function moveSelected(p) {
    const m = ui.moving;
    if (!m.moved) { snapshot(); m.moved = true; }
    replaceSelected(it => ({ ...it, tf: { ...m.tf0, dx: m.tf0.dx + p[0] - m.start[0], dy: m.tf0.dy + p[1] - m.start[1] } }));
    save();
    syncLineBar();
    requestRender();
  }

  function deleteSelected() {
    const s = selected();
    if (!s) return;
    snapshot();
    s.layer.strokes = s.layer.strokes.filter(it => it !== s.item);
    ui.sel = null;
    refreshAfterEdit();
    renderKnobStrip();
    announce('Deleted. Undo brings it back.');
  }

  let knobUndoAt = 0;
  function setDraw(key, v, style) {
    if (style) ui.brushTf[key] = v;
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
        <span class="lb-kicker" id="lb-title">Line</span>
        <span class="lb-target" id="lb-target"></span>
        <button type="button" class="dev-btn lb-reset" id="lb-reset">Reset</button>
      </div>
      <div class="lb-knobs"></div>`;
    for (const d of DRAW_KNOBS) {
      const sign = d.invert ? -1 : 1;
      const k = createKnob({
        label: d.label, min: d.min, max: d.max, step: d.step, value: sign * TF_IDENTITY[d.key], reset: sign * TF_IDENTITY[d.key], fmt: d.fmt,
        hint: d.style ? 'Shapes the selected line, and the next lines you draw' : 'Shapes the selected line',
        onInput: v => {
          if (!selected() && !d.style) { announce('Select a line first (press V and click it), then turn this knob'); syncLineBar(); return; }
          setDraw(d.key, sign * v, d.style);
        },
      });
      k.el.dataset.path = `draw.${d.key}`;
      lineKnobs[d.key] = k;
      host.querySelector('.lb-knobs').append(k.el);
    }
    syncLineBar();
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
    $('#lb-target').textContent = s ? `${toolOf(itemTool(s.item)).label} on ${s.layer.name}` : 'New lines · select one to move or stretch it';
    for (const d of DRAW_KNOBS) {
      lineKnobs[d.key].set((d.invert ? -1 : 1) * tf[d.key]);
      lineKnobs[d.key].el.classList.toggle('is-idle', !s && !d.style);
    }
    $('#lb-reset').disabled = s ? !ST.hasTf(s.item) : isStyleDefault();
  }

  function drawSelection(it) {
    const c = c2d, pts = ST.itemPoints(it);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const pad = 8 + (LINE_WIDTH[it.size] || 6) / 2;
    const X0 = x0 * W - pad, Y0 = y0 * H - pad, X1 = x1 * W + pad, Y1 = y1 * H + pad;
    c.strokeStyle = theme.accent;
    c.fillStyle = theme.accent;
    c.lineWidth = 1.5;
    c.setLineDash([5, 4]);
    c.strokeRect(X0, Y0, X1 - X0, Y1 - Y0);
    c.setLineDash([]);
    for (const [x, y] of [[X0, Y0], [X1, Y0], [X0, Y1], [X1, Y1]]) c.fillRect(x - 3, y - 3, 6, 6);
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

  function commitItem(item) {
    const layer = current(), style = ui.brushTf;
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
      const hit = selectAt(p);
      if (hit) ui.moving = { start: p, tf0: tfOf(hit.item), moved: false };
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
    if (ui.pen && !ui.penKb) {
      const pts = ui.pen.points, last = pts[pts.length - 1];
      if (Math.hypot((p[0] - last[0]) * W, (p[1] - last[1]) * H) >= 2) {
        pts.push(p);
        engine.monitorMove(p[1]);
      }
    } else if (ui.draft && !ui.draft.kb) {
      moveDraft(p, e.shiftKey);
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
  canvas.addEventListener('pointerleave', () => { ui.hover = null; requestRender(); });

  // Keyboard drawing: arrows move the cursor, Space/Enter acts with the current tool.
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
    } else if (e.key === ' ' || e.key === 'Enter') {
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
        else { startDraft(p, true); speak('Start point set. Move with the arrow keys, press Space to finish, Escape to cancel.'); }
      } else if (ui.pen) {
        commitPen();
      } else {
        startPen(p, true);
        speak('Pen down. Move with the arrow keys, press Space to finish, Escape to cancel.');
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
  const tabs = [$('#tab-layers'), $('#tab-timeline'), $('#tab-keys')];
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
    if (which === 'keys') { renderPiano(); renderKeyDetail(); }
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
  }

  const drumKitLabel = d => (d.preset === 'custom' ? 'Custom kit' : (ST.DRUM_KITS.find(k => k.id === d.preset) || { label: 'Kit' }).label);
  function drumMeta() {
    const d = project.drums, style = ST.DRUM_STYLES.find(s => Object.entries(s.v).every(([k, v]) => d[k] === v));
    return `${drumKitLabel(d)} · ${ST.drumsDrawn(d) ? (style ? style.label : 'your groove') : 'no energy line yet'}`;
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
          <input type="range" class="vol" min="0" max="100" value="${Math.round(d.volume * 100)}" data-act="volume" data-id="drums" data-focus-key="vol-drums" aria-label="Drums volume">
        </div>
      </li>`;
  }
  const updateDrumMeta = () => { const m = layerList.querySelector('.drum-layer .layer-meta'); if (m) m.textContent = drumMeta(); };

  // Selecting the drum layer points the sound cards (Source, ADSR, FX) at the drums.
  function selectDrums() {
    ui.drumSel = true;
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
  layerList.addEventListener('input', e => {
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
      if (kind === 'fx') k.el.classList.toggle('is-off', !l.fx[id].on);
    }
  }

  // Three quick knobs on every card, always the same ones (like the fixed MPK map).
  const QUICK = {
    source: () => (ui.drumSel ? ['tune', 'tone', 'punch'] : ['brightness', 'sub', 'noise']).map(k => ['sound', k]),
    envelope: () => (ui.drumSel ? ['attack', 'hold', 'length'] : ['attack', 'decay', 'release']).map(k => ['sound', k]),
    soundfx: () => [['fx', 'filter', 'cutoff'], ['fx', 'drive', 'amount'], ['fx', 'comp', 'amount']],
    timefx: () => [['fx', 'echo', 'amount'], ['fx', 'reverb', 'amount'], ['fx', 'chorus', 'amount']],
    voice: () => (ui.drumSel ? [] : ['tune', 'formant', 'robot'].map(k => ['vox', k])),
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
        const fx = path[0] === 'fx' && FX_BY_ID[path[1]];
        const reset = fx ? fx.defaults[path[2]] : (ui.drumSel ? ST.DRUM_SOUND : DEFAULT_SOUND)[path[1]];
        const k = createKnob({
          label: fx ? fx.label : d.short || d.label, min: d.min, max: d.max, step: d.step, value: d.get(), reset, fmt: d.fmt,
          hint: `${d.hint || ''}${fx ? ' Turning it switches the effect on.' : ''} (${who})`, onInput: v => d.set(v),
        });
        k.el.classList.add('knob-mini');
        quickControls.set(pathKey(path), k);
        host.append(k.el);
      }
    });
    updateCards();
  }
  const refreshQuick = () => { for (const [key, k] of quickControls) k.set(paramDef(key.split('.')).get()); };

  function setPanel(id) {
    ui.panel = id;
    document.body.classList.toggle('panel-open', !!id);
    $('#panel').hidden = !id;
    updateCards();
    if (id) buildPanel();
    else { panelControls.clear(); renderKnobStrip(); }
  }

  $('#qa-cards').addEventListener('click', e => {
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
        </div>`;
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
  function setFx(id, key, value, sets) {
    const l = target(), p = l.fx[id];
    p[key] = value;
    const q = quickControls.get(`fx.${id}.${key}`);
    if (q) q.set(value);
    if (sets) {
      Object.assign(p, sets);
      for (const k in sets) {
        const r = document.querySelector(`#panel input[name="fx-${id}-${k}"][value="${sets[k]}"]`);
        if (r) r.checked = true;
      }
    }
    if (!p.on) { p.on = true; refreshFxState(id); announce(`${FX_BY_ID[id].label} on`); }
    if (!isDrums(l)) markCustom(l); // drum kits only set the sound, not the FX
    engine.updateLayer(l);
    updateCards();
    save();
  }

  const voxOf = l => ({ ...ST.VOX_DEFAULT, ...l.sound.vox });
  // Voice FX live on the layer; a word that is sounding restarts with the new voice.
  function setVox(key, value) {
    const l = target();
    if (isDrums(l)) return;
    l.sound.vox = { ...voxOf(l), [key]: value };
    const q = quickControls.get(`vox.${key}`);
    if (q) q.set(value);
    updateCards();
    save();
  }

  function setSound(key, value) {
    const l = target();
    l.sound[key] = value;
    const q = quickControls.get(`sound.${key}`);
    if (q) q.set(value);
    markCustom(l);
    engine.updateLayer(l);
    updateCards();
    const graph = document.querySelector('#panel .env-graph path');
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
    if (name === 'wave' || name === 'register') {
      setSound(name, value);
      engine.preview(target());
    }
  });

  // ---------- transport ----------
  const playBtn = $('#play');
  function barBeat(t) {
    const beat = Math.floor(t / beatSec() + 1e-6);
    return `bar ${Math.floor(beat / 4) + 1} beat ${beat % 4 + 1}`;
  }
  function updateTransport() {
    const state = engine.playing ? 'playing' : ui.pausedAt != null ? 'paused' : 'stopped';
    playBtn.classList.toggle('is-playing', state === 'playing');
    playBtn.innerHTML = `${state === 'playing' ? ICON.pause : ICON.play}<span>${state === 'playing' ? 'Pause' : state === 'paused' ? 'Resume' : 'Play'}</span>`;
  }
  function updateReadout(t) {
    const beat = Math.floor(t / beatSec() + 1e-6);
    $('#readout').textContent = `${Math.floor(beat / 4) + 1}.${beat % 4 + 1} / ${project.bars}`;
  }

  function frame() {
    if (!engine.playing) return;
    const p = engine.position();
    if (p.done) { finishPlayback(); return; }
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
    updateTransport();
    requestRender();
  }
  function stopAll() { // the panic button: everything silent, nothing left held
    stopRecording();
    engine.stop();
    engine.monitorEnd();
    engine.setBend(0);
    ui.held = [];
    applyHeld(); // drops any key FX at once (nothing is playing, so no beat to wait for)
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
  $('#scale').addEventListener('change', e => {
    project.scale = e.target.value;
    save();
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
    let label = 'Record';
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
  const APP_VERSION = '1.0.0';
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
    return `${project.layers.length} ${project.layers.length === 1 ? 'layer' : 'layers'}, ${lines} ${lines === 1 ? 'item' : 'items'} · ${project.bars} ${project.bars === 1 ? 'bar' : 'bars'} at ${project.bpm} BPM (${secs.toFixed(1)} s loop) · drums ${ST.drumsDrawn(project.drums) && !project.drums.muted ? 'on' : 'off'}`;
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
    project = newProject();
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

  function setVolume(v) {
    const l = current();
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

  function paramDef(path) {
    const [kind, a, b] = path, l = current();
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
    if (kind === 'volume') return { label: 'Volume', min: 0, max: 1, step: 0.01, fmt: v => `${Math.round(v * 100)}%`, get: () => l.volume, set: setVolume };
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
      if (isDrums(target())) return { label: `Voice ${k.label.toLowerCase()}`, idle: 'the drum layer has no voice' };
      return { ...k, short: k.label, label: `Voice ${k.label.toLowerCase()}`, get: () => voxOf(target())[a], set: v => { setVox(a, v); syncControl(path, v); } };
    }
    if (kind === 'sound' && isDrums(target())) {
      const k = ST.DRUM_PANELS.source.concat(ST.DRUM_PANELS.envelope).find(x => x.key === a);
      if (!k) return { label: (SOUND_KNOBS[a] || { label: a }).label, idle: 'not used by the drum layer' };
      return { ...k, short: k.label, label: `Drums ${k.label.toLowerCase()}`, get: () => project.drums.sound[a], set: v => { setSound(a, v); syncControl(path, v); } };
    }
    if (kind === 'sound') {
      const set = v => { setSound(a, v); syncControl(path, v); };
      if (a === 'wave') return choiceDef('Waveform', WAVES.map(w => [w.id, w.label]), () => l.sound.wave, set);
      if (a === 'register') return choiceDef('Pitch range', REGISTERS.map(r => [r.id, r.label]), () => l.sound.register, set);
      return { ...SOUND_KNOBS[a], get: () => l.sound[a], set };
    }
    if (kind === 'fx') {
      const l = target(), f = FX_BY_ID[a], c = f.params.find(p => p.key === b);
      const label = c.label.toLowerCase() === f.label.toLowerCase() ? f.label : `${f.label} ${c.label.toLowerCase()}`;
      const set = v => { setFx(a, b, v, c.sets); syncControl(path, v); };
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
  const raw = Array(8).fill(null), acc = Array(8).fill(0);
  function applyMove(k, move) {
    if (learning) { finishLearn(k); return; }
    const path = knobTargets()[k];
    if (!path) { showHud(k, 'Not used on this page', '', null); return; }
    const d = paramDef(path), key = pathKey(path) + (path[0] === 'draw' && ui.sel ? `:${ui.sel.id}` : '');
    if (d.idle) { showHud(k, d.label, d.idle, null); return; }
    if (d.discrete) {
      const opts = d.options, i = Math.max(0, opts.findIndex(o => o[0] === d.get()));
      let n = i;
      if (move.abs != null) {
        n = Math.round(move.abs * (opts.length - 1));
      } else {
        const ticks = path[0] === 'page' ? 10 : 6; // pages need a firmer turn
        acc[k] += move.delta * 127;
        while (acc[k] >= ticks) { n++; acc[k] -= ticks; }
        while (acc[k] <= -ticks) { n--; acc[k] += ticks; }
        n = Math.max(0, Math.min(opts.length - 1, n));
      }
      if (n !== i) d.set(opts[n][0]);
      if (opts.length < 2) showHud(k, d.label, `${opts[n][1]} (only one: add more)`, null);
      else showHud(k, d.label, opts[n][1], n / (opts.length - 1));
    } else {
      const range = d.max - d.min, cur = d.get();
      const r = raw[k];
      let v = r && r.key === key && Math.abs(r.v - cur) <= d.step ? r.v : cur;
      v = move.abs != null ? d.min + move.abs * range : v + move.delta * range;
      v = Math.min(d.max, Math.max(d.min, v));
      raw[k] = { key, v };
      const dec = (String(d.step).split('.')[1] || '').length;
      const snapped = +(Math.round((v - d.min) / d.step) * d.step + d.min).toFixed(dec);
      if (snapped !== cur) d.set(snapped);
      showHud(k, d.label, d.fmt(snapped), (snapped - d.min) / range);
    }
    const cell = document.querySelector(`#ks-list li[data-k="${k}"]`);
    if (cell) { cell.classList.add('is-hot'); clearTimeout(cell._t); cell._t = setTimeout(() => cell.classList.remove('is-hot'), 350); }
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
    const special = ui.drumMpk || ui.patternOpen || ui.etch.on || Object.keys(midi.settings.pins).length > 0;
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
    targets.forEach((path, k) => {
      if (!path) return;
      const el = document.querySelector(`#panel [data-path="${pathKey(path)}"], #drum-card [data-path="${pathKey(path)}"], #line-bar [data-path="${pathKey(path)}"]`);
      if (!el) return;
      const badge = document.createElement('span');
      badge.className = `k-badge${midi.settings.pins[k] ? ' is-pinned' : ''}`;
      badge.textContent = `K${k + 1}`;
      badge.setAttribute('aria-hidden', 'true');
      (el.querySelector(':scope > .knob-label, :scope > legend') || el).append(badge);
    });
  }

  // Pinning: press L on a focused knob (or Alt-click it), then turn a controller knob.
  let learning = null;
  function startLearn(el) {
    const host = el.closest('[data-path]');
    if (!host) return;
    cancelLearn();
    if (!midi.status.connected) midi.connect();
    learning = { path: host.dataset.path.split('.'), el: host };
    host.classList.add('is-learning');
    announce(`Turn a knob on your controller to pin it to ${paramDef(learning.path).label}. Escape cancels.`);
  }
  function finishLearn(k) {
    const path = learning.path, key = pathKey(path), label = paramDef(path).label;
    for (const j in midi.settings.pins) if (pathKey(midi.settings.pins[j]) === key) delete midi.settings.pins[j];
    midi.settings.pins[k] = path;
    midi.save();
    cancelLearn();
    renderKnobStrip();
    renderPins();
    showHud(k, label, 'pinned', null);
    announce(`K${k + 1} now controls ${label} on every page`);
  }
  function cancelLearn() {
    if (!learning) return;
    learning.el.classList.remove('is-learning');
    learning = null;
  }
  panelEl.addEventListener('keydown', e => {
    if ((e.key === 'l' || e.key === 'L') && !e.metaKey && !e.ctrlKey && !e.altKey && e.target.closest('.knob')) {
      e.preventDefault();
      startLearn(e.target);
    }
  });
  panelEl.addEventListener('pointerdown', e => {
    if (!e.altKey || !e.target.closest('.knob')) return;
    e.preventDefault();
    e.stopPropagation();
    startLearn(e.target);
  }, true);

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
  function renderPins() {
    const pins = Object.entries(midi.settings.pins);
    $('#md-pins').innerHTML = pins.length
      ? pins.map(([k, path]) => `<li><b>K${+k + 1}</b><span>${esc(paramDef(path).label)}</span><button type="button" class="btn btn-small" data-unpin="${k}">Unpin</button></li>`).join('')
      : '<li class="md-empty">No pinned knobs yet.</li>';
  }
  function renderDialog() {
    renderMidiStatus();
    renderSetup(null);
    renderPins();
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
  dlg.addEventListener('change', e => {
    const st = midi.settings;
    if (e.target.name === 'md-mode') st.mode = e.target.value;
    else if (e.target.name === 'md-speed') st.speed = Number(e.target.value);
    else return;
    midi.save();
    renderKnobStrip();
  });
  dlg.addEventListener('click', e => {
    const unpin = e.target.closest('[data-unpin]');
    if (!unpin) return;
    delete midi.settings.pins[unpin.dataset.unpin];
    midi.save();
    renderPins();
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
    const top = [...ui.held].reverse().find(n => fxForKey(n));
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
  function keyDown(note) {
    if (!ui.held.includes(note)) ui.held.push(note);
    ui.keySel = note;
    if (note < ui.keyBase || note > ui.keyBase + 24) ui.keyBase = Math.max(0, Math.floor(note / 12) * 12);
    const p = fxForKey(note);
    showHud(noteName(note), keyFx[note] ? 'Key FX' : p ? 'Default FX' : 'Empty key', p ? fxNames(p.fx) : 'save FX to it, or a default, in the Keys tab', null);
    applyHeld();
    renderKeyDetail();
  }
  function keyUp(note) {
    ui.held = ui.held.filter(n => n !== note);
    applyHeld();
  }
  midi.on('key', (note, vel, on) => (on ? keyDown(note) : keyUp(note)));

  // On-screen keyboard (Keys tab): one tab stop, arrows move between keys.
  const BLACK = [1, 3, 6, 8, 10];
  function renderPiano() {
    const base = ui.keyBase, whites = 15, out = [];
    let wi = 0;
    for (let n = base; n <= base + 24; n++) {
      const black = BLACK.includes(n % 12), has = !!keyFx[n], sel = n === ui.keySel;
      const left = black ? (wi / whites) * 100 - 100 / whites * 0.32 : (wi / whites) * 100;
      out.push(`<button type="button" class="pk ${black ? 'pk-black' : 'pk-white'}${has ? ' has-fx' : ''}${ui.held.includes(n) ? ' is-held' : ''}"
        data-note="${n}" tabindex="${sel ? 0 : -1}" aria-pressed="${sel}" style="left:${left.toFixed(3)}%"
        aria-label="${noteName(n)}${has ? `, ${esc(fxNames(keyFx[n].fx))}` : ', empty'}">${n % 12 === 0 ? `<span>${noteName(n)}</span>` : ''}</button>`);
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
    if (k) selectKey(Number(k.dataset.note));
  });
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
    snapshot();
    ui.drumPen = { last: p, x0: p[0], x1: p[0] };
    paintCurve(p, p, ui.drumTool === 'gap');
    save();
    updateDrumEmpty();
    requestRender();
  });
  drumCanvas.addEventListener('pointermove', e => {
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
  // there, Delete makes a gap, Space puts the line back.
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
    } else if (e.key === ' ' || e.key === 'Enter') {
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
    $('#drum-on').checked = !project.drums.muted;
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
    ['Play', [['Space', 'Play or pause'], ['Shift Space', 'Play or pause, even on the canvas'], ['Home', 'Stop all sound, back to the start'],
      ['+  −', 'Faster or slower (Shift: by 10 BPM)'], ['Shift L', 'Loop on or off'], ['Shift R', 'Record on or off'], ['C', 'Metronome on or off'], ['H', 'Hear lines while drawing']]],
    ['Draw', [['V P L R O T S E', 'Select, Pencil, Line, Rectangle, Ellipse, Text, Spray, Eraser'], ['F', 'Shapes: outline or filled'],
      ['[  ]', 'Quieter or louder lines'], ['G', 'Patterns'], ['Arrows', 'Move the pen on the canvas'], ['Space', 'Start or finish a line on the canvas'], ['Esc', 'Cancel, or deselect']]],
    ['Edit', [[`${MOD} Z`, 'Undo'], [`Shift ${MOD} Z`, 'Redo'], [`${MOD} C`, 'Copy the selected line'], [`${MOD} V`, 'Paste it on the picked layer'], [`${MOD} D`, 'Duplicate the selected line'], ['Alt arrows', 'Nudge the selected line (Shift: bigger steps)'],
      ['Delete', 'Remove the selected line'], ['Double-click', 'Change the words of a text']]],
    ['Layers', [['1 … 8', 'Pick a layer'], ['D', 'Pick the drum layer'], ['N', 'New layer'], ['M', 'Mute the picked layer'], ['Shift S', 'Solo the picked layer']]],
    ['Windows', [['?', 'These shortcuts'], [`${MOD} ,`, 'Settings'], [`${MOD} S`, 'Save a version'], [`${MOD} E`, 'Export'], ['K', 'MIDI setup']]],
    ['Knobs', [['Arrows', 'Turn the focused knob (Shift: bigger steps)'], ['Home  End', 'Minimum or maximum'], ['L', 'Pin the focused knob to a controller knob']]],
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
    const steps = project.bars * 16, n = big ? 4 : 1;
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
  function duplicateSelected() {
    const s = selected();
    if (!s) { announce('Select a line first, then duplicate it'); return; }
    snapshot();
    const tf = tfOf(s.item), copy = { ...JSON.parse(JSON.stringify(s.item)), id: uid(), tf: { ...tf, dx: tf.dx + 1 / (project.bars * 4) } };
    s.layer.strokes.push(copy);
    ui.sel = { layerId: s.layer.id, id: copy.id };
    refreshAfterEdit();
    renderKnobStrip();
    announce('Duplicated, one beat later');
  }
  let clipboard = null;
  function copySelected() {
    const s = selected();
    if (!s) { announce('Select a line first, then copy it'); return; }
    clipboard = JSON.parse(JSON.stringify(s.item));
    announce('Copied. Pick any layer and paste.');
  }
  function pasteClipboard() {
    if (!clipboard) { announce('Nothing copied yet'); return; }
    const layer = current();
    unhideForDrawing();
    snapshot();
    const item = { ...JSON.parse(JSON.stringify(clipboard)), id: uid() };
    layer.strokes.push(item);
    ui.sel = { layerId: layer.id, id: item.id };
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
    if (e.key === 'Escape' && learning) { cancelLearn(); announce('Pinning cancelled'); return; }
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
    } else if (e.key === ' ' && (e.shiftKey ? free : t === document.body || t === tl)) {
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
    $('#loop').checked = project.loop;
    $('#bars').value = String(project.bars);
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
