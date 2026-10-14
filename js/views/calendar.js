// «Календарь»: месяц, цвет дня по статусу, тап — подробности дня.

import { html, monthKey, shiftMonth, monthTitle, monthDays, isoDow, dayTitle, WD_SHORT } from '../util.js';
import { DAY_STATE, DAY_STATUS, MUSCLES, REVIEW, effectiveStatus, dayState, dayCounts, setPoints, signed } from '../logic.js';

const LEGEND = ['confirmed', 'pending', 'missed', 'sick', 'rest', 'bought', 'busy', 'planned'];

export async function render(el, ctx, args, alive) {
  const { api, clock, settings, me } = ctx;
  const athleteId = ctx.athleteId;
  const month = /^\d{4}-\d{2}$/.test(args[0] ?? '') ? args[0] : monthKey(clock.today);
  const dates = monthDays(month);
  let sel = dates.includes(args[1]) ? args[1] : dates.includes(clock.today) ? clock.today : dates[0];

  if (!athleteId) {
    el.innerHTML = String(html`<section class="card"><h2 class="h2">Атлетов пока нет</h2></section>`);
    return;
  }

  const first = dates[0];
  const last = dates[dates.length - 1];
  const isAdmin = me.role === 'admin';
  const [template, days, logs, mornings, exercises, theory] = await Promise.all([
    api.weekTemplate(),
    api.days(athleteId, first, last),
    api.logs(athleteId, first, last),
    api.mornings(athleteId, first, last),
    api.exercises(),
    isAdmin ? api.theory(athleteId, first, last) : [],
  ]);
  if (!alive()) return;

  const info = Object.fromEntries(dates.map((date) => {
    const row = days.find((d) => d.date === date) ?? null;
    const status = effectiveStatus(date, row, template);
    const dayLogs = logs.filter((l) => l.date === date);
    const plan = row?.plan ?? null;
    const state = dayState({ date, today: clock.today, startDate: settings.start_date, status, logs: dayLogs, plan });
    const th = theory.filter((t) => t.date === date);
    return [date, { date, row, status, state, logs: dayLogs, morning: mornings.find((m) => m.date === date),
      theory: new Map(th.map((t) => [t.set_id, t.points])), counts: plan ? dayCounts(plan, dayLogs) : null }];
  }));

  el.innerHTML = String(html`
    <header class="stack-8">
      <p class="sub">${me.role === 'admin' ? 'Календарь друга · тап по дню — подробности' : 'Тап по дню — подробности'}</p>
      <h1 class="h1">Календарь</h1>
    </header>
    <section class="card">
      <div class="row">
        <a class="ghost icon link" href="#/calendar/${shiftMonth(month, -1)}" aria-label="Предыдущий месяц">
          <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></a>
        <h2 class="h2">${monthTitle(month)}</h2>
        <a class="ghost icon link" href="#/calendar/${shiftMonth(month, 1)}" aria-label="Следующий месяц">
          <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></a>
      </div>
      <div class="grid" aria-hidden="true">${WD_SHORT.map((d) => html`<span class="wd">${d}</span>`)}</div>
      <div class="grid" id="days">
        ${Array.from({ length: isoDow(first) - 1 }, () => html`<span></span>`)}
        ${dates.map((date) => html`<button type="button" class="${cellClass(info[date], clock.today, sel)}"
          data-date="${date}" aria-label="${dayTitle(date)}: ${DAY_STATE[info[date].state]}"
          aria-pressed="${date === sel}">${Number(date.slice(8))}</button>`)}
      </div>
    </section>
    <section class="card" id="detail"></section>
    <section class="card">
      <h2 class="h2">Что значат цвета</h2>
      <div class="legend">
        ${LEGEND.map((s) => html`<div class="lg"><span class="sw day-${s}"></span>${DAY_STATE[s]}</div>`)}
        <div class="lg"><span class="sw sw-today"></span>Сегодня</div>
      </div>
    </section>
    ${me.role === 'athlete' ? html`<section class="card">
      <div class="row"><p class="label">Вошёл как ${me.name || 'атлет'}</p>
      <button type="button" class="ghost" id="sign-out">Выйти</button></div></section>` : ''}
  `);

  const detail = el.querySelector('#detail');
  const showDetail = () => {
    detail.innerHTML = String(detailHtml(info[sel], clock, exercises, isAdmin));
  };
  showDetail();

  el.querySelector('#days').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-date]');
    if (!btn) return;
    sel = btn.dataset.date;
    el.querySelectorAll('#days button').forEach((b) => {
      b.className = cellClass(info[b.dataset.date], clock.today, sel);
      b.setAttribute('aria-pressed', String(b.dataset.date === sel));
    });
    history.replaceState(null, '', `#/calendar/${month}/${sel}`);
    showDetail();
  });
  el.querySelector('#sign-out')?.addEventListener('click', ctx.signOut);
}

