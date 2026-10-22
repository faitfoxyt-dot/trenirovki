// «Цель»: путь к телефону по балансу с вехами, баланс, рейтинг, серия и история очков.

import { html, dayTitle, general, addDays } from '../util.js';
import { POINTS, signed, isCalibration } from '../logic.js';
import { featsCard } from './feats.js';

const MILESTONES = [25, 50, 75];
const MODES = [
  { k: 'add', label: 'Добавить', field: 'Сколько добавить' },
  { k: 'take', label: 'Снять', field: 'Сколько снять' },
  { k: 'set', label: 'Ровно', field: 'Баланс станет' },
];

export async function render(el, ctx, args, alive) {
  const { api, me } = ctx;
  const athleteId = ctx.athleteId;
  const isAdmin = me.role === 'admin';
  if (!athleteId) {
    el.innerHTML = String(html`<section class="card"><h2 class="h2">Атлетов пока нет</h2></section>`);
    return;
  }

  const today = ctx.clock.today;
  const start = ctx.settings?.start_date ?? null;
  const from = start ?? addDays(today, -400);
  const [w, rows, body, days, logs, all, catalog] = await Promise.all([
    api.wallet(isAdmin ? athleteId : undefined), api.ledger(athleteId, 60), api.body(athleteId),
    api.days(athleteId, from, today), api.logs(athleteId, from, today), api.ledger(athleteId, 5000), api.exercises(),
  ]);
  if (!alive()) return;

  const r = ctx.rules?.current;
  const price = w.phone_price;
  const pct = price ? Math.min(100, Math.floor((w.balance * 100) / price)) : 0;
  const left = price ? Math.max(0, price - w.balance) : null;

  el.innerHTML = String(html`
    <header class="stack-8">
      <p class="sub">${isAdmin ? 'Путь друга к телефону' : 'Твой путь к телефону'}</p>
      <h1 class="h1">Цель</h1>
      ${isCalibration(r) ? html`<div class="chips"><span class="chip">Тестовый период · очки не начисляются</span></div>` : ''}
    </header>

    ${w.phone_bought ? html`<section class="card phone-done">
      <span class="phone-done-ic" aria-hidden="true">🏆</span>
      <h2 class="h2">Телефон куплен!</h2>
      <p class="label">${dayTitle(w.phone_bought)} · цель выполнена. ${isAdmin ? 'Отменить покупку можно крестиком в истории.' : 'Красава, так держать.'}</p>
    </section>` : ''}

    <section class="card ${w.phone_bought ? 'hidden-card' : ''}">
      <div class="row"><h2 class="h2">Телефон</h2><span class="label">${price ? `${pct}%` : ''}</span></div>
      <p class="big-line"><span class="big">${w.balance}</span>
        <span class="label">${price ? `из ${price} очков` : 'цена телефона ещё не задана'}</span></p>
      <div class="bar" role="progressbar" aria-label="Путь к телефону" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
        <span class="bar-fill" style="width: ${pct}%"></span>
        ${MILESTONES.map((m) => html`<span class="tick ${pct >= m ? 'tick-on' : ''}" style="left: ${m}%"></span>`)}
      </div>
      <div class="marks" aria-hidden="true">
        ${MILESTONES.map((m) => html`<span class="mark ${pct >= m ? 'ok' : ''}" style="left: ${m}%">${m}%</span>`)}
        <span class="mark-end">Телефон</span>
      </div>
      <p class="label">${left === null ? '' : left > 0 ? `Осталось ${POINTS(left)}. ` : 'Очков хватает на телефон! '}Путь считается
        по балансу: каждый купленный выходной и каждый штраф отодвигают телефон.</p>
      ${price ? phoneButton(w, pct, left, isAdmin) : ''}
    </section>

    <div class="tiles">
      <div class="tile"><span class="big">${w.balance}</span><span class="label">Баланс</span></div>
      <div class="tile"><span class="big">${w.rating}</span><span class="label">Рейтинг</span></div>
      <div class="tile"><span class="big">${w.streak}</span>
        <span class="label">${isCalibration(r) ? 'Тест. серия' : 'Серия'}${r?.streak_from && r?.streak_step
          ? html`${isCalibration(r) ? ' ' : ' · сегодня '}<b class="${w.mult > 1 ? 'ok' : ''}">×${w.mult}</b>` : ''}</span></div>
    </div>

    ${featsCard({ days, logs, ledger: all, catalog, start: from, today, rating: w.rating },
      body.map((b) => ({ date: b.date, weight: Number(b.weight), fat: b.fat === null ? null : Number(b.fat) })),
      { open: new URLSearchParams(location.search).get('open') })}

    ${isAdmin ? html`<section class="card" id="manual">
      <h2 class="h2">Очки вручную</h2>
      ${w.theory ? html`<p class="label">Теоретически за тестовый период: <b class="em">${POINTS(w.theory)}</b> по текущим числам правил.
        Это видишь только ты — можешь начислить их или часть.</p>` : ''}
      <div class="seg" role="group" aria-label="Что сделать">
        ${MODES.map((m) => html`<button type="button" class="pill ${m.k === 'add' ? 'pill-on' : ''}" data-mode="${m.k}"
          aria-pressed="${m.k === 'add'}">${m.label}</button>`)}
      </div>
      <div class="grid-2">
        <div class="field"><label class="label" for="grant-amount" id="grant-amount-label">Сколько очков</label>
          <input class="input" id="grant-amount" type="number" inputmode="numeric" min="0" step="1" placeholder="например 50"></div>
        <div class="field"><label class="label" for="grant-note">Причина</label>
          <input class="input" id="grant-note" type="text" maxlength="200" placeholder="за что"></div>
      </div>
      <label class="check check-wide"><input type="checkbox" id="grant-rating" checked><span>Менять и рейтинг</span></label>
      <p class="label" id="grant-preview" aria-live="polite"></p>
      <p class="error" id="grant-error" role="alert"></p>
      <button type="button" class="btn" id="grant">Записать</button>
    </section>` : ''}

    <section class="card">
      <h2 class="h2">История</h2>
      ${rows.length ? html`<ul class="ledger">${group(rows).map((x) => rowHtml(x, isAdmin))}</ul>`
        : html`<p class="label">Пока пусто. Здесь будут начисления за подтверждённые подходы, бонусы, штрафы и покупки — с датой и причиной.</p>`}
    </section>

    <section class="card">
      <h2 class="h2">Как это работает</h2>
      ${howItWorks(r)}
      ${!isAdmin && ctx.settings?.show_rules ? html`<a class="ghost link" href="#/rules">Все цифры — в правилах →</a>` : ''}
    </section>

  `);

  el.querySelectorAll('[data-led]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Удалить эту запись очков? Баланс и рейтинг пересчитаются.')) return;
    try {
      await api.deleteLedger(Number(b.dataset.led));
      ctx.toast('Запись удалена');
      ctx.refresh();
    } catch (e) { ctx.toast(e.message); }
  }));

  el.querySelector('#buy-phone')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!confirm(`Купить телефон за ${POINTS(w.phone_price)}? Очки спишутся с баланса.`)) return;
    btn.disabled = true;
    try {
      await api.buyPhone();
      confetti();
      ctx.toast('Телефон куплен! 🎉');
      setTimeout(() => ctx.refresh(), 1600);
    } catch (x) { ctx.toast(x.message); btn.disabled = false; }
  });

  // Очки вручную: добавить, снять или выставить баланс ровно; рейтинг — по галочке.
  const box = el.querySelector('#manual');
  if (box) {
    let mode = 'add';
    const amountIn = box.querySelector('#grant-amount');
    const ratingIn = box.querySelector('#grant-rating');
    const delta = () => {
      const v = Number(amountIn.value);
      if (amountIn.value === '' || !Number.isInteger(v) || v < 0) return null;
      return mode === 'add' ? v : mode === 'take' ? -v : v - w.balance;
    };
    const preview = () => {
      const d = delta();
      const out = box.querySelector('#grant-preview');
      if (d === null || d === 0) { out.textContent = ''; return; }
      const bal = Math.max(0, w.balance + d);
      const rat = ratingIn.checked ? Math.max(0, w.rating + d) : w.rating;
      out.textContent = `Баланс: ${w.balance} → ${bal} · Рейтинг: ${w.rating} → ${rat}`;
    };
    box.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      mode = b.dataset.mode;
      box.querySelectorAll('[data-mode]').forEach((x) => {
        x.classList.toggle('pill-on', x === b);
        x.setAttribute('aria-pressed', String(x === b));
      });
      box.querySelector('#grant-amount-label').textContent = MODES.find((m) => m.k === mode).field;
      ratingIn.checked = mode === 'add';
      preview();
    }));
    amountIn.addEventListener('input', preview);
    ratingIn.addEventListener('change', preview);
    box.querySelector('#grant').addEventListener('click', async () => {
      const d = delta();
      const note = box.querySelector('#grant-note').value.trim();
      const err = box.querySelector('#grant-error');
      if (d === null) { err.textContent = 'Впиши целое число не меньше нуля'; return; }
      if (d === 0) { err.textContent = mode === 'set' ? 'Баланс уже такой' : 'Впиши число больше нуля'; return; }
      if (!note) { err.textContent = 'Напиши причину'; return; }
      err.textContent = '';
      try {
        await api.grantPoints(athleteId, d, note, ratingIn.checked);
        ctx.toast(`${signed(d)} записано`);
        ctx.refresh();
      } catch (e) { err.textContent = e.message; }
    });
  }
}

