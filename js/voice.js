// Text brush voice: a small formant speech synth in the spirit of the old
// "Talk It!" robots. Letters become phonemes; a buzzy source goes through three
// formant filters (the vowel shape) plus filtered noise (s, sh, f...). The pitch
// follows the text's baseline on the canvas and snaps to the scale: autotune.
(function (ST) {
  'use strict';

  // f: formants F1-F3 (Hz); v: voicing; n: noise; nf: noise band (Hz); w: length weight;
  // stop: a closure then a burst (p, t, k, b, d, g).
  const PH = {
    A: { f: [730, 1090, 2440], v: 1, w: 1 },
    E: { f: [530, 1840, 2480], v: 1, w: 0.9 },
    I: { f: [300, 2250, 2950], v: 1, w: 0.85 },
    O: { f: [570, 840, 2410], v: 1, w: 1 },
    U: { f: [320, 870, 2240], v: 1, w: 0.9 },
    W: { f: [300, 700, 2200], v: 0.8, w: 0.45 },
    Y: { f: [280, 2300, 3000], v: 0.8, w: 0.4 },
    L: { f: [360, 1300, 2700], v: 0.75, w: 0.55 },
    R: { f: [460, 1250, 1600], v: 0.8, w: 0.55 },
    M: { f: [280, 1000, 2200], v: 0.6, w: 0.6 },
    N: { f: [280, 1600, 2600], v: 0.6, w: 0.55 },
    NG: { f: [280, 2300, 2750], v: 0.5, w: 0.5 },
    S: { v: 0, n: 0.75, nf: 6500, w: 0.7 },
    SH: { v: 0, n: 0.8, nf: 3000, w: 0.7 },
    F: { v: 0, n: 0.4, nf: 5000, w: 0.6 },
    TH: { v: 0, n: 0.35, nf: 5500, w: 0.55 },
    H: { v: 0, n: 0.4, nf: 1500, w: 0.45 },
    Z: { f: [280, 1700, 2600], v: 0.45, n: 0.5, nf: 5500, w: 0.6 },
    V: { f: [300, 1300, 2400], v: 0.55, n: 0.25, nf: 4000, w: 0.55 },
    J: { f: [300, 1900, 2600], v: 0.45, n: 0.5, nf: 2800, w: 0.6 },
    P: { v: 0, nf: 900, stop: true, w: 0.45 },
    T: { v: 0, nf: 4000, stop: true, w: 0.45 },
    K: { v: 0, nf: 2000, stop: true, w: 0.45 },
    B: { f: [300, 900, 2300], v: 0.35, nf: 800, stop: true, w: 0.4 },
    D: { f: [300, 1700, 2600], v: 0.35, nf: 3500, stop: true, w: 0.4 },
    G: { f: [300, 2000, 2600], v: 0.35, nf: 1800, stop: true, w: 0.4 },
    _: { v: 0, n: 0, w: 0.45 }, // a pause between words
  };

  const DIGRAPHS = { sh: ['SH'], ch: ['T', 'SH'], th: ['TH'], ph: ['F'], ck: ['K'], ng: ['NG'], qu: ['K', 'W'], ee: ['I'], oo: ['U'], ou: ['U'], ea: ['I'], ai: ['E'], ay: ['E'], oa: ['O'] };
  const LETTERS = {
    a: ['A'], b: ['B'], c: ['K'], d: ['D'], e: ['E'], f: ['F'], g: ['G'], h: ['H'], i: ['I'], j: ['J'], k: ['K'], l: ['L'], m: ['M'],
    n: ['N'], o: ['O'], p: ['P'], q: ['K'], r: ['R'], s: ['S'], t: ['T'], u: ['U'], v: ['V'], w: ['W'], x: ['K', 'S'], y: ['I'], z: ['Z'],
    à: ['A'], è: ['E'], é: ['E'], ì: ['I'], ò: ['O'], ù: ['U'],
  };

  // "Hey Opus" -> [H, E, I, _, O, P, U, S] (simple rules, good enough for a robot)
  const phoneCache = new Map();
  function toPhones(text) {
    const key = text.toLowerCase();
    if (phoneCache.has(key)) return phoneCache.get(key);
    const out = [];
    for (let i = 0; i < key.length;) {
      const two = key.slice(i, i + 2), ch = key[i], next = key[i + 1] || '';
      if (DIGRAPHS[two]) { out.push(...DIGRAPHS[two]); i += 2; continue; }
      if (ch === 'c' && 'eiy'.includes(next)) { out.push('S'); i++; continue; }
      if (ch === 'y' && (i === 0 || !LETTERS[key[i - 1]]) && 'aeiou'.includes(next)) { out.push('Y'); i++; continue; }
      if (ch === 'e' && i === key.length - 1 && out.length > 1) { i++; continue; } // silent final e
      if (LETTERS[ch]) { if (out[out.length - 1] !== LETTERS[ch][0] || 'AEIOU'.includes(LETTERS[ch][0])) out.push(...LETTERS[ch]); }
      else if (/\s|[.,;:!?-]/.test(ch) && out.length && out[out.length - 1] !== '_') out.push('_');
      i++;
    }
    for (let i = out.length - 1; i > 0; i--) if (out[i] === out[i - 1] && !'AEIOU'.includes(out[i])) out.splice(i, 1); // tch -> ch
    while (out[out.length - 1] === '_') out.pop();
    if (!out.length) out.push('A');
    phoneCache.set(key, out);
    return out;
  }

  const VOICE_SHIFT = { low: 0.84, mid: 1, high: 1.2 };
  const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);
  const noiseBufs = new WeakMap();
  function noise(ctx) {
    let b = noiseBufs.get(ctx);
    if (!b) {
      b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      noiseBufs.set(ctx, b);
    }
    return b;
  }

  // Timeline of phonemes for a note: [{ ph, at, dur }] in seconds from the note start.
  // A note cut by a read mode plays only part of the word (and backwards when reversed).
  function phonePlan(note) {
    let list = toPhones(note.text);
    const from = note.textFrom ?? 0, to = note.textTo ?? 1;
    if (from > 0 || to < 1) {
      const total = list.reduce((a, p) => a + PH[p].w, 0);
      let acc = 0;
      list = list.filter(p => { const mid = (acc + PH[p].w / 2) / total; acc += PH[p].w; return mid >= from && mid <= to; });
      if (!list.length) list = ['_'];
    }
    if (note.textRev) list = [...list].reverse();
    const total = list.reduce((a, p) => a + PH[p].w, 0);
    let t = 0;
    return list.map(p => { const dur = PH[p].w / total * note.dur; const r = { ph: p, at: t, dur }; t += dur; return r; });
  }

  const HARMONY = { off: [], third: [4], fifth: [7], octave: [12], low: [-12], chord: [4, 7] };
  const voxOf = sound => ({ ...ST.VOX_DEFAULT, ...(sound && sound.vox) });
  const voxKey = sound => JSON.stringify(voxOf(sound));

  // Schedule one spoken note: pitch curve from note.times/midis, words from note.text,
  // shaped by the layer's Voice FX (sound.vox).
  function scheduleTalk(ctx, dest, sound, note, t, skip, registry, meta) {
    const dur = note.dur - skip;
    if (dur <= 0.02) return null;
    const vox = voxOf(sound), peak = note.peak;
    const shift = (VOICE_SHIFT[note.voice] || 1) * Math.pow(2, vox.formant / 12);
    const whisper = vox.whisper / 100, vScale = 1 - whisper * 0.95;
    const asp = vox.breath / 100 * 0.35 + whisper * 1.1, crisp = 0.4 + vox.crisp / 100 * 1.2;

    // source: one buzzy oscillator per harmony voice
    const ratios = [1, ...(HARMONY[vox.harmony] || []).map(st => Math.pow(2, st / 12))];
    const oscs = ratios.map(() => { const o = ctx.createOscillator(); o.type = vox.wave; return o; });
    const srcMix = ctx.createGain();
    srcMix.gain.value = 1 / Math.sqrt(ratios.length);
    oscs.forEach(o => o.connect(srcMix));
    const nz = ctx.createBufferSource();
    nz.buffer = noise(ctx);
    nz.loop = true;
    const gv = ctx.createGain(), ga = ctx.createGain(), gn = ctx.createGain(), nf = ctx.createBiquadFilter(), sum = ctx.createGain();
    const lp = ctx.createBiquadFilter(), ring = ctx.createGain(), env = ctx.createGain();
    gv.gain.value = 0;
    ga.gain.value = 0;
    gn.gain.value = 0;
    nf.type = 'bandpass';
    nf.Q.value = 1.4;
    sum.gain.value = vox.wave === 'triangle' ? 5 : 3.2; // formant filters are narrow: make up the level
    lp.type = 'lowpass';
    lp.frequency.value = 1800 * Math.pow(7, (sound.brightness ?? 55) / 100);
    env.gain.value = 0;
    srcMix.connect(gv);
    nz.connect(ga); // breath and whisper: air shaped by the same mouth
    const formants = [[8, 1], [12, 0.7], [16, 0.35]].map(([q, g]) => {
      const f = ctx.createBiquadFilter(), fg = ctx.createGain();
      f.type = 'bandpass';
      f.Q.value = q;
      fg.gain.value = g;
      gv.connect(f);
      ga.connect(f);
      f.connect(fg).connect(sum);
      return f;
    });
    nz.connect(gn).connect(nf).connect(sum);
    sum.connect(lp).connect(ring).connect(env).connect(dest);
    const extras = [];
    const lfoTo = (freq, depth, targets) => {
      const lfo = ctx.createOscillator(), lg = ctx.createGain();
      lfo.frequency.value = freq;
      lg.gain.value = depth;
      lfo.connect(lg);
      targets.forEach(x => lg.connect(x));
      extras.push(lfo);
    };
    if (vox.robot > 0) { // ring modulation: signal x (1 - r + r * sin)
      const r = vox.robot / 100;
      ring.gain.value = 1 - r;
      lfoTo(38 + r * 70, r, [ring.gain]);
    }
    if (vox.vibrato > 0) lfoTo(5.5, vox.vibrato / 100 * 60, oscs.map(o => o.detune));
    if (sound.drift > 0) lfoTo(5 + Math.random(), sound.drift / 100 * 30, oscs.map(o => o.detune));

    // pitch: autotune = snap to the note with a glide as fast as the Autotune knob says
    const hard = vox.tune / 100, tc = 0.003 + (1 - hard) * 0.1;
    const snapped = note.snap || hard > 0.5; // theremin mode still snaps to semitones when tuned hard
    const pitch = m => (!note.snap && hard > 0.5 ? Math.round(m) : m);
    const setF = (m, at, how) => oscs.forEach((o, k) => {
      const f = midiToFreq(m) * ratios[k];
      if (how === 'set') o.frequency.setValueAtTime(f, at);
      else if (how === 'snap') o.frequency.setTargetAtTime(f, at, tc);
      else o.frequency.linearRampToValueAtTime(f, at);
    });
    let i = 0;
    while (i < note.times.length - 1 && note.times[i + 1] <= skip) i++;
    let last = pitch(note.midis[i]);
    setF(last, t, 'set');
    for (let j = i + 1; j < note.times.length; j++) {
      const m = pitch(note.midis[j]), at = t + note.times[j] - skip;
      if (snapped) { if (m !== last) setF(m, at, 'snap'); }
      else setF(m, at, 'ramp');
      last = m;
    }

    // mouth: formants glide between phonemes, noise opens for s / sh / f / bursts
    const voicing = (level, at, k) => {
      gv.gain.setTargetAtTime(level * vScale, at, k);
      ga.gain.setTargetAtTime(level * asp, at, k);
    };
    let lastF = [500, 1500, 2500];
    for (const p of phonePlan(note)) {
      const d = PH[p.ph], s0 = t + p.at - skip, e0 = s0 + p.dur;
      if (e0 <= t) { if (d.f) lastF = d.f; continue; }
      const at = Math.max(t, s0);
      if (d.f) lastF = d.f;
      formants.forEach((f, k) => f.frequency.setTargetAtTime(lastF[k] * shift, at, 0.014));
      if (d.stop) {
        const burst = Math.max(at, s0 + p.dur * 0.55);
        voicing(d.v * 0.3, at, 0.006);
        gn.gain.setTargetAtTime(0, at, 0.004);
        nf.frequency.setValueAtTime(d.nf * shift, burst);
        gn.gain.setValueAtTime(0.9 * crisp, burst);
        gn.gain.setTargetAtTime(0, burst + 0.012, 0.012);
        voicing(d.v, burst, 0.01);
      } else {
        voicing(d.v, at, 0.012);
        gn.gain.setTargetAtTime((d.n || 0) * 0.55 * crisp, at, 0.01);
        if (d.nf) nf.frequency.setValueAtTime(d.nf * shift, at);
      }
    }
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.015);
    env.gain.setValueAtTime(peak, t + Math.max(0.02, dur - 0.04));
    env.gain.linearRampToValueAtTime(0, t + dur);
    const sources = [...oscs, ...extras, nz], end = t + dur + 0.05;
    for (const x of sources) { if (x === nz) x.start(t, Math.random()); else x.start(t); x.stop(end); }

    const stopAt = at => {
      env.gain.cancelScheduledValues(at);
      env.gain.setTargetAtTime(0, at, 0.015);
      for (const x of sources) { try { x.stop(at + 0.1); } catch (e) { /* already stopping */ } }
    };
    const voice = {
      tOn: t, endAt: t + dur, meta, talk: true,
      sig: note.sig && note.sig + voxKey(sound),
      kill(at) { voice.endAt = at; stopAt(at); },
      release(at) { voice.endAt = at; stopAt(at); },
    };
    if (registry) {
      registry.add(voice);
      oscs[0].onended = () => { env.disconnect(); registry.delete(voice); };
    }
    return voice;
  }

  // Cheap fingerprint: a sounding voice only restarts when its word really changed.
  const talkSig = n => `${n.text}|${n.voice}|${n.start.toFixed(3)}|${n.dur.toFixed(3)}|${n.midis.length}|${n.midis[0]}|${n.midis[n.midis.length - 1]}|${n.peak.toFixed(3)}|${n.textFrom ?? 0}|${n.textTo ?? 1}|${!!n.textRev}`;

  Object.assign(ST, { toPhones, scheduleTalk, talkSig, voxKey, VOICE_SHIFT });
})(window.ST = window.ST || {});
