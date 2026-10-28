// «Русская рулетка» на «Сегодня»: каждое утро тренировочного дня друг сам крутит колесо.
// Выпавшее число прибавляется к множителю очков за подходы (серия или «Всё или ничего»), не ниже пола.
// Особые сектора: револьвер (жать на курок или убрать), «ещё раз» (колесо крутится снова) и звезда (событие дня).
// Не хочет рисковать — «Не крутить сегодня»: множитель как обычно, крутить в этот день уже нельзя.
// Что выпало, решает база; колесо только красиво доезжает до ответа.

import { html, raw } from '../util.js';
import { confetti } from './goal.js';
import { ROULETTE, OUTCOMES, outcome, rouletteCfg, rouletteEV, addText, toneOf, dayMult, isFloored, chanceSum, rouletteProblems,
  rouletteRange } from '../roulette-data.js';

const C = 200;      // центр колеса во viewBox 400×400
const R_SEC = 170;  // радиус секторов
const BULBS = 24;   // лампочки на ободе
const SOUND_KEY = 'rl-sound';
let uid = 0;        // у каждого колеса свои id градиентов: на экране их бывает два
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ── Колесо ──

const pt = (r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [C + r * Math.sin(a), C - r * Math.cos(a)];
};
const f2 = (n) => n.toFixed(2);

// Сектора по кругу: угол от стрелки по часовой, размер — по шансу.
function sectorsOf(cfg) {
  const list = OUTCOMES.filter((o) => Number(cfg.items[o.key].chance) > 0);
  const total = list.reduce((s, o) => s + Number(cfg.items[o.key].chance), 0) || 1;
  let a = 0;
  return list.map((o) => {
    const span = (360 * Number(cfg.items[o.key].chance)) / total;
    const s = { o, from: a, to: a + span, span, mid: a + span / 2 };
    a += span;
    return s;
  });
}

function sectorPath(s, r) {
  if (s.span >= 359.99) return `M${C} ${C - r}A${r} ${r} 0 1 1 ${C - 0.01} ${C - r}Z`;
  const [x1, y1] = pt(r, s.from);
  const [x2, y2] = pt(r, s.to);
  return `M${C} ${C}L${f2(x1)} ${f2(y1)}A${r} ${r} 0 ${s.span > 180 ? 1 : 0} 1 ${f2(x2)} ${f2(y2)}Z`;
}

// Подпись сектора: значок у обода, число — вдоль радиуса. В узких секторах шрифт меньше, число может не влезть.
function sectorLabel(s, cfg) {
  const rad = (s.span * Math.PI) / 180;
  const fsIcon = Math.min(30, 146 * rad * 0.6);
  const fsVal = Math.min(19, 100 * rad * 0.62);
  const val = s.o.special ? '' : addText(cfg.items[s.o.key].add);
  return `<g class="rl-lab" data-key="${s.o.key}" transform="rotate(${f2(s.mid)} ${C} ${C})">
    <text class="rl-ic" x="${C}" y="${C - 140}" font-size="${f2(fsIcon)}">${s.o.icon}</text>
    ${val && fsVal >= 8 ? `<text class="rl-val" x="${C}" y="${C - 92}" font-size="${f2(fsVal)}" fill="${s.o.ink ?? '#fff'}"
      transform="rotate(-90 ${C} ${C - 92})">${val}</text>` : ''}
  </g>`;
}

// Колесо из слоёв. Диск с секторами крутится целиком внутри .rl-rot — телефон вращает готовую картинку
// и не перерисовывает SVG. Поверх стоят обод, лампочки (мигают прозрачностью), стрелка (качается)
// и, после остановки, слой с выпавшим сектором (.rl-hitbox). Так анимации идут на видеочипе.
function wheelHtml(cfg, segs, { mini = false } = {}) {
  const id = ++uid;
  const sectors = segs.map((s) => `<path class="rl-sec" data-key="${s.o.key}" d="${sectorPath(s, R_SEC)}" fill="${s.o.color}"/>`).join('');
  const labels = mini ? '' : segs.map((s) => sectorLabel(s, cfg)).join('');
  // Золотые спицы между секторами и колышки у обода — по ним «щёлкает» стрелка.
  const spokes = segs.length > 1 ? segs.map((s) => {
    const [x1, y1] = pt(56, s.from);
    const [x2, y2] = pt(R_SEC, s.from);
    const [px, py] = pt(R_SEC - 7, s.from);
    return `<line x1="${f2(x1)}" y1="${f2(y1)}" x2="${f2(x2)}" y2="${f2(y2)}"/>${mini ? '' : `<circle cx="${f2(px)}" cy="${f2(py)}" r="3.2"/>`}`;
  }).join('') : '';
  const bulb = (i) => {
    const [x, y] = pt(179, (360 / BULBS) * i + 360 / BULBS / 2);
    return `<circle cx="${f2(x)}" cy="${f2(y)}" r="${mini ? 5 : 3.6}"/>`;
  };
  const bulbs = (k) => Array.from({ length: BULBS }, (_, i) => (k === null || i % 2 === k ? bulb(i) : '')).join('');
  // Горящие лампочки — два слоя через одну: мигают по очереди.
  const lit = [0, 1].map((k) => `<div class="rl-lit rl-lit-${k}"><svg viewBox="0 0 400 400" aria-hidden="true">
      <defs><filter id="rl-glow-${id}-${k}" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter></defs>
      <g filter="url(#rl-glow-${id}-${k})">${bulbs(k)}</g>
    </svg></div>`).join('');
  return raw(`<div class="rl-wheel ${mini ? 'rl-wheel-mini' : ''}">
    <div class="rl-clip"><div class="rl-rot">
      <svg class="rl-disc" viewBox="0 0 400 400" aria-hidden="true">
        <defs>
          <radialGradient id="rl-shade-${id}" cx="50%" cy="50%" r="50%">
            <stop offset="0" stop-color="#000" stop-opacity=".45"/><stop offset=".42" stop-color="#000" stop-opacity=".08"/>
            <stop offset=".8" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".28"/>
          </radialGradient>
        </defs>
        <circle cx="${C}" cy="${C}" r="${R_SEC}" fill="#0B0C10"/>
        <g class="rl-secs">${sectors}</g>
        <circle cx="${C}" cy="${C}" r="${R_SEC}" fill="url(#rl-shade-${id})" pointer-events="none"/>
        <g class="rl-spokes">${spokes}</g>
        ${labels}
        <circle cx="${C}" cy="${C}" r="56" class="rl-inner"/>
      </svg>
      ${mini ? '' : '<div class="rl-hitbox"></div>'}
    </div></div>
    <svg class="rl-frame" viewBox="0 0 400 400" aria-hidden="true">
      <defs>
        <linearGradient id="rl-rim-${id}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#3A3F4A"/><stop offset=".5" stop-color="#1C1F26"/><stop offset="1" stop-color="#2E333D"/>
        </linearGradient>
        <radialGradient id="rl-gloss-${id}" cx="35%" cy="22%" r="60%">
          <stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <circle cx="${C}" cy="${C}" r="${R_SEC}" fill="url(#rl-gloss-${id})"/>
      <circle cx="${C}" cy="${C}" r="179" fill="none" stroke="url(#rl-rim-${id})" stroke-width="18"/>
      <circle cx="${C}" cy="${C}" r="188.5" fill="none" class="rl-rim-line"/>
      <circle cx="${C}" cy="${C}" r="170" fill="none" class="rl-rim-line"/>
      <g class="rl-bulbs-off">${bulbs(null)}</g>
    </svg>
    ${lit}
    <div class="rl-pinbox"><svg viewBox="180 -2 40 56" aria-hidden="true">
      <defs><linearGradient id="rl-pin-${id}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#FFE9A3"/><stop offset=".55" stop-color="#FFD54A"/><stop offset="1" stop-color="#C79A12"/>
      </linearGradient></defs>
      <path d="M${C} 52 L${C - 15} 18 A17 17 0 1 1 ${C + 15} 18 Z" fill="url(#rl-pin-${id})" stroke="#3B2C00" stroke-width="2.5" stroke-linejoin="round"/>
      <circle cx="${C}" cy="12" r="5.5" fill="#3B2C00"/>
    </svg></div>
    ${mini ? '' : '<button type="button" class="rl-hub" data-rl-hub>КРУТИ</button>'}
  </div>`);
}

