// «Магазин»: выходной за очки, больничный, идеи атлета.
// Админ видит то же самое, отменяет покупки и отвечает на идеи.

import { html, dayTitle, addDays } from '../util.js';
import { POINTS, effectiveStatus } from '../logic.js';

const IDEA = { new: 'на рассмотрении', accepted: 'принята', declined: 'отклонена' };
const AHEAD = 14; // на сколько дней вперёд можно выбрать выходной

export async function render(el, ctx, args, alive) {
  const { api, clock, me } = ctx;
  const athleteId = ctx.athleteId;
  const isAdmin = me.role === 'admin';
  if (!athleteId) {
    el.innerHTML = String(html`<section class="card"><h2 class="h2">Атлетов пока нет</h2></section>`);
    return;
  }

  const t = clock.today;
  const [w, template, days, purchases, sick, ideas] = await Promise.all([
    api.wallet(isAdmin ? athleteId : undefined),
    api.weekTemplate(),
    api.days(athleteId, t, addDays(t, AHEAD)),
    api.purchases(athleteId, addDays(t, 1)),
    api.sickRequests(athleteId, t),
    api.ideas(athleteId),
  ]);
  if (!alive()) return;

  const r = ctx.rules?.current;
  const price = r?.rest_day_price ?? null;
  const statusOf = (d) => effectiveStatus(d, days.find((x) => x.date === d) ?? null, template);
  const options = Array.from({ length: AHEAD }, (_, i) => addDays(t, i + 1)).filter((d) => statusOf(d) === 'training');
  const canBuy = price !== null && w.balance >= price && options.length > 0;
  const todaySick = sick.find((s) => s.date === t) ?? null;
  const todayTraining = statusOf(t) === 'training';

  el.innerHTML = String(html`
    <header class="stack-8">
      <p class="sub">Баланс${isAdmin ? ' друга' : ''}: ${POINTS(w.balance)}</p>
      <h1 class="h1">Магазин</h1>
    </header>

    <section class="card">
      <div class="row"><h2 class="h2">Выходной</h2><span class="chip">${price !== null ? POINTS(price) : 'цена после калибровки'}</span></div>
      <p class="label">Отдых вместо тренировки. Серию не рвёт, но тратит баланс — телефон отодвигается.</p>
      ${isAdmin ? '' : html`
        <label class="label" for="buy-day">На какой день</label>
        <select id="buy-day" class="input" ${options.length ? '' : html`disabled`}>
          ${options.length ? options.map((d) => html`<option value="${d}">${dayTitle(d)}</option>`)
            : html`<option>Тренировок впереди нет</option>`}
        </select>
        <p class="error" id="buy-error" role="alert"></p>
        <button type="button" class="btn" id="buy" ${canBuy ? '' : html`disabled`}>Купить${price !== null ? ` за ${price}` : ''}</button>`}
      <p class="label">${buyHint(r, price, w.balance, isAdmin)}</p>
      ${purchases.length ? html`<div class="stack-8">
        <p class="label em">Куплено</p>
        ${purchases.map((p) => html`<div class="row bought">
          <span>${dayTitle(p.date)} · ${p.price}</span>
          <button type="button" class="ghost" data-cancel="${p.id}">Отменить</button>
        </div>`)}
      </div>` : ''}
    </section>

    <section class="card">
      <div class="row"><h2 class="h2">Больничный</h2><span class="chip">бесплатно</span></div>
      <p class="label">Если болит — не крепатура. Тимур одобряет, очки не тратятся, серия не рвётся.</p>
      ${sickBlock(todaySick, todayTraining, isAdmin)}
    </section>

    <section class="card">
      <h2 class="h2">Идеи для магазина</h2>
      <p class="label">${isAdmin
        ? 'Что друг предлагает покупать за очки. Обсудите в Telegram; если идея подходит — отметь её принятой.'
        : 'Предложи, что ещё можно было бы покупать за очки. Обсудите в Telegram, новый товар добавит Тимур.'}</p>
      ${isAdmin ? '' : html`
        <label class="label" for="idea">Твоя идея</label>
        <textarea id="idea" class="input textarea" rows="3" maxlength="300" placeholder="Напиши идею"></textarea>
        <p class="error" id="idea-error" role="alert"></p>
        <button type="button" class="btn" id="idea-send">Предложить</button>`}
      ${ideas.length ? ideas.map((i) => html`<div class="idea">
        <span class="idea-text">${i.text}</span>
        ${isAdmin && i.status === 'new'
          ? html`<span class="row-gap"><button type="button" class="ghost" data-idea="${i.id}" data-status="accepted">Принять</button>
              <button type="button" class="ghost" data-idea="${i.id}" data-status="declined">Отклонить</button></span>`
          : html`<span class="chip ${i.status === 'accepted' ? 'chip-on' : ''}">${IDEA[i.status]}</span>`}
      </div>`) : html`<p class="label">Идей пока нет.</p>`}
    </section>
  `);

  el.querySelector('#buy')?.addEventListener('click', async () => {
    const date = el.querySelector('#buy-day').value;
    const err = el.querySelector('#buy-error');
    err.textContent = '';
    try {
      await api.buyRestDay(date);
      ctx.toast(`Выходной на ${dayTitle(date)} куплен`);
      ctx.refresh();
    } catch (e) { err.textContent = e.message; }
  });

  el.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api.cancelPurchase(Number(b.dataset.cancel));
      ctx.toast('Покупка отменена, очки вернулись');
      ctx.refresh();
    } catch (e) { ctx.toast(e.message); }
  }));

  el.querySelector('#ask-sick')?.addEventListener('click', async () => {
    try {
      await api.requestSick(el.querySelector('#sick-note').value);
      ctx.toast('Запрос отправлен Тимуру');
      ctx.refresh();
    } catch (e) { ctx.toast(e.message); }
  });

  el.querySelector('#idea-send')?.addEventListener('click', async () => {
    const box = el.querySelector('#idea');
    const err = el.querySelector('#idea-error');
    if (!box.value.trim()) { err.textContent = 'Напиши идею'; return; }
    try {
      await api.addIdea(box.value);
      ctx.toast('Идея отправлена');
      ctx.refresh();
    } catch (e) { err.textContent = e.message; }
  });

  el.querySelectorAll('[data-idea]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api.setIdeaStatus(Number(b.dataset.idea), b.dataset.status);
      ctx.refresh();
    } catch (e) { ctx.toast(e.message); }
  }));
}

