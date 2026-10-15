// «Сегодня»: утренний опрос и подходы дня. Тот же экран открывает прошлый день
// из календаря, а админу показывает день друга без возможности править.

import { html, dayTitle, addDays, shortDate, debounce } from '../util.js';
import { MUSCLES, DAY_STATUS, caption, goalText, reviewNote, dayMode, isCalibration, unitOf, unitText,
  ALLIN, ALLIN_STATE, signed } from '../logic.js';

export async function render(el, ctx, args, alive) {
  const { api, clock, settings, me } = ctx;
  const isAdmin = me.role === 'admin';
  const athleteId = ctx.athleteId;
  const date = args[0] && /^\d{4}-\d{2}-\d{2}$/.test(args[0]) ? args[0] : clock.today;

  if (!athleteId) {
    el.innerHTML = String(html`<section class="card"><h2 class="h2">Атлетов пока нет</h2>
      <p class="label">Создай аккаунт друга в Supabase: Authentication → Users → Add user.</p></section>`);
    return;
  }
  if (date > clock.today) {
    location.replace(`#/calendar/${date.slice(0, 7)}/${date}`);
    return;
  }

  const [day, logs, mornings, sick, wallet, catalog, allin] = await Promise.all([
    api.openDay(date, isAdmin ? athleteId : undefined),
    api.logs(athleteId, date, date),
    api.mornings(athleteId, date, date),
    date === clock.today ? api.sickRequests(athleteId, date) : [],
    date === clock.today ? api.wallet(isAdmin ? athleteId : undefined) : null,
    api.exercises(),
    api.allinDay(date, isAdmin ? athleteId : undefined),
  ]);
  if (!alive()) return;

  const status = day ? day.status : null;
  const mode = isAdmin ? 'view' : dayMode({ date, clock, startDate: settings.start_date, status });
  const state = {
    morning: mornings[0] ?? { muscles: null, energy: null, note: null },
    logs: new Map(logs.map((l) => [`${l.exercise_id}-${l.set_no}`, l])),
    sick: sick.find((s) => s.date === date) ?? null,
    training: status === 'training',
  };
  const isToday = date === clock.today;
  const beforeStart = settings.start_date && date < settings.start_date;
  const yesterday = addDays(clock.today, -1);
  const editable = mode === 'open' || mode === 'grace';

  el.innerHTML = String(html`
    <header class="stack-8">
      <p class="sub">${isAdmin ? html`Экран друга · только просмотр` : dayTitle(date)}</p>
      <h1 class="h1">${isToday ? 'Сегодня' : dayTitle(date)}</h1>
      <div class="chips">
        ${isAdmin && isToday ? html`<span class="chip">${dayTitle(date)}</span>` : ''}
        ${isCalibration(ctx.rules?.current) ? html`<span class="chip">Тестовый период · очки не начисляются</span>` : ''}
        ${wallet && !beforeStart ? streakChip(wallet, ctx.rules?.current) : ''}
        ${beforeStart ? html`<span class="chip chip-warn">Старт ${shortDate(settings.start_date)}</span>` : ''}
        ${allin && status === 'training' ? html`<span class="chip chip-allin">🎲 ALL IN</span>` : ''}
      </div>
    </header>

    ${allin && status === 'training' && !beforeStart ? allinCard(allin, isToday) : ''}

    ${!isAdmin && isToday && clock.grace ? html`<a class="notice" href="#/day/${yesterday}">
      Вчерашний день закрыт. До 03:00 можно отметить видео за вчера →</a>` : ''}
    ${mode === 'grace' ? html`<p class="notice">День закрыт. До 03:00 можно отметить только видео.</p>` : ''}
    ${!isAdmin && !isToday && mode === 'closed' && status === 'training' ? html`<p class="notice">День закрыт, править может только крутой генерал.</p>` : ''}

    ${day?.note && status === 'training' ? html`<section class="card task-card">
      <h2 class="h2">Приказ генерала</h2><p>${day.note}</p></section>` : ''}

    ${isToday || state.morning.muscles || state.morning.energy ? html`<section class="card" id="morning"></section>` : ''}

    ${status === 'training' && day.plan && !beforeStart
      ? day.plan.map((ex) => exerciseCard(ex, date, state, editable, mode, catalog, allin))
      : html`<section class="card">
          <h2 class="h2">${status ? DAY_STATUS[status] : 'План не задан'}</h2>
          <p class="label">${restText(status, beforeStart)}</p>
        </section>`}

    ${status === 'training' && !isAdmin && isToday ? html`<p class="label center">Каждый подход сохраняется сразу.<br>
      День закроется в 00:00, видео можно отметить до 03:00.</p>` : ''}
  `);

  const morningEl = el.querySelector('#morning');
  if (morningEl) renderMorning(morningEl, ctx, state, !isAdmin && isToday);

  if (editable) wireSets(el, ctx, date, state, mode);
  wireCopy(el);
}

