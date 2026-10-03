// Effect definitions: UI controls, defaults and the Web Audio graph for each one.
// Every build() returns { input, output, update(params, env, immediate), dispose? }.
(function (ST) {
  'use strict';

  const pct = v => `${Math.round(v)}%`;
  const sec = v => `${v < 1 ? v.toFixed(2) : v.toFixed(1)} s`;
  const hzFmt = v => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);
  const rateFmt = v => `${v < 1 ? v.toFixed(2) : v.toFixed(1)} Hz`;
  const logMap = (min, max) => v => min * Math.pow(max / min, v / 100);
  const cutoffHz = logMap(40, 18000);
  const ringHz = logMap(20, 2000);
  const wahHz = logMap(100, 6000);

  // note divisions in beats
  const DIVS = { '1/4': 1, '1/8': 0.5, '3/16': 0.75, '1/16': 0.25, '1/32': 0.125 };

  const knob = (key, label, min, max, step, fmt, hint) => ({ kind: 'knob', key, label, min, max, step, fmt, hint });
  const choice = (key, label, options) => ({ kind: 'choice', key, label, options });
  const toggle = (key, label) => ({ kind: 'toggle', key, label });

  function setP(param, v, ctx, now) {
    if (now) param.value = v;
    else param.setTargetAtTime(v, ctx.currentTime, 0.03);
  }

  // input -> dry -> output, plus a wet send the effect writes into.
  function wetDry(ctx) {
    const m = { input: ctx.createGain(), output: ctx.createGain(), dry: ctx.createGain(), wet: ctx.createGain() };
    m.input.connect(m.dry).connect(m.output);
    m.wet.connect(m.output);
    return m;
  }

  function makeLfo(ctx, type) {
    const osc = ctx.createOscillator();
    osc.type = type || 'sine';
    const amp = ctx.createGain();
    osc.connect(amp);
    osc.start();
    return { osc, amp };
  }

  const stopAll = oscs => () => oscs.forEach(o => { try { o.stop(); } catch (e) { /* already stopped */ } });

  function driveCurve(amount) {
    const k = 1 + amount / 100 * 40, n = 2048, c = new Float32Array(n), norm = Math.tanh(k);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * x) / norm; }
    return c;
  }
  function quantizeCurve(bits) {
    const n = 4096, c = new Float32Array(n), step = Math.pow(0.5, bits - 1);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.round(x / step) * step; }
    return c;
  }

  // Worklets for the two effects Web Audio has no node for.
  const WORKLET_SRC = `
class Crush extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'bits', defaultValue: 8, minValue: 1, maxValue: 16 }, { name: 'down', defaultValue: 4, minValue: 1, maxValue: 64 }]; }
  constructor() { super(); this.hold = [0, 0]; this.count = 0; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    if (!inp.length) return true;
    const step = Math.pow(0.5, p.bits[0] - 1), down = Math.max(1, Math.round(p.down[0]));
    for (let i = 0; i < out[0].length; i++) {
      if (this.count <= 0) {
        for (let c = 0; c < out.length; c++) { const s = (inp[c] || inp[0])[i]; this.hold[c] = Math.round(s / step) * step; }
        this.count = down;
      }
      this.count--;
      for (let c = 0; c < out.length; c++) out[c][i] = this.hold[c];
    }
    return true;
  }
}
registerProcessor('st-crush', Crush);
class Gate extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'threshold', defaultValue: -45 }, { name: 'release', defaultValue: 0.08 }]; }
  constructor() { super(); this.env = 0; this.g = 0; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    if (!inp.length) return true;
    const th = Math.pow(10, p.threshold[0] / 20);
    const rel = Math.exp(-1 / (Math.max(0.005, p.release[0]) * sampleRate));
    const att = Math.exp(-1 / (0.002 * sampleRate));
    for (let i = 0; i < out[0].length; i++) {
      let peak = 0;
      for (let c = 0; c < inp.length; c++) peak = Math.max(peak, Math.abs(inp[c][i]));
      this.env = peak > this.env ? peak : this.env * 0.9995;
      const target = this.env > th ? 1 : 0;
      this.g = target + (this.g - target) * (target > this.g ? att : rel);
      for (let c = 0; c < out.length; c++) out[c][i] = (inp[c] || inp[0])[i] * this.g;
    }
    return true;
  }
}
registerProcessor('st-gate', Gate);`;

  const workletLoads = new WeakMap();
  function loadWorklet(ctx) {
    if (!ctx.audioWorklet) return Promise.resolve(false);
    if (!workletLoads.has(ctx)) {
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      workletLoads.set(ctx, ctx.audioWorklet.addModule(url).then(() => true, () => false));
    }
    return workletLoads.get(ctx);
  }

  const irCache = new WeakMap();
  function impulse(ctx, seconds) {
    let byCtx = irCache.get(ctx);
    if (!byCtx) irCache.set(ctx, byCtx = new Map());
    if (!byCtx.has(seconds)) {
      const len = Math.floor(ctx.sampleRate * seconds);
      const buf = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      }
      byCtx.set(seconds, buf);
    }
    return byCtx.get(seconds);
  }

  const FX = [
    // ---------------- FX on sound ----------------
    {
      id: 'gate', group: 'sound', label: 'Noise gate', hint: 'Silences quiet tails and hiss between notes.',
      params: [
        knob('threshold', 'Threshold', -80, -10, 1, v => `${v} dB`, 'Below this, silence'),
        knob('release', 'Release', 0.01, 0.5, 0.01, sec, 'How fast it closes'),
      ],
      defaults: { threshold: -45, release: 0.08 },
      build(ctx, env) {
        if (env.worklet) {
          const n = new AudioWorkletNode(ctx, 'st-gate', { outputChannelCount: [2] });
          return {
            input: n, output: n,
            update(p, _env, now) {
              setP(n.parameters.get('threshold'), p.threshold, ctx, now);
              setP(n.parameters.get('release'), p.release, ctx, now);
            },
          };
        }
        const g = ctx.createGain();
        return { input: g, output: g, update() {} };
      },
    },
    {
      id: 'eq', group: 'sound', label: 'EQ', hint: 'Turn the lows, mids and highs up or down.',
      params: [
        knob('low', 'Low', -12, 12, 0.5, v => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`, 'Bass, below 200 Hz'),
        knob('mid', 'Mid', -12, 12, 0.5, v => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`, 'Body, around 1 kHz'),
        knob('high', 'High', -12, 12, 0.5, v => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`, 'Air, above 4 kHz'),
      ],
      defaults: { low: 0, mid: 0, high: 0 },
      build(ctx) {
        const lo = ctx.createBiquadFilter(), mid = ctx.createBiquadFilter(), hi = ctx.createBiquadFilter();
        lo.type = 'lowshelf'; lo.frequency.value = 200;
        mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 0.9;
        hi.type = 'highshelf'; hi.frequency.value = 4000;
        lo.connect(mid).connect(hi);
        return {
          input: lo, output: hi,
          update(p, _env, now) { setP(lo.gain, p.low, ctx, now); setP(mid.gain, p.mid, ctx, now); setP(hi.gain, p.high, ctx, now); },
        };
      },
    },
    {
      id: 'filter', group: 'sound', label: 'Filter', hint: 'Muffle the sound or thin it out.',
      params: [
        choice('type', 'Type', [['lowpass', 'Low-pass'], ['highpass', 'High-pass'], ['bandpass', 'Band-pass']]),
        knob('cutoff', 'Cutoff', 0, 100, 1, v => hzFmt(cutoffHz(v)), 'Where it cuts'),
        knob('res', 'Resonance', 0, 100, 1, pct, 'Whistle at the cutoff'),
      ],
      defaults: { type: 'lowpass', cutoff: 70, res: 20 },
      build(ctx) {
        const f = ctx.createBiquadFilter();
        return {
          input: f, output: f,
          update(p, _env, now) {
            f.type = p.type;
            setP(f.frequency, cutoffHz(p.cutoff), ctx, now);
            setP(f.Q, 0.5 * Math.pow(36, p.res / 100), ctx, now);
          },
        };
      },
    },
    {
      id: 'drive', group: 'sound', label: 'Drive', hint: 'From gentle warmth to heavy crunch.',
      params: [
        knob('amount', 'Drive', 0, 100, 1, pct, 'How hard it pushes'),
        knob('tone', 'Tone', 0, 100, 1, pct, 'Dark to bright'),
        knob('mix', 'Mix', 0, 100, 1, pct, 'Blend with clean sound'),
      ],
      defaults: { amount: 40, tone: 60, mix: 100 },
      build(ctx) {
        const m = wetDry(ctx), shaper = ctx.createWaveShaper(), tone = ctx.createBiquadFilter(), makeup = ctx.createGain();
        shaper.oversample = '4x';
        tone.type = 'lowpass';
        m.input.connect(shaper).connect(tone).connect(makeup).connect(m.wet);
        let last = null;
        return {
          input: m.input, output: m.output,
          update(p, _env, now) {
            if (p.amount !== last) { shaper.curve = driveCurve(p.amount); last = p.amount; }
            setP(tone.frequency, logMap(800, 16000)(p.tone), ctx, now);
            setP(makeup.gain, 1 / (1 + p.amount * 0.1), ctx, now); // tanh adds a lot of level
            setP(m.wet.gain, p.mix / 100, ctx, now);
            setP(m.dry.gain, 1 - p.mix / 100, ctx, now);
          },
        };
      },
    },
    {
      id: 'crush', group: 'sound', label: 'Bitcrush', hint: 'Retro, lo-fi, 8-bit video game sound.',
      params: [
        knob('bits', 'Bits', 1, 16, 1, v => `${v} bit`, 'Fewer = crunchier'),
        knob('down', 'Rate', 1, 40, 1, v => `÷${v}`, 'Lower sample rate'),
        knob('mix', 'Mix', 0, 100, 1, pct, 'Blend with clean sound'),
      ],
      defaults: { bits: 6, down: 4, mix: 100 },
      build(ctx, env) {
        const m = wetDry(ctx);
        let node, lastBits = null;
        if (env.worklet) {
          node = new AudioWorkletNode(ctx, 'st-crush', { outputChannelCount: [2] });
        } else {
          node = ctx.createWaveShaper(); // fallback: bit depth only
        }
        m.input.connect(node).connect(m.wet);
        return {
          input: m.input, output: m.output,
          update(p, _env, now) {
            if (env.worklet) {
              setP(node.parameters.get('bits'), p.bits, ctx, now);
              setP(node.parameters.get('down'), p.down, ctx, now);
            } else if (p.bits !== lastBits) {
              node.curve = quantizeCurve(p.bits);
              lastBits = p.bits;
            }
            setP(m.wet.gain, p.mix / 100, ctx, now);
            setP(m.dry.gain, 1 - p.mix / 100, ctx, now);
          },
        };
      },
    },
    {
      id: 'ring', group: 'sound', label: 'Ring mod', hint: 'Metallic, robotic, alien tones.',
      params: [
        knob('freq', 'Frequency', 0, 100, 1, v => hzFmt(ringHz(v)), 'Low = wobble, high = metal'),
        knob('mix', 'Mix', 0, 100, 1, pct, 'Blend with clean sound'),
      ],
      defaults: { freq: 40, mix: 50 },
      build(ctx) {
        const m = wetDry(ctx), ring = ctx.createGain(), osc = ctx.createOscillator();
        ring.gain.value = 0;
        osc.connect(ring.gain);
        osc.start();
        m.input.connect(ring).connect(m.wet);
        return {
          input: m.input, output: m.output, dispose: stopAll([osc]),
          update(p, _env, now) {
            setP(osc.frequency, ringHz(p.freq), ctx, now);
            setP(m.wet.gain, p.mix / 100, ctx, now);
            setP(m.dry.gain, 1 - p.mix / 100 * 0.8, ctx, now);
          },
        };
      },
    },
    {
      id: 'comp', group: 'sound', label: 'Compressor', hint: 'Evens out loud and soft parts, adds punch.',
      params: [knob('amount', 'Punch', 0, 100, 1, pct, 'How much it squeezes')],
      defaults: { amount: 50 },
      build(ctx) {
        // DynamicsCompressorNode already applies automatic makeup gain.
        const c = ctx.createDynamicsCompressor();
        c.knee.value = 6; c.attack.value = 0.005; c.release.value = 0.15;
        return {
          input: c, output: c,
          update(p, _env, now) {
            setP(c.threshold, -p.amount * 0.4, ctx, now);
            setP(c.ratio, 2 + p.amount / 100 * 6, ctx, now);
          },
        };
      },
    },
    {
      id: 'stereo', group: 'sound', label: 'Pan & width', hint: 'Place the layer left or right, wider or narrower.',
      params: [
        knob('pan', 'Pan', -100, 100, 1, v => (v === 0 ? 'Centre' : `${Math.abs(v)}% ${v < 0 ? 'L' : 'R'}`), 'Left or right'),
        knob('width', 'Width', 0, 200, 1, pct, 'Mono to extra wide'),
      ],
      defaults: { pan: 0, width: 100 },
      build(ctx) {
        // mid/side: L' = M + wS, R' = M - wS
        const input = ctx.createGain(), split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
        const mid = ctx.createGain(), side = ctx.createGain(), sideW = ctx.createGain(), inv = ctx.createGain(), pan = ctx.createStereoPanner();
        input.channelCountMode = 'explicit'; input.channelCount = 2;
        const lm = ctx.createGain(), rm = ctx.createGain(), ls = ctx.createGain(), rs = ctx.createGain();
        lm.gain.value = 0.5; rm.gain.value = 0.5; ls.gain.value = 0.5; rs.gain.value = -0.5; inv.gain.value = -1;
        input.connect(split);
        split.connect(lm, 0); split.connect(ls, 0); split.connect(rm, 1); split.connect(rs, 1);
        lm.connect(mid); rm.connect(mid); ls.connect(side); rs.connect(side);
        side.connect(sideW);
        mid.connect(merge, 0, 0); mid.connect(merge, 0, 1);
        sideW.connect(merge, 0, 0); sideW.connect(inv).connect(merge, 0, 1);
        merge.connect(pan);
        return {
          input, output: pan,
          update(p, _env, now) { setP(sideW.gain, p.width / 100, ctx, now); setP(pan.pan, p.pan / 100, ctx, now); },
        };
      },
    },

    // ---------------- FX time ----------------
    {
      id: 'echo', group: 'time', label: 'Echo', hint: 'Repeats that bounce after each line.',
      params: [
        choice('sync', 'Sync to tempo', [['free', 'Free'], ['1/4', '1/4'], ['1/8', '1/8'], ['3/16', '1/8 dotted'], ['1/16', '1/16']]),
        toggle('pingpong', 'Ping-pong (left/right)'),
        knob('amount', 'Amount', 0, 100, 1, pct, 'How much echo'),
        { ...knob('time', 'Time', 0.05, 1, 0.01, sec, 'Gap between repeats'), sets: { sync: 'free' } },
        knob('repeats', 'Repeats', 0, 90, 1, pct, 'How long echoes last'),
      ],
      defaults: { amount: 25, sync: '1/8', time: 0.3, repeats: 35, pingpong: false },
      build(ctx) {
        const m = wetDry(ctx), tone = ctx.createBiquadFilter(), dL = ctx.createDelay(2), dR = ctx.createDelay(2);
        const fbL = ctx.createGain(), fbR = ctx.createGain(), xLR = ctx.createGain(), xRL = ctx.createGain(), lToR = ctx.createGain();
        const merge = ctx.createChannelMerger(2);
        tone.type = 'lowpass'; tone.frequency.value = 4500;
        m.input.connect(tone).connect(dL);
        dL.connect(fbL).connect(dL); dR.connect(fbR).connect(dR);
        dL.connect(xLR).connect(dR); dR.connect(xRL).connect(dL);
        dL.connect(merge, 0, 0); dL.connect(lToR).connect(merge, 0, 1); dR.connect(merge, 0, 1);
        merge.connect(m.wet);
        return {
          input: m.input, output: m.output,
          update(p, env, now) {
            const t = p.sync === 'free' ? p.time : Math.min(2, 60 / env.bpm * DIVS[p.sync]);
            const fb = p.repeats / 100;
            setP(dL.delayTime, t, ctx, now); setP(dR.delayTime, t, ctx, now);
            setP(fbL.gain, p.pingpong ? 0 : fb, ctx, now);
            setP(fbR.gain, 0, ctx, now);
            setP(xLR.gain, p.pingpong ? Math.sqrt(fb) : 0, ctx, now);
            setP(xRL.gain, p.pingpong ? Math.sqrt(fb) : 0, ctx, now);
            setP(lToR.gain, p.pingpong ? 0 : 1, ctx, now);
            setP(m.wet.gain, p.amount / 100 * 0.8, ctx, now);
          },
        };
      },
    },
    {
      id: 'reverb', group: 'time', label: 'Reverb', hint: 'Puts the layer in a room, from a closet to a cathedral.',
      params: [
        knob('amount', 'Amount', 0, 100, 1, pct, 'How much room sound'),
        knob('size', 'Size', 0.5, 6, 0.1, v => `${v.toFixed(1)} s`, 'How big the room is'),
        knob('tone', 'Tone', 0, 100, 1, pct, 'Dark to bright room'),
      ],
      defaults: { amount: 30, size: 2.2, tone: 60 },
      build(ctx) {
        const m = wetDry(ctx), conv = ctx.createConvolver(), damp = ctx.createBiquadFilter();
        damp.type = 'lowpass';
        m.input.connect(conv).connect(damp).connect(m.wet);
        let size = null;
        return {
          input: m.input, output: m.output,
          update(p, _env, now) {
            const s = Math.round(p.size * 10) / 10;
            if (s !== size) { conv.buffer = impulse(ctx, s); size = s; }
            setP(damp.frequency, logMap(1200, 16000)(p.tone), ctx, now);
            setP(m.wet.gain, p.amount / 100 * 0.9, ctx, now);
            setP(m.dry.gain, 1 - p.amount / 100 * 0.35, ctx, now);
          },
        };
      },
    },
    {
      id: 'chorus', group: 'time', label: 'Chorus', hint: 'Thick, shimmering, many-voices sound.',
      params: [
        knob('amount', 'Amount', 0, 100, 1, pct, 'How much chorus'),
        knob('rate', 'Speed', 0.1, 5, 0.05, rateFmt, 'How fast it shimmers'),
        knob('depth', 'Depth', 0, 100, 1, pct, 'How wide it wobbles'),
      ],
      defaults: { amount: 45, rate: 0.8, depth: 40 },
      build(ctx) {
        const m = wetDry(ctx), dL = ctx.createDelay(0.1), dR = ctx.createDelay(0.1), merge = ctx.createChannelMerger(2);
        const lfo = makeLfo(ctx), invAmp = ctx.createGain();
        dL.delayTime.value = 0.018; dR.delayTime.value = 0.022;
        lfo.amp.connect(dL.delayTime);
        lfo.osc.connect(invAmp).connect(dR.delayTime);
        m.input.connect(dL).connect(merge, 0, 0);
        m.input.connect(dR).connect(merge, 0, 1);
        merge.connect(m.wet);
        return {
          input: m.input, output: m.output, dispose: stopAll([lfo.osc]),
          update(p, _env, now) {
            const d = p.depth / 100 * 0.006;
            setP(lfo.osc.frequency, p.rate, ctx, now);
            setP(lfo.amp.gain, d, ctx, now);
            setP(invAmp.gain, -d, ctx, now);
            setP(m.wet.gain, p.amount / 100, ctx, now);
            setP(m.dry.gain, 1 - p.amount / 100 * 0.3, ctx, now);
          },
        };
      },
    },
    {
      id: 'flanger', group: 'time', label: 'Flanger', hint: 'Jet-plane whoosh that sweeps up and down.',
      params: [
        knob('amount', 'Amount', 0, 100, 1, pct, 'How much flanger'),
        knob('rate', 'Speed', 0.05, 5, 0.05, rateFmt, 'How fast it sweeps'),
        knob('depth', 'Depth', 0, 100, 1, pct, 'How far it sweeps'),
        knob('feedback', 'Feedback', 0, 90, 1, pct, 'Sharper, more metallic'),
      ],
      defaults: { amount: 50, rate: 0.25, depth: 60, feedback: 50 },
      build(ctx) {
        const m = wetDry(ctx), d = ctx.createDelay(0.05), fb = ctx.createGain(), lfo = makeLfo(ctx);
        d.delayTime.value = 0.003;
        lfo.amp.connect(d.delayTime);
        m.input.connect(d);
        d.connect(fb).connect(d);
        d.connect(m.wet);
        return {
          input: m.input, output: m.output, dispose: stopAll([lfo.osc]),
          update(p, _env, now) {
            setP(lfo.osc.frequency, p.rate, ctx, now);
            setP(lfo.amp.gain, p.depth / 100 * 0.0027, ctx, now);
            setP(fb.gain, p.feedback / 100, ctx, now);
            setP(m.wet.gain, p.amount / 100 * 0.8, ctx, now);
          },
        };
      },
    },
    {
      id: 'phaser', group: 'time', label: 'Phaser', hint: 'Swirly, spacey sweep.',
      params: [
        knob('amount', 'Amount', 0, 100, 1, pct, 'How much phaser'),
        knob('rate', 'Speed', 0.05, 5, 0.05, rateFmt, 'How fast it swirls'),
        knob('depth', 'Depth', 0, 100, 1, pct, 'How far it sweeps'),
        knob('feedback', 'Feedback', 0, 85, 1, pct, 'Stronger, sharper swirl'),
      ],
      defaults: { amount: 60, rate: 0.4, depth: 60, feedback: 40 },
      build(ctx) {
        const m = wetDry(ctx), lfo = makeLfo(ctx), fb = ctx.createGain(), stages = [];
        for (let i = 0; i < 6; i++) {
          const ap = ctx.createBiquadFilter();
          ap.type = 'allpass'; ap.frequency.value = 900; ap.Q.value = 0.6;
          lfo.amp.connect(ap.frequency);
          if (i) stages[i - 1].connect(ap);
          stages.push(ap);
        }
        const last = stages[stages.length - 1];
        m.input.connect(stages[0]);
        last.connect(fb).connect(stages[0]);
        last.connect(m.wet);
        return {
          input: m.input, output: m.output, dispose: stopAll([lfo.osc]),
          update(p, _env, now) {
            setP(lfo.osc.frequency, p.rate, ctx, now);
            setP(lfo.amp.gain, p.depth / 100 * 750, ctx, now);
            setP(fb.gain, p.feedback / 100, ctx, now);
            setP(m.wet.gain, p.amount / 100, ctx, now);
          },
        };
      },
    },
    {
      id: 'tremolo', group: 'time', label: 'Tremolo', hint: 'The volume pulses up and down.',
      params: [
        choice('shape', 'Shape', [['sine', 'Smooth'], ['square', 'Choppy']]),
        knob('rate', 'Speed', 0.5, 16, 0.1, rateFmt, 'Pulses per second'),
        knob('depth', 'Depth', 0, 100, 1, pct, 'How deep it dips'),
      ],
      defaults: { shape: 'sine', rate: 5, depth: 60 },
      build(ctx) {
        const g = ctx.createGain(), lfo = makeLfo(ctx);
        lfo.amp.connect(g.gain);
        return {
          input: g, output: g, dispose: stopAll([lfo.osc]),
          update(p, _env, now) {
            lfo.osc.type = p.shape;
            setP(lfo.osc.frequency, p.rate, ctx, now);
            setP(g.gain, 1 - p.depth / 200, ctx, now);
            setP(lfo.amp.gain, p.depth / 200, ctx, now);
          },
        };
      },
    },
    {
      id: 'vibrato', group: 'time', label: 'Vibrato', hint: 'The pitch wobbles, like a singer or a violin.',
      params: [
        knob('rate', 'Speed', 1, 10, 0.1, rateFmt, 'Wobbles per second'),
        knob('depth', 'Depth', 0, 100, 1, v => `${Math.round(v)} ct`, 'How far the pitch bends'),
      ],
      defaults: { rate: 5, depth: 15 },
      build: null, // applied inside each voice
    },
    {
      id: 'autopan', group: 'time', label: 'Auto-pan', hint: 'The sound travels between left and right.',
      params: [
        knob('rate', 'Speed', 0.05, 8, 0.05, rateFmt, 'How fast it moves'),
        knob('depth', 'Depth', 0, 100, 1, pct, 'How far it travels'),
      ],
      defaults: { rate: 0.5, depth: 70 },
      build(ctx) {
        const pan = ctx.createStereoPanner(), lfo = makeLfo(ctx);
        lfo.amp.connect(pan.pan);
        return {
          input: pan, output: pan, dispose: stopAll([lfo.osc]),
          update(p, _env, now) { setP(lfo.osc.frequency, p.rate, ctx, now); setP(lfo.amp.gain, p.depth / 100, ctx, now); },
        };
      },
    },
    {
      id: 'autofilter', group: 'time', label: 'Auto-wah', hint: 'A filter that opens and closes by itself.',
      params: [
        knob('rate', 'Speed', 0.05, 8, 0.05, rateFmt, 'How fast it sweeps'),
        knob('depth', 'Depth', 0, 100, 1, pct, 'How far it sweeps'),
        knob('freq', 'Centre', 0, 100, 1, v => hzFmt(wahHz(v)), 'Where it sweeps around'),
        knob('res', 'Resonance', 0, 100, 1, pct, 'More “wah”'),
      ],
      defaults: { rate: 0.5, depth: 50, freq: 40, res: 40 },
      build(ctx) {
        const f = ctx.createBiquadFilter(), lfo = makeLfo(ctx);
        f.type = 'lowpass';
        lfo.amp.connect(f.detune); // cents: an even, musical sweep
        return {
          input: f, output: f, dispose: stopAll([lfo.osc]),
          update(p, _env, now) {
            setP(lfo.osc.frequency, p.rate, ctx, now);
            setP(lfo.amp.gain, p.depth / 100 * 4800, ctx, now);
            setP(f.frequency, wahHz(p.freq), ctx, now);
            setP(f.Q, 0.7 + p.res / 100 * 12, ctx, now);
          },
        };
      },
    },
    {
      id: 'trancegate', group: 'time', label: 'Trance gate', hint: 'Chops the sound in rhythm with the tempo.',
      params: [
        choice('division', 'Step', [['1/4', '1/4'], ['1/8', '1/8'], ['1/16', '1/16'], ['1/32', '1/32']]),
        knob('length', 'Length', 10, 90, 1, pct, 'How long each chop stays open'),
        knob('depth', 'Depth', 0, 100, 1, pct, 'How silent the gaps are'),
      ],
      defaults: { division: '1/16', length: 50, depth: 100 },
      build(ctx) {
        const g = ctx.createGain(); // stepped by the scheduler, in time with the loop
        return { input: g, output: g, gate: g, update() {} };
      },
    },
    {
      id: 'tapestop', group: 'time', label: 'Tape stop', hint: 'The loop slows down to a halt at its end, like a stopped record.',
      params: [
        choice('length', 'Slow-down length', [['0.5', '½ beat'], ['1', '1 beat'], ['2', '2 beats'], ['4', '1 bar']]),
      ],
      defaults: { length: '2' },
      build(ctx) {
        const g = ctx.createGain(); // faded by the scheduler; pitch bend happens per voice
        return { input: g, output: g, gate: g, update() {} };
      },
    },
  ];

  const FX_BY_ID = Object.fromEntries(FX.map(f => [f.id, f]));
  const FX_GROUPS = {
    sound: ['eq', 'filter', 'drive', 'crush', 'ring', 'comp', 'gate', 'stereo'],
    time: ['echo', 'reverb', 'chorus', 'flanger', 'phaser', 'tremolo', 'vibrato', 'autopan', 'autofilter', 'trancegate', 'tapestop'],
  };
  // signal order inside a layer bus
  const FX_CHAIN = ['gate', 'eq', 'filter', 'drive', 'crush', 'ring', 'comp',
    'tremolo', 'autofilter', 'trancegate', 'chorus', 'flanger', 'phaser', 'echo', 'reverb', 'autopan', 'stereo', 'tapestop'];

  function defaultFx() {
    const out = {};
    for (const f of FX) out[f.id] = { on: false, ...f.defaults };
    return out;
  }

  Object.assign(ST, { FX, FX_BY_ID, FX_GROUPS, FX_CHAIN, DIVS, defaultFx, loadWorklet, impulse });
})(window.ST = window.ST || {});
