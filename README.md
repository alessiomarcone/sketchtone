# Sketchtone

**Draw lines, hear music.** Sketchtone turns drawings into sound: left to right is time, higher is a higher note, thicker is louder. It is made for people who are not music producers, and it works with a mouse, a keyboard, a touch screen or a MIDI controller.

![Sketchtone with a demo sketch: sung words, a hand-drawn melody, shapes, a bass pattern and a minimal beat](docs/screenshot.png)

Open the app with **`?demo`** at the end of the address to load a ready-made sketch (it never replaces work you already have).

## What you can do

- **Draw sound** with a Paint-style toolbox: pencil, line, rectangle, ellipse, spray and eraser. Shapes play chords, spray plays short sparkles.
- **Sing with text.** The Text brush types words on the canvas and a robot voice sings them, autotuned to the scale, following the slope of the words.
- **Generate patterns** when you don't want to draw: repeat a motif across the loop (rows for chords, climb for arpeggios, brick for off-beats), or start from presets like Arpeggio, Heartbeat or Bouncing ball.
- **Generative drums.** Draw an energy line, turn eight knobs (kicks, snares, hats, percs, fills, gaps, dirt, evolve) and the drummer writes the groove, with fills and drop-outs that change every phrase.
- **Shape the sound** on every layer with knobs: 22 presets, source, envelope, 19 effects and voice effects. The drums are a layer too, with their own kits and effects.
- **Play live.** Edits change the sound while it plays. Read modes reverse, ping-pong or slice the loop. Etch mode draws with two knobs, like the classic red toy.
- **Plug in a controller.** Tuned for the Akai MPK Mini: knobs reshape lines, pads jump to slices, keys hold effect presets, the joystick bends pitch.
- **Keep and share your work.** The sketch saves itself in the browser. Save versions, download a project file, record live, or export a WAV of any length (rendered offline with a fade-out).

## Run it

It is plain HTML, CSS and JavaScript, with no build step and no dependencies.

```bash
python3 -m http.server 5178
```

Then open http://localhost:5178. Opening `index.html` directly from the disk works too. MIDI needs Chrome or Edge.

## Keyboard

| Keys | Action |
| --- | --- |
| Space | Play or pause |
| V P L R O T S E | Select, Pencil, Line, Rectangle, Ellipse, Text, Spray, Eraser |
| Arrows on the canvas | Move the pen; Space starts and finishes a line |
| Ctrl/⌘ Z, Shift Ctrl/⌘ Z | Undo, redo |
| Delete | Remove the selected item |
| Arrows on a knob | Turn it (Shift for bigger steps) |

Every control has a label for screen readers, knobs behave as sliders, and changes are announced.

## Privacy

Everything stays in your browser: no account, no cookies, no analytics. Exports and recordings are made on your computer. The Inter font loads from Google Fonts. See the Privacy page in the app's settings for details.

## How it is built

| File | What it does |
| --- | --- |
| `js/app.js` | Interface, canvas, tools, knobs, settings and export |
| `js/audio.js` | Web Audio engine: voices, effects buses, live edits, offline WAV export |
| `js/shapes.js` | Tools and item geometry, non-destructive transforms |
| `js/patterns.js` | Pattern generator and line presets |
| `js/voice.js` | Robot singing voice: letters to phonemes to formant filters |
| `js/drums.js` | Generative drummer and synthesized kits |
| `js/fx.js` | The 19 effects |
| `js/sounds.js` | Presets, scales and panel definitions |
| `js/midi.js` | Web MIDI input, knob mapping and setup |
| `js/knob.js` | Accessible rotary knob |

## Deploy

The repository includes `netlify.toml`: connect the repository to Netlify and it publishes the app as is. Only `index.html`, `styles.css` and `js/` go online.

## Credits

Idea and design by Alessio Marcone. Built with [Claude Code](https://claude.com/claude-code). All sounds are synthesized live with the Web Audio API. Type: [Inter](https://rsms.me/inter/) by Rasmus Andersson.