// Серия и множитель, на который умножаются очки за сегодняшние подходы.
function streakChip(w, r) {
  const on = !isCalibration(r) && r?.streak_from && r?.streak_step;
  return html`<span class="chip ${on && w.mult > 1 ? 'chip-on' : ''}">${isCalibration(r) ? 'Тестовая серия' : 'Серия'} ${w.streak}${on ? ` · сегодня очки ×${w.mult}` : ''}</span>`;
}

function restText(status, beforeStart) {
  if (beforeStart) return 'Старт ещё не наступил. Подходы можно будет отмечать со дня старта.';
  if (status === 'rest' || status === 'bought') return 'Отдых по плану. Серию не рвёт и не продлевает.';
  if (status === 'sick') return 'Больничный. Восстанавливайся, очки не тратятся.';
  if (status === 'busy') return 'День без задания по договорённости.';
  return 'Крутой генерал ещё не задал план на этот день.';
}

// «Всё или ничего»: что на кону сегодня и какой множитель выходит.
function allinCard(a, isToday) {
  const head = isToday
    ? `Сегодня день на кону. Каждое упражнение до конца (все подходы не меньше цели) — +${a.up} к множителю очков, каждое несделанное — −${a.down}. Каждый подход — с видео.`
    : `День был на кону: каждое упражнение до конца — +${a.up} к множителю очков, каждое несделанное — −${a.down}.`;
  let result;
  if (a.final) {
    const pts = a.bonus === null || a.bonus === undefined ? ''
      : a.test ? ` · в теории ${signed(a.bonus)} очков (видишь только ты)` : ` · ${signed(a.bonus)} очков`;
    result = html`<p class="strong">Итог: очки дня ×${a.mult}${pts}</p>`;
  } else {
    const wait = isToday ? '' : ' Итог посчитается, когда генерал проверит все подходы.';
    result = html`<p class="strong">Сейчас ×${a.mult}${a.best !== a.mult ? ` · добьёшь всё — ×${a.best}` : ''}</p>
      ${wait ? html`<p class="label">${wait.trim()}</p>` : ''}`;
  }
  return html`<section class="card allin-card">
    <div class="row"><h2 class="h2">🎲 ${ALLIN}</h2><span class="chip chip-allin">×${a.mult}</span></div>
    <p class="label">${head}</p>
    <ul class="allin-list">${a.items.map((i) => html`<li class="allin-${i.state}">
      <span aria-hidden="true">${ALLIN_STATE[i.state].icon}</span><span>${i.name}</span><span class="label">${ALLIN_STATE[i.state].text}</span></li>`)}
    </ul>
    ${result}
    ${a.k > 1 ? html`<p class="label">Серия даёт ×${a.k}, модификатор прибавляется к ней.</p>` : ''}
  </section>`;
}

function exerciseCard(ex, date, state, editable, mode, catalog, allin) {
  const unit = unitOf(ex, catalog);
  const u = unitText(unit);
  const sets = Array.from({ length: ex.sets }, (_, i) => i + 1);
  const bet = allin?.items.find((i) => i.id === ex.id);
  return html`<section class="card ${bet ? 'allin-ex' : ''}">
    <div class="stack-4">
      <div class="row"><h2 class="h2">${ex.name}</h2>${bet ? html`<span class="chip allin-bet">${ALLIN_STATE[bet.state].icon} ${
        bet.state === 'done' ? `+${allin.up}` : bet.state === 'miss' ? `−${allin.down}` : `+${allin.up} / −${allin.down}`}</span>` : ''}</div>
      <p class="label">${goalText(ex, unit)}</p></div>
    ${sets.map((n) => {
      const key = `${ex.id}-${n}`;
      const log = state.logs.get(key);
      const cap = caption(date, ex.name, n);
      return html`<div class="set" data-ex="${ex.id}" data-set="${n}" data-unit="${unit}">
        <div class="set-row">
          <span class="num" aria-hidden="true">${n}</span>
          <input class="input set-reps" type="number" inputmode="numeric" pattern="[0-9]*" min="0" max="1000"
            placeholder="${u.input}" aria-label="${ex.name}, подход ${n}, ${u.input}"
            value="${log?.claimed ?? ''}" ${mode !== 'open' ? html`disabled` : ''}>
          <label class="check"><input type="checkbox" class="set-video" ${log?.has_video ? html`checked` : ''}
            ${editable ? '' : html`disabled`}><span>Видео</span></label>
          <button type="button" class="ghost icon set-copy" data-caption="${cap}" aria-label="Скопировать подпись: ${cap}">
            <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg>
          </button>
        </div>
        <p class="set-note" aria-live="polite">${noteHtml(log, unit)}</p>
      </div>`;
    })}
  </section>`;
}

function noteHtml(log, unit) {
  const text = reviewNote(log, unit);
  if (!text) return '';
  const cls = { accepted: 'ok', corrected: 'warn', rejected: 'bad' }[log.review] ?? '';
  return html`<span class="${cls}">${text}</span>${log.comment ? html` · ${log.comment}` : ''}`;
}