// Кнопка покупки: заливка показывает путь, при 100% — блеск и пульс.
export function phoneButton(w, pct, left, isAdmin) {
  const ready = left === 0;
  if (isAdmin) {
    return html`<p class="label">${ready ? 'Очков хватает — друг может купить телефон кнопкой у себя.' : 'Кнопку «Купить телефон» друг нажмёт сам, когда хватит очков.'}</p>`;
  }
  return html`<button type="button" class="phone-btn ${ready ? 'phone-ready' : ''}" id="buy-phone" ${ready ? '' : html`disabled`}
    style="--p: ${pct}%">
    <span class="phone-fill" aria-hidden="true"></span>
    <span class="phone-text">
      <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></svg>
      <span class="phone-lines"><span>Купить телефон</span>
        <small>${ready ? `за ${POINTS(w.phone_price)}` : `ещё ${POINTS(left)}`}</small></span>
    </span>
  </button>`;
}

// Салют из цветных частиц поверх экрана, сам исчезает.
export function confetti() {
  const layer = document.createElement('div');
  layer.className = 'confetti';
  layer.setAttribute('aria-hidden', 'true');
  const colors = ['#C6F432', '#E2FF7A', '#FFB547', '#FF8A3D', '#EDEEF0'];
  for (let i = 0; i < 80; i += 1) {
    const p = document.createElement('i');
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = `${Math.random() * 0.4}s`;
    p.style.setProperty('--x', `${(Math.random() - 0.5) * 160}px`);
    p.style.setProperty('--r', `${Math.random() * 720 - 360}deg`);
    layer.append(p);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 2600);
}

