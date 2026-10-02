// Accessible rotary knob: slider semantics, vertical drag, keyboard and -/+ steppers.
(function (ST) {
  'use strict';

  let count = 0;
  const START = -135, END = 135;

  const polar = (r, deg) => {
    const a = deg * Math.PI / 180;
    return [(28 + r * Math.sin(a)).toFixed(2), (28 - r * Math.cos(a)).toFixed(2)];
  };
  const arc = (r, a0, a1) => {
    const [x0, y0] = polar(r, a0), [x1, y1] = polar(r, a1);
    return `M${x0} ${y0} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };

  function createKnob({ label, min, max, step, value, reset, fmt, hint, onInput }) {
    const id = `knob-${++count}`;
    const el = document.createElement('div');
    el.className = 'knob-ctl';
    el.innerHTML = `
      <span class="knob-label" id="${id}-l">${label}</span>
      <div class="knob" role="slider" tabindex="0" aria-labelledby="${id}-l" aria-describedby="${id}-h"
           aria-valuemin="${min}" aria-valuemax="${max}">
        <svg viewBox="0 0 56 56" aria-hidden="true" focusable="false">
          <circle class="knob-face" cx="28" cy="28" r="19"/>
          <path class="knob-track" d="${arc(24, START, END)}"/>
          <path class="knob-value"/>
          <line class="knob-pointer" x1="28" y1="28" x2="28" y2="14"/>
        </svg>
      </div>
      <div class="stepper">
        <button type="button" class="step-btn" data-d="-1" tabindex="-1" aria-label="Decrease ${label}">−</button>
        <output class="knob-out" aria-hidden="true"></output>
        <button type="button" class="step-btn" data-d="1" tabindex="-1" aria-label="Increase ${label}">+</button>
      </div>
      <span class="knob-hint" id="${id}-h">${hint}</span>`;

    const knob = el.querySelector('.knob');
    const valuePath = el.querySelector('.knob-value');
    const pointer = el.querySelector('.knob-pointer');
    const out = el.querySelector('.knob-out');
    const decimals = (String(step).split('.')[1] || '').length;
    const snap = v => {
      const c = Math.min(max, Math.max(min, v));
      return +(Math.round((c - min) / step) * step + min).toFixed(decimals);
    };
    let current = snap(value);

    function paint() {
      const deg = START + (current - min) / (max - min) * (END - START);
      valuePath.setAttribute('d', current > min ? arc(24, START, deg) : '');
      pointer.setAttribute('transform', `rotate(${deg.toFixed(1)} 28 28)`);
      out.textContent = fmt(current);
      knob.setAttribute('aria-valuenow', current);
      knob.setAttribute('aria-valuetext', fmt(current));
    }

    function commit(v) {
      const n = snap(v);
      if (n === current) return;
      current = n;
      paint();
      onInput(current);
    }

    knob.addEventListener('keydown', e => {
      const big = Math.max(step, (max - min) / 10);
      const deltas = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: big, PageDown: -big };
      if (e.key in deltas) commit(current + deltas[e.key] * (e.shiftKey && e.key.startsWith('Arrow') ? 10 : 1));
      else if (e.key === 'Home') commit(min);
      else if (e.key === 'End') commit(max);
      else if (e.key === 'Enter') openEdit();
      else return;
      e.preventDefault();
    });

    let drag = null;
    knob.addEventListener('pointerdown', e => {
      e.preventDefault();
      knob.focus();
      knob.setPointerCapture(e.pointerId);
      drag = { y: e.clientY, v: current };
    });
    knob.addEventListener('pointermove', e => {
      if (!drag) return;
      const fine = e.shiftKey ? 0.2 : 1;
      commit(drag.v + (drag.y - e.clientY) / 160 * (max - min) * fine);
    });
    const endDrag = () => { drag = null; };
    knob.addEventListener('pointerup', endDrag);
    knob.addEventListener('pointercancel', endDrag);
    knob.addEventListener('dblclick', () => commit(reset));

    el.querySelectorAll('.step-btn').forEach(btn => {
      btn.addEventListener('click', () => commit(current + Number(btn.dataset.d) * step));
    });

    // Type an exact value: click the value (or press Enter on the knob), type, Enter.
    // The text is matched against what the knob shows, so "3" works for "+3 st" and "off" for "Off".
    const num = t => {
      const m = String(t).replace(/−/g, '-').match(/[-+]?\d*[.,]?\d+/);
      return m ? parseFloat(m[0].replace(',', '.')) : NaN;
    };
    function valueFromText(text) {
      const want = text.trim().toLowerCase();
      if (!want) return null;
      const n = num(want), span = Math.round((max - min) / step), stride = Math.max(1, Math.ceil(span / 20000));
      let best = null, bestD = Infinity;
      for (let i = 0; i <= span; i += stride) {
        const v = snap(min + i * step), shown = String(fmt(v));
        if (shown.toLowerCase() === want) return v;
        const fn = num(shown);
        if (!Number.isNaN(n) && !Number.isNaN(fn) && Math.abs(fn - n) < bestD) { bestD = Math.abs(fn - n); best = v; }
      }
      // No shown value matches (e.g. "75" on a knob that shows "~6 / bar"): use the knob's own range.
      if (bestD > 1e-9 && !Number.isNaN(n) && n >= min && n <= max && Math.abs(snap(n) - n) < bestD) return snap(n);
      return best;
    }
    function openEdit() {
      if (el.querySelector('.knob-edit')) return;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'knob-edit';
      input.value = fmt(current);
      input.setAttribute('aria-label', `Type a value for ${label}, then press Enter`);
      out.hidden = true;
      out.after(input);
      input.focus();
      input.select();
      let done = false;
      const close = apply => {
        if (done) return;
        done = true;
        if (apply) { const v = valueFromText(input.value); if (v != null) commit(v); }
        input.remove();
        out.hidden = false;
        knob.focus();
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); close(true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
      });
      input.addEventListener('blur', () => close(true));
    }
    out.addEventListener('click', openEdit);
    out.title = 'Click to type a value';

    paint();
    return { el, set(v) { current = snap(v); paint(); } };
  }

  ST.createKnob = createKnob;
})(window.ST = window.ST || {});
