// Sound presets, scales, read modes and the controls of the Source / ADSR panels.
(function (ST) {
  'use strict';

  const DEFAULT_SOUND = {
    wave: 'triangle', register: 'mid',
    brightness: 55, resonance: 10, sub: 10, noise: 0, fmDepth: 8, fmRatio: 2, unison: 0, drift: 0,
    attack: 0.01, decay: 0.4, sustain: 55, release: 0.5, pluck: 0, glide: 0,
    vox: null, // voice FX for the text brush (VOX_DEFAULT when missing)
  };
  // Voice FX: how the text brush robot sings on this layer.
  const VOX_DEFAULT = { tune: 70, formant: 0, breath: 15, whisper: 0, crisp: 50, vibrato: 0, robot: 0, harmony: 'off', wave: 'sawtooth' };
  const VOX_CHOICES = {
    wave: { label: 'Voice tone', options: [['sawtooth', 'Buzzy'], ['square', 'Hollow'], ['triangle', 'Soft']] },
    harmony: { label: 'Harmony', options: [['off', 'Off'], ['third', '+ Third'], ['fifth', '+ Fifth'], ['octave', '+ Octave'], ['low', '− Octave'], ['chord', 'Chord']] },
  };

  // fx: partial settings per effect; listing an effect switches it on.
  const preset = (label, sound, fx) => ({ label, sound: { ...DEFAULT_SOUND, ...sound }, fx });

  const PRESETS = {
    // keys
    keys: preset('Soft keys', {}, {
      echo: { amount: 15, sync: '1/8', repeats: 35 },
      reverb: { amount: 25, size: 2.2 },
    }),
    epiano: preset('E-piano', { wave: 'sine', brightness: 62, sub: 0, fmDepth: 22, fmRatio: 1, attack: 0.004, decay: 0.9, sustain: 25, release: 0.6 }, {
      tremolo: { rate: 4, depth: 22 },
      chorus: { amount: 20, rate: 0.6, depth: 30 },
      reverb: { amount: 22, size: 2 },
    }),
    organ: preset('Organ', { wave: 'sine', brightness: 65, sub: 45, fmDepth: 10, fmRatio: 2, attack: 0.01, decay: 0.1, sustain: 95, release: 0.08 }, {
      chorus: { amount: 40, rate: 4.5, depth: 25 },
      drive: { amount: 12, tone: 50, mix: 60 },
      reverb: { amount: 20, size: 2.5 },
    }),
    musicbox: preset('Music box', { wave: 'sine', register: 'high', brightness: 80, sub: 0, fmDepth: 30, fmRatio: 4, attack: 0.002, decay: 0.6, sustain: 0, release: 0.9 }, {
      echo: { amount: 22, sync: '1/8', pingpong: true, repeats: 40 },
      reverb: { amount: 38, size: 3 },
    }),
    // pads
    pad: preset('Warm pad', { wave: 'sawtooth', brightness: 32, sub: 25, noise: 4, fmDepth: 0, unison: 30, attack: 0.7, decay: 0.6, sustain: 80, release: 1.6 }, {
      chorus: { amount: 45, rate: 0.4, depth: 50 },
      echo: { amount: 10, sync: '1/4' },
      reverb: { amount: 55, size: 4 },
    }),
    strings: preset('Strings', { wave: 'sawtooth', brightness: 45, sub: 5, fmDepth: 0, unison: 60, drift: 20, attack: 0.5, decay: 0.4, sustain: 85, release: 1.2 }, {
      chorus: { amount: 30, rate: 0.5, depth: 35 },
      reverb: { amount: 45, size: 3.5 },
    }),
    choir: preset('Airy choir', { wave: 'triangle', brightness: 38, resonance: 30, sub: 0, noise: 18, fmDepth: 0, unison: 35, attack: 0.8, decay: 0.5, sustain: 80, release: 2 }, {
      chorus: { amount: 50, rate: 0.3, depth: 55 },
      reverb: { amount: 60, size: 4.5 },
    }),
    drone: preset('Dark drone', { wave: 'sawtooth', register: 'low', brightness: 18, resonance: 40, sub: 40, fmDepth: 0, unison: 50, drift: 40, attack: 1.5, decay: 1, sustain: 100, release: 3 }, {
      autofilter: { rate: 0.1, depth: 40, freq: 35, res: 30 },
      reverb: { amount: 50, size: 5 },
    }),
    // bass
    bass: preset('Deep bass', { wave: 'square', register: 'low', brightness: 28, sub: 70, fmDepth: 0, attack: 0.01, decay: 0.25, sustain: 80, release: 0.15 }, {
      drive: { amount: 20, tone: 40, mix: 60 },
      comp: { amount: 50 },
      reverb: { amount: 6, size: 1 },
    }),
    acid: preset('Acid bass', { wave: 'sawtooth', register: 'low', brightness: 30, resonance: 75, sub: 10, fmDepth: 0, pluck: 70, glide: 55, attack: 0.005, decay: 0.2, sustain: 40, release: 0.1 }, {
      drive: { amount: 30, tone: 55, mix: 80 },
      echo: { amount: 12, sync: '3/16' },
    }),
    subbass: preset('Sub bass', { wave: 'sine', register: 'low', brightness: 20, sub: 0, fmDepth: 0, attack: 0.01, decay: 0.1, sustain: 100, release: 0.15 }, {
      comp: { amount: 60 },
    }),
    pluckbass: preset('Pluck bass', { wave: 'square', register: 'low', brightness: 25, resonance: 25, sub: 35, fmDepth: 0, pluck: 55, attack: 0.003, decay: 0.3, sustain: 20, release: 0.15 }, {
      comp: { amount: 45 },
      reverb: { amount: 10, size: 1.2 },
    }),
    // leads
    lead: preset('Bright lead', { wave: 'sawtooth', brightness: 72, sub: 10, fmDepth: 12, fmRatio: 1, attack: 0.02, decay: 0.2, sustain: 70, release: 0.3 }, {
      drive: { amount: 25 },
      vibrato: { rate: 5.5, depth: 12 },
      echo: { amount: 30, sync: '1/8', pingpong: true },
      reverb: { amount: 20 },
    }),
    supersaw: preset('Supersaw', { wave: 'sawtooth', brightness: 70, sub: 15, fmDepth: 0, unison: 85, attack: 0.01, decay: 0.3, sustain: 80, release: 0.4 }, {
      echo: { amount: 25, sync: '1/8', pingpong: true },
      reverb: { amount: 30, size: 3 },
    }),
    chip: preset('Chip lead', { wave: 'square', brightness: 90, sub: 0, fmDepth: 0, glide: 20, attack: 0.002, decay: 0.05, sustain: 90, release: 0.05 }, {
      crush: { bits: 8, down: 2, mix: 60 },
      echo: { amount: 15, sync: '1/16' },
    }),
    flute: preset('Soft flute', { wave: 'sine', brightness: 50, sub: 0, noise: 12, fmDepth: 4, fmRatio: 2, attack: 0.12, decay: 0.3, sustain: 85, release: 0.3 }, {
      vibrato: { rate: 5, depth: 10 },
      reverb: { amount: 30, size: 2.5 },
    }),
    // plucks
    pluck: preset('Pluck', { wave: 'sawtooth', brightness: 34, resonance: 20, sub: 12, fmDepth: 0, pluck: 80, attack: 0.002, decay: 0.45, sustain: 8, release: 0.4 }, {
      echo: { amount: 25, sync: '3/16', pingpong: true },
      reverb: { amount: 30, size: 2.5 },
    }),
    marimba: preset('Marimba', { wave: 'sine', brightness: 55, sub: 0, fmDepth: 18, fmRatio: 4, attack: 0.002, decay: 0.45, sustain: 0, release: 0.3 }, {
      reverb: { amount: 25, size: 1.8 },
    }),
    harp: preset('Harp', { wave: 'triangle', brightness: 50, sub: 0, fmDepth: 6, fmRatio: 2, unison: 15, pluck: 45, attack: 0.003, decay: 1.2, sustain: 0, release: 1 }, {
      echo: { amount: 15, sync: '1/4' },
      reverb: { amount: 45, size: 3.5 },
    }),
    // textures
    bell: preset('Glass bell', { wave: 'sine', register: 'high', brightness: 85, sub: 0, fmDepth: 45, fmRatio: 3.5, attack: 0.005, decay: 1.1, sustain: 15, release: 1.3 }, {
      echo: { amount: 25, sync: '3/16', pingpong: true },
      reverb: { amount: 40, size: 3 },
    }),
    wind: preset('Wind', { wave: 'sine', brightness: 45, sub: 0, noise: 75, fmDepth: 0, attack: 0.4, decay: 0.3, sustain: 80, release: 1 }, {
      autofilter: { rate: 0.2, depth: 60, freq: 45, res: 30 },
      reverb: { amount: 50, size: 3.5 },
    }),
    scifi: preset('Sci-fi FM', { wave: 'sine', brightness: 60, resonance: 30, sub: 0, fmDepth: 80, fmRatio: 3.5, drift: 60, attack: 0.05, decay: 0.6, sustain: 60, release: 0.8 }, {
      phaser: { amount: 50, rate: 0.3, depth: 60, feedback: 50 },
      echo: { amount: 30, sync: '3/16', pingpong: true, repeats: 50 },
    }),
  };
  // Grouped so the Source panel reads like a small library.
  const PRESET_GROUPS = [
    { label: 'Keys', ids: ['keys', 'epiano', 'organ', 'musicbox'] },
    { label: 'Pads', ids: ['pad', 'strings', 'choir', 'drone'] },
    { label: 'Bass', ids: ['bass', 'acid', 'subbass', 'pluckbass'] },
    { label: 'Leads', ids: ['lead', 'supersaw', 'chip', 'flute'] },
    { label: 'Plucks', ids: ['pluck', 'marimba', 'harp'] },
    { label: 'Textures', ids: ['bell', 'wind', 'scifi'] },
  ];
  const PRESET_ORDER = PRESET_GROUPS.flatMap(g => g.ids);

  const WAVES = [
    { id: 'sine', label: 'Sine', hint: 'Smooth', path: 'M1 6 Q4 0 7 6 T13 6 T19 6 T23 6' },
    { id: 'triangle', label: 'Triangle', hint: 'Soft', path: 'M1 6 L4 1 L10 11 L16 1 L22 11 L23 9' },
    { id: 'sawtooth', label: 'Saw', hint: 'Buzzy', path: 'M1 11 L8 1 L8 11 L15 1 L15 11 L22 1 L22 11' },
    { id: 'square', label: 'Square', hint: 'Hollow', path: 'M1 11 L1 1 L7 1 L7 11 L13 11 L13 1 L19 1 L19 11 L23 11' },
  ];

  const REGISTERS = [
    { id: 'low', label: 'Low' },
    { id: 'mid', label: 'Mid' },
    { id: 'high', label: 'High' },
  ];

  // steps: semitones allowed in each octave; null = continuous pitch.
  const SCALES = [
    { id: 'theremin', label: 'Theremin · continuous', steps: null },
    { id: 'pentatonic', label: 'Notes · pentatonic', steps: [0, 2, 4, 7, 9] },
    { id: 'major', label: 'Notes · major', steps: [0, 2, 4, 5, 7, 9, 11] },
    { id: 'minor', label: 'Notes · minor', steps: [0, 2, 3, 5, 7, 8, 10] },
    { id: 'chromatic', label: 'Notes · chromatic', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  ];

  const READ_MODES = [
    { id: 'normal', label: 'Normal', desc: 'Reads the drawing left to right.', icon: 'M4 12h15M13 6l6 6-6 6' },
    { id: 'reversed', label: 'Reversed', desc: 'Reads the drawing right to left, every line plays backwards.', icon: 'M20 12H5M11 6l-6 6 6 6' },
    { id: 'pingpong', label: 'Ping-pong', desc: 'Forwards on one loop, backwards on the next.', icon: 'M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4' },
    { id: 'random', label: 'Random', desc: 'Cuts the loop into slices and plays them in a shuffled order.', icon: 'M4 7h3l10 10h3M4 17h3l3-3M14 10l3-3h3M18 4l3 3-3 3M18 14l3 3-3 3' },
    { id: 'sliced', label: 'Sliced', desc: 'Keeps the order but repeats and drops slices for a chopped groove.', icon: 'M6 6a2.5 2.5 0 1 0 0 .01M6 18a2.5 2.5 0 1 0 0 .01M8 7.5L20 18M8 16.5L20 6' },
  ];

  const num = v => String(Math.round(v));
  const pct = v => `${Math.round(v)}%`;
  const sec = v => `${v < 1 ? v.toFixed(2) : v.toFixed(1)} s`;

  const PANELS = [
    {
      id: 'source', tag: 'Source', title: 'Sound',
      intro: 'The raw character of this layer.',
      knobs: [
        { key: 'brightness', label: 'Brightness', min: 0, max: 100, step: 1, fmt: num, hint: 'Dull to sharp' },
        { key: 'resonance', label: 'Resonance', min: 0, max: 100, step: 1, fmt: num, hint: 'A singing peak at the brightness point' },
        { key: 'sub', label: 'Sub level', min: 0, max: 100, step: 1, fmt: num, hint: 'Low weight underneath' },
        { key: 'noise', label: 'Noise level', min: 0, max: 100, step: 1, fmt: num, hint: 'Breath and air' },
        { key: 'fmDepth', label: 'FM depth', min: 0, max: 100, step: 1, fmt: num, hint: 'Metallic, bell-like edge' },
        { key: 'fmRatio', label: 'FM ratio', min: 0.5, max: 8, step: 0.5, fmt: v => v.toFixed(1), hint: 'Colour of that edge' },
        { key: 'unison', label: 'Unison', min: 0, max: 100, step: 1, fmt: v => (v < 1 ? 'Off' : pct(v)), hint: 'Stack detuned copies for a thick, wide sound' },
        { key: 'drift', label: 'Drift', min: 0, max: 100, step: 1, fmt: v => (v < 1 ? 'Off' : pct(v)), hint: 'Slow, wobbly pitch like an old analog synth' },
      ],
    },
    {
      id: 'envelope', tag: 'ADSR', title: 'Shape',
      intro: 'How each line starts, holds and fades out.',
      knobs: [
        { key: 'attack', label: 'Attack', min: 0, max: 2, step: 0.01, fmt: sec, hint: 'How fast it starts' },
        { key: 'decay', label: 'Decay', min: 0, max: 2, step: 0.01, fmt: sec, hint: 'Drop after the start' },
        { key: 'sustain', label: 'Sustain', min: 0, max: 100, step: 1, fmt: pct, hint: 'Level while the line runs' },
        { key: 'release', label: 'Release', min: 0, max: 4, step: 0.01, fmt: sec, hint: 'Fade after the line ends' },
        { key: 'pluck', label: 'Pluck', min: 0, max: 100, step: 1, fmt: v => (v < 1 ? 'Off' : pct(v)), hint: 'Each note starts bright and closes: plucks and acid' },
        { key: 'glide', label: 'Glide', min: 0, max: 100, step: 1, fmt: v => (v < 1 ? 'Off' : `${Math.round(v * 1.2)} ms`), hint: 'Slide between notes instead of jumping' },
      ],
    },
    { id: 'soundfx', tag: 'FX on sound', title: 'Sound FX', group: 'sound', intro: 'Change the tone and colour of this layer.' },
    { id: 'timefx', tag: 'FX time', title: 'Time FX', group: 'time', intro: 'Echoes, rooms and movement over time.' },
    { id: 'lfo', tag: 'LFO', title: 'Motion', lfo: true, intro: 'Moves one knob of this layer up and down, in time with the beat.' },
    {
      id: 'voice', tag: 'Voice', title: 'Voice FX', vox: true,
      intro: 'How the robot sings every word of this layer.',
      knobs: [
        { key: 'tune', label: 'Autotune', min: 0, max: 100, step: 1, fmt: v => (v < 5 ? 'Loose' : v > 85 ? 'Hard' : pct(v)), hint: 'How fast the voice jumps onto the right note. Hard is the classic autotune effect.' },
        { key: 'formant', label: 'Formant', min: -12, max: 12, step: 1, fmt: v => `${v > 0 ? '+' : ''}${v} st`, hint: 'Mouth size: lower sounds bigger and darker, higher smaller and brighter' },
        { key: 'breath', label: 'Breath', min: 0, max: 100, step: 1, fmt: v => (v < 1 ? 'Off' : pct(v)), hint: 'Air in the voice' },
        { key: 'whisper', label: 'Whisper', min: 0, max: 100, step: 1, fmt: v => (v < 1 ? 'Off' : pct(v)), hint: 'From singing to whispering' },
        { key: 'crisp', label: 'Consonants', min: 0, max: 100, step: 1, fmt: pct, hint: 'How sharp s, t, k and p sound' },
        { key: 'vibrato', label: 'Vibrato', min: 0, max: 100, step: 1, fmt: v => (v < 1 ? 'Off' : pct(v)), hint: 'A singer\'s wobble on long notes' },
        { key: 'robot', label: 'Robot', min: 0, max: 100, step: 1, fmt: v => (v < 1 ? 'Off' : pct(v)), hint: 'Metallic ring, like an old sci-fi robot' },
      ],
    },
  ];

  Object.assign(ST, { VOX_DEFAULT, VOX_CHOICES, DEFAULT_SOUND, PRESETS, PRESET_ORDER, PRESET_GROUPS, WAVES, REGISTERS, SCALES, READ_MODES, PANELS });
})(window.ST = window.ST || {});
