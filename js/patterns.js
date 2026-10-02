// Pattern generator: repeat a small motif across the loop, like a pattern tool
// in a drawing app, but musical. Time (x) repeats, rows stack in pitch (chords),
// climb walks each repeat up or down (arpeggios, staircases). The result is plain
// canvas items, so every knob, the eraser and undo work on them afterwards.
(function (ST) {
  'use strict';

  const ST_PER_HEIGHT = 36; // the canvas spans three octaves

  // Motif shapes: f(u) for u in 0..1, value -1 (low) .. 1 (high).
  const MOTIFS = [
    { id: 'blip', label: 'Blip', f: null, icon: 'M12 12h.01' },
    { id: 'dash', label: 'Dash', f: () => 0, icon: 'M5 12h14' },
    { id: 'rise', label: 'Rise', f: u => u * 2 - 1, icon: 'M5 18L19 6' },
    { id: 'fall', label: 'Fall', f: u => 1 - u * 2, icon: 'M5 6l14 12' },
    { id: 'wave', label: 'Wave', f: u => Math.sin(u * Math.PI * 2), icon: 'M3 12c3-6 6-6 9 0s6 6 9 0' },
    { id: 'zigzag', label: 'Zigzag', f: u => 1 - 4 * Math.abs(((u + 0.25) % 1) - 0.5), icon: 'M3 15l4.5-6 4.5 6 4.5-6 4.5 6' },
    { id: 'steps', label: 'Steps', f: u => Math.min(2, Math.floor(u * 3)) - 1, icon: 'M4 18h5v-5h5V8h6' },
    { id: 'arc', label: 'Arc', f: u => Math.sin(u * Math.PI) * 2 - 1, icon: 'M4 17c2-11 14-11 16 0' },
  ];
  const MOTIF = Object.fromEntries(MOTIFS.map(m => [m.id, m]));

  const PATTERN_DEFAULT = { motif: 'dash', repeats: 8, length: 60, rows: 1, rowGap: 4, climb: 0, cycle: 0, height: 5, offset: 0, random: 0, mirror: false, y: 0.5, seed: 7 };

  // One-tap starting points ("line presets").
  const PATTERN_PRESETS = [
    { id: 'drone', label: 'Drone', v: { motif: 'dash', repeats: 1, length: 100, rows: 1, climb: 0, height: 0, offset: 0, random: 0, mirror: false, y: 0.62 } },
    { id: 'sweep', label: 'Rising sweep', v: { motif: 'rise', repeats: 1, length: 100, rows: 1, climb: 0, height: 14, offset: 0, random: 0, mirror: false, y: 0.5 } },
    { id: 'arp', label: 'Arpeggio', v: { motif: 'dash', repeats: 16, length: 45, rows: 1, climb: 4, cycle: 4, height: 0, offset: 0, random: 0, mirror: false, y: 0.75 } },
    { id: 'heartbeat', label: 'Heartbeat', v: { motif: 'blip', repeats: 8, length: 30, rows: 2, rowGap: 7, climb: 0, height: 0, offset: 12, random: 0, mirror: false, y: 0.7 } },
    { id: 'stabs', label: 'Chord stabs', v: { motif: 'dash', repeats: 8, length: 28, rows: 3, rowGap: 4, climb: 0, height: 0, offset: 0, random: 0, mirror: false, y: 0.55 } },
    { id: 'waves', label: 'Ocean waves', v: { motif: 'wave', repeats: 4, length: 100, rows: 1, climb: 0, height: 6, offset: 0, random: 0, mirror: false, y: 0.5 } },
    { id: 'zigzag', label: 'Zigzag', v: { motif: 'zigzag', repeats: 4, length: 100, rows: 1, climb: 0, height: 7, offset: 0, random: 0, mirror: false, y: 0.45 } },
    { id: 'stairs', label: 'Staircase', v: { motif: 'steps', repeats: 4, length: 100, rows: 1, climb: 3, height: 3, offset: 0, random: 0, mirror: false, y: 0.7 } },
    { id: 'bounce', label: 'Bouncing ball', v: { motif: 'arc', repeats: 6, length: 90, rows: 1, climb: -2, height: 6, offset: 0, random: 0, mirror: false, y: 0.4 } },
    { id: 'callresp', label: 'Call & response', v: { motif: 'rise', repeats: 8, length: 70, rows: 1, climb: 0, height: 5, offset: 0, random: 0, mirror: true, y: 0.5 } },
    { id: 'sparkle', label: 'Sparkle', v: { motif: 'blip', repeats: 24, length: 30, rows: 2, rowGap: 9, climb: 0, height: 0, offset: 25, random: 75, mirror: false, y: 0.35 } },
  ];

  // Repeatable randomness: the same seed gives the same sparkle.
  function rnd(...n) {
    let h = 2166136261;
    for (const v of n) { h ^= v | 0; h = Math.imul(h, 16777619); h ^= h >>> 13; }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
  }
  const clamp01 = v => Math.min(1, Math.max(0, v));

  // cfg -> canvas items ({ size, points } strokes, or one spray item of blips).
  function generate(cfg, size = 'm') {
    const c = { ...PATTERN_DEFAULT, ...cfg }, m = MOTIF[c.motif] || MOTIF.dash;
    const reps = Math.max(1, Math.round(c.repeats)), rows = Math.max(1, Math.round(c.rows));
    const cellW = 1 / reps, len = Math.max(0.05, c.length / 100) * cellW, rand = c.random / 100;
    const items = [], dots = [];
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < reps; i++) {
        const jx = rand ? (rnd(c.seed, r, i, 1) - 0.5) * cellW * 0.5 * rand : 0;
        const jy = rand ? (rnd(c.seed, r, i, 2) - 0.5) * 14 * rand : 0;
        const x0 = i * cellW + (r % 2 ? c.offset / 100 * cellW : 0) + jx;
        if (x0 >= 1 || x0 < -cellW) continue;
        const step = c.cycle > 0 ? i % Math.round(c.cycle) : i; // climb restarts every `cycle` repeats
        const semis = r * c.rowGap + step * c.climb + jy; // up from the base pitch
        const base = c.y - semis / ST_PER_HEIGHT;
        const flip = c.mirror && i % 2 ? -1 : 1;
        if (!m.f) { dots.push([clamp01(x0), clamp01(base)]); continue; }
        const n = m.id === 'dash' || m.id === 'rise' || m.id === 'fall' ? 2 : m.id === 'steps' ? 0 : 24;
        const pts = [];
        if (m.id === 'steps') { // hard corners for steps
          for (let k = 0; k < 3; k++) {
            const y = base - flip * m.f((k + 0.5) / 3) * c.height / ST_PER_HEIGHT;
            pts.push([x0 + len * k / 3, y], [x0 + len * (k + 1) / 3, y]);
          }
        } else {
          for (let k = 0; k < n; k++) {
            const u = k / (n - 1);
            pts.push([x0 + len * u, base - flip * m.f(u) * c.height / ST_PER_HEIGHT]);
          }
        }
        const kept = pts.filter(p => p[0] >= 0 && p[0] <= 1).map(([x, y]) => [x, clamp01(y)]);
        if (kept.length) items.push({ size, points: kept.length === 1 ? [kept[0], kept[0]] : kept });
      }
    }
    if (dots.length) items.push({ kind: 'spray', size, dots });
    return items;
  }

  Object.assign(ST, { PATTERN_MOTIFS: MOTIFS, PATTERN_DEFAULT, PATTERN_PRESETS, generatePattern: generate });
})(window.ST = window.ST || {});