// Выпавший сектор: колесо темнеет, сектор остаётся ярким, обводка мигает. Отдельный слой над диском.
function hitHtml(s, cfg) {
  if (!s) return '';
  const d = sectorPath(s, R_SEC);
  return `<div class="rl-hit-dim"><svg viewBox="0 0 400 400" aria-hidden="true">
      <circle cx="${C}" cy="${C}" r="${R_SEC}" fill="#07080B" fill-opacity=".74"/>
      <path d="${d}" fill="${s.o.color}"/>${sectorLabel(s, cfg)}
      <circle cx="${C}" cy="${C}" r="56" class="rl-inner"/>
    </svg></div>
    <div class="rl-ring"><svg viewBox="0 0 400 400" aria-hidden="true">
      <path d="${d}" fill="none" stroke="#FFF4C8" stroke-width="4" stroke-linejoin="round"/>
    </svg></div>`;
}

// Кривая Безье для времени анимации — та же, что у браузера, чтобы щелчки стрелки совпадали с колесом.
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1; const bx = 3 * (x2 - x1) - cx; const ax = 1 - cx - bx;
  const cy = 3 * y1; const by = 3 * (y2 - y1) - cy; const ay = 1 - cy - by;
  const X = (t) => ((ax * t + bx) * t + cx) * t;
  const Y = (t) => ((ay * t + by) * t + cy) * t;
  const dX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const e = X(t) - x;
      if (Math.abs(e) < 1e-6) break;
      const d = dX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    return Y(Math.min(1, Math.max(0, t)));
  };
}
const EASE_IN = 'cubic-bezier(0.333, 0, 0.667, 0.333)'; // ровно t²: равномерный разгон
const EASE_OUT = [0.25, 1, 0.5, 1];                      // торможение, начальная скорость ×4 к средней
const easeOut = bezier(...EASE_OUT);

// Колесо крутится с постоянной скоростью, пока ждём базу, а потом плавно доезжает до нужного сектора.
// Вращение — анимация браузера (видеочип, без перерисовки), а угол для щелчков считаем той же формулой.
// onTick(скорость) — стрелка перескочила на соседний сектор.
function spinner(box, segs, onTick) {
  const rot = box.querySelector('.rl-rot');
  const V = reduced() ? 500 : 1150; // градусов в секунду
  const R = 0.45;                   // разгон до V, секунд
  let angle = Math.random() * 360;  // угол, с которого началось текущее движение
  let plan = null;                  // { kind: 'run' | 'stop', t0, … }
  let anim = null;
  let raf = 0;
  const at = (a) => {
    const p = (((-a) % 360) + 360) % 360;
    const i = segs.findIndex((s) => p >= s.from && p < s.to);
    return i < 0 ? segs.length - 1 : i;
  };
  const rotate = (a) => `rotate(${f2(a)}deg)`;
  // Угол и скорость в момент now — та же кривая, что у анимации.
  const state = (now) => {
    if (!plan) return [angle, 0];
    const t = Math.max(0, (now - plan.t0) / 1000);
    if (plan.kind === 'run') {
      return t < R ? [angle + (V * t * t) / (2 * R), (V * t) / R] : [angle + (V * R) / 2 + V * (t - R), V];
    }
    const x = Math.min(1, t / plan.T);
    const dx = Math.min(1, x + 0.002);
    return [angle + plan.A * easeOut(x), x >= 1 ? 0 : (plan.A * (easeOut(dx) - easeOut(x))) / ((dx - x) * plan.T)];
  };
  let cur = at(angle);
  const watch = (now) => {
    const [a, speed] = state(now);
    const i = at(a);
    if (i !== cur) { cur = i; onTick(speed); }
    if (plan) raf = requestAnimationFrame(watch);
  };
  const play = (keyframes, opts) => {
    anim?.cancel();
    anim = rot.animate?.(keyframes, { fill: 'forwards', ...opts }) ?? null;
    if (!anim) rot.style.transform = keyframes[keyframes.length - 1].transform;
  };
  rot.style.transform = rotate(angle);
  return {
    start() {
      const now = performance.now();
      [angle] = state(now);
      plan = { kind: 'run', t0: now };
      const LONG = 600; // секунд: столько база точно не думает
      play([
        { transform: rotate(angle), easing: EASE_IN },
        { transform: rotate(angle + (V * R) / 2), offset: R / LONG },
        { transform: rotate(angle + (V * R) / 2 + V * (LONG - R)) },
      ], { duration: LONG * 1000 });
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(watch);
    },
    // Остановиться на секторе key: место внутри сектора — случайное, но не у самой границы.
    land(key) {
      return new Promise((done) => {
        const now = performance.now();
        const [from, speed] = state(now);
        const s = segs.find((x) => x.o.key === key) ?? segs[0];
        const phi = s.from + s.span * (0.2 + Math.random() * 0.6);
        const v = Math.max(speed, V * 0.6);
        const rest = ((((-phi - from) % 360) + 360) % 360);
        const A = 360 * (reduced() ? 1 : 3) + rest;
        const T = ((4 * A) / v); // секунд: начальная скорость кривой — 4 средних
        angle = from;
        plan = { kind: 'stop', t0: now, A, T };
        play([{ transform: rotate(from) }, { transform: rotate(from + A) }],
          { duration: T * 1000, easing: `cubic-bezier(${EASE_OUT.join(', ')})` });
        const finish = () => {
          angle = from + A;
          plan = null;
          cancelAnimationFrame(raf);
          rot.style.transform = rotate(angle);
          anim?.cancel();
          anim = null;
          done();
        };
        if (anim) anim.finished.then(finish, () => {}); else finish();
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(watch);
      });
    },
    kill() { cancelAnimationFrame(raf); anim?.cancel(); anim = null; plan = null; },
  };
}

