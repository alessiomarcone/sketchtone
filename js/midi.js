// Web MIDI input: finds controllers and turns knob (CC) messages into moves of K1–K8.
(function (ST) {
  'use strict';

  const STORE = 'sketchtone.midi.v1';
  const KNOBS = 8;
  // Factory presets: MPK Mini mk3 sends CC 70–77, mk2 sends CC 1–8. Other layouts
  // get auto-assigned in the order knobs are first turned, or via setup.
  const MPK3_CCS = [70, 71, 72, 73, 74, 75, 76, 77];

  // learned: controller input -> on-screen control, e.g. { 'cc:72': 'mix.<layer>.volume', 'note:9:40': 'scene.2' }
  const defaults = () => ({ ccs: Array(KNOBS).fill(null), mode: 'smooth', speed: 1, pins: {}, pads: [], learned: {} });
  const settings = (() => {
    try { return { ...defaults(), ...JSON.parse(localStorage.getItem(STORE)) }; } catch (e) { return defaults(); }
  })();
  // v1.3: pinned K-knobs became learned CCs (any CC, any control)
  for (const k in settings.pins) {
    const cc = settings.ccs[k], path = settings.pins[k];
    if (cc != null && Array.isArray(path)) settings.learned[`cc:${cc}`] = path.join('.');
  }
  settings.pins = {};
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch (e) { /* storage unavailable */ } };

  const listeners = { move: [], status: [], assign: [], message: [], pad: [], key: [], bend: [], learned: [], learnedNote: [] };
  const on = (type, fn) => listeners[type].push(fn);
  const emit = (type, ...args) => listeners[type].forEach(fn => fn(...args));

  const last = new Map(); // cc -> last absolute value
  let access = null, setup = null, padSetup = null, learn = null;
  const status = { supported: !!navigator.requestMIDIAccess, connected: false, inputs: [], error: null, last: null };

  // Which of K1–K8 a CC belongs to; unknown CCs fill the next free slot.
  function knobFor(cc) {
    let k = settings.ccs.indexOf(cc);
    if (k >= 0) return k;
    if (cc === 64) return -1;
    // MPK Mini mk3 factory preset sends CC 70–77, the mk2 sends CC 1–8
    const preferred = MPK3_CCS.includes(cc) ? MPK3_CCS.indexOf(cc) : cc >= 1 && cc <= 8 ? cc - 1 : -1;
    k = preferred >= 0 && settings.ccs[preferred] == null ? preferred : settings.ccs.indexOf(null);
    if (k < 0) return -1;
    settings.ccs[k] = cc;
    save();
    emit('assign', k, cc, preferred === k);
    return k;
  }

  // Pads: learned (channel, note) pairs, or by default anything on MIDI channel 10,
  // which is where the MPK Mini sends its drum pads.
  function padOf(ch, note) {
    if (settings.pads.length) return settings.pads.indexOf(`${ch}:${note}`);
    return ch === 9 && note >= 36 && note <= 51 ? note - 36 : -1;
  }

  function handleNote(ch, note, vel, on) {
    const id = `note:${ch}:${note}`;
    if (learn && on) { const cb = learn; learn = null; cb(id, `${ch === 9 ? 'Pad' : 'Note'} ${note}`); return; }
    if (padSetup) {
      const id = `${ch}:${note}`;
      if (on && !padSetup.ids.includes(id)) {
        padSetup.ids.push(id);
        padSetup.onStep(padSetup.ids.length);
        if (padSetup.ids.length === 8) finishPadSetup();
      }
      return;
    }
    if (settings.learned[id]) { emit('learnedNote', id, vel, on); return; }
    const pad = padOf(ch, note);
    status.last = { note, ch, pad, on };
    emit('message', status.last);
    if (pad >= 0) emit('pad', pad, vel, on);
    else emit('key', note, vel, on);
  }

  function handle(data) {
    const [st, cc, val] = data;
    const type = st & 0xf0, ch = st & 0x0f;
    if (type === 0x90 || type === 0x80) { handleNote(ch, cc, val, type === 0x90 && val > 0); return; }
    if (type === 0xe0) { emit('bend', (((val << 7) | cc) - 8192) / 8192); return; } // joystick left/right, -1..1
    if (type !== 0xb0) return;
    status.last = { cc, val };
    emit('message', status.last);
    if (setup) {
      if (!setup.ccs.includes(cc)) {
        setup.ccs.push(cc);
        setup.onStep(setup.ccs.length);
        if (setup.ccs.length === KNOBS) finishSetup();
      }
      return;
    }
    if (learn) { const cb = learn; learn = null; last.set(cc, val); cb(`cc:${cc}`, `CC ${cc}`); return; }
    if (settings.learned[`cc:${cc}`]) { emit('learned', `cc:${cc}`, moveOf(cc, val)); return; }
    const k = knobFor(cc);
    if (k < 0) return;
    emit('move', k, moveOf(cc, val));
  }
  function moveOf(cc, val) {
    if (settings.mode === 'relative') return { delta: (val < 64 ? val : val - 128) / 127 * settings.speed }; // two's complement encoders
    const prev = last.get(cc);
    last.set(cc, val);
    if (settings.mode === 'jump') return { abs: val / 127 };
    return { delta: prev === undefined ? 0 : (val - prev) / 127 * settings.speed }; // first touch: show value
  }

  function bindInputs() {
    status.inputs = [];
    for (const input of access.inputs.values()) {
      input.onmidimessage = e => handle(e.data);
      status.inputs.push(input.name);
    }
    status.connected = true;
    emit('status', status);
  }

  async function connect() {
    if (!status.supported) { status.error = 'unsupported'; emit('status', status); return false; }
    if (access) return true;
    try {
      access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      status.error = 'denied';
      emit('status', status);
      return false;
    }
    status.error = null;
    access.onstatechange = bindInputs;
    bindInputs();
    return true;
  }

  // Reconnect silently on reload when permission was already given.
  async function autoConnect() {
    try {
      const p = await navigator.permissions.query({ name: 'midi' });
      if (p.state === 'granted') connect();
    } catch (e) { /* permissions API without midi */ }
  }

  function startSetup(onStep, onDone) {
    setup = { ccs: [], onStep, onDone };
  }
  function finishSetup() {
    const s = setup;
    setup = null;
    settings.ccs = s.ccs.concat(Array(KNOBS).fill(null)).slice(0, KNOBS);
    last.clear();
    save();
    s.onDone(true);
  }
  function startPadSetup(onStep, onDone) {
    padSetup = { ids: [], onStep, onDone };
  }
  function finishPadSetup() {
    const s = padSetup;
    padSetup = null;
    settings.pads = s.ids;
    save();
    s.onDone(true);
  }
  function cancelPadSetup() {
    if (!padSetup) return;
    const s = padSetup;
    padSetup = null;
    s.onDone(false);
  }

  function cancelSetup() {
    if (!setup) return;
    const s = setup;
    setup = null;
    s.onDone(false);
  }

  // MIDI learn: the next knob turned or pad/key pressed is handed to cb(id, label).
  const startLearn = cb => { learn = cb; };
  const cancelLearn = () => { learn = null; };
  // Which input is learned to a control, as a short label (CC 72, Pad 40), or null.
  function learnedFor(path) {
    const id = Object.keys(settings.learned).find(k => settings.learned[k] === path);
    if (!id) return null;
    const p = id.split(':');
    if (p[0] === 'cc') { const k = settings.ccs.indexOf(Number(p[1])); return { id, label: k >= 0 ? `K${k + 1}` : `CC ${p[1]}` }; }
    return { id, label: `${p[1] === '9' ? 'Pad' : 'Note'} ${p[2]}` };
  }

  ST.midi = {
    startLearn, cancelLearn, learnedFor,
    KNOBS, settings, status, save, on, connect, autoConnect, handle, startSetup, cancelSetup, isSetup: () => !!setup,
    startPadSetup, cancelPadSetup, isPadSetup: () => !!padSetup, knobOf: cc => settings.ccs.indexOf(cc),
  };
})(window.ST = window.ST || {});