function cellClass(d, today, sel) {
  return ['day', `day-${d.state}`, d.date === today ? 'day-today' : '', d.date === sel ? 'day-sel' : '']
    .filter(Boolean).join(' ');
}

function detailHtml(d, clock, exercises, showTheory) {
  const plan = d.row?.plan ?? [];
  const name = (id) => (plan.find((e) => e.id === id) ?? exercises.find((e) => e.id === id))?.name ?? 'Упражнение';
  const isPast = d.date <= clock.today;
  const sorted = d.logs.slice().sort((a, b) => a.exercise_id - b.exercise_id || a.set_no - b.set_no);
  const theoryDay = [...d.theory.values()].reduce((a, b) => a + b, 0);
  const pts = (l) => {
    if (setPoints(l) !== null) return ` · ${signed(setPoints(l))}`;
    return showTheory && d.theory.has(l.id) ? ` · в теории ${signed(d.theory.get(l.id))}` : '';
  };

  return html`
    <div class="row"><h2 class="h2">${dayTitle(d.date)}</h2><span class="chip day-chip-${d.state}">${DAY_STATE[d.state]}</span></div>
    ${!isPast ? html`<p class="label">${d.status ? `План: ${DAY_STATUS[d.status].toLowerCase()}.` : 'План на этот день ещё не задан.'}
      Статус дня задаёт Тимур в шаблоне недели или отдельно для дня.</p>` : ''}
    ${isPast && d.state === 'before' ? html`<p class="label">До старта.</p>` : ''}
    ${isPast && d.state === 'missed' ? html`<p class="label">${d.counts && d.counts.done
      ? `Пропуск: сделано ${d.counts.done} из ${d.counts.total} подходов плана.` : 'Тренировочный день без отметок.'}</p>` : ''}
    ${d.row?.note && d.status === 'training' ? html`<p class="label">Задание от Тимура: «${d.row.note}»</p>` : ''}
    ${showTheory && theoryDay ? html`<p class="label">Теоретически за день: <b class="em">${signed(theoryDay)}</b> · видишь только ты</p>` : ''}
    ${d.morning ? html`<p class="label">Утро: ${MUSCLES.find((m) => m.key === d.morning.muscles)?.label.toLowerCase() ?? '—'},
      энергия — ${d.morning.energy ?? '—'}${d.morning.note ? html`. «${d.morning.note}»` : ''}</p>` : ''}
    ${sorted.length ? html`<ul class="log-list">
      ${sorted.map((l) => html`<li>
        <div class="row"><span>${name(l.exercise_id)} · подход ${l.set_no}</span>
          <span class="review review-${l.review}">${REVIEW[l.review]}${pts(l)}</span></div>
        <p class="label">Заявлено: ${l.claimed ?? '—'}${l.review !== 'pending' ? ` · подтверждено: ${l.confirmed}` : ''}
          · видео ${l.has_video ? 'есть' : 'нет'}</p>
        ${l.comment ? html`<p class="label comment">Тимур: ${l.comment}</p>` : ''}
      </li>`)}
    </ul>` : ''}
    ${isPast && d.status === 'training' && d.state !== 'before'
      ? html`<a class="ghost link" href="#/day/${d.date}">${d.date === clock.today ? 'Открыть день' : 'Открыть день целиком'}</a>` : ''}
  `;
}