function wireSets(el, ctx, date, state, mode) {
  const save = async (row) => {
    const exId = Number(row.dataset.ex);
    const setNo = Number(row.dataset.set);
    const key = `${exId}-${setNo}`;
    const input = row.querySelector('.set-reps');
    const video = row.querySelector('.set-video').checked;
    const note = row.querySelector('.set-note');
    const prev = state.logs.get(key);
    let claimed = input.value === '' ? null : Number(input.value);
    if (mode === 'grace') claimed = prev?.claimed ?? null;
    if (claimed !== null && (!Number.isInteger(claimed) || claimed < 0 || claimed > 1000)) {
      note.innerHTML = '<span class="bad">Нужно целое число от 0 до 1000</span>';
      return;
    }
    if (prev && prev.claimed === claimed && prev.has_video === video) return;
    if (!prev && claimed === null && !video) return;
    note.textContent = 'Сохраняю…';
    try {
      const saved = await ctx.api.logSet(date, exId, setNo, claimed, video);
      state.logs.set(key, saved);
      note.innerHTML = String(noteHtml(saved, row.dataset.unit)) || 'Сохранено';
    } catch (err) {
      note.innerHTML = '';
      note.append(Object.assign(document.createElement('span'), { className: 'bad', textContent: err.message }));
    }
  };

  el.querySelectorAll('.set').forEach((row) => {
    const later = debounce(() => save(row), 900);
    const reps = row.querySelector('.set-reps');
    reps.addEventListener('input', later);
    reps.addEventListener('change', () => save(row));
    row.querySelector('.set-video').addEventListener('change', () => save(row));
  });
}

function wireCopy(el) {
  el.querySelectorAll('.set-copy').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.caption;
      const ok = await copy(text);
      const note = btn.closest('.set').querySelector('.set-note');
      note.innerHTML = '';
      note.append(Object.assign(document.createElement('span'), {
        className: ok ? 'ok' : 'bad',
        textContent: ok ? `Скопировано: ${text}` : 'Не получилось скопировать',
      }));
    });
  });
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

// ── Утро ──

function sickHtml(state, editable) {
  const s = state.sick;
  if (s?.status === 'pending') return html`<p class="warn-strong">Запрос отправлен генералу</p>`;
  if (s?.status === 'approved') return html`<p class="warn-strong">Генерал одобрил больничный</p>`;
  const btn = editable && state.training
    ? html`<button type="button" class="ghost ghost-bad" id="ask-sick">Попросить больничный</button>` : '';
  if (s?.status === 'declined') return html`<p class="warn-strong">Генерал отказал. Можно попросить ещё раз.</p>${btn}`;
  return btn;
}

function renderMorning(el, ctx, state, editable) {
  const m = state.morning;
  const done = m.muscles && m.energy;
  el.innerHTML = String(html`
    <div class="row"><h2 class="h2">Утро: как ты?</h2>${done ? html`<span class="chip chip-on">готово</span>` : ''}</div>
    <p class="label" id="muscles-label">Самочувствие</p>
    <div class="seg" role="group" aria-labelledby="muscles-label">
      ${MUSCLES.map((x) => html`<button type="button" class="pill ${m.muscles === x.key ? 'pill-on' : ''}"
        data-muscles="${x.key}" aria-pressed="${m.muscles === x.key}" ${editable ? '' : html`disabled`}>${x.label}</button>`)}
    </div>
    <p class="label" id="energy-label">Энергия</p>
    <div class="seg" role="group" aria-labelledby="energy-label">
      ${[1, 2, 3, 4, 5].map((n) => html`<button type="button" class="pill ${m.energy === n ? 'pill-on' : ''}"
        data-energy="${n}" aria-pressed="${m.energy === n}" ${editable ? '' : html`disabled`}>${n}</button>`)}
    </div>
    ${editable ? html`<label class="label" for="morning-note">Заметка, если хочешь</label>
      <input class="input" id="morning-note" type="text" maxlength="500" value="${m.note ?? ''}" placeholder="Например: плохо спал">`
      : m.note ? html`<p class="label">Заметка: ${m.note}</p>` : ''}
    ${m.muscles === 'pain' ? html`<div class="warn-box">
      <p>Если болит по-настоящему, а не крепатура, — попроси больничный: очки не тратятся, серия не рвётся.</p>
      ${sickHtml(state, editable)}
    </div>` : ''}
  `);
  if (!editable) return;

  el.querySelector('#ask-sick')?.addEventListener('click', async () => {
    try {
      state.sick = await ctx.api.requestSick(m.note);
      renderMorning(el, ctx, state, editable);
    } catch (err) {
      ctx.toast(err.message);
    }
  });

  const save = async (patch) => {
    try {
      state.morning = await ctx.api.saveMorning(patch);
      renderMorning(el, ctx, state, editable);
    } catch (err) {
      ctx.toast(err.message);
    }
  };
  el.querySelectorAll('[data-muscles]').forEach((b) => b.addEventListener('click', () => save({ muscles: b.dataset.muscles })));
  el.querySelectorAll('[data-energy]').forEach((b) => b.addEventListener('click', () => save({ energy: Number(b.dataset.energy) })));
  el.querySelector('#morning-note').addEventListener('change', (e) => save({ note: e.target.value }));
}
