// Событие дня: звёздочка на ниточке висит поверх любого экрана друга.
// Нажал — открывается мини-игра из 5 ходов. Каждый верный ход — +0.1x к очкам дня,
// все 5 — ×1.5. Попытка одна.

import { html } from '../util.js';
import { confetti } from './goal.js';

const ROUNDS = 5;
const STEP = 0.1;

export const GAMES = {
  a: { name: 'Идеальный повтор', icon: '🎯',
    rules: ['Бегунок ползает по линейке туда-сюда.', 'Жми, когда он в зелёной зоне.', 'С каждым ходом быстрее, а зона уже.'] },
};

export const multOf = (score) => Math.round((1 + STEP * score) * 10) / 10;
const fmt = (m) => `×${m.toFixed(1)}`;

let starEl = null;

// Повесить или убрать звезду. Вызывается после каждого перехода по экранам.
export async function mountStar(ctx) {
  const { api, me, clock } = ctx;
  const ev = me.role === 'athlete' && api.eventDay ? await api.eventDay(clock.today) : null;
  const show = ev && ev.score === null; // начал играть — звезды больше нет, даже после перезагрузки
  if (!show) { starEl?.remove(); starEl = null; return; }
  if (starEl?.isConnected) return;
  starEl = document.createElement('button');
  starEl.type = 'button';
  starEl.className = 'ev-star';
  starEl.setAttribute('aria-label', 'Событие дня: открыть мини-игру');
  starEl.innerHTML = `<span class="ev-swing"><span class="ev-thread"></span>
    <svg class="ev-star-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.9 6 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.2 1.3-6.6L2.5 9.3l6.6-.8z"/></svg></span>`;
  starEl.addEventListener('click', () => {
    starEl.classList.add('ev-tug');
    setTimeout(() => open(ctx, ev), 260);
  });
  document.body.append(starEl);
}

