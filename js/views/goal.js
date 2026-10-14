// «Цель»: путь к телефону по балансу с вехами, баланс, рейтинг, серия и история очков.

import { html, dayTitle } from '../util.js';
import { POINTS, signed, isCalibration } from '../logic.js';

const MILESTONES = [25, 50, 75];

export async function render(el, ctx, args, alive) {
  const { api, me } = ctx;
  const athleteId = ctx.athleteId;
  const isAdmin = me.role === 'admin';
  if (!athleteId) {
    el.innerHTML = String(html`<section class="card"><h2 class="h2">Атлетов пока нет</h2></section>`);
    return;
  }

  const [w, rows] = await Promise.all([api.wallet(isAdmin ? athleteId : undefined), api.ledger(athleteId, 60)]);
  if (!alive()) return;

  const r = ctx.rules?.current;
  const price = w.phone_price;
  const pct = price ? Math.min(100, Math.floor((w.balance * 100) / price)) : 0;
  const left = price ? Math.max(0, price - w.balance) : null;

  el.innerHTML = String(html`
    <header class="stack-8">
      <p class="sub">${isAdmin ? 'Путь друга к телефону' : 'Твой путь к телефону'}</p>
      <h1 class="h1">Цель</h1>
      ${isCalibration(r) ? html`<div class="chips"><span class="chip">Калибровка · очки не начисляются</span></div>` : ''}
    </header>

    <section class="card">
      <div class="row"><h2 class="h2">Телефон</h2><span class="label">${price ? `${pct}%` : ''}</span></div>
      <p class="big-line"><span class="big">${w.balance}</span>
        <span class="label">${price ? `из ${price} очков` : 'из [цена после калибровки]'}</span></p>
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
    </section>

    <div class="tiles">
      <div class="tile"><span class="big">${w.balance}</span><span class="label">Баланс</span></div>
      <div class="tile"><span class="big">${w.rating}</span><span class="label">Рейтинг</span></div>
      <div class="tile"><span class="big">${w.streak}</span>
        <span class="label">Серия, дней${w.mult > 1 ? html` · <b class="ok">×${w.mult}</b>` : ''}</span></div>
    </div>

    <section class="card">
      <h2 class="h2">История</h2>
      ${rows.length ? html`<ul class="ledger">${group(rows).map(rowHtml)}</ul>`
        : html`<p class="label">Пока пусто. Здесь будут начисления за подтверждённые подходы, бонусы, штрафы и покупки — с датой и причиной.</p>`}
    </section>

    <section class="card">
      <h2 class="h2">Как это работает</h2>
      <ul class="list">${howItWorks(r)}</ul>
      ${!isAdmin && ctx.settings?.show_rules ? html`<a class="ghost link" href="#/rules">Все числа правил →</a>` : ''}
    </section>

    ${isAdmin ? html`<section class="card">
      <h2 class="h2">Начислить или снять очки</h2>
      ${w.theory ? html`<p class="label">Теоретически за калибровку: <b class="em">${POINTS(w.theory)}</b> по текущим числам правил.
        Это видишь только ты — можешь начислить их или часть вручную.</p>` : ''}
      <div class="grid-2">
        <div class="field"><label class="label" for="grant-amount">Очки (минус — снять)</label>
          <input class="input" id="grant-amount" type="number" inputmode="numeric" step="1" placeholder="например 50"></div>
        <div class="field"><label class="label" for="grant-note">Причина</label>
          <input class="input" id="grant-note" type="text" maxlength="200" placeholder="за что"></div>
      </div>
      <p class="error" id="grant-error" role="alert"></p>
      <button type="button" class="btn" id="grant">Записать</button>
      <p class="label">Плюс идёт в баланс и рейтинг, минус — только из баланса, ниже нуля не уходит.</p>
    </section>` : ''}
  `);

  el.querySelector('#grant')?.addEventListener('click', async () => {
    const amount = Number(el.querySelector('#grant-amount').value);
    const note = el.querySelector('#grant-note').value.trim();
    const err = el.querySelector('#grant-error');
    if (!Number.isInteger(amount) || amount === 0) { err.textContent = 'Впиши целое число, не ноль'; return; }
    if (!note) { err.textContent = 'Напиши причину'; return; }
    try {
      await api.grantPoints(athleteId, amount, note);
      ctx.toast(`${signed(amount)} записано`);
      ctx.refresh();
    } catch (e) { err.textContent = e.message; }
  });
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

function rowHtml(x) {
  if (x.kind === 'day') {
    const cls = x.amount > 0 ? 'ok' : x.amount < 0 ? 'bad' : '';
    return html`<li>
      <div class="row"><span>Подходы за день: ${x.items.length}</span><b class="${cls} nowrap">${signed(x.amount)}</b></div>
      <p class="label">${dayTitle(x.date)}</p>
      <details class="more"><summary class="label">Подробнее</summary>
        <ul class="sub-ledger">${x.items.map((i) => html`<li class="row"><span>${i.note}</span>
          <span class="nowrap">${signed(i.amount)}</span></li>`)}</ul>
      </details>
    </li>`;
  }
  const milestone = x.kind === 'milestone';
  const cls = milestone ? 'ok' : x.amount > 0 ? 'ok' : x.amount < 0 ? 'bad' : '';
  const ratingNote = x.rating !== x.amount && x.rating !== 0 ? ` · рейтинг ${signed(x.rating)}` : '';
  return html`<li class="${milestone ? 'led-star' : ''}">
    <div class="row"><span>${x.note}</span><b class="${cls} nowrap">${milestone ? '★' : signed(x.amount)}</b></div>
    <p class="label">${dayTitle(x.date)}${ratingNote}</p>
  </li>`;
}

function howItWorks(r) {
  const cal = isCalibration(r);
  const n = (v) => (v === null || v === undefined ? null : Number(v));
  const items = [];
  items.push(cal
    ? 'Сейчас калибровка: очки не начисляются. Числа правил Тимур поставит после неё.'
    : 'Очки — только за подходы, которые подтвердил Тимур: за каждый повтор, за подход, где цель выполнена, и за повторы сверх цели. Числа у каждого упражнения свои.');
  items.push('Серия — тренировочные дни подряд, где сделан весь план. Выходные, купленные дни и больничный её не продлевают и не рвут.'
    + (!cal && r.streak_from && r.streak_step
      ? ` С ${r.streak_from}-го дня серии все очки за подход умножаются: +${n(r.streak_step)} в день, максимум ×${n(r.streak_max) ?? '∞'}.` : ''));
  items.push('Рост: если лучший подход недели в упражнении больше, чем на прошлой неделе, — бонус.');
  items.push(!cal && n(r.miss_penalty_pct) > 0
    ? `Пропуск — не сделан хоть один подход плана. Штраф: ${n(r.miss_penalty_pct)}% от баланса.`
    : 'Пропуск — не сделан хоть один подход плана. За него штраф: процент от баланса.');
  items.push('Рейтинг — всё, что заработано. Покупки и штрафы трогают только баланс.');
  return items.map((t) => html`<li>${t}</li>`);
}