function buyHint(r, price, balance, isAdmin) {
  if (price === null) return 'Цену выходного Тимур поставит после калибровки.';
  const parts = [];
  if (!isAdmin && balance < price) parts.push(`Не хватает ${POINTS(price - balance)}.`);
  parts.push('Купить можно только заранее, до начала дня. Отменить — тоже до начала дня, очки вернутся.');
  if (r?.purchase_limit_week != null) parts.push(`Не больше ${r.purchase_limit_week} в неделю.`);
  return parts.join(' ');
}

function sickBlock(s, todayTraining, isAdmin) {
  if (s?.status === 'pending') {
    return isAdmin
      ? html`<p class="warn-strong">Друг просит больничный на сегодня${s.note ? `: «${s.note}»` : ''}. Решение — во вкладке «Проверка».</p>`
      : html`<p class="ok strong">Запрос на сегодня отправлен Тимуру</p>`;
  }
  if (s?.status === 'approved') return html`<p class="ok strong">Сегодня больничный: Тимур одобрил</p>`;
  if (isAdmin) return '';
  if (!todayTraining) return html`<p class="label">Сегодня нет тренировки — больничный не нужен.</p>`;
  return html`
    ${s?.status === 'declined' ? html`<p class="warn-strong">Тимур отказал. Можно попросить ещё раз.</p>` : ''}
    <label class="label" for="sick-note">Что болит</label>
    <input class="input" id="sick-note" type="text" maxlength="300" placeholder="Например: плечо после подтягиваний">
    <button type="button" class="ghost" id="ask-sick">Попросить больничный на сегодня</button>`;
}