// ── Звук и вибрация: короткие синтезированные звуки, без файлов ──

let audio = null;
const soundOn = () => { try { return localStorage.getItem(SOUND_KEY) !== '0'; } catch { return true; } };
function ctxAudio() {
  if (!audio) {
    const A = window.AudioContext || window.webkitAudioContext;
    audio = A ? new A() : null;
  }
  if (audio?.state === 'suspended') audio.resume().catch(() => {});
  return audio;
}
function tone({ freq, dur, type = 'triangle', gain = 0.06, slide = null, at = 0 }) {
  const a = soundOn() ? ctxAudio() : null;
  if (!a) return;
  const t = a.currentTime + at;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}
function noise({ dur = 0.5, gain = 0.5, cutoff = 1000 }) {
  const a = soundOn() ? ctxAudio() : null;
  if (!a) return;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * dur), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i += 1) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
  const src = a.createBufferSource();
  const lp = a.createBiquadFilter();
  const g = a.createGain();
  src.buffer = buf;
  lp.type = 'lowpass';
  lp.frequency.value = cutoff;
  g.gain.value = gain;
  src.connect(lp).connect(g).connect(a.destination);
  src.start();
}
const SFX = {
  tick: () => tone({ freq: 2300, dur: 0.02, type: 'square', gain: 0.022 }),
  good: () => [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, dur: 0.18, gain: 0.07, at: i * 0.08 })),
  gold: () => {
    [523, 659, 784, 1047, 1319, 1568, 2093].forEach((f, i) => tone({ freq: f, dur: 0.24, gain: 0.08, at: i * 0.07 }));
    [1568, 2093, 2637].forEach((f, i) => tone({ freq: f, dur: 0.5, type: 'sine', gain: 0.04, at: 0.55 + i * 0.12 }));
  },
  zero: () => tone({ freq: 392, dur: 0.22, type: 'sine', gain: 0.06 }),
  bad: () => tone({ freq: 260, dur: 0.5, type: 'sawtooth', gain: 0.045, slide: 90 }),
  awful: () => { tone({ freq: 180, dur: 0.8, type: 'sawtooth', gain: 0.06, slide: 45 }); noise({ dur: 0.35, gain: 0.25, cutoff: 500 }); },
  special: () => [784, 988, 1175, 1568].forEach((f, i) => tone({ freq: f, dur: 0.14, type: 'sine', gain: 0.06, at: i * 0.06 })),
  cock: () => { tone({ freq: 900, dur: 0.03, type: 'square', gain: 0.05 }); tone({ freq: 1400, dur: 0.03, type: 'square', gain: 0.05, at: 0.09 }); },
  roll: () => Array.from({ length: 9 }, (_, i) => tone({ freq: 3000 - i * 120, dur: 0.012, type: 'square', gain: 0.02, at: i * 0.07 + i * i * 0.006 })),
  click: () => { tone({ freq: 3400, dur: 0.018, type: 'square', gain: 0.08 }); tone({ freq: 1200, dur: 0.05, type: 'square', gain: 0.03, at: 0.02 }); },
  bang: () => { noise({ dur: 0.9, gain: 0.9, cutoff: 1800 }); tone({ freq: 90, dur: 0.6, type: 'sine', gain: 0.3, slide: 30 }); },
};
const buzz = (p) => { try { navigator.vibrate?.(p); } catch { /* нет вибрации */ } };
const BUZZ = { gold: [40, 50, 40, 50, 120], great: [30, 40, 60], good: 30, zero: 15, bad: [60, 40, 60], awful: [120, 60, 220], special: [20, 30, 20] };

// ── Карточка на «Сегодня» ──

const baseText = (s) => (s.allin != null ? `ALL IN ×${s.allin}` : `серия ×${s.k}`);
const fmt = (n) => Number(n ?? 0).toLocaleString('ru-RU');
const signedPts = (n) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : '0');

