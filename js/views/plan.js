// «План» (админ): старт, шаблон недели, комплекс из списка упражнений, план на день, очистка.

import { html, WEEKDAYS, dayTitle, addDays } from '../util.js';
import { DAY_STATUS } from '../logic.js';

const TEMPLATE_OPTIONS = [
  { value: '', label: 'Не задано' },
  { value: 'training', label: 'Тренировка' },
  { value: 'rest', label: 'Выходной' },
  { value: 'busy', label: 'Занят' },
];
const DAY_OPTIONS = ['training', 'rest', 'sick', 'busy'];
const CLEAR = [
  { k: 'sets', label: 'Подходы (и их теоретические очки)' },
  { k: 'points', label: 'Записи очков' },
  { k: 'purchases', label: 'Покупки выходных' },
  { k: 'sick', label: 'Запросы больничного' },
  { k: 'ideas', label: 'Идеи' },
  { k: 'mornings', label: 'Утро' },
  { k: 'days', label: 'Планы, задания и статусы дней' },
];

export async function render(el, ctx, args, alive) {
  const { api, clock, settings, me } = ctx;
  const [template, exercises] = await Promise.all([api.weekTemplate(), api.exercises()]);
  if (!alive()) return;

  // Список упражнений ведётся в «Правилах»; здесь из него собирается общий комплекс.
  const catalog = exercises.filter((e) => !e.archived);
  const rows = catalog.filter((e) => e.active).map(({ id, sets, target_reps }) => ({ id, sets, target_reps }));
  const athleteName = ctx.athletes.find((a) => a.id === ctx.athleteId)?.name || 'без имени';

  el.innerHTML = String(html`
    <header class="stack-8">
      <p class="sub">Что друг делает каждый день</p>
      <h1 class="h1">План</h1>
    </header>

    <section class="card">
      <h2 class="h2">Старт</h2>
      <p class="label">С этого дня друг отмечает подходы. До него дни закрыты.</p>
      <label class="label" for="start-date">Дата старта</label>
      <input class="input" id="start-date" type="date" value="${settings.start_date ?? ''}">
      <p class="label ok" id="settings-saved" aria-live="polite"></p>
      <p class="label">Тестовый период и очки — во вкладке «Правила».</p>
    </section>

    <section class="card">
      <h2 class="h2">Шаблон недели</h2>
      <p class="label">Повторяется каждую неделю. Отдельный день меняется ниже.</p>
      ${WEEKDAYS.map((name, i) => {
        const cur = template.find((t) => t.dow === i + 1)?.status ?? '';
        return html`<div class="row">
          <label for="dow-${i + 1}" class="dow-label">${name}</label>
          <select id="dow-${i + 1}" class="input dow" data-dow="${i + 1}">
            ${TEMPLATE_OPTIONS.map((o) => html`<option value="${o.value}" ${o.value === (cur ?? '') ? html`selected` : ''}>${o.label}</option>`)}
          </select>
        </div>`;
      })}
    </section>

    <section class="card">
      <h2 class="h2">Комплекс тренировки</h2>
      <p class="label">Один комплекс на все тренировочные дни. Пустая цель — друг просто пишет, сколько сделал.
        Изменения попадут в дни, которые друг ещё не открывал. Новые упражнения и очки — во вкладке «Правила».</p>
      <div id="ex-list"></div>
      ${catalog.length ? html`<button type="button" class="ghost" id="ex-add">+ Упражнение из списка</button>`
        : html`<p class="label">Список упражнений пуст. Добавь их во вкладке «Правила».</p>`}
      <p class="error" id="ex-error" role="alert"></p>
      <button type="button" class="btn" id="ex-save">Сохранить комплекс</button>
    </section>

    <section class="card">
      <h2 class="h2">Изменить один день</h2>
      ${ctx.athleteId ? html`
        <label class="label" for="one-day">День</label>
        <input class="input" id="one-day" type="date" value="${clock.today}">
        <label class="label" for="one-status">Статус</label>
        <select id="one-status" class="input">
          ${DAY_OPTIONS.map((s) => html`<option value="${s}">${DAY_STATUS[s]}</option>`)}
        </select>
        <p class="error" id="one-error" role="alert"></p>
        <button type="button" class="btn" id="one-apply">Применить</button>
        <p class="label ok" id="one-saved" aria-live="polite"></p>`
      : html`<p class="label">Сначала создай аккаунт друга в Supabase.</p>`}
    </section>

    ${ctx.athleteId ? html`<section class="card">
      <h2 class="h2">План на конкретный день</h2>
      <p class="label">Свой набор упражнений и задание на один день — сегодня или позже. Остальные дни идут по общему комплексу.</p>
      <label class="label" for="dp-date">День</label>
      <input class="input" id="dp-date" type="date" min="${clock.today}" value="${addDays(clock.today, 1)}">
      <div id="dp-body"></div>
    </section>

    <section class="card">
      <h2 class="h2">Очистить данные атлета</h2>
      <p class="label">Сотри только нужное: выбери, что и за какие дни. Пустые даты — за всё время.
        Аккаунт, список упражнений, комплекс и правила не трогаются. Вернуть нельзя.</p>
      <div class="stack-4">${CLEAR.map((c) => html`<label class="check check-wide"><input type="checkbox" data-clear="${c.k}"><span>${c.label}</span></label>`)}</div>
      <div class="grid-2">
        <div class="field"><label class="label" for="clear-from">С</label><input class="input" id="clear-from" type="date"></div>
        <div class="field"><label class="label" for="clear-to">По</label><input class="input" id="clear-to" type="date"></div>
      </div>
      <label class="label" for="reset-confirm">Чтобы подтвердить, впиши имя атлета: <b class="em">${athleteName}</b></label>
      <input class="input" id="reset-confirm" type="text" autocomplete="off">
      <p class="error" id="reset-error" role="alert"></p>
      <button type="button" class="ghost ghost-bad" id="reset">Стереть выбранное у ${athleteName}</button>
    </section>` : ''}

    <section class="card">
      <div class="row"><p class="label">Вошёл как ${me.name || 'админ'}</p>
      <button type="button" class="ghost" id="sign-out">Выйти</button></div>
    </section>
  `);

  // Старт
  const savedNote = el.querySelector('#settings-saved');
  const saveSettings = async (patch) => {
    try {
      await api.updateSettings(patch);
      Object.assign(settings, patch);
      savedNote.textContent = 'Сохранено';
    } catch (err) { ctx.toast(err.message); }
  };
  el.querySelector('#start-date').addEventListener('change', (e) => saveSettings({ start_date: e.target.value || null }));

  // Шаблон недели
  el.querySelectorAll('select.dow').forEach((s) => s.addEventListener('change', async () => {
    try {
      await api.setWeekday(Number(s.dataset.dow), s.value || null);
      ctx.toast(`${WEEKDAYS[Number(s.dataset.dow) - 1]}: сохранено`);
    } catch (err) { ctx.toast(err.message); }
  }));

  // Комплекс: упражнения из списка, у каждого свои подходы и цель.
  const list = el.querySelector('#ex-list');
  const draw = () => {
    list.innerHTML = String(html`${rows.map((x, i) => html`<div class="ex-edit" data-i="${i}">
      <div class="field">
        <label class="label" for="ex-id-${i}">Упражнение</label>
        <select class="input" id="ex-id-${i}" data-k="id">
          ${catalog.map((e) => html`<option value="${e.id}" ${e.id === x.id ? html`selected` : ''}
            ${e.id !== x.id && rows.some((r) => r.id === e.id) ? html`disabled` : ''}>${e.name}</option>`)}
        </select>
      </div>
      <div class="grid-2">
        <div class="field"><label class="label" for="ex-sets-${i}">Подходов</label>
          <input class="input" id="ex-sets-${i}" data-k="sets" type="number" inputmode="numeric" min="1" max="10" value="${x.sets}"></div>
        <div class="field"><label class="label" for="ex-goal-${i}">Цель, повторов</label>
          <input class="input" id="ex-goal-${i}" data-k="target_reps" type="number" inputmode="numeric" min="1" max="1000" placeholder="без цели" value="${x.target_reps ?? ''}"></div>
      </div>
      <div class="row">
        <div class="row-gap">
          <button type="button" class="ghost icon" data-move="-1" aria-label="Выше" ${i === 0 ? html`disabled` : ''}>↑</button>
          <button type="button" class="ghost icon" data-move="1" aria-label="Ниже" ${i === rows.length - 1 ? html`disabled` : ''}>↓</button>
        </div>
        <button type="button" class="ghost" data-remove>Убрать</button>
      </div>
    </div>`)}`);
  };
  draw();

  list.addEventListener('change', (e) => {
    const i = Number(e.target.closest('.ex-edit')?.dataset.i);
    if (e.target.dataset.k !== 'id') return;
    const ex = catalog.find((c) => c.id === Number(e.target.value));
    rows[i] = { id: ex.id, sets: ex.sets, target_reps: ex.target_reps };
    draw();
  });
  list.addEventListener('input', (e) => {
    const i = Number(e.target.closest('.ex-edit')?.dataset.i);
    const k = e.target.dataset.k;
    if (!k || k === 'id') return;
    rows[i][k] = e.target.value === '' ? null : Number(e.target.value);
  });
  list.addEventListener('click', (e) => {
    const card = e.target.closest('.ex-edit');
    if (!card) return;
    const i = Number(card.dataset.i);
    const move = e.target.closest('[data-move]');
    if (move) {
      const j = i + Number(move.dataset.move);
      [rows[i], rows[j]] = [rows[j], rows[i]];
      draw();
    }
    if (e.target.closest('[data-remove]')) {
      rows.splice(i, 1);
      draw();
    }
  });
  el.querySelector('#ex-add')?.addEventListener('click', () => {
    const ex = catalog.find((c) => !rows.some((r) => r.id === c.id));
    if (!ex) { ctx.toast('Все упражнения из списка уже в комплексе'); return; }
    rows.push({ id: ex.id, sets: ex.sets, target_reps: ex.target_reps });
    draw();
  });
  el.querySelector('#ex-save').addEventListener('click', async () => {
    const error = el.querySelector('#ex-error');
    const bad = rows.find((x) => !Number.isInteger(x.sets) || x.sets < 1 || x.sets > 10
      || (x.target_reps !== null && (!Number.isInteger(x.target_reps) || x.target_reps < 1)));
    if (bad) {
      error.textContent = 'У каждого упражнения от 1 до 10 подходов; цель — целое число или пусто';
      return;
    }
    error.textContent = '';
    try {
      for (const [i, x] of rows.entries()) {
        const ex = catalog.find((c) => c.id === x.id);
        await api.saveExercise({ ...ex, sets: x.sets, target_reps: x.target_reps, position: i, active: true });
      }
      for (const ex of catalog.filter((c) => c.active && !rows.some((r) => r.id === c.id))) {
        await api.saveExercise({ ...ex, active: false });
      }
      ctx.toast('Комплекс сохранён');
      ctx.refresh();
    } catch (err) { error.textContent = err.message; }
  });

  // Один день
  el.querySelector('#one-apply')?.addEventListener('click', async () => {
    const date = el.querySelector('#one-day').value;
    const status = el.querySelector('#one-status').value;
    const error = el.querySelector('#one-error');
    if (!date) { error.textContent = 'Выбери день'; return; }
    error.textContent = '';
    try {
      await api.setDayStatus(ctx.athleteId, date, status);
      el.querySelector('#one-saved').textContent = `${dayTitle(date)}: ${DAY_STATUS[status].toLowerCase()}. Друг увидит это в календаре.`;
    } catch (err) { error.textContent = err.message; }
  });

  // План на конкретный день
  const dpDate = el.querySelector('#dp-date');
  if (dpDate) {
    const loadDay = async () => {
      const date = dpDate.value;
      const body = el.querySelector('#dp-body');
      if (!date || date < clock.today) { body.innerHTML = String(html`<p class="error">Выбери сегодня или день позже</p>`); return; }
      const [row] = await api.days(ctx.athleteId, date, date);
      dayEditor(body, ctx, date, row ?? null, await api.exercises());
    };
    dpDate.addEventListener('change', loadDay);
    loadDay();
  }

  // Очистка
  el.querySelector('#reset')?.addEventListener('click', async () => {
    const err = el.querySelector('#reset-error');
    const what = [...el.querySelectorAll('[data-clear]:checked')].map((c) => c.dataset.clear);
    const from = el.querySelector('#clear-from').value;
    const to = el.querySelector('#clear-to').value;
    if (!what.length) { err.textContent = 'Отметь, что стереть'; return; }
    if (from && to && from > to) { err.textContent = 'Дата «с» позже даты «по»'; return; }
    if (el.querySelector('#reset-confirm').value.trim() !== athleteName) { err.textContent = 'Имя не совпадает'; return; }
    err.textContent = '';
    try {
      const res = await api.clearAthlete(ctx.athleteId, what, from, to);
      const n = Object.values(res ?? {}).reduce((a, b) => a + b, 0);
      ctx.toast(`Стёрто записей: ${n}`);
      ctx.refresh();
    } catch (e) { err.textContent = e.message; }
  });

  el.querySelector('#sign-out').addEventListener('click', ctx.signOut);
}