function open(ctx, ev) {
  const game = 'a'; // пока игра одна
  const g = GAMES[game];
  const layer = document.createElement('div');
  layer.className = 'ev-overlay';
  layer.innerHTML = String(html`<div class="ev-sheet" role="dialog" aria-modal="true" aria-label="${ev.title}">
    <div class="row">
      <span class="ev-tag">⭐ ${ev.title}</span>
      <button type="button" class="ghost icon ev-close" aria-label="Закрыть">✕</button>
    </div>
    <div class="ev-stage"></div>
  </div>`);
  document.body.append(layer);
  const stage = layer.querySelector('.ev-stage');
  let started = false;
  let score = 0;
  let stop = () => {};
  const close = () => { stop(); layer.remove(); };
  layer.querySelector('.ev-close').addEventListener('click', async () => {
    if (started) await finish(true); else close();
  });

  stage.innerHTML = String(html`<div class="ev-intro">
    <div class="ev-big-ic">${g.icon}</div>
    <h2 class="ev-title">${g.name}</h2>
    <ul class="ev-rules">${g.rules.map((r) => html`<li>${r}</li>`)}</ul>
    <div class="ev-prize">
      <p><b>5 ходов.</b> Каждый верный — <b class="ev-gold">+0.1x</b> к очкам за сегодня.</p>
      <p>Все 5 верно — <b class="ev-gold">×1.5</b> на весь день!</p>
    </div>
    <p class="label center">Попытка одна. Начал — уже не переиграть.</p>
    <button type="button" class="btn ev-go">Начать</button>
  </div>`);
  // Счёт сохраняем сразу и после каждого хода: перезагрузка страницы не даёт переиграть.
  const save = (done) => ctx.api.playEvent(ctx.clock.today, score, done);
  stage.querySelector('.ev-go').addEventListener('click', async () => {
    try { await save(false); } catch (err) { ctx.toast(err.message); close(); return; }
    started = true;
    stage.innerHTML = String(html`<div class="ev-head">
        <div class="ev-dots">${Array.from({ length: ROUNDS }, () => html`<i></i>`)}</div>
        <span class="ev-mult">${fmt(1)}</span>
      </div>
      <div class="ev-play"></div>`);
    const dots = [...stage.querySelectorAll('.ev-dots i')];
    const multEl = stage.querySelector('.ev-mult');
    let round = 0;
    const onRound = (ok) => {
      dots[round].className = ok ? 'ev-hit' : 'ev-miss';
      if (ok) {
        score += 1;
        multEl.textContent = fmt(multOf(score));
        multEl.classList.remove('ev-pop');
        void multEl.offsetWidth;
        multEl.classList.add('ev-pop');
        save(false).catch(() => {});
      }
      round += 1;
      return round;
    };
    stop = PLAY[game](stage.querySelector('.ev-play'), onRound, () => finish(false));
  });

  async function finish(early) {
    stop();
    try { await save(true); } catch (err) { ctx.toast(err.message); }
    const m = multOf(score);
    const all = score === ROUNDS;
    stage.innerHTML = String(html`<div class="ev-result ${all ? 'ev-result-max' : ''}">
      <p class="ev-res-n">${score} из ${ROUNDS}${early ? ' · вышел раньше' : ''}</p>
      <p class="ev-res-m">${fmt(m)}</p>
      <h2 class="ev-title">${all ? 'Вот это да! 🔥' : score >= 3 ? 'Неплохо!' : score > 0 ? 'Хоть что-то!' : 'В этот раз мимо'}</h2>
      <p class="label center">${score > 0
        ? `Очки за сегодня умножатся на ${m.toFixed(1)}, когда генерал проверит подходы. Осталось их сделать.`
        : 'Бонуса не будет. Следующее событие — скоро.'}</p>
      <button type="button" class="btn ev-done">${score > 0 ? 'Забрать бонус' : 'Понятно'}</button>
    </div>`);
    if (all) confetti();
    starEl?.remove();
    starEl = null;
    stage.querySelector('.ev-done').addEventListener('click', () => { close(); ctx.refresh(); });
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Игра: play(el, onRound(ok) → номер следующего хода, done()) → stop() ──

const PLAY = {
  // «Идеальный повтор»: бегунок ползает по линейке, жми, когда он в зелёной зоне.
  a(el, onRound, done) {
    const zones = [30, 25, 21, 18, 15];      // ширина зоны, %
    const periods = [2200, 1950, 1750, 1550, 1400]; // проход туда-обратно, мс
    el.innerHTML = String(html`<p class="ev-say">Жми, когда бегунок в зелёной зоне</p>
      <div class="ev-track"><div class="ev-zone"></div><div class="ev-marker"></div></div>
      <p class="ev-flash" aria-live="polite"></p>
      <button type="button" class="btn ev-tap">Жми!</button>`);
    const zone = el.querySelector('.ev-zone');
    const marker = el.querySelector('.ev-marker');
    const flash = el.querySelector('.ev-flash');
    const btn = el.querySelector('.ev-tap');
    let k = 0;
    let raf = 0;
    let t0 = 0;
    let pos = 0;
    let z = { from: 0, to: 0 };
    let live = true;
    let busy = false;
    const setup = () => {
      const w = zones[k];
      const from = 8 + Math.random() * (84 - w);
      z = { from, to: from + w };
      zone.style.left = `${from}%`;
      zone.style.width = `${w}%`;
      t0 = performance.now() + Math.random() * 400;
      busy = false;
      btn.disabled = false;
      flash.textContent = `Ход ${k + 1} из ${ROUNDS}`;
      flash.className = 'ev-flash';
      raf = requestAnimationFrame(tick);
    };
    const tick = (now) => {
      const p = (((now - t0) / periods[k]) % 1 + 1) % 1;
      pos = (p < 0.5 ? p * 2 : 2 - p * 2) * 100;
      marker.style.left = `${pos}%`;
      if (live) raf = requestAnimationFrame(tick);
    };
    const hit = async () => {
      if (busy) return;
      busy = true;
      btn.disabled = true;
      cancelAnimationFrame(raf);
      const ok = pos >= z.from && pos <= z.to;
      el.querySelector('.ev-track').classList.add(ok ? 'ev-good' : 'ev-bad');
      flash.textContent = ok ? 'Чётко! +0.1x' : 'Мимо';
      flash.className = `ev-flash ${ok ? 'ev-ok' : 'ev-no'}`;
      k = onRound(ok);
      await wait(800);
      el.querySelector('.ev-track')?.classList.remove('ev-good', 'ev-bad');
      if (!live) return;
      if (k >= ROUNDS) done(); else setup();
    };
    btn.addEventListener('click', hit);
    el.querySelector('.ev-track').addEventListener('pointerdown', hit);
    setup();
    return () => { live = false; cancelAnimationFrame(raf); };
  },
};