// s — состояние дня из api.rouletteDay, null — рулетки в этот день нет.
export function rouletteCard(s, settings, { isToday, isAdmin }) {
  if (!s) return '';
  const cfg = rouletteCfg(settings?.roulette);
  const sp = s.spin;
  if (!sp) {
    if (isAdmin) {
      return html`<section class="card rl-card"><div class="row"><span class="rl-tag">🎰 ${ROULETTE}</span>
        <span class="chip">ещё не крутил</span></div>
        <p class="label">Друг ещё не крутил колесо.${cfg.lock ? ' Пока не крутанёт или не откажется, подходы у него закрыты.' : ''}</p></section>`;
    }
    const segs = sectorsOf(cfg);
    return html`<section class="card rl-card rl-cta">
      <div class="rl-cta-row">
        <span class="rl-cta-wheel">${wheelHtml(cfg, segs, { mini: true })}</span>
        <div class="stack-4">
          <span class="rl-tag">🎰 ${ROULETTE}</span>
          <h2 class="rl-cta-title">Крути колесо дня</h2>
          <p class="label">Выпадет число — оно прибавится к множителю очков за подходы. Чаще плюс, но бывает и минус.</p>
        </div>
      </div>
      <button type="button" class="btn rl-go" data-rl-spin>🎰 Крутить</button>
      <button type="button" class="ghost rl-skip-btn" data-rl-skip>Не крутить сегодня</button>
      ${cfg.lock ? html`<p class="label center">🔒 Подходы откроются, когда крутанёшь колесо или откажешься от него.</p>` : ''}
    </section>`;
  }
  if (sp.key === 'skip') {
    return html`<section class="card rl-card rl-skip">
      <div class="row"><span class="rl-tag">🎰 ${ROULETTE}</span><span class="chip">🚫 без колеса</span></div>
      <p class="label">${isAdmin ? 'Друг отказался от колеса' : isToday ? 'Сегодня без колеса' : 'В этот день без колеса'}:
        очки за подходы как обычно — ${baseText(s)}.</p>
    </section>`;
  }
  const o = outcome(sp.key);
  if (sp.gun === 'offer') {
    return html`<section class="card rl-card rl-special" style="--rl-color: ${o.color}">
      <div class="row"><span class="rl-tag">🎰 ${ROULETTE}</span><span class="chip rl-chip">🔫 Револьвер</span></div>
      <p class="rl-mult">Револьвер у тебя в руках</p>
      <p class="label">В барабане ${cfg.gun.chambers} гнёзд и 1 патрон. Пусто — ${addText(cfg.gun.win)} к множителю, выстрел — ${addText(cfg.gun.lose)}.
        Можно убрать револьвер — тогда 0. Не решишь до полуночи — тоже 0.</p>
      ${isToday && !isAdmin ? html`<button type="button" class="btn rl-trigger" data-rl-gun>🔫 Решить</button>` : ''}
    </section>`;
  }
  const tone = toneOf(sp.key, sp.add);
  const star = sp.key === 'star';
  const chain = sp.chain.length > 1 ? html`<span class="label">🔄 → </span>` : '';
  const gunNote = { click: ' · револьвер: щёлк, пусто', bang: ' · револьвер: выстрел', pass: ' · револьвер убран' }[sp.gun] ?? '';
  let points;
  if (s.test) points = html`<p class="label">Тестовый период: очков нет.</p>`;
  else if (star) points = html`<p class="label">Множитель колесо не меняет, зато сегодня событие дня: звезда наверху справа, мини-игра до ×1.5.</p>`;
  else if (s.mult === s.m) points = html`<p class="label">Сегодня рулетка очки не меняет.</p>`;
  else if (s.final) points = html`<p class="label">Итог дня: подходы ${fmt(s.points)} · рулетка <b class="rl-pts">${signedPts(s.applied)}</b></p>`;
  else if (s.points) {
    points = html`<p class="label">Пока: подходы ${fmt(s.points)} · рулетка <b class="rl-pts">${signedPts(s.bonus)}</b>.
      Начислится одной строкой, когда день закончится и генерал всё проверит.</p>`;
  } else if (!isToday) points = html`<p class="label">Подходы ещё у генерала на проверке. Рулетка начислится, когда он всё проверит.</p>`;
  else points = html`<p class="label">Все подходы сегодня — по этому множителю. Разница придёт одной строкой, когда день закончится и генерал всё проверит.</p>`;
  return html`<section class="card rl-card rl-${tone}" style="--rl-color: ${o.color}">
    <div class="row"><span class="rl-tag">🎰 ${ROULETTE}</span><span class="chip rl-chip">${chain}${o.icon} ${o.name}${star ? '' : ` ${addText(sp.add)}`}</span></div>
    <p class="rl-mult">${isToday ? 'Сегодня очки' : 'Очки'} за подходы <b>×${s.mult}</b></p>
    <p class="label">${baseText(s)} · ${star ? 'звезда: событие дня' : `рулетка ${addText(sp.add)}`}${gunNote}${s.floored ? ` · но не ниже ×${cfg.floor}` : ''}</p>
    ${points}
  </section>`;
}

// Подходы закрыты, пока друг не крутанул колесо и не решил с револьвером или не отказался от колеса (если генерал так настроил).
export const rouletteLocked = (s, settings) => Boolean(s?.need && rouletteCfg(settings?.roulette).lock);

// Чип в шапке «Сегодня»: что выпало.
export function rouletteChip(s) {
  if (!s?.spin || s.spin.gun === 'offer' || s.spin.key === 'skip') return '';
  const o = outcome(s.spin.key);
  return html`<span class="chip rl-head-chip" style="--rl-color: ${o.color}">🎰 ${o.icon} ×${s.mult}</span>`;
}

export function wireRoulette(el, ctx, s) {
  el.querySelector('[data-rl-spin]')?.addEventListener('click', () => openRoulette(ctx, s));
  el.querySelector('[data-rl-gun]')?.addEventListener('click', () => openRoulette(ctx, s, { gun: true }));
  const skip = el.querySelector('[data-rl-skip]');
  skip?.addEventListener('click', async () => {
    if (!confirm('Не крутить колесо сегодня? Очки за подходы будут как обычно, а крутить сегодня уже не получится.')) return;
    skip.disabled = true;
    try {
      await ctx.api.skipRoulette();
      ctx.refresh();
    } catch (err) {
      skip.disabled = false;
      ctx.toast(err.message);
    }
  });
}

// ── Шансы: что может выпасть ──

