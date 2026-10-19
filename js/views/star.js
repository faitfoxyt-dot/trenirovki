// Событие дня: звёздочка на ниточке висит поверх любого экрана друга.
// Нажал — открывается мини-игра из 5 ходов. Каждый верный ход — +0.1x к очкам дня,
// все 5 — ×1.5. Попытка одна.

import { html } from '../util.js';
import { confetti } from './goal.js';

const ROUNDS = 5;
const STEP = 0.1;

export const GAMES = {
  b: { name: 'Генерал приказал', icon: '🫡',
    rules: ['Жми упражнение, только если сказано «Генерал приказал».', 'Без этих слов — ничего не трогай.', 'На ответ пара секунд.'] },
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
  const game = GAMES[ev.game] ? ev.game : 'b';
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
  // «Генерал приказал»: жми, только если приказ.
  b(el, onRound, done) {
    const moves = [['squat', '🦵', 'Присед'], ['push', '💪', 'Отжимания'], ['plank', '🧱', 'Планка']];
    const times = [2600, 2300, 2000, 1800, 1600];
    // 2 хода-ловушки из 5, на случайных местах (но не первый).
    const traps = new Set();
    while (traps.size < 2) traps.add(1 + Math.floor(Math.random() * 4));
    el.innerHTML = String(html`<div class="ev-order"><p class="ev-order-who"></p><p class="ev-order-what"></p></div>
      <div class="ev-timer"><i></i></div>
      <p class="ev-flash" aria-live="polite"></p>
      <div class="ev-moves">${moves.map(([id, ic, name]) => html`<button type="button" class="ev-move" data-move="${id}">
        <span class="ev-move-ic">${ic}</span>${name}</button>`)}</div>`);
    const who = el.querySelector('.ev-order-who');
    const what = el.querySelector('.ev-order-what');
    const bar = el.querySelector('.ev-timer i');
    const flash = el.querySelector('.ev-flash');
    const btns = [...el.querySelectorAll('.ev-move')];
    let k = 0;
    let live = true;
    let timer = 0;
    let cur = null;
    const setup = () => {
      const [id, , name] = moves[Math.floor(Math.random() * moves.length)];
      cur = { id, trap: traps.has(k) };
      who.textContent = cur.trap ? '' : 'Генерал приказал:';
      what.textContent = `${name}!`;
      el.querySelector('.ev-order').className = 'ev-order ev-order-in';
      flash.textContent = `Ход ${k + 1} из ${ROUNDS}`;
      flash.className = 'ev-flash';
      btns.forEach((b) => { b.disabled = false; b.className = 'ev-move'; });
      bar.style.transition = 'none';
      bar.style.width = '100%';
      void bar.offsetWidth;
      bar.style.transition = `width ${times[k]}ms linear`;
      bar.style.width = '0%';
      timer = setTimeout(() => answer(null), times[k]);
    };
    const answer = async (pick) => {
      if (!cur) return;
      clearTimeout(timer);
      const ok = cur.trap ? pick === null : pick === cur.id;
      const msg = ok ? (cur.trap ? 'Не повёлся! +0.1x' : 'Есть! +0.1x')
        : cur.trap ? 'Генерал не приказывал!' : pick === null ? 'Не успел' : 'Не то упражнение';
      bar.style.transition = 'none';
      bar.style.width = getComputedStyle(bar).width;
      btns.forEach((b) => { b.disabled = true; if (b.dataset.move === pick) b.classList.add(ok ? 'ev-move-ok' : 'ev-move-no'); });
      flash.textContent = msg;
      flash.className = `ev-flash ${ok ? 'ev-ok' : 'ev-no'}`;
      cur = null;
      k = onRound(ok);
      await wait(900);
      if (!live) return;
      if (k >= ROUNDS) done(); else setup();
    };
    btns.forEach((b) => b.addEventListener('click', () => answer(b.dataset.move)));
    setup();
    return () => { live = false; clearTimeout(timer); };
  },
};
