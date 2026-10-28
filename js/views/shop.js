// «Магазин»: выходной за очки, «Всё или ничего», «За гранью предела» (пари на 3 тренировки), больничный, идеи атлета.
// Админ видит то же самое, отменяет покупки и отвечает на идеи.

import { html, dayTitle, addDays } from '../util.js';
import { POINTS, effectiveStatus, ALLIN, allinExample, PARI, PARI_STATE, pariTimes, amount, unitOf } from '../logic.js';
import { phoneButton, confetti } from './goal.js';
import { restTodayPrice } from '../logic.js';

const IDEA = { new: 'на рассмотрении', accepted: 'принята', declined: 'отклонена' };
const AHEAD = 14; // на сколько дней вперёд можно выбрать выходной
const WEEK = 7; // «Всё или ничего» и начало «За гранью предела» — не дальше недели

export async function render(el, ctx, args, alive) {
  const { api, clock, me } = ctx;
  const athleteId = ctx.athleteId;
  const isAdmin = me.role === 'admin';
  if (!athleteId) {
    el.innerHTML = String(html`<section class="card"><h2 class="h2">Атлетов пока нет</h2></section>`);
    return;
  }

  const t = clock.today;
  const [w, template, days, purchases, sick, ideas, paris] = await Promise.all([
    api.wallet(isAdmin ? athleteId : undefined),
    api.weekTemplate(),
    api.days(athleteId, t, addDays(t, AHEAD)),
    api.purchases(athleteId, addDays(t, 1)),
    api.sickRequests(athleteId, t),
    api.ideas(athleteId),
    api.pariList(addDays(t, -21), isAdmin ? athleteId : undefined),
  ]);
  if (!alive()) return;

  const r = ctx.rules?.current;
  const price = r?.rest_day_price ?? null;
  const statusOf = (d) => effectiveStatus(d, days.find((x) => x.date === d) ?? null, template);
  // Пари, которые ещё идут или впереди (последний день — сегодня или позже).
  const pariNow = paris.filter((p) => p.status === 'active' && p.days.length && p.days[p.days.length - 1] >= t);
  // День, на который уже есть покупка или идёт пари, второй раз не купить.
  const taken = new Set([...purchases.map((p) => p.date), ...pariNow.flatMap((p) => p.days)]);
  const options = Array.from({ length: AHEAD }, (_, i) => addDays(t, i + 1)).filter((d) => statusOf(d) === 'training' && !taken.has(d));
  const canBuy = price !== null && w.balance >= price && options.length > 0;
  const aPrice = r?.allin_price ?? null;
  const allinOpen = w.streak >= (r?.allin_streak ?? 0);
  const allinOptions = options.filter((d) => d <= addDays(t, WEEK));
  const pPrice = r?.pari_price ?? null;
  const pariOpen = w.streak >= (r?.pari_streak ?? 0);
  const pariPrizes = [[10, r?.pari_p10], [25, r?.pari_p25], [50, r?.pari_p50]].filter(([, v]) => v != null);
  const canAllin = allinOpen && aPrice !== null && w.balance >= aPrice && allinOptions.length > 0;
  const ex = allinExample(r);
  const todaySick = sick.find((s) => s.date === t) ?? null;
  const todayTraining = statusOf(t) === 'training';
  const tPrice = restTodayPrice(r, w.balance);
  const todayPari = pariNow.some((p) => p.days.includes(t));
  const canToday = tPrice !== null && todayTraining && !todayPari && w.balance >= tPrice;

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

    ${tPrice !== null ? html`<section class="card today-rest-card">
      <div class="row"><h2 class="h2">🆘 Выходной на сегодня</h2><span class="chip">${POINTS(tPrice)}</span></div>
      <p>Не успеваешь сегодня? Бери выходной прямо сейчас. Серия сохранится, штрафа за пропуск не будет.</p>
      <p class="label">Цена — ${r.rest_today_pct ?? 0}% от баланса, но не меньше ${POINTS(r.rest_today_min ?? 0)}. Купить можно до полуночи. Отменить нельзя. Подходы, которые уже сделал сегодня, остаются с очками.</p>
      ${statusOf(t) === 'bought' ? html`<p class="ok strong">✅ Сегодня выходной. Отдыхай.</p>`
        : isAdmin ? '' : html`
        <p class="error" id="today-error" role="alert"></p>
        <button type="button" class="btn" id="buy-today" ${canToday ? '' : html`disabled`}>Взять выходной сегодня за ${tPrice}</button>
        <p class="label">${todayHint(todayTraining, todayPari, tPrice, w.balance)}</p>`}
    </section>` : ''}

    <section class="card allin-card">
      <div class="row"><h2 class="h2">🎲 ${ALLIN}</h2><span class="chip">${aPrice !== null ? POINTS(aPrice) : 'не продаётся'}</span></div>
      ${r?.allin_streak ? streakLock(w.streak, r.allin_streak, isAdmin) : ''}
      <p>Ставишь день на кон. Каждое упражнение, сделанное до конца, даёт +${ex.up} к множителю очков дня. Каждое несделанное — −${ex.down}.</p>
      <p class="label">Сделано до конца — все подходы не меньше цели. Добавка складывается с серией и действует на все очки этого дня, ниже ×0.1 не падает.
        Пример на трёх упражнениях: сделал всё — очки дня ×${ex.all}, одно не добил — ×${ex.oneMiss}, это уже меньше обычного дня.
        Каждый подход — с видео. Итог считается, когда день закончился и генерал всё проверил.</p>
      ${isAdmin || !allinOpen ? '' : html`
        <label class="label" for="allin-day">На какой день</label>
        <select id="allin-day" class="input" ${allinOptions.length ? '' : html`disabled`}>
          ${allinOptions.length ? allinOptions.map((d) => html`<option value="${d}">${dayTitle(d)}</option>`)
            : html`<option>Тренировок впереди нет</option>`}
        </select>
        <p class="error" id="allin-error" role="alert"></p>
        <button type="button" class="btn" id="buy-allin" ${canAllin ? '' : html`disabled`}>Пойти ва-банк${aPrice !== null ? ` за ${aPrice}` : ''}</button>`}
      <p class="label">${allinHint(r, aPrice, w.balance, isAdmin)}</p>
    </section>

    <section class="card beyond-card ${pariOpen ? '' : 'locked'}">
      <div class="row"><h2 class="h2">🔥 ${PARI}</h2><span class="chip">${pPrice !== null ? POINTS(pPrice) : 'не продаётся'}</span></div>
      ${r?.pari_streak ? streakLock(w.streak, r.pari_streak, isAdmin) : ''}
      <p>Спор с генералом на 3 тренировки подряд.</p>
      <ul class="pari-list">
        <li>На каждую тренировку выбираешь одно упражнение и ставку: сделать на 10%, 25% или 50% больше своего рекорда за один подход.</li>
        <li>Рекорд — твой лучший подход в этом упражнении. Если его ещё нет или он меньше цели, считаем от цели.</li>
        <li>Сколько раз нужно сделать, увидишь сразу. Сделал — забираешь приз. Не сделал — приза нет, но обычные очки за день остаются.</li>
      </ul>
      <div class="pari-prizes">${pariPrizes.map(([pct, prize]) => html`<div><span class="label">ставка +${pct}%</span><b>${prize}</b></div>`)}</div>
      <p class="label">Подход со ставкой сними на видео — его проверит генерал. Купить можно раз в неделю, начать — в ближайшие 7 дней. В эти 3 дня нельзя «${ALLIN}» и выходной.</p>
      ${pariNow.map((p) => pariBlock(p, t))}
      ${isAdmin || !pariOpen || pPrice === null || pariNow.some((p) => p.start > t) ? '' : html`
        <label class="label" for="pari-start">С какой тренировки начать</label>
        <select id="pari-start" class="input" ${allinOptions.length ? '' : html`disabled`}>
          ${allinOptions.length ? allinOptions.map((d) => html`<option value="${d}">${dayTitle(d)}</option>`)
            : html`<option>Тренировок впереди нет</option>`}
        </select>
        <button type="button" class="ghost" id="pari-plan" ${allinOptions.length ? '' : html`disabled`}>Выбрать упражнения</button>
        <div id="pari-form" class="stack-8"></div>`}
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

  el.querySelector('#buy-today')?.addEventListener('click', async () => {
    const err = el.querySelector('#today-error');
    err.textContent = '';
    if (!confirm(`Взять выходной на сегодня за ${POINTS(tPrice)}? Отменить будет нельзя.`)) return;
    try {
      await api.buyRestToday();
      ctx.toast('Сегодня выходной. Серия сохранена');
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

  el.querySelector('#pari-plan')?.addEventListener('click', async () => {
    const box = el.querySelector('#pari-form');
    try {
      const plan = await api.pariPlan(el.querySelector('#pari-start').value);
      if (!alive()) return;
      box.innerHTML = String(pariForm(plan, w.balance));
      const tiers = new Map(); // номер тренировки → выбранная ставка, %
      const sync = () => {
        box.querySelectorAll('[data-n]').forEach((row) => {
          const n = Number(row.dataset.n);
          const it = plan.days[n - 1].items.find((x) => x.id === Number(row.querySelector('select').value));
          row.querySelector('.pari-base').textContent = !it.record ? `Рекорда пока нет — считаем от цели: ${pariTimes(it.base, it.unit)}`
            : it.base > it.record ? `Рекорд ${pariTimes(it.record, it.unit)}, но цель больше — считаем от цели: ${pariTimes(it.base, it.unit)}`
              : `Твой рекорд: ${pariTimes(it.record, it.unit)}`;
          row.querySelector('.pari-tiers').innerHTML = String(pariTiers(it, tiers.get(n)));
        });
      };
      box.addEventListener('click', (e) => {
        const b = e.target.closest('[data-tier]');
        if (!b) return;
        tiers.set(Number(b.closest('[data-n]').dataset.n), Number(b.dataset.tier));
        sync();
      });
      box.addEventListener('change', sync);
      sync();
      box.querySelector('#buy-pari').addEventListener('click', async () => {
        const err = box.querySelector('#pari-error');
        err.textContent = '';
        const bets = [...box.querySelectorAll('[data-n]')].map((row) => ({ n: Number(row.dataset.n),
          exercise_id: Number(row.querySelector('select').value), tier: tiers.get(Number(row.dataset.n)) ?? null }));
        if (bets.some((x) => !x.tier)) { err.textContent = 'Выбери ставку на каждую из трёх тренировок'; return; }
        if (!confirm(`${PARI} с ${dayTitle(plan.start)} за ${POINTS(plan.price)}? Ставки потом не поменять.`)) return;
        try {
          await api.buyPari(plan.start, bets);
          ctx.toast('Пари принято. Генерал ждёт!');
          ctx.refresh();
        } catch (e) { err.textContent = e.message; }
      });
    } catch (e) { box.innerHTML = String(html`<p class="error" role="alert">${e.message}</p>`); }
  });

  el.querySelectorAll('[data-cancel-pari]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Отменить «${PARI}»? Очки вернутся.`)) return;
    try {
      await api.cancelPari(Number(b.dataset.cancelPari));
      ctx.toast('Пари отменено, очки вернулись');
      ctx.refresh();
    } catch (e) { ctx.toast(e.message); }
  }));

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

function todayHint(training, pari, price, balance) {
  if (!training) return 'Сегодня и так нет тренировки.';
  if (pari) return 'Сегодня идёт «За гранью предела» — выходной не купить.';
  if (balance < price) return `Не хватает ${POINTS(price - balance)}.`;
  return '';
}

// Купленное пари: 3 тренировки, ставки и что с ними.
function pariBlock(p, t) {
  return html`<div class="pari-bought stack-8">
    <p class="strong">Твоё пари с ${dayTitle(p.start)}</p>
    ${p.bets.map((b, i) => html`<div class="row pari-bet pari-${b.state}">
      <span><span class="label">${p.days[i] ? dayTitle(p.days[i]) : `Тренировка ${i + 1}`}</span><br>${b.name} — ${pariTimes(b.reps, unitOf(b))}</span>
      <span class="chip">${PARI_STATE[b.state].icon} ${b.state === 'won' ? `+${b.prize}` : b.prize}</span>
    </div>`)}
    ${p.start > t ? html`<button type="button" class="ghost" data-cancel-pari="${p.id}">Отменить до начала</button>` : ''}
  </div>`;
}

// Форма ставок: на каждую из 3 тренировок — упражнение из плана и одна из трёх ставок к рекорду.
function pariForm(plan, balance) {
  if (plan.days.length < 3) return html`<p class="error">Впереди меньше трёх тренировок.</p>`;
  return html`
    ${plan.days.map((d) => html`<div class="pari-day stack-8" data-n="${d.n}">
      <p class="strong">Тренировка ${d.n} · ${dayTitle(d.date)}</p>
      <select class="input" aria-label="Упражнение">${d.items.map((it) => html`<option value="${it.id}">${it.name}</option>`)}</select>
      <p class="label pari-base"></p>
      <div class="pari-tiers" role="radiogroup" aria-label="Ставка"></div>
    </div>`)}
    <p class="error" id="pari-error" role="alert"></p>
    <button type="button" class="btn" id="buy-pari" ${balance >= plan.price ? '' : html`disabled`}>Поспорить за ${plan.price}</button>
    ${balance < plan.price ? html`<p class="label">Не хватает ${POINTS(plan.price - balance)}.</p>` : ''}`;
}

// Три ставки для упражнения: сколько раз сделать (вверх от базы) и приз.
function pariTiers(it, tier) {
  return html`${it.bets.map((b) => html`<button type="button" class="pill pari-tier" role="radio" data-tier="${b.tier}"
    aria-pressed="${b.tier === tier ? 'true' : 'false'}" aria-checked="${b.tier === tier ? 'true' : 'false'}">
    <span>+${b.tier}%</span><b>${pariTimes(b.reps, it.unit)}</b><span class="label">приз ${b.prize}</span></button>`)}`;
}

// Замок по серии: открыто, пока серия держится; пропуск дня — снова закрыто.
function streakLock(streak, need, isAdmin) {
  const pct = Math.min(100, Math.round((streak * 100) / need));
  if (streak >= need) return html`<p class="ok strong">🔓 Открыто: серия ${streak} дн. Пропустишь день — снова закроется.</p>`;
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
  parts.push('Купить можно только заранее, до начала дня, и не дальше чем на неделю вперёд.');
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