// Подходы одного дня — одной строкой, подробности под «Подробнее».
function group(rows) {
  const out = [];
  const days = new Map();
  rows.forEach((x) => {
    if (x.kind !== 'set') { out.push(x); return; }
    let g = days.get(x.date);
    if (!g) {
      g = { kind: 'day', date: x.date, amount: 0, rating: 0, items: [] };
      days.set(x.date, g);
      out.push(g);
    }
    g.amount += x.amount;
    g.rating += x.rating;
    g.items.push(x);
  });
  return out;
}

// Админ может удалить запись крестиком.
const del = (x, isAdmin) => (isAdmin ? html`<button type="button" class="ghost icon del-led" data-led="${x.id}" aria-label="Удалить запись">✕</button>` : '');

function rowHtml(x, isAdmin) {
  if (x.kind === 'day') {
    const cls = x.amount > 0 ? 'ok' : x.amount < 0 ? 'bad' : '';
    return html`<li>
      <div class="row"><span>Подходы за день: ${x.items.length}</span><b class="${cls} nowrap">${signed(x.amount)}</b></div>
      <p class="label">${dayTitle(x.date)}</p>
      <details class="more"><summary class="label">Подробнее</summary>
        <ul class="sub-ledger">${x.items.map((i) => html`<li class="row"><span>${general(i.note)}</span>
          <span class="row-gap nowrap"><span>${signed(i.amount)}</span>${del(i, isAdmin)}</span></li>`)}</ul>
      </details>
    </li>`;
  }
  const milestone = x.kind === 'milestone';
  const cls = milestone ? 'ok' : x.amount > 0 ? 'ok' : x.amount < 0 ? 'bad' : '';
  const ratingNote = x.rating !== x.amount && x.rating !== 0 ? ` · рейтинг ${signed(x.rating)}` : '';
  return html`<li class="${milestone ? 'led-star' : ''}">
    <div class="row"><span>${general(x.note)}</span><span class="row-gap nowrap"><b class="${cls}">${milestone ? '★' : signed(x.amount)}</b>${del(x, isAdmin)}</span></div>
    <p class="label">${dayTitle(x.date)}${ratingNote}</p>
  </li>`;
}

