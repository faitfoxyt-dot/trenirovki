// «Календарь»: месяц, цвет дня по статусу, тап — подробности дня.
// Админ может поправить подходы прошедшего дня («Поправить подходы»): очки, штраф и серия пересчитываются в базе.

import { html, monthKey, shiftMonth, monthTitle, monthDays, isoDow, dayTitle, addDays, WD_SHORT } from '../util.js';
import { DAY_STATE, DAY_STATUS, MUSCLES, REVIEW, effectiveStatus, dayState, dayCounts, setPoints, signed, multTag, amount, unitOf,
  unitText, setNumber, ALLIN } from '../logic.js';

const LEGEND = ['confirmed', 'pending', 'missed', 'sick', 'rest', 'bought', 'busy', 'planned'];
const FIX_DAYS = 30; // править можно последние 30 дней — как fix_sets в базе
let fixResult = null; // итог последней правки — показываем после перерисовки

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
  const [template, days, logs, mornings, exercises, theory, purchases] = await Promise.all([
    api.weekTemplate(),
    api.days(athleteId, first, last),
    api.logs(athleteId, first, last),
    api.mornings(athleteId, first, last),
    api.exercises(),
    isAdmin ? api.theory(athleteId, first, last) : [],
    api.purchases(athleteId, first),
  ]);
  if (!alive()) return;

  const info = Object.fromEntries(dates.map((date) => {
    const row = days.find((d) => d.date === date) ?? null;
    const status = effectiveStatus(date, row, template);
    const dayLogs = logs.filter((l) => l.date === date);
    const plan = row?.plan ?? null;
    const state = dayState({ date, today: clock.today, startDate: settings.start_date, status, logs: dayLogs, plan });
    const th = theory.filter((t) => t.date === date);
    const allin = status === 'training' && purchases.some((p) => p.date === date && p.kind === 'allin');
    return [date, { date, row, status, state, allin, logs: dayLogs, morning: mornings.find((m) => m.date === date),
      theory: new Map(th.map((t) => [t.set_id, t])), counts: plan ? dayCounts(plan, dayLogs) : null }];
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
        <div class="lg"><span class="sw day-planned day-allin"></span>${ALLIN}</div>
      </div>
    </section>
    ${me.role === 'athlete' ? html`<section class="card">
      <div class="row"><p class="label">Вошёл как ${me.name || 'атлет'}</p>
      <button type="button" class="ghost" id="sign-out">Выйти</button></div></section>` : ''}
  `);

  const detail = el.querySelector('#detail');
  const canFix = (d) => isAdmin && api.fixSets && d.status === 'training' && d.row?.plan?.length
    && d.date < clock.today && d.date >= addDays(clock.today, -FIX_DAYS)
    && Boolean(settings.start_date) && d.date >= settings.start_date;
  const showDetail = () => {
    const res = isAdmin && fixResult?.date === sel ? fixResult : null;
    detail.innerHTML = String(html`${res ? resultHtml(res) : ''}${detailHtml(info[sel], clock, exercises, isAdmin, canFix(info[sel]))}`);
  };
  showDetail();

  detail.addEventListener('click', async (e) => {
    if (e.target.closest('#fix-done')) { fixResult = null; showDetail(); return; }
    if (e.target.closest('#fix-open')) {
      const d = info[sel];
      const btn = e.target.closest('#fix-open');
      btn.disabled = true;
      let videos = [];
      try { videos = api.waitingVideos ? await api.waitingVideos(athleteId, d.date) : []; } catch { /* без видео — не страшно */ }
      fixResult = null;
      detail.innerHTML = String(fixHtml(d, exercises, videos));
      detail.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    if (e.target.closest('#fix-cancel')) { showDetail(); return; }
    const save = e.target.closest('#fix-save');
    if (!save) return;
    const items = [...detail.querySelectorAll('.fix-reps')]
      .filter((i) => i.value.trim() !== i.dataset.was)
      .map((i) => ({ exercise_id: Number(i.dataset.ex), set_no: Number(i.dataset.set), reps: i.value.trim() === '' ? null : Number(i.value) }))
      .filter((x) => x.reps !== null);
    const bad = items.find((x) => !Number.isInteger(x.reps) || x.reps < 0 || x.reps > 1000);
    if (bad) { ctx.toast('Число от 0 до 1000'); return; }
    if (!items.length) { ctx.toast('Ничего не поменялось'); return; }
    save.disabled = true;
    save.textContent = 'Сохраняю…';
    try {
      const res = await api.fixSets(athleteId, sel, items, detail.querySelector('#fix-note').value);
      fixResult = { date: sel, ...res };
      ctx.refresh();
    } catch (err) {
      ctx.toast(err.message);
      save.disabled = false;
      save.textContent = 'Сохранить';
    }
  });

  el.querySelector('#days').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-date]');
    if (!btn) return;
    sel = btn.dataset.date;
    fixResult = null;
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
  return ['day', `day-${d.state}`, d.allin ? 'day-allin' : '', d.date === today ? 'day-today' : '', d.date === sel ? 'day-sel' : '']
    .filter(Boolean).join(' ');
}

function detailHtml(d, clock, exercises, showTheory, canFix = false) {
  const plan = d.row?.plan ?? [];
  const name = (id) => (plan.find((e) => e.id === id) ?? exercises.find((e) => e.id === id))?.name ?? 'Упражнение';
  const unit = (id) => unitOf(plan.find((e) => e.id === id) ?? { id }, exercises);
  const isPast = d.date <= clock.today;
  const sorted = d.logs.slice().sort((a, b) => a.exercise_id - b.exercise_id || a.set_no - b.set_no);
  const theoryDay = [...d.theory.values()].reduce((a, t) => a + t.points, 0);
  const pts = (l) => {
    if (setPoints(l) !== null) return ` · ${signed(setPoints(l))}${multTag(l.mult)}`;
    const t = showTheory ? d.theory.get(l.id) : null;
    return t ? ` · в теории ${signed(t.points)}${multTag(t.mult)}` : '';
  };

  return html`
    <div class="row"><h2 class="h2">${dayTitle(d.date)}</h2><span class="chip day-chip-${d.state}">${DAY_STATE[d.state]}</span></div>
    ${d.allin ? html`<p class="label">🎲 ${ALLIN}: каждое упражнение до конца — плюс к множителю очков, несделанное — минус.${
      d.date >= clock.today ? '' : ' Итог — в «Цели», в истории очков.'}</p>` : ''}
    ${!isPast ? html`<p class="label">${d.status ? `План: ${DAY_STATUS[d.status].toLowerCase()}.` : 'План на этот день ещё не задан.'}
      Какой это день, решает крутой генерал.</p>` : ''}
    ${isPast && d.state === 'before' ? html`<p class="label">До старта.</p>` : ''}
    ${isPast && d.state === 'missed' ? html`<p class="label">${d.counts && d.counts.done
      ? `Пропуск: сделано ${d.counts.done} из ${d.counts.total} подходов плана.` : 'Тренировочный день без отметок.'}</p>` : ''}
    ${d.row?.note && d.status === 'training' ? html`<p class="label">Приказ генерала: «${d.row.note}»</p>` : ''}
    ${showTheory && theoryDay ? html`<p class="label">Теоретически за день: <b class="em">${signed(theoryDay)}</b> · видишь только ты</p>` : ''}
    ${d.morning ? html`<p class="label">Утро: ${MUSCLES.find((m) => m.key === d.morning.muscles)?.label.toLowerCase() ?? '—'},
      энергия — ${d.morning.energy ?? '—'}${d.morning.note ? html`. «${d.morning.note}»` : ''}</p>` : ''}
    ${sorted.length ? html`<ul class="log-list">
      ${sorted.map((l) => html`<li>
        <div class="row"><span>${name(l.exercise_id)} · подход ${l.set_no}</span>
          <span class="review review-${l.review}">${REVIEW[l.review]}${pts(l)}</span></div>
        <p class="label">Заявлено: ${amount(l.claimed, unit(l.exercise_id))}${l.review !== 'pending' ? ` · подтверждено: ${amount(l.confirmed, unit(l.exercise_id))}` : ''}
          · видео ${l.has_video ? 'есть' : 'нет'}</p>
        ${l.comment ? html`<p class="label comment">Генерал: ${l.comment}</p>` : ''}
      </li>`)}
    </ul>` : ''}
    ${canFix ? html`<button type="button" class="btn" id="fix-open">✏️ Поправить подходы</button>` : ''}
    ${isPast && d.status === 'training' && d.state !== 'before'
      ? html`<a class="ghost link" href="#/day/${d.date}">${d.date === clock.today ? 'Открыть день' : 'Открыть день целиком'}</a>` : ''}
  `;
}

// Правка подходов прошедшего дня: поле на каждый подход плана, рядом — что было.
function fixHtml(d, exercises, videos) {
  const plan = d.row.plan;
  const logs = new Map(d.logs.map((l) => [`${l.exercise_id}-${l.set_no}`, l]));
  const vids = new Map(videos.map((v) => [v.no, v]));
  return html`
    <div class="row"><h2 class="h2">Поправить подходы</h2><span class="chip">${dayTitle(d.date)}</span></div>
    <p class="label">Впиши, сколько друг сделал на самом деле. Пустое поле — подход не трогаем, <b>0</b> — не засчитан.
      Очки, штраф за пропуск, серия и модификаторы дня пересчитаются сами.</p>
    ${plan.map((ex) => {
      const unit = unitOf(ex, exercises);
      const u = unitText(unit);
      return html`<div class="fix-ex">
        <div class="row"><b>${ex.name}</b><span class="label">${ex.target_reps ? `цель ${amount(ex.target_reps, unit)}` : 'без цели'}</span></div>
        ${Array.from({ length: ex.sets }, (_, i) => i + 1).map((n) => {
          const l = logs.get(`${ex.id}-${n}`);
          const v = vids.get(setNumber(plan, ex.id, n));
          const was = l ? String(l.review === 'pending' ? l.claimed ?? '' : l.confirmed ?? '') : '';
          return html`<div class="fix-set">
            <span class="num" aria-hidden="true">${n}</span>
            <label class="fix-in"><input class="input fix-reps" type="number" inputmode="numeric" pattern="[0-9]*" min="0" max="1000"
              data-ex="${ex.id}" data-set="${n}" data-was="${was}" value="${was}" placeholder="—"
              aria-label="${ex.name}, подход ${n}, ${u.many}"><span class="fix-unit">${u.many}</span></label>
            <span class="fix-was">${fixState(l, v, unit)}</span>
          </div>`;
        })}
      </div>`;
    })}
    <label class="field"><span class="label">Комментарий для друга (необязательно)</span>
      <input class="input" id="fix-note" maxlength="200" placeholder="Например: вписал по видео"></label>
    <div class="fix-actions"><button type="button" class="ghost" id="fix-cancel">Отмена</button>
      <button type="button" class="btn" id="fix-save">Сохранить</button></div>
  `;
}

function fixState(l, v, unit) {
  if (!l) {
    return v ? html`<span class="warn">🎬 Видео #${v.no} есть, повторы не вписаны</span>
      ${v.url ? html` · <a href="${v.url}" target="_blank" rel="noopener">открыть</a>` : ''}`
      : html`<span class="bad">Не вписан</span>`;
  }
  const cls = { accepted: 'ok', corrected: 'warn', rejected: 'bad' }[l.review] ?? '';
  return html`Друг: ${amount(l.claimed, unit)} · <span class="${cls}">${REVIEW[l.review].toLowerCase()}</span>${
    l.points != null ? ` · ${signed(l.points)}` : ''}`;
}

// Итог правки: какие записи очков добавились.
function resultHtml(r) {
  const sum = r.ledger.reduce((n, x) => n + x.amount, 0);
  // Подходы следующих дней, пересчитанные из-за серии, — одной строкой на день.
  const lines = [];
  r.ledger.forEach((x) => {
    if (x.kind === 'set' && x.date !== r.date) {
      const g = lines.find((y) => y.streak === x.date);
      if (g) { g.amount += x.amount; g.n += 1; return; }
      lines.push({ streak: x.date, amount: x.amount, n: 1 });
      return;
    }
    lines.push({ note: x.date === r.date ? x.note : `${dayTitle(x.date)} · ${x.note}`, amount: x.amount });
  });
  lines.forEach((y) => {
    if (y.streak) y.note = `${dayTitle(y.streak)} · серия стала другой: пересчитано ${y.n} ${y.n === 1 ? 'подход' : y.n < 5 ? 'подхода' : 'подходов'}`;
  });
  return html`<div class="fix-result">
    <div class="row"><h2 class="h2">✅ Сохранено</h2><span class="chip">${r.changed} ${r.changed === 1 ? 'подход' : r.changed < 5 ? 'подхода' : 'подходов'}</span></div>
    ${lines.length ? html`<ul class="fix-lines">${lines.map((x) => html`<li><span>${x.note}</span>
      <b class="${x.amount < 0 ? 'bad' : 'ok'}">${signed(x.amount)}</b></li>`)}</ul>
      <p class="label">Итого к балансу: <b class="em">${signed(sum)}</b> · баланс теперь ${r.balance.toLocaleString('ru-RU')}</p>`
      : html`<p class="label">Очки не поменялись.</p>`}
    <button type="button" class="ghost" id="fix-done">Понятно</button>
  </div>`;
}
