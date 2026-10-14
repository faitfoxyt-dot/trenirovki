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
    </section>
  `);
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
    : `Очки — только за подходы, которые подтвердил Тимур: ${n(r.points_per_rep) ?? 0} за повтор`
      + ` и ${n(r.points_per_set) ?? 0} за подход, где цель выполнена.`);
  items.push('Серия — тренировочные дни подряд с отметками. Выходные, купленные дни и больничный её не рвут.'
    + (!cal && r.streak_from && r.streak_step
      ? ` С ${r.streak_from}-го дня серии очки умножаются: +${n(r.streak_step)} в день, максимум ×${n(r.streak_max) ?? '∞'}.` : ''));
  if (!cal && n(r.bonus_over) > 0) {
    items.push(`Повторы сверх цели: +${n(r.bonus_over)} за каждый${r.bonus_cap_day != null ? `, не больше ${r.bonus_cap_day} в день` : ''}.`);
  }
  if (!cal && r.bonus_growth > 0) {
    items.push(`Рост: если лучший подход недели больше, чем на прошлой, +${r.bonus_growth} за каждое такое упражнение.`);
  }
  items.push(!cal && r.miss_penalty > 0
    ? `Пропуск без выходного — минус ${POINTS(r.miss_penalty)}. Ниже нуля баланс не падает.`
    : 'Пропуск без выходного — минус очки. Ниже нуля баланс не падает.');
  items.push('Рейтинг — всё, что заработано. Он никогда не уменьшается: покупки и штрафы трогают только баланс.');
  return items.map((t) => html`<li>${t}</li>`);
}