export function oddsHtml(raw) {
  const cfg = rouletteCfg(raw);
  const g = cfg.gun;
  const rows = OUTCOMES.filter((o) => Number(cfg.items[o.key].chance) > 0).map((o) => ({ o, v: o.special ? null : Number(cfg.items[o.key].add) }))
    .sort((a, b) => (a.v === null) - (b.v === null) || (b.v ?? 0) - (a.v ?? 0));
  const what = (o) => ({
    revolver: `курок: ${addText(g.win)} или ${addText(g.lose)}`,
    respin: 'крутишь снова',
    star: 'мини-игра до ×1.5',
  }[o.key]);
  const ev = rouletteEV(cfg);
  return html`<ul class="rl-odds-list">${rows.map(({ o, v }) => html`<li style="--rl-color: ${o.color}">
      <span class="rl-dot"></span><span class="rl-odds-ic">${o.icon}</span><span class="rl-odds-name">${o.name}</span>
      <span class="rl-odds-val ${v === null ? 'label' : v > 0 ? 'ok' : v < 0 ? 'bad' : ''}">${v === null ? what(o) : addText(v)}</span>
      <span class="rl-odds-pct">${cfg.items[o.key].chance}%</span></li>`)}</ul>
    <p class="label">В среднем ${addText(ev)} к множителю. Итог дня не ниже ×${cfg.floor ?? '—'}.</p>`;
}

// ── Окно с колесом ──

