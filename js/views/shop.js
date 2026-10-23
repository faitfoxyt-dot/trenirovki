// «Магазин»: выходной за очки, «Всё или ничего», «За гранью предела» (пока только витрина), больничный, идеи атлета.
// Админ видит то же самое, отменяет покупки и отвечает на идеи.

import { html, dayTitle, addDays } from '../util.js';
import { POINTS, effectiveStatus, ALLIN, allinExample, ALLIN_STREAK, BEYOND, BEYOND_STREAK } from '../logic.js';
import { phoneButton, confetti } from './goal.js';

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
  // День, на который уже есть покупка, второй раз не купить.
  const taken = new Set(purchases.map((p) => p.date));
  const options = Array.from({ length: AHEAD }, (_, i) => addDays(t, i + 1)).filter((d) => statusOf(d) === 'training' && !taken.has(d));
  const canBuy = price !== null && w.balance >= price && options.length > 0;
  const aPrice = r?.allin_price ?? null;
  const allinOpen = w.streak >= ALLIN_STREAK;
  const canAllin = allinOpen && aPrice !== null && w.balance >= aPrice && options.length > 0;
  const ex = allinExample(r);
  const todaySick = sick.find((s) => s.date === t) ?? null;
  const todayTraining = statusOf(t) === 'training';

  el.innerHTML = String(html`
    <header class="stack-8">
      <p class="sub">Баланс${isAdmin ? ' друга' : ''}: ${POINTS(w.balance)}</p>
      <h1 class="h1">Магазин</h1>
    </header>

    ${w.phone_price ? html`<section class="card">
      <div class="row"><h2 class="h2">Телефон</h2><span class="chip">${POINTS(w.phone_price)}</span></div>
      ${w.phone_bought ? html`<p class="ok strong">Куплен ${dayTitle(w.phone_bought)} 🏆</p>`
        : phoneButton(w, Math.min(100, Math.floor((w.balance * 100) / w.phone_price)), Math.max(0, w.phone_price - w.balance), isAdmin)}
    </section>` : ''}

    <section class="card">
      <div class="row"><h2 class="h2">Выходной</h2><span class="chip">${price !== null ? POINTS(price) : 'цена не задана'}</span></div>
      <p class="label">Отдых вместо тренировки. Серию не рвёт и не продлевает, но тратит баланс — телефон отодвигается.</p>
      ${isAdmin ? '' : html`
        <label class="label" for="buy-day">На какой день</label>
        <select id="buy-day" class="input" ${options.length ? '' : html`disabled`}>
          ${options.length ? options.map((d) => html`<option value="${d}">${dayTitle(d)}</option>`)
            : html`<option>Тренировок впереди нет</option>`}
        </select>
        <p class="error" id="buy-error" role="alert"></p>
        <button type="button" class="btn" id="buy" ${canBuy ? '' : html`disabled`}>Купить${price !== null ? ` за ${price}` : ''}</button>`}
      <p class="label">${buyHint(r, price, w.balance, isAdmin)}</p>
    </section>

    <section class="card allin-card">
      <div class="row"><h2 class="h2">🎲 ${ALLIN}</h2><span class="chip">${aPrice !== null ? POINTS(aPrice) : 'не продаётся'}</span></div>
      ${streakLock(w.streak, ALLIN_STREAK, isAdmin)}
      <p>Ставишь день на кон. Каждое упражнение, сделанное до конца, даёт +${ex.up} к множителю очков дня. Каждое несделанное — −${ex.down}.</p>
      <p class="label">Сделано до конца — все подходы не меньше цели. Добавка складывается с серией и действует на все очки этого дня, ниже ×0.1 не падает.
        Пример на трёх упражнениях: сделал всё — очки дня ×${ex.all}, одно не добил — ×${ex.oneMiss}, это уже меньше обычного дня.
        Каждый подход — с видео. Итог считается, когда день закончился и генерал всё проверил.</p>
      ${isAdmin || !allinOpen ? '' : html`
        <label class="label" for="allin-day">На какой день</label>
        <select id="allin-day" class="input" ${options.length ? '' : html`disabled`}>
          ${options.length ? options.map((d) => html`<option value="${d}">${dayTitle(d)}</option>`)
            : html`<option>Тренировок впереди нет</option>`}
        </select>
        <p class="error" id="allin-error" role="alert"></p>
        <button type="button" class="btn" id="buy-allin" ${canAllin ? '' : html`disabled`}>Пойти ва-банк${aPrice !== null ? ` за ${aPrice}` : ''}</button>`}
      <p class="label">${allinHint(r, aPrice, w.balance, isAdmin)}</p>
    </section>

    <section class="card beyond-card ${w.streak >= BEYOND_STREAK ? '' : 'locked'}">
      <div class="row"><h2 class="h2">🔥 ${BEYOND}</h2><span class="chip">скоро</span></div>
      ${streakLock(w.streak, BEYOND_STREAK, isAdmin, 'Серия есть — генерал скоро запустит.')}
    </section>

    ${purchases.length ? html`<section class="card">
      <h2 class="h2">Куплено</h2>
      ${purchases.map((p) => html`<div class="row bought">
        <span>${p.kind === 'allin' ? `🎲 ${ALLIN}` : 'Выходной'} · ${dayTitle(p.date)} · ${p.price}</span>
        <button type="button" class="ghost" data-cancel="${p.id}">Отменить</button>
      </div>`)}
      <p class="label">Отменить можно до начала дня, очки вернутся.</p>
    </section>` : ''}

    <section class="card">
      <div class="row"><h2 class="h2">Больничный</h2><span class="chip">бесплатно</span></div>
      <p class="label">Если болит по-настоящему, а не просто крепатура. Генерал одобрит: очки не тратятся, серия не ломается.</p>
      ${sickBlock(todaySick, todayTraining, isAdmin)}
    </section>

    <section class="card">
      <h2 class="h2">Идеи для магазина</h2>
      <p class="label">${isAdmin
        ? 'Что друг предлагает покупать за очки. Обсудите в Telegram; если идея подходит — отметь её принятой.'
        : 'Предложи, что ещё можно было бы покупать за очки. Обсудите в Telegram, новый товар добавит крутой генерал.'}</p>
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
        ${isAdmin ? html`<button type="button" class="ghost icon" data-del-idea="${i.id}" aria-label="Удалить идею">✕</button>` : ''}
      </div>`) : html`<p class="label">Идей пока нет.</p>`}
    </section>
  `);

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

  el.querySelector('#buy-allin')?.addEventListener('click', async () => {
    const date = el.querySelector('#allin-day').value;
    const err = el.querySelector('#allin-error');
    err.textContent = '';
    if (!confirm(`${ALLIN} на ${dayTitle(date)} за ${POINTS(aPrice)}? В этот день каждое упражнение — до конца и с видео.`)) return;
    try {
      await api.buyAllin(date);
      ctx.toast(`${ALLIN} на ${dayTitle(date)} куплено. Удачи!`);
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
      ctx.toast('Запрос отправлен генералу');
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

  el.querySelectorAll('[data-del-idea]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Удалить идею?')) return;
    try {
      await api.deleteIdea(Number(b.dataset.delIdea));
      ctx.refresh();
    } catch (e) { ctx.toast(e.message); }
  }));

  el.querySelectorAll('[data-idea]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api.setIdeaStatus(Number(b.dataset.idea), b.dataset.status);
      ctx.refresh();
    } catch (e) { ctx.toast(e.message); }
  }));
}

function buyHint(r, price, balance, isAdmin) {
  if (price === null) return 'Цену выходного генерал ещё не поставил.';
  const parts = [];
  if (!isAdmin && balance < price) parts.push(`Не хватает ${POINTS(price - balance)}.`);
  parts.push('Купить можно только заранее, до начала дня. Отменить — тоже до начала дня, очки вернутся.');
  if (r?.purchase_limit_week != null) parts.push(`Не больше ${r.purchase_limit_week} в неделю.`);
  return parts.join(' ');
}

// Замок по серии: открыто, пока серия держится; пропуск дня — снова закрыто.
function streakLock(streak, need, isAdmin, open = '') {
  const pct = Math.min(100, Math.round((streak * 100) / need));
  if (streak >= need) return html`<p class="ok strong">🔓 ${open || `Открыто: серия ${streak} дн. Пропустишь день — снова закроется.`}</p>`;
  return html`<div class="lock">
    <p class="strong">🔒 Открывается при серии от ${need} дней подряд</p>
    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${need}" aria-valuenow="${streak}"><span class="bar-fill" style="width:${pct}%"></span></div>
    <p class="label">${isAdmin ? 'Серия друга' : 'Твоя серия'}: ${streak} из ${need}. Работает, пока серия держится: пропуск — снова закрыто.</p>
  </div>`;
}

function allinHint(r, price, balance, isAdmin) {
  if (price === null) return 'Генерал ещё не поставил цену — пока не продаётся.';
  const parts = [];
  if (!isAdmin && balance < price) parts.push(`Не хватает ${POINTS(price - balance)}.`);
  parts.push('Купить можно только заранее, до начала дня.');
  if (r?.allin_limit_week != null) parts.push(`Не больше ${r.allin_limit_week} в неделю.`);
  return parts.join(' ');
}

function sickBlock(s, todayTraining, isAdmin) {
  if (s?.status === 'pending') {
    return isAdmin
      ? html`<p class="warn-strong">Друг просит больничный на сегодня${s.note ? `: «${s.note}»` : ''}. Решение — во вкладке «Проверка».</p>`
      : html`<p class="ok strong">Запрос на сегодня отправлен генералу</p>`;
  }
  if (s?.status === 'approved') return html`<p class="ok strong">Сегодня больничный: генерал одобрил</p>`;
  if (isAdmin) return '';
  if (!todayTraining) return html`<p class="label">Сегодня нет тренировки — больничный не нужен.</p>`;
  return html`
    ${s?.status === 'declined' ? html`<p class="warn-strong">Генерал отказал. Можно попросить ещё раз.</p>` : ''}
    <label class="label" for="sick-note">Что болит</label>
    <input class="input" id="sick-note" type="text" maxlength="300" placeholder="Например: плечо">
    <button type="button" class="ghost" id="ask-sick">Попросить больничный на сегодня</button>`;
}
