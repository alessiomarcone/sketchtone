// Drawing tools and items: freehand/line strokes, rectangles, ellipses, spray.
// Items keep their drawn geometry; an optional transform `tf` (moved, stretched,
// wiggled, tilted, louder) is applied on top, so knob edits are never destructive.
(function (ST) {
  'use strict';

  const TOOLS = [
    { id: 'select', label: 'Select', key: 'v', hint: 'Click a line to pick it. Drag to move it, turn the knobs to reshape it, Delete removes it.', icon: 'M6 3l12 9-5.5 1L10 19z' },
    { id: 'pencil', label: 'Pencil', key: 'p', hint: 'Draw freely: the line is your melody.', icon: 'M4 20l4-1L18.5 8.5l-3-3L5 16l-1 4zM13.5 7.5l3 3' },
    { id: 'line', label: 'Line', key: 'l', hint: 'Straight line: a glide between two notes. Hold Shift for a flat note.', icon: 'M5 19L19 5' },
    { id: 'rect', label: 'Rectangle', key: 'r', hint: 'Top and bottom edges play together. Filled plays a full chord. Shift makes a square.', icon: 'M4 6h16v12H4z' },
    { id: 'ellipse', label: 'Ellipse', key: 'o', hint: 'Two voices spread apart and meet again. Filled swells like a chord. Shift makes a circle.', icon: 'M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z' },
    { id: 'text', label: 'Text', key: 't', hint: 'Click and type: a robot voice sings your words. Drag first to set how long and which way the pitch goes.', icon: 'M5 6h14M12 6v13M9 19h6' },
    { id: 'spray', label: 'Spray', key: 's', hint: 'Hold to scatter short, sparkly notes.', icon: 'M6 11h7v9H6zM8 11V8h3v3M16 7h.01M19 5h.01M18.5 10h.01M21.5 8h.01M16.5 13h.01M20 13.5h.01' },
    { id: 'erase', label: 'Eraser', key: 'e', hint: 'Drag over anything to remove it.', icon: 'M4 15.5l8.5-8.5 6 6-6.5 6.5H8zM9 20h11M9.5 10l6 6' },
  ];

  const TF_IDENTITY = { dx: 0, dy: 0, waves: 0, amp: 0, sx: 1, sy: 1, tilt: 0, gain: 1 };
  const tfOf = it => ({ ...TF_IDENTITY, ...it.tf });
  const hasTf = it => !!it.tf && Object.keys(TF_IDENTITY).some(k => it.tf[k] !== undefined && it.tf[k] !== TF_IDENTITY[k]);
  const clamp01 = v => Math.min(1, Math.max(0, v));

  const box = it => {
    const [x0, y0, x1, y1] = it.box;
    return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  };

  function ellipsePoly(b) {
    const [x0, y0, x1, y1] = b, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
    return Array.from({ length: 49 }, (_, i) => {
      const a = i / 48 * Math.PI * 2;
      return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
    });
  }

  // Geometry as drawn, before any transform.
  function baseGeom(it) {
    if (it.dots) return { dots: it.dots };
    if (it.points) return { points: it.points };
    const b = box(it);
    if (it.kind === 'rect') return { poly: [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]] };
    return { poly: ellipsePoly(b) };
  }

  // Bounds of the drawn geometry: the transform stretches and tilts around its centre.
  const boundsCache = new WeakMap();
  function baseBounds(it) {
    let b = boundsCache.get(it);
    if (!b) {
      const g = baseGeom(it), pts = g.points || g.dots || g.poly;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      b = { x0, x1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
      boundsCache.set(it, b);
    }
    return b;
  }

  // Evenly respaced points along a polyline, so wiggles have enough detail.
  function resample(pts, n) {
    if (pts.length < 2) return pts;
    const d = [0];
    for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = d[d.length - 1];
    if (!total) return pts;
    const out = [];
    for (let k = 0, i = 1; k < n; k++) {
      const s = k / (n - 1) * total;
      while (i < d.length - 1 && d[i] < s) i++;
      const t = (s - d[i - 1]) / ((d[i] - d[i - 1]) || 1);
      out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]);
    }
    return out;
  }

  // Order: wiggle along the line, stretch around the centre, tilt, then move.
  function transform(pts, it, dense) {
    if (!hasTf(it)) return pts;
    const t = tfOf(it), { x0, x1, cx, cy } = baseBounds(it), span = (x1 - x0) || 1e-6;
    const wiggle = t.amp > 0 && t.waves > 0;
    const src = dense && wiggle ? resample(pts, Math.max(pts.length, t.waves * 24, 32)) : pts;
    return src.map(([x, y]) => {
      const u = (x - x0) / span;
      let yy = wiggle ? y + t.amp * Math.sin(2 * Math.PI * t.waves * u) : y;
      yy = cy + (yy - cy) * t.sy + t.tilt * (u - 0.5);
      return [clamp01(cx + (x - cx) * t.sx + t.dx), clamp01(yy + t.dy)];
    });
  }

  // Geometry as it looks and plays: { points } | { dots } | { poly }.
  const geomCache = new WeakMap();
  function geom(it) {
    let g = geomCache.get(it);
    if (!g) {
      const b = baseGeom(it);
      g = b.dots ? { dots: transform(b.dots, it, false) } : b.points ? { points: transform(b.points, it, true) } : { poly: transform(b.poly, it, true) };
      geomCache.set(it, g);
    }
    return g;
  }

  const itemPoints = it => { const g = geom(it); return g.points || g.dots || g.poly; };
  const outline = itemPoints;

  function inside(it, p) {
    if (!it.fill) return false;
    const poly = geom(it).poly;
    if (!poly) return false;
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  }

  // What an item plays: a list of stroke-like voices { size, points, gain?, short? }.
  function baseVoices(it) {
    if (it.kind === 'spray') return it.dots.map(d => ({ size: it.size, points: [d], gain: 0.45, short: true }));
    if (it.kind === 'text') return [{ size: it.size, points: it.points, text: it.text, voice: it.voice }];
    if (it.kind !== 'rect' && it.kind !== 'ellipse') return [{ size: it.size, points: it.points }];
    const [x0, y0, x1, y1] = box(it), N = 40;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
    // f = 0 is the top edge, 1 the bottom edge; in between fills the shape
    const edge = f => {
      if (it.kind === 'rect') { const y = y0 + (y1 - y0) * f; return [[x0, y], [x1, y]]; }
      return Array.from({ length: N + 1 }, (_, i) => {
        const x = x0 + (x1 - x0) * i / N, t = rx ? (x - cx) / rx : 0, h = ry * Math.sqrt(Math.max(0, 1 - t * t));
        return [x, cy - h + 2 * h * f];
      });
    };
    const semis = (y1 - y0) * 36;
    const n = y1 - y0 < 0.01 ? 1 : it.fill ? Math.max(3, Math.min(6, Math.round(semis / 5) + 2)) : 2;
    const gain = 1 / Math.sqrt(n);
    return Array.from({ length: n }, (_, i) => ({ size: it.size, points: edge(n === 1 ? 0 : i / (n - 1)), gain }));
  }

  const voiceCache = new WeakMap();
  function voices(it) {
    let v = voiceCache.get(it);
    if (!v) {
      const g = tfOf(it).gain;
      v = baseVoices(it).map(b => ({ ...b, points: transform(b.points, it, !b.short), gain: (b.gain || 1) * g }));
      voiceCache.set(it, v);
    }
    return v;
  }

  Object.assign(ST, { TOOLS, TF_IDENTITY, tfOf, hasTf, itemPoints, outline, inside, voices, geom, shapeBox: box });
})(window.ST = window.ST || {});
