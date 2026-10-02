// Drum strip: a generative drummer, its synthesized kit and the drum bus.
// Eight macro knobs (kicks, snares, hats, percs, fills, gaps, dirt, evolve) and a
// drawn energy line drive the engine; it writes the hits bar by bar, thinks in
// phrases (fills before a new phrase, drop-outs before the downbeat) and can
// listen to the melody.
(function (ST) {
  'use strict';

  // Lanes top to bottom, as shown in the strip.
  const DRUMS = [
    { id: 'ohat', label: 'Open hat' },
    { id: 'chat', label: 'Closed hat' },
    { id: 'shaker', label: 'Shaker' },
    { id: 'clap', label: 'Clap' },
    { id: 'snare3', label: 'Rim' },
    { id: 'snare2', label: 'Ghost snare' },
    { id: 'snare1', label: 'Snare' },
    { id: 'conga', label: 'Conga' },
    { id: 'tom', label: 'Tom' },
    { id: 'kick2', label: 'Boom kick' },
    { id: 'kick1', label: 'Kick' },
  ];
  const LANE = Object.fromEntries(DRUMS.map((d, i) => [d.id, i]));

  // The eight macros, in MPK knob order (K1..K8 in drum mode).
  const MACROS = [
    { key: 'kicks', label: 'Kicks', hint: 'How many kicks: from one per bar to eight, spread evenly' },
    { key: 'snares', label: 'Snares', hint: 'Backbeat, then ghost notes, claps and rims' },
    { key: 'hats', label: 'Hats', hint: 'Offbeats, eighths, sixteenths, then rolls' },
    { key: 'percs', label: 'Percs', hint: 'Shaker, congas and toms that answer the kick' },
    { key: 'fills', label: 'Fills', hint: 'How often a fill leads into a new phrase, and how wild' },
    { key: 'gaps', label: 'Gaps', hint: 'Silence as a tool: drop-outs, stops and missing parts' },
    { key: 'dirt', label: 'Dirt', hint: 'Distortion and crunch; harder hits get dirtier' },
    { key: 'evolve', label: 'Evolve', hint: 'Locked loop at zero, a new variation every bar at the top' },
  ];

  // Style tiles set all the macros at once.
  const STYLES = [
    { id: 'house', label: 'Four on the floor', v: { kicks: 50, snares: 30, hats: 35, percs: 25, fills: 30, gaps: 20, dirt: 0, evolve: 15, swing: 10 } },
    { id: 'trance', label: 'Trance', v: { kicks: 50, snares: 25, hats: 80, percs: 10, fills: 60, gaps: 35, dirt: 10, evolve: 10, swing: 0 } },
    { id: 'broken', label: 'Broken beat', v: { kicks: 65, snares: 62, hats: 60, percs: 35, fills: 50, gaps: 30, dirt: 20, evolve: 40, swing: 22 } },
    { id: 'minimal', label: 'Minimal', v: { kicks: 30, snares: 12, hats: 30, percs: 50, fills: 15, gaps: 45, dirt: 0, evolve: 30, swing: 28 } },
    { id: 'industrial', label: 'Industrial', v: { kicks: 70, snares: 55, hats: 55, percs: 30, fills: 40, gaps: 40, dirt: 85, evolve: 30, swing: 0 } },
    { id: 'afro', label: 'Afro percs', v: { kicks: 40, snares: 20, hats: 40, percs: 88, fills: 35, gaps: 25, dirt: 0, evolve: 35, swing: 32 } },
    { id: 'jungle', label: 'Jungle', v: { kicks: 58, snares: 82, hats: 85, percs: 30, fills: 70, gaps: 35, dirt: 15, evolve: 60, swing: 14 } },
    { id: 'chaos', label: 'Chaos', v: { kicks: 80, snares: 88, hats: 92, percs: 72, fills: 85, gaps: 60, dirt: 55, evolve: 95, swing: 30 } },
  ];

  const KIT_SOUND = {}; // filled once the kits are defined below
  const CURVE = 128; // energy samples across the loop; -1 is a gap (no drums)

  const DRUM_COLOR = '#f4511e';
  function defaultDrums() {
    return {
      v: 2, name: 'Drums', color: DRUM_COLOR, curve: Array(CURVE).fill(-1), muted: false, solo: false,
      preset: 'analog', sound: { ...DRUM_SOUND, ...KIT_SOUND.analog }, fx: ST.defaultFx(),
      ...STYLES[0].v, energy: 50, listen: 0, morph: 0, volume: 0.8,
      seed: 1 + Math.floor(Math.random() * 1e6), seedB: null,
    };
  }

  // Projects from the first drum strip (drawn lane lines) start from a flat line.
  function migrateDrums(old) {
    const d = { ...defaultDrums(), ...(old && old.v === 2 ? old : {}) };
    if (old && old.v !== 2) {
      for (const k of ['volume', 'swing', 'seed', 'muted']) if (old[k] !== undefined) d[k] = old[k];
      if (old.lines && old.lines.length) d.curve = Array(CURVE).fill(0.6);
    }
    if (!Array.isArray(d.curve) || d.curve.length !== CURVE) d.curve = Array(CURVE).fill(-1);
    const fx = ST.defaultFx();
    for (const id in fx) fx[id] = { ...fx[id], ...(d.fx || {})[id] };
    Object.assign(d, { name: 'Drums', color: DRUM_COLOR, fx, sound: { ...DRUM_SOUND, ...d.sound }, solo: !!d.solo });
    return d;
  }

  // Repeatable pseudo-random numbers: same inputs, same pattern every loop.
  function rnd(...n) {
    let h = 2166136261;
    for (const v of n) { h ^= v | 0; h = Math.imul(h, 16777619); h ^= h >>> 13; }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
  }

  // p hits spread as evenly as possible over n steps (a Euclidean rhythm).
  const euclid = (p, n, rot = 0) => {
    const out = new Set();
    for (let i = 0; i < n; i++) if ((i * p) % n < p) out.add((i + rot) % n);
    return out;
  };
  const clamp01 = v => Math.min(1, Math.max(0, v));
  const drawn = d => (d.frozen ? (d.pattern || []).length > 0 : d.curve.some(v => v >= 0));

  // Every hit of loop pass k: { id, lane, t, vel, dirt, tune, step, fill }.
  // `melody` (optional) is how busy and high the melody is on each 16th, 0..1.
  // A frozen groove: fixed hits you can edit, still with swing, dirt and per-hit chance.
  function frozenHits(d, bars, L, k) {
    const steps = bars * 16, stepDur = L / steps, out = [];
    out.fills = [];
    out.stops = [];
    const dirt = d.dirt / 100;
    for (const h of d.pattern || []) {
      if (h.step >= steps) continue;
      if (h.prob < 1 && rnd(d.seed, 0xf2, k, h.step, h.lane) >= h.prob) continue;
      const swing = h.step % 2 ? d.swing / 100 * stepDur * 0.5 : 0;
      const grit = dirt ? Math.min(1, dirt * (0.35 + h.vel * 0.8)) : 0;
      out.push({ id: DRUMS[h.lane].id, lane: h.lane, t: h.step * stepDur + swing, vel: h.vel, dirt: grit, step: h.step, tune: h.tune || 1 });
    }
    return out;
  }

  function drumHits(d, bars, L, k, melody) {
    if (d.frozen) return frozenHits(d, bars, L, k);
    const steps = bars * 16, stepDur = L / steps, out = [];
    out.fills = [];
    out.stops = [];
    if (!drawn(d)) return out;
    // Decisions are keyed so Morph can blend two grooves decision by decision.
    const pick = (...n) => (d.seedB != null && rnd(0x5eed, ...n) < d.morph / 100 ? d.seedB : d.seed);
    const R = (...n) => rnd(pick(...n), ...n);
    const E = d.energy / 50, listen = d.listen / 100;
    const energyAt = s => {
      const c = d.curve[Math.min(CURVE - 1, Math.floor((s + 0.5) / steps * CURVE))];
      if (c < 0) return -1;
      let e = c * E;
      if (melody && listen) e *= 1 - listen + listen * melody[s] * 1.6;
      return clamp01(e);
    };
    const phrase = d.fills > 66 ? 2 : d.fills > 33 ? 4 : 8;
    const kicks = d.kicks / 100, snares = d.snares / 100, hats = d.hats / 100, percs = d.percs / 100;
    const fills = d.fills / 100, gaps = d.gaps / 100, dirt = d.dirt / 100;

    const add = (id, s, vel, sub = 0, extra = {}) => {
      const swing = s % 2 && !sub ? d.swing / 100 * stepDur * 0.5 : 0;
      const jitter = (R(7, LANE[id], s, sub * 13) - 0.5) * 0.006;
      const t = Math.max(0, s * stepDur + swing + jitter + sub);
      const v = Math.max(0.12, Math.min(1, vel));
      const grit = dirt ? clamp01(dirt * (0.35 + v * 0.8) * (0.7 + 0.6 * R(17, s, LANE[id]))) : 0;
      out.push({ id, lane: LANE[id], t, vel: v, dirt: grit, step: s, tune: 1, ...extra });
    };

    for (let bar = 0; bar < bars; bar++) {
      const G = k * bars + bar; // bar count since Play: phrases run across loop passes
      const mutate = R(0xe7, G) < d.evolve / 100;
      const V = mutate ? 7919 + G : bar; // which variation this bar plays
      const b0 = bar * 16;
      let eSum = 0, eN = 0;
      for (let i = 0; i < 16; i++) { const e = energyAt(b0 + i); if (e >= 0) { eSum += e; eN++; } }
      if (!eN) continue;
      const eBar = eSum / eN;

      // phrase shape: a fill (and maybe a stop) at the end, a big downbeat after it
      const fillBar = fills > 0 && (G + 1) % phrase === 0;
      const downbeat = G > 0 && G % phrase === 0;
      const stop = fillBar && R(1, V, G) < gaps * 0.8; // silence on the last beat
      const fillLen = fillBar ? Math.min(16, 4 + Math.round(fills * 8 + R(2, V) * fills * 4)) : 0;
      const fillEnd = stop ? 12 : 16, fillStart = fillEnd - fillLen;
      const noKick = !fillBar && !downbeat && R(3, V, G) < gaps * 0.3; // breakdown bar
      const dropFam = R(4, V, G) < gaps * 0.4 ? ['hats', 'percs', 'snares'][Math.floor(R(5, V, G) * 3)] : null;
      if (fillBar) out.fills.push([(b0 + Math.max(0, fillStart)) * stepDur, (b0 + fillEnd) * stepDur]);
      if (stop) out.stops.push([(b0 + 12) * stepDur, (b0 + 16) * stepDur]);

      // kicks: an even spread, busier with energy, sometimes shifted
      const kp = Math.round(kicks * 8 * (0.55 + 0.9 * eBar));
      const krot = R(6, V) < kicks * 0.35 ? [0, 2, 3, 6, 10][Math.floor(R(7, V) * 5)] : 0;
      const kset = kp ? euclid(Math.min(12, kp), 16, krot) : new Set();
      if (kp) kset.add(0);
      // congas answer the kick: an even spread moved off the kick steps
      const cn = [3, 5, 7, 9][Math.min(3, Math.floor(percs * 4))];
      const cset = [...euclid(cn, 16, Math.floor(R(8, V) * 16))].map(i => (kset.has(i) ? (i + 1) % 16 : i));
      const rims = euclid(R(9, V) < 0.5 ? 3 : 5, 16, Math.floor(R(10, V) * 16));
      const openHat = hats > 0.35 && R(11, V) < (hats - 0.3) * 1.2;
      const clapOn = snares > 0.55 && R(12, V) < (snares - 0.5) * 2.5;

      for (let i = 0; i < 16; i++) {
        const s = b0 + i, e = energyAt(s);
        if (e < 0 || (stop && i >= 12)) continue;
        const acc = i % 4 === 0 ? 1 : i % 2 === 0 ? 0.8 : 0.62;
        const inFill = fillBar && i >= fillStart && i < fillEnd;

        if (inFill) { // the fill replaces snares, hats and percs; the kick keeps time lightly
          const u = (i - fillStart) / Math.max(1, fillLen - 1), kind = Math.floor(R(13, V) * 3);
          if (i === fillStart && kicks) add('kick1', s, 0.9);
          if (R(14, V, i) < 0.35 + fills * 0.6) {
            const id = kind === 0 ? 'snare1' : kind === 1 ? 'tom' : (i % 2 ? 'tom' : 'snare1');
            const vel = (0.45 + 0.55 * u) * (0.8 + 0.2 * e);
            const tune = id === 'tom' ? 1.5 - u * 0.8 : 1 + u * 0.15; // toms fall, snare rises
            add(id, s, vel, 0, { tune, fill: true });
            if (u > 0.5 && R(15, V, i) < fills * 0.7) { // rolls speed up at the end
              const r = fills > 0.75 ? 3 : 2;
              for (let j = 1; j < r; j++) add(id, s, vel * 0.8, j * stepDur / r, { tune, fill: true });
            }
          }
          continue;
        }

        // kick
        if (kicks && !noKick && kset.has(i) && (i === 0 || R(16, V, i) < 0.55 + e * 0.6)) {
          add(i === 0 && downbeat ? 'kick2' : 'kick1', s, i === 0 ? 1 : 0.82 + 0.15 * e);
          if (i === 0 && downbeat) add('kick1', s, 0.9);
        } else if (kicks > 0.6 && !noKick && kset.has((i + 1) % 16) && R(17, V, i) < (kicks - 0.6) * e * 1.5) {
          add('kick1', s, 0.5); // ghost kick just before a main one
        }
        // snares
        if (snares > 0.04 && dropFam !== 'snares') {
          const back = i === 4 || i === 12;
          if (back && (i === 12 || e > 0.18)) {
            add('snare1', s, 0.95 * acc);
            if (clapOn) add('clap', s, 0.85);
          } else if (snares > 0.3 && i % 2 && R(18, V, i) < (snares - 0.3) * 0.5 * (0.4 + e)) {
            add('snare2', s, 0.25 + R(19, V, i) * 0.25);
          }
          if (snares > 0.7 && rims.has(i) && !back && R(20, V, i) < 0.4 + e * 0.6) add('snare3', s, 0.55 * acc + 0.2);
        }
        // hats
        if (hats > 0.04 && dropFam !== 'hats') {
          const h = hats * (0.5 + e);
          let on = false;
          if (h < 0.2) on = i % 4 === 2;
          else if (h < 0.45) on = i % 2 === 0;
          else on = i % 2 === 0 || R(21, V, i) < 0.35 + h * 0.5;
          if (on) {
            const open = openHat && i % 4 === 2 && R(22, V, i) < 0.75;
            add(open ? 'ohat' : 'chat', s, (open ? 0.7 : 0.55) * (i % 4 === 2 ? 1 : acc) + e * 0.2);
            if (!open && h >= 0.8 && i % 2 && R(23, V, i) < (h - 0.75) * 1.5) { // rolls
              const r = R(24, V, i) < 0.5 ? 2 : 3;
              for (let j = 1; j < r; j++) add('chat', s, 0.35, j * stepDur / r);
            }
          }
        }
        // percs
        if (percs > 0.04 && dropFam !== 'percs') {
          if (percs > 0.15 && R(25, V, i) < percs * 0.7 * (0.3 + e)) add('shaker', s, 0.3 + R(26, V, i) * 0.3 + (i % 2 ? 0 : 0.1));
          if (cset.includes(i) && R(27, V, i) < 0.6 + e * 0.4) add('conga', s, 0.5 + 0.3 * acc, 0, { tune: R(28, V, i) < 0.35 ? 1.35 : 1 });
          if (percs > 0.6 && i === 14 && R(29, V) < percs - 0.4) add('tom', s, 0.6, 0, { tune: 1.2 });
        }
      }
    }
    return out;
  }

  // ---------- synthesis ----------
  // The drum layer has its own sound design, like a canvas layer: a kit (Source),
  // tune / tone / punch / snap, and an attack-hold-length shape (ADSR card).
  const DRUM_SOUND = { kit: 'analog', tune: 0, tone: 50, punch: 45, snap: 50, attack: 0, hold: 0, length: 1 };

  // What each kit starts from. kick: [start Hz, end Hz, sweep s, decay s].
  const KIT_BASE = {
    analog: { level: 1, kick: [150, 46, 0.09, 0.7], click: 0.25, thump: 0, snare: [185, 330], noise: 1600, metal: 1, air: 0.25, bright: 1, len: 1, fm: 0 },
    punchy: { level: 0.6, kick: [230, 52, 0.045, 0.42], click: 0.85, thump: 0.25, snare: [200, 360], noise: 2400, metal: 0.5, air: 0.8, bright: 1.15, len: 0.9, fm: 0 },
    lofi: { level: 1.15, kick: [140, 50, 0.07, 0.45], click: 0.15, thump: 0.35, snare: [190, 0], noise: 1400, metal: 0.3, air: 0.9, bright: 0.38, len: 0.75, fm: 0 },
    acoustic: { level: 0.85, kick: [95, 55, 0.03, 0.32], click: 0.5, thump: 0.9, snare: [215, 0], noise: 3800, metal: 0.12, air: 1, bright: 1, len: 1, fm: 0 },
    metal: { level: 0.8, kick: [170, 45, 0.07, 0.5], click: 0.4, thump: 0, snare: [240, 437], noise: 2800, metal: 1.3, air: 0.3, bright: 1.3, len: 1.1, fm: 1 },
    boom: { level: 0.8, kick: [120, 40, 0.18, 1.6], click: 0.2, thump: 0, snare: [200, 0], noise: 3200, metal: 0.4, air: 1, bright: 1.2, len: 1, fm: 0 },
    techno: { level: 0.66, kick: [200, 48, 0.035, 0.36], click: 1, thump: 0.4, snare: [180, 280], noise: 1900, metal: 0.8, air: 0.6, bright: 0.85, len: 0.85, fm: 0.3 },
    dusty: { level: 1.02, kick: [105, 52, 0.035, 0.3], click: 0.35, thump: 1, snare: [205, 0], noise: 3000, metal: 0.1, air: 1, bright: 0.62, len: 0.95, fm: 0 },
  };
  const KITS = [
    { id: 'analog', label: 'Analog', sound: { tone: 50, punch: 40, snap: 45, length: 1.2 } },
    { id: 'punchy', label: 'Punchy', sound: { tone: 60, punch: 75, snap: 60, hold: 0.01, length: 0.9 } },
    { id: 'lofi', label: 'Lo-fi tape', sound: { tune: -2, tone: 35, punch: 30, snap: 40, attack: 0.004, length: 0.85 } },
    { id: 'acoustic', label: 'Acoustic', sound: { tone: 55, punch: 55, snap: 72, length: 1 } },
    { id: 'metal', label: 'Metal', sound: { tone: 68, punch: 60, snap: 55, hold: 0.005, length: 1.1 } },
    { id: 'boom', label: '808 boom', sound: { tune: -2, tone: 58, punch: 35, snap: 65, length: 1.3 } },
    { id: 'techno', label: 'Techno', sound: { tone: 45, punch: 85, snap: 40, hold: 0.015, length: 0.9 } },
    { id: 'dusty', label: 'Dusty break', sound: { tune: 1, tone: 42, punch: 50, snap: 75, attack: 0.002, length: 0.95 } },
  ].map(k => ({ ...k, sound: { ...DRUM_SOUND, ...k.sound, kit: k.id } }));
  for (const k of KITS) KIT_SOUND[k.id] = k.sound;

  const ms = v => `${Math.round(v * 1000)} ms`;
  const DRUM_PANELS = {
    source: [
      { key: 'tune', label: 'Tune', min: -12, max: 12, step: 1, fmt: v => `${v > 0 ? '+' : ''}${v} st`, hint: 'The whole kit lower or higher' },
      { key: 'tone', label: 'Tone', min: 0, max: 100, step: 1, fmt: v => `${Math.round(v)}`, hint: 'Dark to bright' },
      { key: 'punch', label: 'Punch', min: 0, max: 100, step: 1, fmt: v => `${Math.round(v)}`, hint: 'The click and knock at the start of each hit' },
      { key: 'snap', label: 'Snap', min: 0, max: 100, step: 1, fmt: v => `${Math.round(v)}`, hint: 'Snares and claps: round body to crisp noise' },
    ],
    envelope: [
      { key: 'attack', label: 'Attack', min: 0, max: 0.05, step: 0.001, fmt: ms, hint: 'Hard hit to soft start' },
      { key: 'hold', label: 'Hold', min: 0, max: 0.2, step: 0.005, fmt: ms, hint: 'Full level before the fade' },
      { key: 'length', label: 'Length', min: 0.3, max: 3, step: 0.05, fmt: v => `${v.toFixed(2)}×`, hint: 'Short and tight to long and ringing' },
    ],
  };

  const noiseBufs = new WeakMap();
  function noise(ctx) {
    let b = noiseBufs.get(ctx);
    if (!b) {
      b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      noiseBufs.set(ctx, b);
    }
    return b;
  }
  const hz = f => Math.min(18000, Math.max(30, f));

  // Attack (at least the part's own), hold, then an exponential fade scaled by Length.
  function env(ctx, S, t, peak, attack, decay) {
    const g = ctx.createGain(), a = Math.max(0.0008, attack, S.a), end = t + a + S.h + decay * S.len;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    if (S.h) g.gain.setValueAtTime(peak, t + a + S.h);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    return [g, end];
  }

  function tone(ctx, dest, S, t, type, f0, f1, sweep, peak, decay, fm = 0) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(hz(f0), t);
    o.frequency.exponentialRampToValueAtTime(hz(f1), t + sweep);
    const [g, end] = env(ctx, S, t, peak, 0.001, decay);
    if (fm) { // metallic, inharmonic edge
      const m = ctx.createOscillator(), mg = ctx.createGain();
      m.frequency.value = f1 * 1.47;
      mg.gain.setValueAtTime(f1 * fm * 4, t);
      mg.gain.exponentialRampToValueAtTime(1, t + decay * S.len * 0.6 + 0.01);
      m.connect(mg).connect(o.frequency);
      m.start(t);
      m.stop(end + 0.05);
    }
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(end + 0.05);
  }

  function hiss(ctx, dest, S, t, type, freq, q, peak, attack, decay) {
    const s = ctx.createBufferSource();
    s.buffer = noise(ctx);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = hz(freq);
    f.Q.value = q;
    const [g, end] = env(ctx, S, t, peak, attack, decay);
    s.connect(f).connect(g).connect(dest);
    s.start(t, Math.random() * 0.5);
    s.stop(end + 0.05);
  }

  // Six detuned squares through band and high pass: the classic machine cymbal.
  function metal(ctx, dest, S, t, peak, decay, hp) {
    const mix = ctx.createGain(), bp = ctx.createBiquadFilter(), hi = ctx.createBiquadFilter();
    mix.gain.value = 1 / 6;
    bp.type = 'bandpass'; bp.frequency.value = hz(10000 * S.br); bp.Q.value = 0.8;
    hi.type = 'highpass'; hi.frequency.value = hz(hp * S.br);
    const [g, end] = env(ctx, S, t, peak, 0.0008, decay);
    mix.connect(bp).connect(hi).connect(g).connect(dest);
    for (const f of [205.3, 304.4, 369.6, 522.7, 540, 800]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f * S.f * (S.K.fm ? 1.13 : 1);
      o.connect(mix);
      o.start(t);
      o.stop(end + 0.05);
    }
  }

  function snare(ctx, dest, S, t, v, short) {
    const K = S.K, n = short ? 0.6 : 1, body = 1 - S.snap * 0.65;
    tone(ctx, dest, S, t, 'triangle', K.snare[0] * S.f * 1.2, K.snare[0] * S.f, 0.03, 0.55 * body * v, 0.12 * n, K.fm * 0.3);
    if (K.snare[1]) tone(ctx, dest, S, t, 'sine', K.snare[1] * S.f, K.snare[1] * S.f * 0.95, 0.02, 0.3 * body * v, 0.07 * n);
    hiss(ctx, dest, S, t, 'highpass', K.noise * S.br * 0.8, 0.7, (0.3 + 0.6 * S.snap) * v, 0.001, (0.16 + 0.1 * S.snap) * n);
    hiss(ctx, dest, S, t, 'bandpass', K.noise * S.br * 1.8, 1, 0.25 * S.snap * v, 0.001, 0.09 * n);
    if (S.punch > 0.6) hiss(ctx, dest, S, t, 'highpass', 4000 * S.br, 0.7, 0.15 * (S.punch - 0.6) * v, 0.0005, 0.008);
  }

  function hit(ctx, dest, id, t, vel, tune = 1, snd = DRUM_SOUND) {
    const K = KIT_BASE[snd.kit] || KIT_BASE.analog, v = vel * K.level; // kits level-matched
    const S = {
      K, f: 2 ** ((snd.tune || 0) / 12), br: 2 ** (((snd.tone ?? 50) - 50) / 30) * K.bright,
      punch: (snd.punch ?? 45) / 50, snap: (snd.snap ?? 50) / 100, a: snd.attack || 0, h: snd.hold || 0, len: (snd.length || 1) * K.len,
    };
    if (S.br < 0.8) { // dark kits and low Tone: a gentle lowpass over the whole hit
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = hz(9000 * S.br);
      lp.connect(dest);
      dest = lp;
    }
    const f = S.f * tune;
    switch (id) {
      case 'kick1': {
        const [f0, f1, sw, dec] = K.kick;
        tone(ctx, dest, S, t, 'sine', f0 * f * (0.8 + 0.25 * S.punch), f1 * f, sw * (1.4 - 0.4 * S.punch), v, dec, K.fm * 0.6);
        hiss(ctx, dest, S, t, 'highpass', 1800 * S.br, 0.7, (0.1 + 0.3 * K.click * S.punch) * v, 0.0005, 0.012);
        if (K.click > 0.5) tone(ctx, dest, S, t, 'square', f0 * f * 2, f0 * f, 0.015, 0.1 * K.click * S.punch * v, 0.02);
        if (K.thump) hiss(ctx, dest, S, t, 'lowpass', 220, 1, 0.5 * K.thump * v, 0.001, 0.06);
        break;
      }
      case 'kick2': { // the big one on phrase downbeats
        const [f0, f1, sw, dec] = K.kick;
        tone(ctx, dest, S, t, 'sine', f0 * f * 0.8, f1 * f * 0.88, sw * 2.5, 0.95 * v, dec * 1.8);
        tone(ctx, dest, S, t, 'triangle', f1 * f * 2.2, f1 * f * 1.2, 0.05, 0.22 * v, 0.08);
        hiss(ctx, dest, S, t, 'highpass', 1500 * S.br, 0.7, (0.08 + 0.25 * K.click * S.punch) * v, 0.0005, 0.015);
        break;
      }
      case 'snare1': snare(ctx, dest, { ...S, f }, t, v, false); break;
      case 'snare2': snare(ctx, dest, { ...S, f }, t, v * 0.85, true); break;
      case 'snare3': // rim
        tone(ctx, dest, S, t, 'triangle', 1700 * f, 1600 * f, 0.01, 0.42 * v, 0.03, K.fm * 0.4);
        tone(ctx, dest, S, t, 'square', 450 * f, 440 * f, 0.01, 0.12 * v, 0.02);
        hiss(ctx, dest, S, t, 'bandpass', 3500 * S.br, 2, 0.25 * v, 0.0005, 0.025);
        break;
      case 'clap': {
        const fq = 1100 * S.br * (1 + 0.4 * S.snap);
        for (const dt of [0, 0.009, 0.018, 0.027]) hiss(ctx, dest, S, t + dt, 'bandpass', fq, 1.4, 0.5 * v, 0.001, 0.008);
        hiss(ctx, dest, S, t + 0.027, 'bandpass', fq * 1.1, 0.9, 0.5 * v, 0.002, 0.14 + 0.12 * S.snap);
        break;
      }
      case 'chat':
        metal(ctx, dest, S, t, 0.22 * K.metal * v, 0.045, 7000);
        hiss(ctx, dest, S, t, 'highpass', 7500 * S.br, 0.7, 0.3 * K.air * v, 0.0008, 0.04);
        break;
      case 'ohat':
        metal(ctx, dest, S, t, 0.2 * K.metal * v, 0.34, 6500);
        hiss(ctx, dest, S, t, 'highpass', 7000 * S.br, 0.7, 0.24 * K.air * v, 0.002, 0.3);
        break;
      case 'shaker':
        hiss(ctx, dest, S, t, 'bandpass', 5200 * S.br, 2, 0.3 * v, 0.006, K === KIT_BASE.acoustic ? 0.09 : 0.06);
        break;
      case 'conga':
        tone(ctx, dest, S, t, 'sine', 245 * f, 205 * f, 0.04, 0.6 * v, 0.24, K.fm * 0.5);
        hiss(ctx, dest, S, t, 'bandpass', 1000 * S.br, 1.5, (0.06 + 0.12 * S.punch) * v, 0.0005, 0.02);
        break;
      case 'tom':
        tone(ctx, dest, S, t, 'sine', 155 * f, 92 * f, 0.2, 0.78 * v, 0.34, K.fm * 0.4);
        if (K.thump > 0.5) hiss(ctx, dest, S, t, 'lowpass', 900 * S.br, 0.8, 0.18 * v, 0.001, 0.05);
        break;
      default:
    }
  }

  // Dirt: a hard tanh drive, then a bit-crush staircase once dirt passes 50%.
  const curves = new Map();
  function dirtCurve(amount) {
    const key = Math.round(amount * 20);
    if (curves.has(key)) return curves.get(key);
    const n = 4096, c = new Float32Array(n), a = key / 20, k = 3 + a * 22, norm = Math.tanh(k);
    const levels = a > 0.5 ? Math.round(2 ** (7 - (a - 0.5) * 9)) : 0;
    for (let i = 0; i < n; i++) {
      let y = Math.tanh(k * (i / (n - 1) * 2 - 1)) / norm;
      if (levels) y = Math.round(y * levels) / levels;
      c[i] = y;
    }
    curves.set(key, c);
    return c;
  }

  // clean input ─────────────┐
  // dirty input -> drive ────┴-> glue compressor -> volume -> dest
  function makeDrumBus(ctx, dest) {
    const bus = { input: ctx.createGain(), dirty: ctx.createGain(), shaper: ctx.createWaveShaper(), makeup: ctx.createGain(), comp: ctx.createDynamicsCompressor(), out: ctx.createGain() };
    bus.input.gain.value = 0.8;
    bus.dirty.gain.value = 0.8;
    bus.shaper.oversample = '2x';
    bus.comp.threshold.value = -12;
    bus.comp.ratio.value = 3;
    bus.comp.attack.value = 0.005;
    bus.comp.release.value = 0.12;
    bus.input.connect(bus.comp);
    bus.dirty.connect(bus.shaper).connect(bus.makeup).connect(bus.comp);
    bus.comp.connect(bus.out).connect(dest);
    return bus;
  }

  function configureDrumBus(bus, ctx, d, now, on = !d.muted) {
    const a = d.dirt / 100;
    bus.shaper.curve = dirtCurve(a);
    const makeup = 0.5 - a * 0.25, v = on ? d.volume : 0;
    if (now) { bus.out.gain.value = v; bus.makeup.gain.value = makeup; }
    else { bus.out.gain.setTargetAtTime(v, ctx.currentTime, 0.03); bus.makeup.gain.setTargetAtTime(makeup, ctx.currentTime, 0.03); }
  }

  // One generated hit, split between the clean and the dirty path by its own dirt.
  function playHit(ctx, bus, h, t, snd) {
    if (!h.dirt) { hit(ctx, bus.input, h.id, t, h.vel, h.tune, snd); return; }
    const send = ctx.createGain(), clean = ctx.createGain(), dirty = ctx.createGain();
    clean.gain.value = 1 - h.dirt;
    dirty.gain.value = h.dirt;
    send.connect(clean).connect(bus.input);
    send.connect(dirty).connect(bus.dirty);
    hit(ctx, send, h.id, t, h.vel, h.tune, snd);
  }

  Object.assign(ST, { DRUMS, DRUM_LANE: LANE, DRUM_MACROS: MACROS, DRUM_STYLES: STYLES, DRUM_CURVE: CURVE, DRUM_SOUND, DRUM_KITS: KITS, DRUM_PANELS, DRUM_COLOR, defaultDrums, migrateDrums, drumsDrawn: drawn, drumHits, drumHit: hit, playDrumHit: playHit, makeDrumBus, configureDrumBus });
})(window.ST = window.ST || {});