// «Как это работает» простыми словами. Видно всегда, даже в тестовом периоде и при скрытых правилах.
// Цифры серии и штрафа — только когда очки уже идут и numbers не выключен.
export function howItWorks(r, { numbers = true } = {}) {
  const cal = isCalibration(r);
  const nums = numbers && !cal;
  const n = (v) => (v === null || v === undefined ? null : Number(v));
  const x = (v) => Math.round(v * 100) / 100;
  const streak = nums && r.streak_from && r.streak_step
    ? `С ${r.streak_from}-го дня подряд очки умножаются на ×${x(1 + Number(r.streak_step))}, потом каждый день ещё +${n(r.streak_step)}`
      + (n(r.streak_max) ? `, максимум ×${n(r.streak_max)}.` : '.')
    : 'Чем дольше держишь серию, тем больше множитель на очки.';
  const penalty = nums && n(r.miss_penalty_pct) > 0 ? `${n(r.miss_penalty_pct)}% баланса` : 'часть баланса';
  const items = [
    { icon: '💪', title: 'Тренируешься — получаешь очки', body: html`
      <p>Отметил подход, крутой генерал проверил — очки твои. Они идут:</p>
      <ul class="how-list">
        <li>за каждый повтор до цели (в упражнениях на время, например в планке, — за каждую секунду);</li>
        <li>бонусом за каждый повтор или секунду сверх цели.</li>
      </ul>
      <p class="label">У каждого упражнения свои цены. Бонус сверх цели в каждом подходе ограничен: дальше лишние повторы очков не добавляют.</p>` },
    { icon: '🔥', title: 'Серия', body: html`
      <p>Делаешь весь план каждый тренировочный день подряд — серия растёт. ${streak}</p>
      <p class="label">Выходной и больничный серию не ломают. У тестового периода своя серия: в настоящую она не идёт и её не ломает.</p>` },
    { icon: '⚠️', title: 'Пропуск', body: html`
      <p>Не сделал хоть один подход из плана — день пропущен. Серия начинается заново, и сгорает ${penalty}.</p>
      <p class="label">Подход на 0 повторов — не подход.</p>` },
    { icon: '🛒', title: 'Куда тратить', body: html`
      <p>Всё в «Магазине». Главная цель — телефон, копи на него. По пути можно купить выходной, если очень надо,
        или пойти ва-банк — день «Всё или ничего».</p>
      <p class="label">Заболел по-настоящему — попроси больничный, это бесплатно. Есть идея, что ещё продавать за очки, — предложи там же.</p>` },
    { icon: '🏆', title: 'Баланс и рейтинг', body: html`
      <p><b>Баланс</b> — сколько можешь потратить прямо сейчас. <b>Рейтинг</b> — сколько заработал за всё время, он никогда не падает.</p>` },
    { icon: '👀', title: 'События', body: html`
      <p>Иногда тут будет происходить что-то особенное. Объявлять никто не будет: кто ищет, тот найдёт.</p>` },
  ];
  return html`${cal ? html`<p class="notice">Сейчас тестовый период: очки пока не идут. Скоро всё будет по-настоящему.</p>` : ''}
    <div class="how">${items.map((i) => html`<div class="how-item">
      <span class="how-icon" aria-hidden="true">${i.icon}</span>
      <div class="how-text"><h3 class="how-title">${i.title}</h3>${i.body}</div>
    </div>`)}</div>`;
}
