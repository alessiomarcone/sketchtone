// Audio engine: pitch mapping, read modes, layer buses with FX chains,
// the loop scheduler, live recording and WAV export.
(function (ST) {
  'use strict';

  const { FX_BY_ID, FX_CHAIN, DIVS, SCALES, loadWorklet, impulse, itemPoints, voices, drumHits, drumHit, playDrumHit, makeDrumBus, configureDrumBus } = ST;

  const LOW_MIDI = 48;  // C3 at the bottom of the canvas
  const HIGH_MIDI = 84; // C6 at the top
  const REGISTER = { low: -12, mid: 0, high: 12 };
  const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const MIN_NOTE = 0.12; // seconds, so a single tap still makes a blip
  const LOUDNESS = { s: 0.3, m: 0.55, l: 0.85 };
  const LOOKAHEAD = 0.25;
  const SCALE_STEPS = Object.fromEntries(SCALES.map(s => [s.id, s.steps]));

  const clamp01 = v => Math.min(1, Math.max(0, v));
  const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);
  const noteName = m => {
    const r = Math.round(m);
    return NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
  };
  const cutoff = b => 150 * Math.pow(120, b / 100); // 150 Hz .. 18 kHz
  const loopLength = p => p.bars * 4 * 60 / p.bpm;
  const isSnapped = scale => !!SCALE_STEPS[scale];
  // Root key (0 = C … 11 = B): every scale is built on it. Set from the project.
  let rootKey = 0;
  const setRootKey = k => { rootKey = ((Math.round(k) % 12) + 12) % 12; };

  function snapTo(m, steps) {
    let best = Math.round(m), bestD = Infinity;
    const oct = Math.floor(m / 12);
    for (let o = oct - 1; o <= oct + 1; o++) {
      for (const s of steps) {
        const n = o * 12 + s, d = Math.abs(n - m);
        if (d < bestD) { bestD = d; best = n; }
      }
    }
    return best;
  }

  function yToMidi(y, scale, register) {
    const m = LOW_MIDI + (1 - clamp01(y)) * (HIGH_MIDI - LOW_MIDI);
    const steps = SCALE_STEPS[scale];
    return (steps ? snapTo(m - rootKey, steps) + rootKey : m) + (REGISTER[register] || 0);
  }

  // Guide lines for the canvas: every scale note, or just octaves for theremin.
  function pitchLines(scale) {
    const steps = SCALE_STEPS[scale] || [0], out = [];
    for (let m = LOW_MIDI; m <= HIGH_MIDI; m++) {
      const deg = (((m - rootKey) % 12) + 12) % 12;
      if (steps.includes(deg)) out.push({ y: 1 - (m - LOW_MIDI) / (HIGH_MIDI - LOW_MIDI), midi: m, isC: deg === 0 }); // isC: the root note
    }
    return out;
  }

  const spanCache = new WeakMap();
  function strokeSpan(stroke) {
    let s = spanCache.get(stroke);
    if (!s) {
      let x0 = Infinity, x1 = -Infinity;
      for (const p of itemPoints(stroke)) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; }
      s = [x0, x1];
      spanCache.set(stroke, s);
    }
    return s;
  }

  // Turn a freehand stroke into a note: start, length and a pitch curve
  // sampled along x. Where a stroke doubles back, the part drawn last wins.
  const noteCache = new WeakMap();
  function strokeToNote(stroke, length, scale, register) {
    const key = `${length}|${scale}|${register}|${rootKey}`;
    const hit = noteCache.get(stroke);
    if (hit && hit.key === key) return hit.note;
    const pts = stroke.points;
    const [x0, x1] = strokeSpan(stroke);
    const span = x1 - x0;
    const dur = Math.max(stroke.short ? 0.08 : MIN_NOTE, span * length);
    const n = Math.max(2, Math.ceil(dur * 60) + 1);
    const ys = new Array(n).fill(NaN);
    if (span < 1e-6) {
      ys.fill(pts.reduce((a, p) => a + p[1], 0) / pts.length);
    } else {
      const idx = x => (x - x0) / span * (n - 1);
      for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[i];
        const ia = idx(a[0]), ib = idx(b[0]);
        const lo = Math.ceil(Math.min(ia, ib)), hi = Math.floor(Math.max(ia, ib));
        for (let k = lo; k <= hi; k++) ys[k] = ib === ia ? b[1] : a[1] + (b[1] - a[1]) * (k - ia) / (ib - ia);
      }
      let last = NaN;
      for (let k = 0; k < n; k++) { if (isNaN(ys[k])) ys[k] = last; else last = ys[k]; }
      for (let k = n - 2; k >= 0; k--) if (isNaN(ys[k])) ys[k] = ys[k + 1];
    }
    const times = [], midis = [];
    for (let k = 0; k < n; k++) {
      times.push(k / (n - 1) * dur);
      midis.push(yToMidi(ys[k], scale, register));
    }
    const note = { start: x0 * length, dur, times, midis, snap: isSnapped(scale), peak: (LOUDNESS[stroke.size] || LOUDNESS.m) * (stroke.gain || 1) };
    if (stroke.text) Object.assign(note, { text: stroke.text, voice: stroke.voice || 'mid' });
    noteCache.set(stroke, { key, note });
    return note;
  }

  // ---------- read modes ----------
  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // For each output slot, which source slice plays there (-1 = silent).
  function sliceOrder(read) {
    const N = read.divisions, rand = mulberry32(read.seed || 1);
    if (read.mode === 'random') {
      const perm = [...Array(N).keys()];
      for (let i = N - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
      if (perm.every((v, i) => v === i)) perm.push(perm.shift());
      return perm;
    }
    const out = [0];
    for (let j = 1; j < N; j++) {
      const r = rand();
      out.push(r < 0.28 ? out[j - 1] : r < 0.4 ? -1 : j);
    }
    return out;
  }

  // Segments of one loop pass: output offset o reads source window [a, b].
  function readPlan(layer, k, L) {
    const r = layer.read;
    if (r.mode === 'reversed') return [{ o: 0, a: 0, b: L, rev: true }];
    if (r.mode === 'pingpong') return [{ o: 0, a: 0, b: L, rev: k % 2 === 1 }];
    if (r.mode !== 'random' && r.mode !== 'sliced') return [{ o: 0, a: 0, b: L, rev: false }];
    const w = L / r.divisions;
    return sliceOrder(r).map((src, j) => (src < 0 ? null : { o: j * w, a: src * w, b: (src + 1) * w, rev: false })).filter(Boolean);
  }

  // Where in the drawing (0..1) a layer is reading at pass time t, or null when silent.
  function readPos(layer, t, k, L) {
    for (const s of readPlan(layer, k, L)) {
      if (t >= s.o && t < s.o + (s.b - s.a)) return (s.rev ? s.b - (t - s.o) : s.a + (t - s.o)) / L;
    }
    return null;
  }

  function subNote(note, a, b, seg) {
    const d = b - a, n = Math.max(2, Math.ceil(d * 60) + 1), len = note.times.length;
    const times = [], midis = [];
    for (let i = 0; i < n; i++) {
      const s = seg.rev ? b - i / (n - 1) * d : a + i / (n - 1) * d;
      const f = Math.min(len - 1, Math.max(0, (s - note.start) / note.dur * (len - 1)));
      const lo = Math.floor(f), hi = Math.min(len - 1, lo + 1);
      midis.push(note.snap ? note.midis[Math.round(f)] : note.midis[lo] + (note.midis[hi] - note.midis[lo]) * (f - lo));
      times.push(i / (n - 1) * d);
    }
    const start = seg.rev ? seg.o + (seg.b - b) : seg.o + (a - seg.a);
    const out = { start, dur: d, times, midis, snap: note.snap, peak: note.peak };
    if (note.text) { // a word cut by the read mode says only its part, backwards if reversed
      Object.assign(out, { text: note.text, voice: note.voice, textFrom: (a - note.start) / note.dur, textTo: (b - note.start) / note.dur, textRev: !!seg.rev });
    }
    return out;
  }

  // All notes a layer plays in loop pass k, start relative to the pass.
  function collectNotes(layer, k, L, scale) {
    const out = [], all = [];
    // shapes and spray expand into several voices; keys let live edits find a sounding note again
    for (const it of layer.strokes) voices(it).forEach((v, vi) => all.push([v, `${it.id}.${vi}`]));
    readPlan(layer, k, L).forEach((seg, si) => {
      for (const [st, id] of all) {
        const note = strokeToNote(st, L, scale, layer.sound.register);
        const ns = note.start, ne = ns + note.dur;
        const a = Math.max(ns, seg.a), b = Math.min(ne, seg.b);
        if (b - a < 0.02) continue;
        const n = !seg.rev && a === ns && b === ne ? { ...note, start: seg.o + (ns - seg.a) } : subNote(note, a, b, seg);
        n.key = `${id}.${si}`;
        if (n.text) n.sig = ST.talkSig(n);
        out.push(n);
      }
    });
    return out;
  }

  // Solo works across canvas layers and the drum layer alike.
  const anySolo = p => p.layers.some(l => l.solo) || !!(p.drums && p.drums.solo);
  const audible = (layer, project) => !layer.muted && (!anySolo(project) || layer.solo);
  const drumsAudible = p => !p.drums.muted && (!anySolo(p) || p.drums.solo);
  // The drum bus already applies the drum volume; this channel adds only what an LFO moves.
  const drumChannel = (d, v = d) => ({ volume: d.volume ? v.volume / d.volume : 1, pan: v.pan || 0, send: v.send });

  // ---------- LFO ----------
  // One per layer (and the drums): moves one knob up and down, in time with the beat.
  // The phase comes from the song position, so live play and export move the same way.
  const LFO_DEFAULT = { on: false, target: 'fx.filter.cutoff', rate: 4, depth: 40, shape: 'sine' };
  const LFO_RATES = [0.25, 0.5, 1, 2, 4, 8, 16, 32]; // beats per cycle
  function lfoWave(shape, cycles) {
    const ph = cycles - Math.floor(cycles);
    if (shape === 'triangle') return 1 - 4 * Math.abs(ph - 0.5);
    if (shape === 'square') return ph < 0.5 ? 1 : -1;
    if (shape === 'saw') return 1 - 2 * ph; // falls: opens then closes
    if (shape === 'random') return mulberry32(Math.floor(cycles) * 7919 + 13)() * 2 - 1; // a new step every cycle
    return Math.sin(ph * Math.PI * 2);
  }
  // Motions: the Motion card's LFO plus any knob set to move by itself (right-click a knob).
  const motionsOf = l => (l ? [l.lfo, ...(l.motions || [])].filter(m => m && m.on && m.depth > 0 && m.target) : []);
  const soundKnob = (key, drums) => (drums ? [...ST.DRUM_PANELS.source, ...ST.DRUM_PANELS.envelope] : ST.PANELS.filter(p => p.knobs && !p.vox).flatMap(p => p.knobs)).find(k => k.key === key);
  // What a motion target is, and the range it moves in.
  function lfoRange(target, drums) {
    if (target === 'volume') return { min: 0, max: 1.2 };
    if (target === 'pan') return { min: -1, max: 1 };
    if (target === 'send.room' || target === 'send.echo') return { min: 0, max: 100 };
    const [kind, id, key] = String(target).split('.');
    if (kind === 'sound') { const k = soundKnob(id, drums); return k ? { min: k.min, max: k.max } : null; }
    const c = kind === 'fx' && FX_BY_ID[id] && FX_BY_ID[id].params.find(q => q.key === key && q.kind === 'knob');
    return c ? { min: c.min, max: c.max } : null;
  }
  // The value a motion gives at song time u, around the knob's own value.
  function motionValue(m, base, r, u, bpm) {
    const w = lfoWave(m.shape, u * bpm / 60 / Math.max(0.0625, m.rate)), span = (r.max - r.min) / 2 * m.depth / 100;
    return Math.min(r.max, Math.max(r.min, base + w * span));
  }
  // The layer and FX as they sound at song time u: the stored values with every motion applied.
  function modView(layer, fx, u, bpm) {
    let lay = layer, f = fx;
    for (const m of motionsOf(layer)) {
      const r = !m.target.startsWith('sound.') && lfoRange(m.target);
      if (!r) continue;
      const val = base => motionValue(m, base, r, u, bpm);
      if (m.target === 'volume') lay = { ...lay, volume: val(lay.volume) };
      else if (m.target === 'pan') lay = { ...lay, pan: val(lay.pan || 0) };
      else if (m.target.startsWith('send.')) {
        const k = m.target.slice(5), send = { room: 0, echo: 0, ...lay.send };
        lay = { ...lay, send: { ...send, [k]: val(send[k]) } };
      } else {
        const [, id, key] = m.target.split('.');
        f = { ...f, [id]: { ...f[id], on: true, [key]: val(f[id][key]) } };
      }
    }
    return { layer: lay, fx: f };
  }
  const lfoActive = l => motionsOf(l).some(m => !m.target.startsWith('sound.') && lfoRange(m.target));
  // Sound knobs (brightness, attack…) take their moving value at the start of each note or hit.
  const soundMoves = l => motionsOf(l).some(m => m.target.startsWith('sound.'));
  function soundAt(l, u, bpm, drums) {
    const out = { ...l.sound };
    for (const m of motionsOf(l)) {
      if (!m.target.startsWith('sound.')) continue;
      const key = m.target.slice(6), r = lfoRange(m.target, drums);
      if (r && typeof out[key] === 'number') out[key] = motionValue(m, out[key], r, u, bpm);
    }
    return out;
  }
  // The master can move too: filter, Room and Echo levels, echo repeats.
  const MASTER_RANGES = { filter: { min: -100, max: 100 }, roomlevel: { min: 0, max: 100 }, echolevel: { min: 0, max: 100 }, feedback: { min: 0, max: 90 } };
  const masterMotions = m => ((m && m.motions) || []).filter(x => x && x.on && x.depth > 0 && MASTER_RANGES[x.target]);
  function masterView(m, u, bpm) {
    const ms = masterMotions(m);
    if (!ms.length) return m;
    const v = { ...m, room: { ...m.room }, echo: { ...m.echo } };
    const get = { filter: () => v.filter, roomlevel: () => v.room.level, echolevel: () => v.echo.level, feedback: () => v.echo.feedback };
    const set = { filter: x => { v.filter = x; }, roomlevel: x => { v.room.level = x; }, echolevel: x => { v.echo.level = x; }, feedback: x => { v.echo.feedback = x; } };
    for (const x of ms) set[x.target](motionValue(x, get[x.target](), MASTER_RANGES[x.target], u, bpm));
    return v;
  }

  // ---------- graph ----------
  const noiseBufs = new WeakMap();
  function noiseBuffer(ctx) {
    let buf = noiseBufs.get(ctx);
    if (!buf) {
      buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      noiseBufs.set(ctx, buf);
    }
    return buf;
  }

  // DJ filter on the master: below 0 closes a low-pass (darker), above 0 opens a high-pass (thinner).
  const djFreqs = v => ({ lp: v < 0 ? 20000 * Math.pow(180 / 20000, -v / 100) : 20000, hp: v > 0 ? 20 * Math.pow(2500 / 20, v / 100) : 20 });
  function makeMaster(ctx) {
    const lp = ctx.createBiquadFilter(), hp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; hp.type = 'highpass';
    lp.frequency.value = 20000; hp.frequency.value = 20;
    lp.Q.value = hp.Q.value = 1.1;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    const limiter = ctx.createDynamicsCompressor(); // brick wall so stacked FX never clip
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    const out = ctx.createGain();
    out.gain.value = 0.9;
    lp.connect(hp).connect(comp).connect(limiter).connect(out);
    out.connect(ctx.destination);
    return { input: lp, output: out, lp, hp };
  }
  function setMasterFilter(master, ctx, v, now) {
    const f = djFreqs(Math.max(-100, Math.min(100, v || 0)));
    if (now) { master.lp.frequency.value = f.lp; master.hp.frequency.value = f.hp; return; }
    master.lp.frequency.setTargetAtTime(f.lp, ctx.currentTime, 0.04);
    master.hp.frequency.setTargetAtTime(f.hp, ctx.currentTime, 0.04);
  }

  // Shared sends: one Room and one Echo for the whole song. Every layer and the drums
  // send some of their sound to them (after volume and pan), like on a mixing desk.
  const MASTER_DEFAULT = { filter: 0, room: { level: 80, size: 3.5, tone: 55 }, echo: { level: 70, sync: '3/16', feedback: 45 } };
  function makeReturns(ctx, dest) {
    const room = { input: ctx.createGain(), conv: ctx.createConvolver(), damp: ctx.createBiquadFilter(), out: ctx.createGain(), size: null };
    room.damp.type = 'lowpass';
    room.input.connect(room.conv).connect(room.damp).connect(room.out).connect(dest);
    // ping-pong echo: left, then right, then left again, a little darker each time
    const echo = { input: ctx.createGain(), tone: ctx.createBiquadFilter(), dL: ctx.createDelay(2), dR: ctx.createDelay(2), lr: ctx.createGain(), rl: ctx.createGain(), merge: ctx.createChannelMerger(2), out: ctx.createGain() };
    echo.tone.type = 'lowpass';
    echo.tone.frequency.value = 4200;
    echo.input.connect(echo.tone).connect(echo.dL);
    echo.dL.connect(echo.lr).connect(echo.dR);
    echo.dR.connect(echo.rl).connect(echo.dL);
    echo.dL.connect(echo.merge, 0, 0);
    echo.dR.connect(echo.merge, 0, 1);
    echo.merge.connect(echo.out).connect(dest);
    return { room, echo };
  }
  function configureReturns(r, ctx, m, bpm, now) {
    const set = (param, v) => (now ? (param.value = v) : param.setTargetAtTime(v, ctx.currentTime, 0.04));
    const size = Math.round((m.room.size || 3) * 10) / 10;
    if (size !== r.room.size) { r.room.conv.buffer = impulse(ctx, size); r.room.size = size; }
    set(r.room.damp.frequency, 1200 * Math.pow(16000 / 1200, (m.room.tone ?? 55) / 100));
    set(r.room.out.gain, (m.room.level ?? 80) / 100 * 0.9);
    const t = Math.min(2, 60 / bpm * (DIVS[m.echo.sync] || 0.75)), fb = Math.sqrt(Math.min(0.92, (m.echo.feedback ?? 45) / 100));
    set(r.echo.dL.delayTime, t);
    set(r.echo.dR.delayTime, t);
    set(r.echo.lr.gain, fb);
    set(r.echo.rl.gain, fb);
    set(r.echo.out.gain, (m.echo.level ?? 70) / 100 * 0.8);
  }

  // A channel: input -> effects -> volume -> pan -> destination.
  function makeBus(ctx, dest, returns) {
    const bus = { input: ctx.createGain(), out: ctx.createGain(), pan: ctx.createStereoPanner ? ctx.createStereoPanner() : null, chain: [], inst: {}, sig: null };
    bus.input.connect(bus.out);
    if (bus.pan) bus.out.connect(bus.pan).connect(dest); else bus.out.connect(dest);
    if (returns) { // post-fader sends to the shared Room and Echo
      bus.sends = { room: ctx.createGain(), echo: ctx.createGain() };
      bus.sends.room.gain.value = bus.sends.echo.gain.value = 0;
      const from = bus.pan || bus.out;
      from.connect(bus.sends.room).connect(returns.room.input);
      from.connect(bus.sends.echo).connect(returns.echo.input);
    }
    return bus;
  }

  // Rebuild the FX chain when the set of active effects changes, otherwise just update params.
  function configureBus(bus, ctx, layer, env, isAudible, now, fx = layer.fx) {
    const ids = FX_CHAIN.filter(id => fx[id] && fx[id].on && FX_BY_ID[id].build);
    const sig = ids.join(',') + (env.worklet ? '|w' : '');
    if (sig !== bus.sig) {
      bus.input.disconnect();
      for (const inst of bus.chain) {
        try { inst.output.disconnect(); } catch (e) { /* not connected */ }
        if (inst.dispose) inst.dispose();
      }
      bus.chain = [];
      bus.inst = {};
      let node = bus.input;
      for (const id of ids) {
        const inst = FX_BY_ID[id].build(ctx, env);
        inst.update(fx[id], env, true);
        node.connect(inst.input);
        node = inst.output;
        bus.chain.push(inst);
        bus.inst[id] = inst;
      }
      node.connect(bus.out);
      bus.sig = sig;
    } else {
      for (const id of ids) bus.inst[id].update(fx[id], env, now);
    }
    const v = isAudible ? layer.volume : 0, pan = Math.max(-1, Math.min(1, layer.pan || 0));
    if (now) { bus.out.gain.value = v; if (bus.pan) bus.pan.pan.value = pan; }
    else { bus.out.gain.setTargetAtTime(v, ctx.currentTime, 0.03); if (bus.pan) bus.pan.pan.setTargetAtTime(pan, ctx.currentTime, 0.03); }
    if (bus.sends) {
      const send = layer.send || {};
      for (const k of ['room', 'echo']) {
        const g = Math.max(0, Math.min(100, send[k] || 0)) / 100;
        if (now) bus.sends[k].gain.value = g; else bus.sends[k].gain.setTargetAtTime(g, ctx.currentTime, 0.03);
      }
    }
  }

  const bendSources = new WeakMap(); // ctx -> ConstantSourceNode (cents), realtime only

  // A synth voice: carrier (+ sub, FM modulator, noise) -> lowpass -> envelope.
  function createVoice(ctx, dest, sound, tOn, peak, registry, vib) {
    const env = ctx.createGain();
    env.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.8 + (sound.resonance || 0) / 100 * 17;
    filter.frequency.value = cutoff(sound.brightness);
    const lvl = ctx.createGain(); // live loudness changes, independent of the envelope
    filter.connect(env).connect(lvl).connect(dest);

    const carrier = ctx.createOscillator();
    carrier.type = sound.wave;
    const carrierGain = ctx.createGain();
    carrierGain.gain.value = 0.3;
    carrier.connect(carrierGain).connect(filter);
    const sources = [carrier], pitched = [carrier];
    const freqParams = [[carrier.frequency, 1]]; // [param, multiple of note frequency]
    if (sound.unison > 0) { // two detuned copies either side: thick, wide
      const cents = 4 + sound.unison / 100 * 28;
      carrierGain.gain.value = 0.3 / (1 + sound.unison / 100 * 0.9);
      for (const sign of [-1, 1]) {
        const o = ctx.createOscillator(), g = ctx.createGain(), pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        o.type = sound.wave;
        o.detune.value = sign * cents;
        g.gain.value = carrierGain.gain.value * (0.4 + sound.unison / 100 * 0.5);
        o.connect(g);
        if (pan) { pan.pan.value = sign * sound.unison / 100 * 0.7; g.connect(pan).connect(filter); } else g.connect(filter);
        sources.push(o);
        pitched.push(o);
        freqParams.push([o.frequency, 1]);
      }
    }

    if (sound.sub > 0) {
      const sub = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.value = sound.sub / 100 * 0.35;
      sub.connect(g).connect(filter);
      sources.push(sub);
      pitched.push(sub);
      freqParams.push([sub.frequency, 0.5]);
    }
    if (sound.fmDepth > 0) {
      const mod = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.value = 0;
      mod.connect(g).connect(carrier.frequency);
      sources.push(mod);
      pitched.push(mod);
      freqParams.push([mod.frequency, sound.fmRatio], [g.gain, sound.fmRatio * sound.fmDepth / 100 * 5]);
    }
    if (vib && vib.on && vib.depth > 0) {
      const lfo = ctx.createOscillator();
      const g = ctx.createGain();
      lfo.frequency.value = vib.rate;
      g.gain.value = vib.depth;
      lfo.connect(g);
      for (const o of pitched) g.connect(o.detune);
      sources.push(lfo);
    }
    if (sound.drift > 0) { // slow, uneven wobble of the whole pitch
      const lfo = ctx.createOscillator(), g = ctx.createGain();
      lfo.frequency.value = 0.15 + Math.random() * 0.6;
      g.gain.value = sound.drift / 100 * 22;
      lfo.connect(g);
      for (const o of pitched) g.connect(o.detune);
      sources.push(lfo);
    }
    if (sound.pluck > 0) { // filter envelope: opens bright, closes over the decay
      const base = cutoff(sound.brightness), top = Math.min(18000, base * (1 + sound.pluck / 100 * 20));
      filter.frequency.setValueAtTime(top, tOn);
      filter.frequency.setTargetAtTime(base, tOn + 0.004, Math.max(0.02, (sound.decay || 0.3) * 0.35));
    }
    let noise = null;
    if (sound.noise > 0) {
      noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer(ctx);
      noise.loop = true;
      const g = ctx.createGain();
      g.gain.value = sound.noise / 100 * 0.45;
      noise.connect(g).connect(filter);
    }
    const bendSrc = bendSources.get(ctx);
    if (bendSrc) for (const o of pitched) bendSrc.connect(o.detune);
    for (const s of sources) s.start(tOn);
    if (noise) { noise.start(tOn, Math.random() * 1.5); sources.push(noise); }

    const A = Math.max(0.004, sound.attack), D = Math.max(0.02, sound.decay);
    const S = sound.sustain / 100, R = Math.max(0.03, sound.release);
    const level = t => (t < A ? t / A : t < A + D ? 1 - (1 - S) * (t - A) / D : S);
    const g = env.gain;
    const finish = t => { for (const s of sources) { try { s.stop(t); } catch (e) { /* already stopped */ } } };
    const holdParam = (param, t) => {
      if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
      else { param.cancelScheduledValues(t); param.setValueAtTime(param.value, t); }
    };

    const glide = (sound.glide || 0) / 100 * 0.04; // time constant: up to ~120 ms to settle
    let tuned = false;
    const voice = {
      tOn,
      setFreq(f, t, how) {
        if (how === 'set' && glide && tuned) how = 'slide';
        tuned = true;
        for (const [param, k] of freqParams) {
          if (how === 'slide') param.setTargetAtTime(f * k, t, glide);
          else if (how === 'ramp') param.linearRampToValueAtTime(f * k, t);
          else if (how === 'glide') param.setTargetAtTime(f * k, t, 0.012);
          else param.setValueAtTime(f * k, t);
        }
      },
      // Note with a known length: envelope is written analytically, no cancels.
      playFor(dur) {
        voice.endAt = tOn + dur;
        g.setValueAtTime(0, tOn);
        if (dur <= A) {
          g.linearRampToValueAtTime(peak * dur / A, tOn + dur);
        } else {
          g.linearRampToValueAtTime(peak, tOn + A);
          if (dur <= A + D) g.linearRampToValueAtTime(peak * level(dur), tOn + dur);
          else { g.linearRampToValueAtTime(peak * S, tOn + A + D); g.setValueAtTime(peak * S, tOn + dur); }
        }
        g.linearRampToValueAtTime(0, tOn + dur + R);
        finish(tOn + dur + R + 0.05);
      },
      // Open-ended note (live drawing): attack/decay now, release later.
      hold() {
        g.setValueAtTime(0, tOn);
        g.linearRampToValueAtTime(peak, tOn + A);
        g.linearRampToValueAtTime(peak * S, tOn + A + D);
      },
      release(t) {
        voice.endAt = t;
        const lvl = peak * level(Math.max(0, t - tOn));
        if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
        else { g.cancelScheduledValues(t); g.setValueAtTime(lvl, t); }
        g.linearRampToValueAtTime(0, t + R);
        finish(t + R + 0.05);
      },
      kill(t) {
        voice.endAt = t;
        if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
        else { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); }
        g.setTargetAtTime(0, t, 0.015);
        finish(t + 0.12);
      },
      // The line changed while this note sounds: follow the new pitch curve from
      // now on, take the new loudness and brightness, and move the end if needed.
      reshape(now, note, start, snd) {
        const times = note.times, midis = note.midis, rel = now - start;
        let i = 0;
        while (i < times.length - 1 && times[i + 1] <= rel) i++;
        const j = Math.min(times.length - 1, i + 1);
        const f = times[j] > times[i] ? Math.min(1, Math.max(0, (rel - times[i]) / (times[j] - times[i]))) : 0;
        let last = note.snap ? midis[i] : midis[i] + (midis[j] - midis[i]) * f;
        for (const [param] of freqParams) holdParam(param, now);
        voice.setFreq(midiToFreq(last), now + 0.015, 'ramp');
        for (let k = i + 1; k < times.length; k++) {
          const at = start + times[k], m = midis[k];
          if (at <= now + 0.015) continue;
          if (note.snap) { if (m !== last) voice.setFreq(midiToFreq(m), at, 'set'); }
          else voice.setFreq(midiToFreq(m), at, 'ramp');
          last = m;
        }
        lvl.gain.setTargetAtTime(note.peak / peak, now, 0.02);
        if (snd) filter.frequency.setTargetAtTime(cutoff(snd.brightness), now, 0.02);
        const end = start + note.dur;
        if (Math.abs(end - voice.endAt) <= 0.01) return;
        voice.endAt = end;
        if (end <= now + 0.01) { voice.release(now); return; }
        holdParam(g, now);
        const settle = Math.max(end, tOn + A + D);
        if (now < tOn + A + D) g.linearRampToValueAtTime(peak * S, tOn + A + D);
        g.setValueAtTime(peak * S, settle);
        g.linearRampToValueAtTime(0, settle + R);
        finish(settle + R + 0.05);
      },
    };
    if (registry) {
      registry.add(voice);
      carrier.onended = () => { env.disconnect(); registry.delete(voice); };
    }
    return voice;
  }

  // bend(ctxTime) -> pitch multiplier, used by tape stop.
  function scheduleNote(ctx, dest, sound, note, t, skip, registry, vib, bend, meta) {
    const dur = note.dur - skip;
    if (dur <= 0.01) return;
    if (note.text) { ST.scheduleTalk(ctx, dest, sound, note, t, skip, registry, meta); return; }
    const v = createVoice(ctx, dest, sound, t, note.peak, registry, vib);
    v.meta = meta;
    const freq = (m, at) => midiToFreq(m) * (bend ? bend(at) : 1);
    let i = 0;
    while (i < note.times.length - 1 && note.times[i + 1] <= skip) i++;
    let last = note.midis[i];
    v.setFreq(freq(last, t), t, 'set');
    for (let j = i + 1; j < note.times.length; j++) {
      const m = note.midis[j], at = t + note.times[j] - skip;
      if (bend) v.setFreq(freq(m, at), at, 'ramp');
      else if (note.snap) { if (m !== last) v.setFreq(midiToFreq(m), at, 'set'); }
      else v.setFreq(midiToFreq(m), at, 'ramp');
      last = m;
    }
    v.playFor(dur);
  }

  // Schedule everything of one layer in loop pass k whose time falls in [u0, u1).
  // u is song time; ctxAt(u) converts to AudioContext time.
  function schedulePass(ctx, bus, layer, project, notes, k, L, u0, u1, ctxAt, registry, fx = layer.fx) {
    const beat = 60 / project.bpm, base = k * L;
    const tapeLen = fx.tapestop.on ? Math.min(L, Number(fx.tapestop.length) * beat) : 0;
    const zone = base + L - tapeLen, origin = ctxAt(0);
    const bend = tc => { const u = tc - origin; return u <= zone ? 1 : Math.max(0.03, 1 - (u - zone) / tapeLen); };

    for (const n of notes) {
      const at = base + n.start;
      if (at < u0 || at >= u1) continue;
      const bends = tapeLen && at + n.dur > zone;
      scheduleNote(ctx, bus.input, soundMoves(layer) ? soundAt(layer, at, project.bpm) : layer.sound, n, ctxAt(at), 0, registry, fx.vibrato, bends ? bend : null,
        { key: `${layer.id}:${n.key}@${k}`, bend: !!bends });
    }

    const gate = bus.inst.trancegate;
    if (gate) {
      const p = fx.trancegate, step = beat * DIVS[p.division];
      const low = 1 - p.depth / 100, open = step * p.length / 100;
      for (let i = Math.max(0, Math.floor((u0 - base) / step)); ; i++) {
        const at = base + i * step;
        if (at >= u1 || at >= base + L - 1e-6) break;
        if (at < u0) continue;
        const t = ctxAt(at);
        gate.gate.gain.setTargetAtTime(1, t, 0.002);
        gate.gate.gain.setTargetAtTime(low, t + open, 0.004);
      }
    }
    const tape = bus.inst.tapestop;
    if (tape && tapeLen && zone >= u0 && zone < u1) {
      const t = ctxAt(zone), end = ctxAt(base + L);
      tape.gate.gain.setValueAtTime(1, t);
      tape.gate.gain.linearRampToValueAtTime(0, end - 0.004);
      tape.gate.gain.setValueAtTime(1, end);
    }
  }

  // snd: the drum sound, or a function of song time when a drum sound knob moves by itself
  function scheduleDrums(ctx, bus, hits, k, L, u0, u1, ctxAt, snd) {
    for (const h of hits) {
      const at = k * L + h.t;
      if (at >= u0 && at < u1) playDrumHit(ctx, bus, h, ctxAt(at), typeof snd === 'function' ? snd(at) : snd);
    }
  }

  // How busy and how high the melody is on each 16th (0..1), for drums that listen.
  function melodyActivity(project, L, notesOf) {
    const steps = project.bars * 16, act = new Float32Array(steps), step = L / steps;
    let max = 0;
    for (const layer of project.layers) {
      if (!audible(layer, project)) continue;
      for (const n of notesOf(layer)) {
        const high = Math.min(1, Math.max(0, (n.midis.reduce((a, m) => a + m, 0) / n.midis.length - 48) / 36));
        const w = n.peak * (0.6 + 0.4 * high);
        for (let s = Math.max(0, Math.floor(n.start / step)); s < Math.min(steps, Math.ceil((n.start + n.dur) / step)); s++) {
          act[s] += w;
          max = Math.max(max, act[s]);
        }
      }
    }
    if (!max) return null;
    for (let s = 0; s < steps; s++) act[s] /= max;
    return act;
  }

  // ---------- realtime engine ----------
  class Engine {
    constructor(getProject) {
      this.getProject = getProject;
      this.ctx = null;
      this.master = null;
      this.buses = new Map();
      this.voices = new Set();
      this.notesCache = new Map();
      this.state = null;
      this.monitor = null;
      this.timer = 0;
      this.worklet = false;
      this.recorder = null;
      this.fxOverride = null;
    }

    fxOf(layer) { return this.fxOverride || layer.fx; }

    // Held MPK key: every layer temporarily uses these FX (null = back to their own).
    setFxOverride(fx) {
      this.fxOverride = fx;
      this.updateAll();
    }

    // Peak level of one channel (a layer id, or 'drums'), for the mixer meters.
    channelPeak(id) {
      const bus = id === 'drums' ? this.drumFx : this.buses.get(id);
      if (!bus || !this.ctx) return 0;
      if (!bus.meter) {
        bus.meter = this.ctx.createAnalyser();
        bus.meter.fftSize = 512;
        bus.meterBuf = new Float32Array(bus.meter.fftSize);
        (bus.pan || bus.out).connect(bus.meter);
      }
      bus.meter.getFloatTimeDomainData(bus.meterBuf);
      let pk = 0;
      for (const v of bus.meterBuf) { const a = Math.abs(v); if (a > pk) pk = a; }
      return pk;
    }

    // Peak level of what goes to the speakers (0..1+), for the meter.
    peak() {
      if (!this.ctx) return 0;
      if (!this.meter) {
        this.meter = this.ctx.createAnalyser();
        this.meter.fftSize = 1024;
        this.meterBuf = new Float32Array(this.meter.fftSize);
        this.master.output.connect(this.meter);
      }
      this.meter.getFloatTimeDomainData(this.meterBuf);
      let pk = 0;
      for (const v of this.meterBuf) { const a = Math.abs(v); if (a > pk) pk = a; }
      return pk;
    }

    setMasterVolume(v) { // speaker level only; exports keep the standard level
      this.masterVol = v;
      if (this.ctx) this.master.output.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
    }

    // Metronome: straight to the speakers, so it is never recorded or exported.
    scheduleClicks(project, k, L, u0, u1, ctxAt) {
      const ctx = this.ctx, beat = 60 / project.bpm, base = k * L;
      if (!this.clickOut) { this.clickOut = ctx.createGain(); this.clickOut.gain.value = 0.35; this.clickOut.connect(ctx.destination); }
      for (let i = Math.ceil((Math.max(u0, base) - base) / beat - 1e-6); base + i * beat < Math.min(u1, base + L); i++) {
        const t = ctxAt(base + i * beat), o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = i % 4 === 0 ? 1600 : 1050; // the bar's first beat is higher
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(i % 4 === 0 ? 1 : 0.6, t + 0.002);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
        o.connect(g).connect(this.clickOut);
        o.start(t);
        o.stop(t + 0.06);
      }
    }

    setBend(amount) { // -1..1, ±2 semitones
      const src = this.ctx && bendSources.get(this.ctx);
      if (src) src.offset.setTargetAtTime(amount * 200, this.ctx.currentTime, 0.01);
    }

    get playing() { return !!this.state; }
    env() { return { bpm: this.getProject().bpm, worklet: this.worklet }; }

    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.master = makeMaster(this.ctx);
        if (this.masterVol != null) this.master.output.gain.value = this.masterVol;
        const bend = this.ctx.createConstantSource();
        bend.offset.value = 0;
        bend.start();
        bendSources.set(this.ctx, bend);
        this.returns = makeReturns(this.ctx, this.master.input);
        this.updateMaster(true);
        this.drumFx = makeBus(this.ctx, this.master.input, this.returns); // drum layer FX, like a canvas layer
        this.drumBus = makeDrumBus(this.ctx, this.drumFx.input);
        this.updateDrums(true);
        loadWorklet(this.ctx).then(ok => { this.worklet = ok; if (ok) this.updateAll(); });
      }
      if (this.ctx.state !== 'running') this.ctx.resume();
      return this.ctx;
    }

    invalidate() { this.notesCache.clear(); this.drumCache = new Map(); this.resyncSoon(); }

    // Master DJ filter and the shared Room / Echo returns.
    updateMaster(now = false) {
      if (!this.ctx) return;
      const p = this.getProject(), stored = p.master || MASTER_DEFAULT, pos = this.state && masterMotions(stored).length ? this.position() : null;
      const m = pos ? masterView(stored, pos.u, p.bpm) : stored;
      setMasterFilter(this.master, this.ctx, m.filter, now);
      configureReturns(this.returns, this.ctx, m, p.bpm, now);
    }

    // A layer as it sounds right now: its own settings, or a held key's FX, plus its LFO.
    view(layer, fx = this.fxOf(layer)) {
      const pos = this.state && lfoActive(layer) ? this.position() : null;
      return pos ? modView(layer, fx, pos.u, this.getProject().bpm) : { layer, fx };
    }

    // Run fn at song time u, in step with the scheduler: scenes launch exactly on the bar.
    at(u, fn) { this.queued = { u, fn }; }
    cancelQueued() { this.queued = null; }

    // Keys in "Play notes" mode: a note that sounds while the key is held.
    noteOn(layer, midi, vel = 0.8) {
      const ctx = this.ensure(), t = ctx.currentTime + 0.005;
      const v = createVoice(ctx, this.bus(layer).input, layer.sound, t, 0.2 + 0.45 * vel, this.voices, this.fxOf(layer).vibrato);
      v.setFreq(midiToFreq(midi), t, 'set');
      v.hold();
      return v;
    }
    noteOff(v) { if (v && this.ctx) v.release(this.ctx.currentTime + 0.005); }

    resyncSoon() {
      if (!this.state || this.resyncTimer) return;
      this.resyncTimer = setTimeout(() => { this.resyncTimer = 0; this.resync(); }, 30);
    }

    // Edits while playing: notes that are sounding follow the new drawing, notes
    // that should be sounding now start mid-way, notes whose line is gone fade out.
    // at: an AudioContext time to reconcile at (a scene launch), default just after now.
    resync(at) {
      const s = this.state;
      if (!s) return;
      const ctx = this.ctx, p = this.getProject(), L = loopLength(p), now = at != null ? at : ctx.currentTime + 0.01;
      const ctxAt = u => s.t0 + u - s.offset;
      const live = new Map();
      for (const v of this.voices) if (v.meta && v.endAt > now) live.set(v.meta.key, v);
      const kNow = Math.floor(Math.max(0, s.offset + now - s.t0) / L);
      const kMax = p.loop ? Math.floor((s.offset + s.until - s.t0) / L) : 0;
      for (const layer of p.layers) {
        const on = audible(layer, p);
        for (let k = kNow; k <= kMax; k++) {
          for (const n of this.notes(layer, k, L, p)) {
            const start = ctxAt(k * L + n.start);
            if (start + n.dur <= now || start >= s.until) continue;
            const key = `${layer.id}:${n.key}@${k}`, v = live.get(key);
            live.delete(key);
            if (!on || (v && v.meta.bend)) continue;
            if (v && v.talk && v.sig === n.sig + ST.voxKey(layer.sound)) continue; // same words and voice, keep talking
            if (v && start <= now && v.reshape) { v.reshape(now, n, start, layer.sound); continue; }
            if (v) v.kill(now); // not started yet, or a voice that restarts mid-word
            const skip = Math.max(0, now - start);
            scheduleNote(ctx, this.bus(layer).input, soundMoves(layer) ? soundAt(layer, k * L + n.start, p.bpm) : layer.sound, n, start + skip, skip, this.voices, this.fxOf(layer).vibrato, null, { key });
          }
        }
      }
      for (const v of live.values()) { // their line moved away or was erased
        if (v.meta.bend) continue;
        if (v.tOn > now - 1e-4) v.kill(Math.max(v.tOn, now)); else v.release(now);
      }
    }

    // Drum hits of loop pass k: phrases, fills and Evolve make every pass its own.
    drums(k) {
      const p = this.getProject(), d = p.drums, L = loopLength(p);
      if (!this.drumCache) this.drumCache = new Map();
      let h = this.drumCache.get(k);
      if (!h) {
        if (this.drumCache.size > 8) this.drumCache.clear();
        const melody = d.listen ? melodyActivity(p, L, layer => this.notes(layer, k, L, p)) : null;
        h = drumHits(d, p.bars, L, k, melody);
        this.drumCache.set(k, h);
      }
      return h;
    }

    updateDrums(now = false) {
      if (!this.ctx) return;
      const p = this.getProject(), d = p.drums, v = this.view(d);
      configureDrumBus(this.drumBus, this.ctx, d, now, drumsAudible(p));
      configureBus(this.drumFx, this.ctx, drumChannel(d, v.layer), this.env(), true, now, v.fx);
    }

    // One drum hit right now, with the drum layer's sound and FX (editing hits).
    drumNow(id, vel = 0.9) {
      const ctx = this.ensure();
      drumHit(ctx, this.drumBus.input, id, ctx.currentTime + 0.01, vel, 1, this.getProject().drums.sound);
    }

    // "Try sound" on the drum layer: a one-bar lick through its FX.
    previewDrums() {
      const ctx = this.ensure(), d = this.getProject().drums, t = ctx.currentTime + 0.03, s = 60 / this.getProject().bpm / 4;
      [['kick1', 0, 1], ['chat', 2, 0.6], ['snare1', 4, 0.95], ['chat', 6, 0.6], ['kick1', 7, 0.8], ['kick1', 8, 1], ['ohat', 10, 0.7], ['snare1', 12, 0.95], ['clap', 12, 0.7], ['tom', 14, 0.7]]
        .forEach(([id, step, vel]) => drumHit(ctx, this.drumBus.input, id, t + step * s, vel, 1, d.sound));
    }

    notes(layer, k, L, project) {
      const key = `${layer.id}:${layer.read.mode === 'pingpong' ? k % 2 : 0}`;
      let n = this.notesCache.get(key);
      if (!n) { n = collectNotes(layer, k, L, project.scale); this.notesCache.set(key, n); }
      return n;
    }

    bus(layer) {
      let b = this.buses.get(layer.id);
      if (!b) {
        b = makeBus(this.ctx, this.master.input, this.returns);
        const v = this.view(layer);
        configureBus(b, this.ctx, v.layer, this.env(), audible(layer, this.getProject()), true, v.fx);
        this.buses.set(layer.id, b);
      }
      return b;
    }

    updateLayer(layer) {
      if (layer === this.getProject().drums) { this.updateDrums(); return; }
      const b = this.buses.get(layer.id);
      if (!b) return;
      const v = this.view(layer);
      configureBus(b, this.ctx, v.layer, this.env(), audible(layer, this.getProject()), false, v.fx);
    }

    updateAll() {
      if (!this.ctx) return;
      const layers = this.getProject().layers, ids = new Set(layers.map(l => l.id));
      for (const [id, b] of this.buses) {
        if (!ids.has(id)) { b.out.disconnect(); this.buses.delete(id); }
      }
      for (const l of layers) this.updateLayer(l);
      this.updateDrums();
      this.updateMaster();
    }

    // LFOs: move their knob a little every scheduler tick, from the song position.
    modulate() {
      const p = this.getProject();
      for (const l of p.layers) if (lfoActive(l)) this.updateLayer(l);
      if (lfoActive(p.drums)) this.updateDrums();
      if (masterMotions(p.master).length) this.updateMaster();
    }

    // from: song time in seconds (may be past the first loop pass when resuming)
    play(from) {
      const ctx = this.ensure();
      this.stop();
      const project = this.getProject(), L = loopLength(project);
      const t0 = ctx.currentTime + 0.06;
      this.state = { t0, offset: from, until: t0 };
      // Notes already running at the start position join part-way through.
      const k0 = Math.floor(from / L);
      for (const layer of project.layers) {
        if (!audible(layer, project)) continue;
        for (const n of this.notes(layer, k0, L, project)) {
          const at = k0 * L + n.start;
          if (at < from && at + n.dur > from + 0.02) {
            scheduleNote(ctx, this.bus(layer).input, layer.sound, n, t0, from - at, this.voices, this.fxOf(layer).vibrato, null, { key: `${layer.id}:${n.key}@${k0}` });
          }
        }
      }
      this.tick();
      this.timer = setInterval(() => this.tick(), 25);
    }

    tick() {
      const s = this.state;
      if (!s) return;
      this.modulate();
      const horizon = this.ctx.currentTime + LOOKAHEAD;
      if (horizon <= s.until) return;
      const u0 = s.offset + (s.until - s.t0), u1 = s.offset + (horizon - s.t0);
      const ctxAt = u => s.t0 + u - s.offset;
      const q = this.queued;
      if (q && q.u < u1) { // a scene change inside this window: old notes up to it, new ones after
        this.queued = null;
        const at = Math.max(u0, q.u);
        this.scheduleRange(u0, at, ctxAt);
        s.until = ctxAt(at);
        q.fn();
        this.notesCache.clear();
        this.drumCache = new Map();
        this.resync(s.until); // old notes end at the boundary, long new ones join part-way
        this.scheduleRange(at, u1, ctxAt);
      } else this.scheduleRange(u0, u1, ctxAt);
      s.until = horizon;
    }

    scheduleRange(u0, u1, ctxAt) {
      if (u1 <= u0) return;
      const ctx = this.ctx, project = this.getProject(), L = loopLength(project);
      const kMax = project.loop ? Math.floor(u1 / L) : 0;
      for (let k = Math.floor(u0 / L); k <= kMax; k++) {
        for (const layer of project.layers) {
          if (!audible(layer, project)) continue;
          schedulePass(ctx, this.bus(layer), layer, project, this.notes(layer, k, L, project), k, L, u0, u1, ctxAt, this.voices, this.fxOf(layer));
        }
        const d = project.drums;
        scheduleDrums(ctx, this.drumBus, this.drums(k), k, L, u0, u1, ctxAt, soundMoves(d) ? u => soundAt(d, u, project.bpm, true) : d.sound);
        if (this.metronome) this.scheduleClicks(project, k, L, u0, u1, ctxAt);
        schedulePass(ctx, this.drumFx, d, project, [], k, L, u0, u1, ctxAt, null, this.fxOf(d)); // trance gate, tape stop
      }
    }

    // letRing: stop scheduling but let already-sounding tails fade naturally.
    stop(letRing) {
      clearInterval(this.timer);
      const wasModulating = !!this.state;
      this.state = null;
      this.queued = null;
      if (!this.ctx) return;
      if (wasModulating) this.updateAll(); // LFOs back to the stored values
      const t = this.ctx.currentTime;
      for (const b of [...this.buses.values(), this.drumFx]) {
        for (const id of ['trancegate', 'tapestop']) {
          const inst = b.inst[id];
          if (inst) { inst.gate.gain.cancelScheduledValues(t); inst.gate.gain.setValueAtTime(1, t); }
        }
      }
      if (!letRing) for (const v of this.voices) if (v !== this.monitor) v.kill(t);
    }

    position() {
      const s = this.state;
      if (!s) return null;
      const p = this.getProject(), L = loopLength(p);
      const u = s.offset + Math.max(0, this.ctx.currentTime - s.t0);
      if (!p.loop && u >= L) return { t: L, u, k: 0, done: true };
      return { t: u % L, u, k: Math.floor(u / L), done: false };
    }

    monitorStart(layer, y) {
      const ctx = this.ensure();
      this.monitorEnd();
      const p = this.getProject();
      const v = createVoice(ctx, this.bus(layer).input, layer.sound, ctx.currentTime, 0.45, this.voices, this.fxOf(layer).vibrato);
      v.setFreq(midiToFreq(yToMidi(y, p.scale, layer.sound.register)), ctx.currentTime, 'set');
      v.hold();
      this.monitor = v;
      this.monitorLayer = layer;
    }

    monitorMove(y) {
      if (!this.monitor) return;
      const p = this.getProject();
      const f = midiToFreq(yToMidi(y, p.scale, this.monitorLayer.sound.register));
      if (!Number.isFinite(f)) return;
      this.monitor.setFreq(f, this.ctx.currentTime, isSnapped(p.scale) ? 'set' : 'glide');
    }

    monitorEnd() {
      if (!this.monitor) return;
      this.monitor.release(this.ctx.currentTime);
      this.monitor = null;
    }

    // Short three-note phrase so people can hear a sound without drawing.
    preview(layer) {
      if (layer === this.getProject().drums) { this.previewDrums(); return; }
      const ctx = this.ensure();
      const dest = this.bus(layer).input;
      const shift = REGISTER[layer.sound.register] || 0;
      const t = ctx.currentTime + 0.03;
      [[60, 0], [67, 0.3], [72, 0.6]].forEach(([m, dt]) => {
        scheduleNote(ctx, dest, layer.sound, { dur: 0.26, times: [0], midis: [m + shift], snap: true, peak: 0.5 }, t + dt, 0, this.voices, this.fxOf(layer).vibrato, null);
      });
    }

    // Hear canvas items once from now, as if the loop started (pattern preview).
    audition(layer, items, maxSecs = 8) {
      const ctx = this.ensure(), p = this.getProject(), L = loopLength(p), t0 = ctx.currentTime + 0.05;
      for (const it of items) {
        for (const v of voices(it)) {
          const n = strokeToNote(v, L, p.scale, layer.sound.register);
          if (n.start < maxSecs) scheduleNote(ctx, this.bus(layer).input, layer.sound, n, t0 + n.start, 0, this.voices, this.fxOf(layer).vibrato, null);
        }
      }
    }

    // A text item speaks once, right now (hear while typing).
    say(layer, item) {
      const ctx = this.ensure(), p = this.getProject(), L = loopLength(p);
      for (const v of voices(item)) {
        const n = strokeToNote(v, L, p.scale, layer.sound.register);
        scheduleNote(ctx, this.bus(layer).input, layer.sound, { ...n, dur: Math.min(n.dur, 4) }, ctx.currentTime + 0.02, 0, this.voices, null, null);
      }
    }

    // Short notes at the given heights, played together (shape and spray feedback).
    blip(layer, ys, dur) {
      const ctx = this.ensure(), p = this.getProject();
      const dest = this.bus(layer).input, t = ctx.currentTime + 0.01, peak = 0.45 / Math.sqrt(ys.length);
      for (const y of ys) {
        const m = yToMidi(y, p.scale, layer.sound.register);
        scheduleNote(ctx, dest, layer.sound, { dur: dur || 0.3, times: [0], midis: [m], snap: true, peak }, t, 0, this.voices, this.fxOf(layer).vibrato, null);
      }
    }

    // Live capture of everything that comes out of the speakers.
    startRecording() {
      const ctx = this.ensure();
      if (!this.recDest) {
        this.recDest = ctx.createMediaStreamDestination();
        this.master.output.connect(this.recDest);
      }
      const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
      const type = types.find(t => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(this.recDest.stream, type ? { mimeType: type } : undefined);
      const chunks = [];
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      const done = new Promise(resolve => {
        rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' }));
      });
      rec.start(250);
      this.recorder = rec;
      return done;
    }

    stopRecording() {
      if (this.recorder && this.recorder.state === 'recording') this.recorder.stop();
      this.recorder = null;
    }
  }

  // ---------- export ----------
  // Offline export of the loop as it really plays: every pass (drum fills, evolving
  // grooves, ping-pong) for `seconds`, then either a fade-out or the natural tail.
  // Events are scheduled window by window while rendering, so long files stay light.
  async function renderWav(project, opts = {}) {
    setRootKey(project.key || 0); // the file uses the project's own key
    const sr = 44100, L = loopLength(project);
    const seconds = Math.max(0.5, opts.seconds || L), fade = Math.max(0, opts.fade || 0);
    const total = seconds + (fade ? 0.05 : 5);
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new OAC(2, Math.ceil(sr * total), sr);
    const env = { bpm: project.bpm, worklet: await loadWorklet(ctx) };
    const master = makeMaster(ctx), mset = project.master || MASTER_DEFAULT, m0 = masterView(mset, 0, project.bpm);
    setMasterFilter(master, ctx, m0.filter, true);
    const returns = makeReturns(ctx, master.input);
    configureReturns(returns, ctx, m0, project.bpm, true);
    const layers = project.layers.filter(l => audible(l, project) && l.strokes.length);
    const view = (l, u) => (lfoActive(l) ? modView(l, l.fx, u, project.bpm) : { layer: l, fx: l.fx });
    const buses = new Map(layers.map(l => { const bus = makeBus(ctx, master.input, returns), v = view(l, 0); configureBus(bus, ctx, v.layer, env, true, true, v.fx); return [l.id, bus]; }));
    const noteCache = new Map();
    const notesOf = (layer, k) => {
      const key = `${layer.id}:${layer.read.mode === 'pingpong' ? k % 2 : 0}`;
      if (!noteCache.has(key)) noteCache.set(key, collectNotes(layer, k, L, project.scale));
      return noteCache.get(key);
    };
    const d = project.drums;
    let drumBus = null, drumFx = null;
    if (d && drumsAudible(project)) {
      drumFx = makeBus(ctx, master.input, returns);
      drumBus = makeDrumBus(ctx, drumFx.input);
      const v = view(d, 0);
      configureBus(drumFx, ctx, drumChannel(d, v.layer), env, true, true, v.fx);
      configureDrumBus(drumBus, ctx, d, true);
    }
    const scheduleWindow = (u0, u1) => {
      u1 = Math.min(u1, seconds);
      if (u1 <= u0) return;
      for (let k = Math.floor(u0 / L); k * L < u1; k++) {
        for (const l of layers) schedulePass(ctx, buses.get(l.id), l, project, notesOf(l, k), k, L, u0, u1, u => u, null);
        if (drumBus) {
          const melody = d.listen ? melodyActivity(project, L, layer => notesOf(layer, k)) : null;
          scheduleDrums(ctx, drumBus, drumHits(d, project.bars, L, k, melody), k, L, u0, u1, u => u, soundMoves(d) ? x => soundAt(d, x, project.bpm, true) : d.sound);
          schedulePass(ctx, drumFx, d, project, [], k, L, u0, u1, u => u, null, d.fx);
        }
      }
    };
    // LFOs move at small steps while rendering (a few dozen per cycle).
    const moving = [...layers, ...(drumFx && lfoActive(d) ? [d] : [])].filter(lfoActive);
    const rates = [...moving.flatMap(l => motionsOf(l).map(m => m.rate)), ...masterMotions(mset).map(m => m.rate)];
    const lfoStep = rates.length ? Math.min(0.25, Math.max(0.03, Math.min(...rates) * 60 / project.bpm / 32)) : 0;
    const modulate = u => {
      if (masterMotions(mset).length) {
        const mv = masterView(mset, u, project.bpm);
        setMasterFilter(master, ctx, mv.filter, false);
        configureReturns(returns, ctx, mv, project.bpm, false);
      }
      for (const l of moving) {
        const v = view(l, u);
        if (l === d) configureBus(drumFx, ctx, drumChannel(d, v.layer), env, true, false, v.fx);
        else configureBus(buses.get(l.id), ctx, v.layer, env, true, false, v.fx);
      }
    };
    const WIN = 4, stops = new Map(); // render quantum -> what to do there
    const quantum = t => Math.round(t * sr / 128);
    scheduleWindow(0, WIN);
    for (let t = WIN; t < seconds; t += WIN) stops.set(quantum(t - 1), { win: t }); // schedule a little early
    const lastQ = Math.floor(ctx.length / 128) - 1; // a suspend must fall inside the render
    if (lfoStep) for (let t = lfoStep; t < total; t += lfoStep) { const q = quantum(t); if (q > 0 && q <= lastQ) stops.set(q, { ...stops.get(q), mod: true }); }
    for (const [q, job] of stops) {
      ctx.suspend(q * 128 / sr).then(() => {
        if (job.win) { scheduleWindow(job.win, job.win + WIN); if (opts.onProgress) opts.onProgress(Math.min(1, job.win / total)); }
        if (job.mod) modulate(q * 128 / sr);
        ctx.resume();
      });
    }
    const buf = await ctx.startRendering();
    if (fade) { // fade the finished samples: exact, whatever the render did
      const a = Math.floor(Math.max(0, seconds - fade) * sr), b = Math.min(buf.length, Math.floor(seconds * sr));
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = a; i < d.length; i++) d[i] *= i >= b ? 0 : 1 - (i - a) / (b - a);
      }
    }
    if (opts.onProgress) opts.onProgress(1);
    return toWav(buf, opts.keepTail ? buf.length : Math.ceil(sr * (fade ? total : seconds)));
  }

  // Stems: every audible layer and the drums on their own, same length, aligned at zero.
  async function renderStems(project, opts = {}) {
    const solo = (keep, drums) => {
      const p = JSON.parse(JSON.stringify(project));
      p.layers.forEach(l => { l.solo = false; l.muted = l.id !== keep; });
      p.drums.solo = false;
      p.drums.muted = !drums;
      return p;
    };
    const channels = project.layers.filter(l => audible(l, project) && l.strokes.length).map(l => ({ name: l.name, p: solo(l.id, false) }));
    if (project.drums && drumsAudible(project) && ST.drumsDrawn(project.drums)) channels.push({ name: 'Drums', p: solo(null, true) });
    const out = [];
    for (let i = 0; i < channels.length; i++) {
      const c = channels[i];
      const blob = await renderWav(c.p, { ...opts, keepTail: true, onProgress: f => opts.onProgress && opts.onProgress((i + f) / channels.length) });
      out.push({ name: c.name, blob });
    }
    return out;
  }

  // MIDI: the drawn notes (split where the pitch steps) and the drum hits, for `seconds`.
  const GM_DRUMS = { kick1: 36, kick2: 35, snare1: 38, snare2: 40, snare3: 37, clap: 39, chat: 42, ohat: 46, shaker: 82, conga: 63, tom: 45 };
  function buildMidi(project, seconds) {
    setRootKey(project.key || 0);
    const L = loopLength(project), passes = Math.max(1, Math.ceil(seconds / L - 1e-9)), tracks = [];
    let channel = 0;
    for (const layer of project.layers) {
      if (!audible(layer, project) || !layer.strokes.length) continue;
      const notes = [];
      for (let k = 0; k < passes; k++) {
        for (const n of collectNotes(layer, k, L, project.scale)) {
          const vel = Math.max(30, Math.min(127, n.peak / 0.85 * 110));
          let segStart = 0, cur = Math.round(n.midis[0]);
          const flush = end => {
            const t = k * L + n.start + segStart, dur = end - segStart;
            if (dur >= 0.03 && t < seconds) notes.push({ t, dur: Math.min(dur, seconds - t), note: cur, vel });
          };
          for (let i = 1; i < n.times.length; i++) {
            const m = Math.round(n.midis[i]);
            if (m !== cur) { flush(n.times[i]); segStart = n.times[i]; cur = m; }
          }
          flush(n.dur);
        }
      }
      tracks.push({ name: layer.name, channel, notes });
      channel = channel === 8 ? 10 : (channel + 1) % 16; // channel 10 (index 9) is for drums
    }
    const d = project.drums;
    if (d && drumsAudible(project) && ST.drumsDrawn(d)) {
      const notes = [];
      for (let k = 0; k < passes; k++) {
        for (const h of drumHits(d, project.bars, L, k)) {
          const t = k * L + h.t;
          if (t < seconds) notes.push({ t, dur: 0.06, note: GM_DRUMS[h.id] || 38, vel: Math.max(20, Math.min(127, h.vel * 120)) });
        }
      }
      tracks.push({ name: 'Drums', channel: 9, notes });
    }
    return new Blob([ST.makeMidi(tracks, project.bpm)], { type: 'audio/midi' });
  }

  function toWav(buf, minLen) {
    const ch = buf.numberOfChannels, sr = buf.sampleRate;
    const data = [];
    for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
    let end = buf.length - 1;
    outer: for (; end > 0; end--) for (const d of data) if (Math.abs(d[end]) > 3e-4) break outer;
    const len = Math.min(buf.length, Math.max(minLen, end + Math.floor(sr * 0.25)));
    const view = new DataView(new ArrayBuffer(44 + len * ch * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); view.setUint32(4, 36 + len * ch * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, ch, true);
    view.setUint32(24, sr, true); view.setUint32(28, sr * ch * 2, true); view.setUint16(32, ch * 2, true); view.setUint16(34, 16, true);
    str(36, 'data'); view.setUint32(40, len * ch * 2, true);
    let o = 44;
    for (let i = 0; i < len; i++) {
      for (const d of data) {
        const s = Math.max(-1, Math.min(1, d[i]));
        view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  Object.assign(ST, {
    Engine, REGISTER, pitchLines, LFO_DEFAULT, LFO_RATES, MASTER_DEFAULT, MASTER_RANGES, lfoRange, motionValue, snapMidi: (m, scale) => (SCALE_STEPS[scale] ? snapTo(m - rootKey, SCALE_STEPS[scale]) + rootKey : Math.round(m)), yToMidi, noteName, strokeSpan, renderWav, renderStems, buildMidi, setRootKey, KEY_NAMES: NAMES,
    loopLength, readPos, readPlan, sliceOrder, collectNotes, audible,
  });
})(window.ST = window.ST || {});
