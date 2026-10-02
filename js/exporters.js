// File writers for exports, with no libraries: a plain ZIP (stored, no compression,
// fine for WAV) and a Standard MIDI File (type 1, one track per layer, drums on channel 10).
(function (ST) {
  'use strict';

  // ---------- ZIP ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // files: [{ name, data: Uint8Array }] -> Blob (application/zip)
  function makeZip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
      const head = new DataView(new ArrayBuffer(30));
      head.setUint32(0, 0x04034b50, true);
      head.setUint16(4, 20, true);
      head.setUint16(6, 0x0800, true); // UTF-8 names
      head.setUint16(8, 0, true); // stored
      head.setUint16(10, dosTime, true);
      head.setUint16(12, dosDate, true);
      head.setUint32(14, crc, true);
      head.setUint32(18, size, true);
      head.setUint32(22, size, true);
      head.setUint16(26, name.length, true);
      head.setUint16(28, 0, true);
      parts.push(head, name, f.data);
      const dir = new DataView(new ArrayBuffer(46));
      dir.setUint32(0, 0x02014b50, true);
      dir.setUint16(4, 20, true);
      dir.setUint16(6, 20, true);
      dir.setUint16(8, 0x0800, true);
      dir.setUint16(10, 0, true);
      dir.setUint16(12, dosTime, true);
      dir.setUint16(14, dosDate, true);
      dir.setUint32(16, crc, true);
      dir.setUint32(20, size, true);
      dir.setUint32(24, size, true);
      dir.setUint16(28, name.length, true);
      dir.setUint32(42, offset, true);
      central.push(dir, name);
      offset += 30 + name.length + size;
    }
    const dirSize = central.reduce((a, x) => a + x.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, dirSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  // ---------- MIDI ----------
  const PPQ = 480;
  const varLen = n => {
    const bytes = [n & 0x7F];
    while ((n >>= 7)) bytes.unshift((n & 0x7F) | 0x80);
    return bytes;
  };
  const text = s => [...new TextEncoder().encode(s)];
  function chunk(type, body) {
    return [...text(type), (body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255, ...body];
  }
  // events: [{ tick, data: [...] }] -> track bytes (sorted, delta times, end of track)
  function trackBytes(events) {
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const out = [];
    let last = 0;
    for (const e of events) { out.push(...varLen(Math.max(0, e.tick - last)), ...e.data); last = e.tick; }
    out.push(0, 0xFF, 0x2F, 0);
    return chunk('MTrk', out);
  }

  // tracks: [{ name, channel, notes: [{ t, dur, note, vel }] }] (seconds) -> Uint8Array
  function makeMidi(tracks, bpm) {
    const tick = s => Math.round(s * bpm / 60 * PPQ);
    const usPerBeat = Math.round(60000000 / bpm);
    const tempo = [
      { tick: 0, order: 0, data: [0xFF, 0x03, ...varLen(10), ...text('Sketchtone')] },
      { tick: 0, order: 0, data: [0xFF, 0x51, 0x03, (usPerBeat >> 16) & 255, (usPerBeat >> 8) & 255, usPerBeat & 255] },
      { tick: 0, order: 0, data: [0xFF, 0x58, 0x04, 4, 2, 24, 8] },
    ];
    const chunks = [trackBytes(tempo)];
    for (const tr of tracks) {
      const name = text(tr.name).slice(0, 120), ev = [{ tick: 0, order: 0, data: [0xFF, 0x03, ...varLen(name.length), ...name] }];
      for (const n of tr.notes) {
        const a = tick(n.t), b = Math.max(a + 1, tick(n.t + n.dur)), note = Math.max(0, Math.min(127, Math.round(n.note)));
        ev.push({ tick: a, order: 2, data: [0x90 | tr.channel, note, Math.max(1, Math.min(127, Math.round(n.vel)))] });
        ev.push({ tick: b, order: 1, data: [0x80 | tr.channel, note, 0] }); // offs before ons on the same tick
      }
      chunks.push(trackBytes(ev));
    }
    const header = chunk('MThd', [0, 1, 0, chunks.length & 255, (PPQ >> 8) & 255, PPQ & 255]);
    return new Uint8Array([...header, ...chunks.flat()]);
  }

  Object.assign(ST, { makeZip, makeMidi, crc32 });
})(window.ST = window.ST || {});