export function openRoulette(ctx, s, { gun = false } = {}) {
  const cfg = rouletteCfg(ctx.settings?.roulette);
  const segs = sectorsOf(cfg);
  const layer = document.createElement('div');
  layer.className = 'rl-overlay';
  layer.innerHTML = String(html`<div class="rl-sheet" role="dialog" aria-modal="true" aria-label="${ROULETTE}">
    <div class="row">
      <span class="rl-tag">🎰 ${ROULETTE}</span>
      <span class="row-gap">
        <button type="button" class="ghost icon rl-icon-btn" data-rl-sound aria-label="Звук"></button>
        <button type="button" class="ghost icon rl-icon-btn" data-rl-close aria-label="Закрыть">✕</button>
      </span>
    </div>
    <div class="rl-stage">${wheelHtml(cfg, segs)}</div>
    <div class="rl-panel" aria-live="polite"></div>
  </div>`);
  document.body.append(layer);
  document.body.classList.add('gd-lock');
  const sheet = layer.querySelector('.rl-sheet');
  const stage = layer.querySelector('.rl-stage');
  const panel = layer.querySelector('.rl-panel');
  const box = stage.querySelector('.rl-wheel');
  const pin = box.querySelector('.rl-pinbox');
  const hitbox = box.querySelector('.rl-hitbox');
  const hub = box.querySelector('[data-rl-hub]');
  let busy = false;
  let changed = false;
  let lastTick = 0;
  let lastBuzz = 0;

  const soundBtn = layer.querySelector('[data-rl-sound]');
  const drawSound = () => { soundBtn.textContent = soundOn() ? '🔊' : '🔇'; };
  drawSound();
  soundBtn.addEventListener('click', () => {
    try { localStorage.setItem(SOUND_KEY, soundOn() ? '0' : '1'); } catch { /* без памяти */ }
    drawSound();
  });
  const close = () => {
    if (busy) return;
    wheel.kill();
    layer.remove();
    document.body.classList.remove('gd-lock');
    if (changed) ctx.refresh();
  };
  layer.querySelector('[data-rl-close]').addEventListener('click', close);
  layer.addEventListener('click', (e) => { if (e.target === layer) close(); });

  const wheel = spinner(box, segs, (speed) => {
    const now = performance.now();
    pin.animate?.([{ transform: 'rotate(0deg)' }, { transform: 'rotate(-18deg)' }, { transform: 'rotate(0deg)' }],
      { duration: Math.max(70, Math.min(180, 60000 / Math.max(speed, 1))), easing: 'ease-out' });
    if (now - lastTick > 28) { SFX.tick(); lastTick = now; }
    if (speed < 700 && now - lastBuzz > 60) { buzz(4); lastBuzz = now; }
  });

  // Сначала — кнопка и шансы. Друг уже крутил (револьвер ждёт решения) — сразу к барабану.
  const intro = () => {
    panel.innerHTML = String(html`<p class="rl-hint">Жми — и узнаешь, какой сегодня множитель</p>
      <button type="button" class="btn rl-go" data-rl-go>🎰 Крутить</button>
      <details class="rl-odds"><summary>Что может выпасть</summary>${oddsHtml(cfg)}</details>`);
    panel.querySelector('[data-rl-go]').addEventListener('click', go);
    hub?.addEventListener('click', go);
  };

  async function go() {
    if (busy) return;
    busy = true;
    ctxAudio();
    buzz(20);
    box.classList.add('rl-spinning');
    hub.disabled = true;
    panel.innerHTML = String(html`<p class="rl-hint rl-rolling">Крутится…</p>`);
    wheel.start();
    const t0 = performance.now();
    let res;
    try {
      res = await ctx.api.spinRoulette();
    } catch (err) {
      await wheel.land(segs[Math.floor(Math.random() * segs.length)].o.key);
      box.classList.remove('rl-spinning');
      busy = false;
      panel.innerHTML = String(html`<p class="error">${err.message}</p>`);
      return;
    }
    changed = true;
    // Даём колесу покрутиться хотя бы секунду, даже если база ответила мгновенно.
    const wait = 1000 - (performance.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    s = res;
    await landOn(s.spin.chain[0]);
    if (s.spin.chain.length > 1) {
      busy = false;
      showRespin();
      return;
    }
    busy = false;
    finish();
  }

  async function landOn(key) {
    await wheel.land(key);
    box.classList.remove('rl-spinning');
    const o = outcome(key);
    sheet.style.setProperty('--rl-color', o.color);
    bloom();
    box.classList.add('rl-won');
    hitbox.innerHTML = hitHtml(segs.find((x) => x.o.key === key), cfg);
    hub.textContent = o.icon;
    hub.classList.add('rl-hub-won');
  }

  function reset() {
    box.classList.remove('rl-won');
    hitbox.innerHTML = '';
    hub.textContent = 'КРУТИ';
    hub.classList.remove('rl-hub-won');
  }

  // Вспышка цвета выпавшего сектора за колесом.
  function bloom() {
    sheet.classList.remove('rl-bloom');
    void sheet.offsetWidth;
    sheet.classList.add('rl-bloom');
  }

  // Колесо уменьшается, чтобы освободить место итогу. Размер меняется сразу, а глазу — плавно: transform на видеочипе.
  function shrink() {
    if (stage.classList.contains('rl-small')) return;
    const a = box.getBoundingClientRect();
    stage.classList.add('rl-small');
    const b = box.getBoundingClientRect();
    if (!b.width || reduced()) return;
    box.animate?.([
      { transformOrigin: '0 0', transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${a.width / b.width})` },
      { transformOrigin: '0 0', transform: 'none' },
    ], { duration: 500, easing: 'ease' });
  }

  function showRespin() {
    const o = outcome('respin');
    SFX.special();
    buzz(BUZZ.special);
    panel.innerHTML = String(html`<div class="rl-result rl-special" style="--rl-color: ${o.color}">
      <p class="rl-res-name">${o.icon} Ещё раз!</p>
      <p class="label center">${o.say} Второй результат — окончательный.</p>
      <button type="button" class="btn rl-go" data-rl-again>🎰 Крутить ещё раз</button>
    </div>`);
    panel.querySelector('[data-rl-again]').addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      reset();
      box.classList.add('rl-spinning');
      panel.innerHTML = String(html`<p class="rl-hint rl-rolling">Крутится…</p>`);
      wheel.start();
      await new Promise((r) => setTimeout(r, 900));
      await landOn(s.spin.chain[s.spin.chain.length - 1]);
      busy = false;
      finish();
    });
  }

  // Итог: что выпало и какой теперь множитель. Револьвер — к барабану, звезда — к событию дня.
  function finish() {
    const sp = s.spin;
    if (sp.gun === 'offer') {
      // Секунда на колесо с выпавшим револьвером — потом барабан.
      busy = true;
      panel.innerHTML = String(html`<p class="rl-res-name center">🔫 Револьвер!</p>`);
      setTimeout(() => { busy = false; revolver(); }, reduced() ? 200 : 1000);
      return;
    }
    const o = outcome(sp.key);
    const tone = toneOf(sp.key, sp.add);
    (SFX[tone] ?? SFX.zero)();
    buzz(BUZZ[tone] ?? 15);
    if (tone === 'gold') confetti();
    if (tone === 'awful') shake();
    const star = sp.key === 'star';
    shrink();
    panel.innerHTML = String(html`<div class="rl-result rl-${tone}" style="--rl-color: ${o.color}">
      ${tone === 'gold' ? html`<p class="rl-banner">ДЖЕКПОТ</p>` : ''}
      <p class="rl-res-name">${o.icon} ${o.name}${star ? '' : html` <span class="rl-res-add">${addText(sp.add)}</span>`}</p>
      <p class="label center">${o.say}</p>
      ${multBlock(s, sp.add, star ? 'колесо множитель не меняет, зато сегодня событие дня' : '')}
      <button type="button" class="btn rl-go" data-rl-ok>${star ? '⭐ К звезде' : tone === 'awful' || tone === 'bad' ? 'Всё равно сделаю' : 'Погнали 💪'}</button>
    </div>`);
    panel.querySelector('[data-rl-ok]').addEventListener('click', close);
  }

  // Множитель дня после рулетки: база + прибавка, но не ниже пола.
  function multBlock(st, add, note = '') {
    const floored = isFloored(st.m, add, cfg.floor);
    return html`<div class="rl-res-mult">
      <span class="label">${st.test ? 'Тестовый период: множитель для примера' : 'Сегодня очки за подходы'}</span>
      <b>×${dayMult(st.m, add, cfg.floor)}</b>
      <span class="label">${baseText(st)} · ${note || `рулетка ${addText(add)}`}${floored ? ` · но не ниже ×${cfg.floor}` : ''}</span>
    </div>`;
  }

  function shake() {
    sheet.classList.remove('rl-shake');
    void sheet.offsetWidth;
    sheet.classList.add('rl-shake');
  }

  function flash(kind) {
    const f = document.createElement('div');
    f.className = `rl-flash rl-flash-${kind}`;
    document.body.append(f);
    setTimeout(() => f.remove(), 900);
  }

  // Револьвер: барабан на 6 гнёзд, 1 патрон. Жать на курок или убрать (0).
  function revolver() {
    const g = cfg.gun;
    SFX.special();
    buzz(BUZZ.special);
    stage.innerHTML = String(drumHtml(g.chambers));
    const drum = stage.querySelector('.rl-drum-rot');
    panel.innerHTML = String(html`<div class="rl-result rl-special rl-gun" style="--rl-color: ${outcome('revolver').color}">
      <p class="rl-res-name">🔫 Револьвер</p>
      <p class="label center">В барабане ${g.chambers} гнёзд и 1 патрон. Жмёшь на курок: пусто — <b class="ok">${addText(g.win)}</b> к множителю,
        выстрел — <b class="bad">${addText(g.lose)}</b>. Не хочешь рисковать — убери револьвер, будет 0.</p>
      <button type="button" class="btn rl-fire" data-rl-pull>Жать на курок</button>
      <button type="button" class="ghost" data-rl-pass>Убрать револьвер (0)</button>
    </div>`);
    const decide = async (pull) => {
      if (busy) return;
      busy = true;
      panel.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      let res;
      try {
        if (pull) {
          SFX.cock();
          drum.classList.add('rl-drum-spin');
          SFX.roll();
        }
        res = await ctx.api.pullTrigger(pull);
      } catch (err) {
        busy = false;
        panel.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        drum.classList.remove('rl-drum-spin');
        ctx.toast(err.message);
        return;
      }
      changed = true;
      s = res;
      if (pull) await new Promise((r) => setTimeout(r, reduced() ? 300 : 1500));
      busy = false;
      gunResult();
    };
    panel.querySelector('[data-rl-pull]').addEventListener('click', () => decide(true));
    panel.querySelector('[data-rl-pass]').addEventListener('click', () => decide(false));
  }

  function gunResult() {
    const sp = s.spin;
    const drumBox = stage.querySelector('.rl-drum');
    drumBox?.classList.add(`rl-drum-${sp.gun}`);
    let head;
    if (sp.gun === 'bang') {
      SFX.bang();
      buzz([200, 60, 320]);
      flash('bang');
      shake();
      head = html`<p class="rl-banner rl-banner-bad">БАХ!</p><p class="rl-res-name">Выстрел <span class="rl-res-add">${addText(sp.add)}</span></p>
        <p class="label center">Не повезло. Сделай всё равно весь план — серия важнее.</p>`;
    } else if (sp.gun === 'click') {
      SFX.click();
      setTimeout(SFX.good, 250);
      buzz([30, 60, 30]);
      flash('click');
      head = html`<p class="rl-banner rl-banner-ok">Щёлк!</p><p class="rl-res-name">Пусто <span class="rl-res-add">${addText(sp.add)}</span></p>
        <p class="label center">Пронесло. Риск окупился.</p>`;
    } else {
      SFX.zero();
      head = html`<p class="rl-res-name">Револьвер убран</p><p class="label center">Сегодня без прибавки — 0.</p>`;
    }
    const tone = sp.gun === 'bang' ? 'awful' : sp.gun === 'click' ? 'great' : 'zero';
    panel.innerHTML = String(html`<div class="rl-result rl-${tone}" style="--rl-color: ${outcome('revolver').color}">
      ${head}
      ${multBlock(s, sp.add)}
      <button type="button" class="btn rl-go" data-rl-ok>${sp.gun === 'bang' ? 'Всё равно сделаю' : 'Погнали 💪'}</button>
    </div>`);
    panel.querySelector('[data-rl-ok]').addEventListener('click', close);
  }

  if (gun && s.spin?.gun === 'offer') {
    landOn('revolver').then(revolver);
  } else intro();
}

// Барабан револьвера: гнёзда по кругу, сверху — ствол. Какое гнездо с патроном, не видно до выстрела.
// Барабан крутится отдельным слоем (.rl-drum-rot), патрон и ствол лежат поверх и не перерисовываются.
function drumHtml(n) {
  const holes = Array.from({ length: n }, (_, i) => {
    const [x, y] = [100 + 54 * Math.sin((2 * Math.PI * i) / n), 100 - 54 * Math.cos((2 * Math.PI * i) / n)];
    const [fx, fy] = [100 + 86 * Math.sin((2 * Math.PI * (i + 0.5)) / n), 100 - 86 * Math.cos((2 * Math.PI * (i + 0.5)) / n)];
    return `<circle class="rl-hole ${i === 0 ? 'rl-hole-top' : ''}" cx="${f2(x)}" cy="${f2(y)}" r="20"/>
      <ellipse class="rl-flute" cx="${f2(fx)}" cy="${f2(fy)}" rx="9" ry="14" transform="rotate(${f2((360 * (i + 0.5)) / n)} ${f2(fx)} ${f2(fy)})"/>`;
  }).join('');
  return raw(`<div class="rl-drum">
    <div class="rl-drum-rot"><svg viewBox="0 0 200 200" aria-hidden="true">
      <defs>
        <radialGradient id="rl-steel" cx="40%" cy="35%" r="70%">
          <stop offset="0" stop-color="#C9CFD8"/><stop offset=".55" stop-color="#7C8492"/><stop offset="1" stop-color="#3A404B"/>
        </radialGradient>
      </defs>
      <circle cx="100" cy="100" r="96" fill="url(#rl-steel)" stroke="#1B1E24" stroke-width="3"/>
      ${holes}
      <circle cx="100" cy="100" r="15" fill="#2A2F38" stroke="#9AA2AE" stroke-width="2"/>
      <circle cx="100" cy="100" r="5" fill="#9AA2AE"/>
    </svg></div>
    <svg class="rl-drum-top" viewBox="0 0 200 228" aria-hidden="true">
      <defs>
        <radialGradient id="rl-brass" cx="40%" cy="35%" r="70%">
          <stop offset="0" stop-color="#FFE9A3"/><stop offset=".6" stop-color="#E0A92A"/><stop offset="1" stop-color="#8A5A00"/>
        </radialGradient>
      </defs>
      <circle class="rl-shell" cx="100" cy="74" r="17" fill="url(#rl-brass)"/>
      <circle class="rl-shell" cx="100" cy="74" r="6" fill="#B07A10" stroke="#5A3A00" stroke-width="1.5"/>
      <rect class="rl-barrel" x="86" y="0" width="28" height="30" rx="5"/>
      <rect class="rl-barrel-hole" x="94" y="6" width="12" height="20" rx="4"/>
    </svg>
  </div>`);
}

// ── «Правила» → рулетка: генерал включает колесо и меняет прибавки и шансы ──

const SPECIAL_NOTE = { revolver: 'см. ниже', respin: 'крутит снова', star: 'событие дня' };
// Дробные — через запятую, минус можно любым: «-0,3» или «−0,3».
const comma = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ',').replace('-', '−'));
const parse = (v) => {
  const t = String(v ?? '').trim().replace(/\s/g, '').replace(',', '.').replace('−', '-');
  return t === '' ? null : Number(t);
};

// В «Правилах» сектора по порядку: от большого плюса к минусу, особые — в конце.
const byValue = (cfg) => OUTCOMES.slice().sort((a, b) => (a.special ?? false) - (b.special ?? false)
  || (a.special ? 0 : Number(cfg.items[b.key].add) - Number(cfg.items[a.key].add)));

// Карточка в «Правилах». Другу — только шансы, если колесо включено.
export function rouletteRules(settings, isAdmin) {
  const cfg = rouletteCfg(settings?.roulette);
  if (!isAdmin) {
    return cfg.on ? html`<section class="card"><h2 class="h2">🎰 ${ROULETTE}</h2>
      <p class="label">Каждый тренировочный день крутишь колесо на «Сегодня». Выпавшее число прибавляется к множителю очков за подходы.
        Не хочешь рисковать — можно не крутить, тогда множитель как обычно.</p>
      ${oddsHtml(cfg)}</section>` : '';
  }
  const g = cfg.gun;
  const numIn = (attr, v, label) => html`<input class="input" type="text" inputmode="decimal" ${raw(attr)} value="${comma(v)}" placeholder="—" aria-label="${label}">`;
  return html`<section class="card" id="rl-rules">
    <div class="row"><h2 class="h2">🎰 ${ROULETTE}</h2><span class="chip ${cfg.on ? 'chip-on' : ''}" id="rl-state">${cfg.on ? 'включена' : 'выключена'}</span></div>
    <p class="label">Каждый тренировочный день друг сам крутит колесо на «Сегодня». Выпавшее число прибавляется к множителю очков за подходы
      (серия или «Всё или ничего»). Можно и не крутить — тогда множитель как обычно, а крутить в этот день уже нельзя.
      Событие дня и пари рулетка не трогает. Начисляется, когда день закончился и всё проверено.</p>
    <label class="row switch-row"><span>Колесо каждый тренировочный день</span>
      <input type="checkbox" class="switch" data-rl="on" ${cfg.on ? html`checked` : ''}></label>
    <label class="row switch-row"><span>Подходы — только после колеса (или отказа от него)</span>
      <input type="checkbox" class="switch" data-rl="lock" ${cfg.lock ? html`checked` : ''}></label>
    <label class="row rule-row"><span>Множитель дня не ниже (пусто — без пола)</span>
      <input class="input num-in" type="text" inputmode="decimal" data-rl="floor" value="${comma(cfg.floor)}" placeholder="—"></label>
    <div class="rl-ed">
      <div class="rl-ed-row rl-ed-head"><span>Сектор</span><span>Прибавка</span><span>Шанс, %</span></div>
      ${byValue(cfg).map((o) => html`<div class="rl-ed-row" style="--rl-color: ${o.color}">
        <span class="rl-ed-name"><i></i>${o.icon} ${o.name}</span>
        ${o.special ? html`<span class="rl-ed-sub" style="text-align: right">${SPECIAL_NOTE[o.key]}</span>`
          : numIn(`data-rl-add="${o.key}"`, cfg.items[o.key].add, `${o.name}: прибавка`)}
        ${numIn(`data-rl-chance="${o.key}"`, cfg.items[o.key].chance, `${o.name}: шанс, %`)}
      </div>`)}
    </div>
    <h3 class="h2">🔫 Револьвер</h3>
    <label class="row rule-row"><span>Гнёзд в барабане (патрон один)</span>
      <input class="input num-in" type="text" inputmode="numeric" data-rl-gun="chambers" value="${g.chambers}"></label>
    <label class="row rule-row"><span>Пусто — прибавка</span>
      <input class="input num-in" type="text" inputmode="decimal" data-rl-gun="win" value="${comma(g.win)}"></label>
    <label class="row rule-row"><span>Выстрел — прибавка</span>
      <input class="input num-in" type="text" inputmode="decimal" data-rl-gun="lose" value="${comma(g.lose)}"></label>
    <p class="label">Друг сам решает: жать на курок или убрать револьвер — тогда 0. Не решил до полуночи — тоже 0.</p>
    <div class="rl-sum" id="rl-sum" aria-live="polite"></div>
    <p class="error" id="rl-error" role="alert"></p>
    <button type="button" class="btn" id="rl-save">Сохранить рулетку</button>
  </section>`;
}

export function wireRouletteRules(el, ctx) {
  const box = el.querySelector('#rl-rules');
  if (!box) return;
  const read = () => {
    const cfg = rouletteCfg(ctx.settings?.roulette);
    const out = { ...cfg, items: {}, gun: {} };
    out.on = box.querySelector('[data-rl="on"]').checked;
    out.lock = box.querySelector('[data-rl="lock"]').checked;
    out.floor = parse(box.querySelector('[data-rl="floor"]').value);
    OUTCOMES.forEach((o) => {
      const add = box.querySelector(`[data-rl-add="${o.key}"]`);
      out.items[o.key] = { chance: parse(box.querySelector(`[data-rl-chance="${o.key}"]`).value) ?? 0, ...(add ? { add: parse(add.value) ?? 0 } : {}) };
    });
    ['chambers', 'win', 'lose'].forEach((k) => { out.gun[k] = parse(box.querySelector(`[data-rl-gun="${k}"]`).value); });
    return out;
  };
  const sum = () => {
    const cfg = read();
    const total = chanceSum(cfg);
    const range = rouletteRange(cfg);
    const top = Number(ctx.rules?.current?.streak_max ?? 1);
    const span = (m) => (range ? `от ×${dayMult(m, range.low[0], cfg.floor)} (${range.low[1]}) до ×${dayMult(m, range.high[0], cfg.floor)} (${range.high[1]})` : '—');
    box.querySelector('#rl-sum').innerHTML = String(html`
      <p class="${total === 100 ? 'ok' : 'bad'}">Сумма шансов: ${total}%${total === 100 ? ' ✓' : ' — нужно ровно 100%'}</p>
      <p>В среднем: <b>${addText(rouletteEV(cfg))}</b> к множителю за день</p>
      <p class="label">Без серии (×1): ${span(1)}</p>
      ${top > 1 ? html`<p class="label">Потолок серии ×${top}: ${span(top)}</p>` : ''}`);
  };
  sum();
  box.addEventListener('input', sum);
  box.addEventListener('change', sum);
  box.querySelector('#rl-save').addEventListener('click', async () => {
    const err = box.querySelector('#rl-error');
    const cfg = read();
    const bad = rouletteProblems(cfg);
    if (bad.length) { err.textContent = `Проверь: ${bad.join('; ')}.`; return; }
    err.textContent = '';
    try {
      ctx.settings.roulette = await ctx.api.saveRoulette(cfg);
      const chip = box.querySelector('#rl-state');
      chip.textContent = cfg.on ? 'включена' : 'выключена';
      chip.classList.toggle('chip-on', cfg.on);
      ctx.toast(cfg.on ? 'Рулетка сохранена и включена' : 'Рулетка сохранена, колесо выключено');
    } catch (e) { err.textContent = e.message; }
  });
}