// Редактор одного дня: галочка — упражнение в плане дня, свои подходы и цель, задание текстом.
function dayEditor(old, ctx, date, row, exercises) {
  // Новый узел — чтобы обработчики прошлого дня не копились.
  const body = old.cloneNode(false);
  old.replaceWith(body);
  const general = exercises.filter((e) => e.active).sort((a, b) => a.position - b.position || a.id - b.id)
    .map(({ id, name, sets, target_reps }) => ({ id, name, sets, target_reps }));
  const key = (p) => JSON.stringify(p.map((x) => [x.id, x.sets, x.target_reps ?? null]));
  const custom = Boolean(row?.plan) && key(row.plan) !== key(general);
  const base = row?.plan ?? general;
  const items = exercises.filter((e) => !e.archived || base.some((b) => b.id === e.id)).map((e) => {
    const inPlan = base.find((b) => b.id === e.id);
    return { id: e.id, name: e.name, on: Boolean(inPlan), sets: inPlan?.sets ?? e.sets, target_reps: inPlan ? inPlan.target_reps : e.target_reps };
  });

  const draw = () => {
    body.innerHTML = String(html`
      ${row && row.status !== 'training' ? html`<p class="notice">Сейчас этот день: ${DAY_STATUS[row.status]?.toLowerCase() ?? 'не задан'}.
        Сохранишь план — станет тренировкой.</p>` : ''}
      <p class="label">${custom ? 'У этого дня свой план.' : 'Сейчас: общий комплекс. Поменяй, что нужно, и сохрани.'}</p>
      ${items.map((x, i) => html`<div class="ex-edit dp-item" data-i="${i}">
        <label class="check"><input type="checkbox" data-k="on" ${x.on ? html`checked` : ''}><span class="em">${x.name}</span></label>
        <div class="grid-2">
          <div class="field"><label class="label" for="dp-sets-${i}">Подходов</label>
            <input class="input" id="dp-sets-${i}" data-k="sets" type="number" inputmode="numeric" min="1" max="10" value="${x.sets}"></div>
          <div class="field"><label class="label" for="dp-goal-${i}">Цель, повторов</label>
            <input class="input" id="dp-goal-${i}" data-k="target_reps" type="number" inputmode="numeric" min="1" max="1000" placeholder="без цели" value="${x.target_reps ?? ''}"></div>
        </div>
      </div>`)}
      <p class="label">Нужного упражнения нет — добавь его во вкладке «Правила».</p>
      <label class="label" for="dp-note">Задание дня (друг увидит на экране «Сегодня»)</label>
      <textarea id="dp-note" class="input textarea" rows="2" maxlength="500" placeholder="Например: подтягивания широким хватом">${row?.note ?? ''}</textarea>
      <p class="error" id="dp-error" role="alert"></p>
      <button type="button" class="btn" id="dp-save">Сохранить план на ${dayTitle(date)}</button>
      ${custom || row?.note ? html`<button type="button" class="ghost" id="dp-reset">Вернуть общий комплекс</button>` : ''}`);
  };
  draw();

  body.addEventListener('input', (e) => {
    const i = Number(e.target.closest('.dp-item')?.dataset.i);
    const k = e.target.dataset.k;
    if (Number.isNaN(i) || !k) return;
    items[i][k] = k === 'on' ? e.target.checked : e.target.value === '' ? null : Number(e.target.value);
  });
  body.addEventListener('change', (e) => {
    if (e.target.dataset.k === 'on') items[Number(e.target.closest('.dp-item').dataset.i)].on = e.target.checked;
  });
  body.addEventListener('click', async (e) => {
    const err = body.querySelector('#dp-error');
    if (e.target.id === 'dp-save') {
      const plan = items.filter((x) => x.on).map(({ id, sets, target_reps }) => ({ id, sets, target_reps }));
      if (!plan.length) { err.textContent = 'Отметь хотя бы одно упражнение'; return; }
      if (plan.some((x) => !Number.isInteger(x.sets) || x.sets < 1 || x.sets > 10
        || (x.target_reps !== null && (!Number.isInteger(x.target_reps) || x.target_reps < 1)))) {
        err.textContent = 'Подходов — от 1 до 10, цель — целое число или пусто';
        return;
      }
      try {
        await ctx.api.setDayPlan(ctx.athleteId, date, plan, body.querySelector('#dp-note').value);
        ctx.toast(`План на ${dayTitle(date)} сохранён`);
        const [fresh] = await ctx.api.days(ctx.athleteId, date, date);
        dayEditor(body, ctx, date, fresh ?? null, await ctx.api.exercises());
      } catch (x) { err.textContent = x.message; }
    }
    if (e.target.id === 'dp-reset') {
      try {
        await ctx.api.setDayPlan(ctx.athleteId, date, null, null);
        ctx.toast(`${dayTitle(date)}: общий комплекс`);
        const [fresh] = await ctx.api.days(ctx.athleteId, date, date);
        dayEditor(body, ctx, date, fresh ?? null, await ctx.api.exercises());
      } catch (x) { err.textContent = x.message; }
    }
  });
}
