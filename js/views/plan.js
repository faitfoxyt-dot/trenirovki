// «План» (админ): старт, шаблон недели, комплексы по кругу, план на день, очистка.

import { html, WEEKDAYS, WD_SHORT, dayTitle, addDays, isoDow, shortDate } from '../util.js';
import { DAY_STATUS, unitOf, unitText, cxLetter, CX_LETTERS } from '../logic.js';
import { GAMES, multOf } from './star.js';

const TEMPLATE_OPTIONS = [
  { value: '', label: 'Не задано' },
  { value: 'training', label: 'Тренировка' },
  { value: 'rest', label: 'Выходной' },
  { value: 'busy', label: 'Занят' },
];
const DAY_OPTIONS = ['training', 'rest', 'sick', 'busy'];
const dayShort = (d) => `${WD_SHORT[isoDow(d) - 1]} ${shortDate(d)}`;
const CLEAR = [
  { k: 'sets', label: 'Подходы (и их теоретические очки)' },
  { k: 'points', label: 'Записи очков' },
  { k: 'purchases', label: 'Покупки (выходные и «Всё или ничего»)' },
  { k: 'sick', label: 'Запросы больничного' },
  { k: 'ideas', label: 'Идеи' },
  { k: 'mornings', label: 'Утро' },
  { k: 'days', label: 'Планы, задания и статусы дней' },
];

export async function render(el, ctx, args, alive) {
  const { api, clock, settings, me } = ctx;
  const [template, exercises, complexes, schedule, video] = await Promise.all([
    api.weekTemplate(), api.exercises(), api.complexes(),
    ctx.athleteId ? api.complexSchedule(ctx.athleteId, clock.today, addDays(clock.today, 27)) : [],
    api.videoSettings ? api.videoSettings() : null,
  ]);
  if (!alive()) return;

  // Список упражнений ведётся в «Правилах»; здесь из него собираются комплексы А, Б, В…
  const catalog = exercises.filter((e) => !e.archived);
  const cx = complexes.map((c) => c.items.filter((x) => catalog.some((e) => e.id === x.id))
    .map(({ id, sets, target_reps, alt }) => ({ id, sets, target_reps: target_reps ?? null,
      alt: alt && catalog.some((e) => e.id === alt.id) ? { id: alt.id, sets: alt.sets ?? sets, target_reps: alt.target_reps ?? null } : null })));
  let choice = Boolean(settings.choice); // «Выбор»: места с двумя вариантами работают, только когда он включён
  if (!cx.length) cx.push([]);
  let cur = 0; // какой комплекс сейчас открыт
  // Какой комплекс сегодня (или на ближайшей тренировке, если сегодня не тренировка).
  let next = Math.min(schedule[0]?.complex ?? 0, cx.length - 1);
  const todayTraining = schedule[0]?.status === 'training';
  const athleteName = ctx.athletes.find((a) => a.id === ctx.athleteId)?.name || 'без имени';

  el.innerHTML = String(html`
    <header class="stack-8">
      <p class="sub">Что друг делает каждый день</p>
      <h1 class="h1">План</h1>
    </header>

    ${ctx.athleteId && api.setEvent ? html`<section class="card event-set" id="ev-card"></section>` : ''}

    ${video ? videoCard(video) : ''}

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
      <h2 class="h2">Комплексы</h2>
      <p class="label">Комплексы идут по кругу по тренировочным дням: А, Б, В, снова А… В каждом месте — одно упражнение
        или выбор из двух: друг сам берёт одно на «Сегодня». Новые упражнения и цены — во вкладке «Правила».</p>
      <div class="seg" id="cx-tabs" role="group" aria-label="Комплексы"></div>
      <div id="ex-list"></div>
      ${catalog.length ? html`<button type="button" class="ghost" id="ex-add">+ Место</button>`
        : html`<p class="label">Список упражнений пуст. Добавь их во вкладке «Правила».</p>`}
      <button type="button" class="text-btn bad" id="cx-del" hidden></button>
      <div id="cx-rot" class="stack-8"></div>
      <p class="error" id="ex-error" role="alert"></p>
      <button type="button" class="btn" id="ex-save">Сохранить комплексы</button>
      <p class="label">Изменения попадут в дни, которые друг ещё не начал.</p>
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
      <p class="label">Свой набор упражнений и задание на один день — сегодня или позже. Остальные дни идут по очереди комплексов.</p>
      <label class="label" for="dp-date">День</label>
      <input class="input" id="dp-date" type="date" min="${clock.today}" value="${addDays(clock.today, 1)}">
      <div id="dp-body"></div>
    </section>

    <section class="card">
      <h2 class="h2">Очистить данные атлета</h2>
      <p class="label">Сотри только нужное: выбери, что и за какие дни. Пустые даты — за всё время.
        Аккаунт, список упражнений, комплексы и правила не трогаются. Вернуть нельзя.</p>
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

  const evEl = el.querySelector('#ev-card');
  if (evEl) renderEvent(evEl, ctx, clock.today, alive);

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

  // Комплексы: вкладки А, Б, В…; в каждом упражнения из списка со своими подходами и целью.
  const list = el.querySelector('#ex-list');
  const tabs = el.querySelector('#cx-tabs');
  const rot = el.querySelector('#cx-rot');
  const delBtn = el.querySelector('#cx-del');
  const trainingDays = schedule.filter((d) => d.status === 'training').map((d) => d.date);
  const used = (rows) => rows.flatMap((r) => (r.alt ? [r.id, r.alt.id] : [r.id]));
  // Слот места: упражнение, подходы, цель. alt — второй вариант (друг выбирает один из двух).
  const slot = (o, i, rows, alt) => {
    const p = alt ? 'alt_' : '';
    const unit = unitText(unitOf(o, catalog)).many;
    return html`<div class="slot">
      <select class="input" id="ex-${p}id-${i}" data-k="${alt ? 'alt' : 'id'}" aria-label="${alt ? 'Второй вариант' : 'Упражнение'}">
        ${catalog.map((e) => html`<option value="${e.id}" ${e.id === o.id ? html`selected` : ''}
          ${e.id !== o.id && used(rows).includes(e.id) ? html`disabled` : ''}>${e.name}${e.unit === 'sec' ? ' · на время' : ''}</option>`)}
      </select>
      <div class="grid-2">
        <div class="field"><label class="label" for="ex-${p}sets-${i}">Подходов</label>
          <input class="input" id="ex-${p}sets-${i}" data-k="${p}sets" type="number" inputmode="numeric" min="1" max="10" value="${o.sets ?? ''}"></div>
        <div class="field"><label class="label" for="ex-${p}goal-${i}">Цель, ${unit}</label>
          <input class="input" id="ex-${p}goal-${i}" data-k="${p}target_reps" type="number" inputmode="numeric" min="1" max="1000" placeholder="без цели" value="${o.target_reps ?? ''}"></div>
      </div>
    </div>`;
  };
  const draw = () => {
    const rows = cx[cur];
    el.querySelector('#ex-error').textContent = '';
    tabs.innerHTML = String(html`${cx.map((_, i) => html`<button type="button" class="pill ${i === cur ? 'pill-on' : ''}"
        data-cx="${i}" aria-pressed="${i === cur}">${cxLetter(i)}</button>`)}
      ${cx.length < CX_LETTERS.length ? html`<button type="button" class="pill" id="cx-add" aria-label="Добавить комплекс">${cx.length === 1 ? '+ Комплекс' : '+'}</button>` : ''}`);
    list.innerHTML = String(html`${rows.length ? '' : html`<p class="label">В комплексе ${cxLetter(cur)} пока пусто — нажми «+ Место».</p>`}
    ${rows.map((x, i) => html`<div class="place ${x.alt ? 'place-two' : ''}" data-i="${i}">
      <div class="place-head">
        <span class="place-no">${i + 1}</span>
        <div class="seg place-kind" role="group" aria-label="Что в месте ${i + 1}">
          <button type="button" class="pill ${x.alt ? '' : 'pill-on'}" data-kind="one" aria-pressed="${!x.alt}">Одно</button>
          <button type="button" class="pill ${x.alt ? 'pill-on' : ''}" data-kind="two" aria-pressed="${Boolean(x.alt)}">Выбор из двух</button>
        </div>
      </div>
      ${slot(x, i, rows, false)}
      ${x.alt ? html`<p class="alt-or">или</p>${slot({ ...x.alt, sets: x.alt.sets ?? x.sets }, i, rows, true)}` : ''}
      <div class="row">
        <div class="row-gap">
          <button type="button" class="ghost icon" data-move="-1" aria-label="Выше" ${i === 0 ? html`disabled` : ''}>↑</button>
          <button type="button" class="ghost icon" data-move="1" aria-label="Ниже" ${i === rows.length - 1 ? html`disabled` : ''}>↓</button>
        </div>
        <button type="button" class="text-btn bad" data-remove>Убрать место</button>
      </div>
    </div>`)}`);
    delBtn.hidden = cx.length < 2;
    delBtn.textContent = `Удалить комплекс ${cxLetter(cur)}`;
    // Очередь: какой комплекс сегодня и что дальше (как будет после сохранения).
    rot.innerHTML = cx.length < 2 || !ctx.athleteId ? '' : String(html`
      <label class="label" for="cx-next">${todayTraining ? 'Сегодня — комплекс' : 'Ближайшая тренировка — комплекс'}</label>
      <select class="input" id="cx-next">${cx.map((_, i) => html`<option value="${i}" ${i === next ? html`selected` : ''}>${cxLetter(i)}</option>`)}</select>
      <p class="label">Дальше по тренировкам:</p>
      <div class="chips">${trainingDays.slice(0, 8).map((d, k) => html`<span class="chip ${(next + k) % cx.length === cur ? 'chip-on' : ''}">${dayShort(d)} · ${cxLetter((next + k) % cx.length)}</span>`)}</div>`);
  };
  draw();

  el.querySelector('#video-auto')?.addEventListener('change', async (e) => {
    try {
      await api.setVideoAuto(e.target.checked);
      ctx.toast(e.target.checked ? 'Подтверждение по видео включено' : 'Подтверждение по видео выключено');
    } catch (err) { e.target.checked = !e.target.checked; ctx.toast(err.message); }
  });

  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cx]');
    if (b) { cur = Number(b.dataset.cx); draw(); return; }
    if (e.target.closest('#cx-add')) { cx.push([]); cur = cx.length - 1; draw(); }
  });
  delBtn.addEventListener('click', () => {
    if (cx.length < 2) return;
    if (cx[cur].length && !confirm(`Удалить комплекс ${cxLetter(cur)}? Удалится после «Сохранить комплексы».`)) return;
    cx.splice(cur, 1);
    next = Math.min(next > cur ? next - 1 : next, cx.length - 1);
    cur = Math.min(cur, cx.length - 1);
    draw();
  });
  rot.addEventListener('change', (e) => {
    if (e.target.id === 'cx-next') { next = Number(e.target.value); draw(); }
  });
  list.addEventListener('change', (e) => {
    const i = Number(e.target.closest('.place')?.dataset.i);
    if (e.target.dataset.k === 'alt') {
      const ex = catalog.find((c) => c.id === Number(e.target.value));
      cx[cur][i].alt = { id: ex.id, sets: cx[cur][i].alt?.sets ?? cx[cur][i].sets, target_reps: ex.target_reps };
      draw();
      return;
    }
    if (e.target.dataset.k !== 'id') return;
    const ex = catalog.find((c) => c.id === Number(e.target.value));
    cx[cur][i] = { id: ex.id, sets: cx[cur][i].sets, target_reps: ex.target_reps, alt: cx[cur][i].alt };
    draw();
  });
  list.addEventListener('input', (e) => {
    const i = Number(e.target.closest('.place')?.dataset.i);
    const k = e.target.dataset.k;
    if (!k || k === 'id' || k === 'alt') return;
    const v = e.target.value === '' ? null : Number(e.target.value);
    if (k.startsWith('alt_')) cx[cur][i].alt[k.slice(4)] = v;
    else cx[cur][i][k] = v;
  });
  list.addEventListener('click', (e) => {
    const card = e.target.closest('.place');
    if (!card) return;
    const rows = cx[cur];
    const i = Number(card.dataset.i);
    const kind = e.target.closest('[data-kind]');
    if (kind) {
      const two = kind.dataset.kind === 'two';
      if (two === Boolean(rows[i].alt)) return;
      if (two) {
        const ex = catalog.find((c) => !used(rows).includes(c.id));
        if (!ex) { ctx.toast(`Все упражнения из списка уже в комплексе ${cxLetter(cur)}`); return; }
        rows[i].alt = { id: ex.id, sets: rows[i].sets, target_reps: ex.target_reps };
      } else rows[i].alt = null;
      draw();
      return;
    }
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
    const rows = cx[cur];
    const ex = catalog.find((c) => !used(rows).includes(c.id));
    if (!ex) { ctx.toast(`Все упражнения из списка уже в комплексе ${cxLetter(cur)}`); return; }
    rows.push({ id: ex.id, sets: rows[0]?.sets ?? ex.sets, target_reps: ex.target_reps, alt: null });
    draw();
  });
  el.querySelector('#ex-save').addEventListener('click', async () => {
    const error = el.querySelector('#ex-error');
    const badAt = cx.findIndex((rows) => rows.some((x) => !Number.isInteger(x.sets) || x.sets < 1 || x.sets > 10
      || (x.target_reps !== null && (!Number.isInteger(x.target_reps) || x.target_reps < 1))
      || (x.alt && x.alt.target_reps !== null && (!Number.isInteger(x.alt.target_reps) || x.alt.target_reps < 1))
      || (x.alt && (!Number.isInteger(x.alt.sets ?? x.sets) || (x.alt.sets ?? x.sets) < 1 || (x.alt.sets ?? x.sets) > 10))));
    if (badAt >= 0) {
      cur = badAt; draw();
      error.textContent = `Комплекс ${cxLetter(badAt)}: у каждого упражнения от 1 до 10 подходов; цель — целое число или пусто`;
      return;
    }
    const emptyAt = cx.length > 1 ? cx.findIndex((rows) => !rows.length) : -1;
    if (emptyAt >= 0) {
      cur = emptyAt; draw();
      error.textContent = `В комплексе ${cxLetter(emptyAt)} нет упражнений: добавь их или удали комплекс`;
      return;
    }
    error.textContent = '';
    try {
      await api.saveComplexes(cx, next);
      // Место с выбором из двух работает, только когда «Выбор» включён.
      if (!choice && cx.some((rows) => rows.some((x) => x.alt))) { await api.setChoice(true); choice = settings.choice = true; }
      ctx.toast(cx.length > 1 ? 'Комплексы сохранены' : 'Комплекс сохранён');
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
      dayEditor(body, ctx, date, ...await dayData(api, ctx.athleteId, date));
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

// Всё для редактора дня: строка дня, список упражнений и комплекс, который день получает по очереди.
async function dayData(api, athleteId, date) {
  const [[row], exercises, complexes, [sch]] = await Promise.all([
    api.days(athleteId, date, date), api.exercises(), api.complexes(), api.complexSchedule(athleteId, date, date),
  ]);
  const idx = sch?.complex ?? null;
  const general = (complexes[idx ?? 0]?.items ?? []).map((x) => {
    const e = exercises.find((y) => y.id === x.id && !y.archived);
    return e && { id: e.id, name: e.name, sets: x.sets, target_reps: x.target_reps ?? null };
  }).filter(Boolean);
  return [row ?? null, exercises, general, complexes.length > 1 && idx !== null ? cxLetter(idx) : null];
}

// Редактор одного дня: галочка — упражнение в плане дня, свои подходы и цель, задание текстом.
function dayEditor(old, ctx, date, row, exercises, general, letter) {
  // Новый узел — чтобы обработчики прошлого дня не копились.
  const body = old.cloneNode(false);
  old.replaceWith(body);
  const generalName = letter ? `комплекс ${letter} (по очереди)` : 'общий комплекс';
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
      <p class="label">${custom ? 'У этого дня свой план.' : `Сейчас: ${generalName}. Поменяй, что нужно, и сохрани.`}</p>
      ${items.map((x, i) => html`<div class="ex-edit dp-item" data-i="${i}">
        <label class="check"><input type="checkbox" data-k="on" ${x.on ? html`checked` : ''}><span class="em">${x.name}${unitOf(x, exercises) === 'sec' ? ' · на время' : ''}</span></label>
        <div class="grid-2">
          <div class="field"><label class="label" for="dp-sets-${i}">Подходов</label>
            <input class="input" id="dp-sets-${i}" data-k="sets" type="number" inputmode="numeric" min="1" max="10" value="${x.sets}"></div>
          <div class="field"><label class="label" for="dp-goal-${i}">Цель, ${unitText(unitOf(x, exercises)).many}</label>
            <input class="input" id="dp-goal-${i}" data-k="target_reps" type="number" inputmode="numeric" min="1" max="1000" placeholder="без цели" value="${x.target_reps ?? ''}"></div>
        </div>
      </div>`)}
      <p class="label">Нужного упражнения нет — добавь его во вкладке «Правила».</p>
      <label class="label" for="dp-note">Задание дня (друг увидит на экране «Сегодня»)</label>
      <textarea id="dp-note" class="input textarea" rows="2" maxlength="500" placeholder="Например: подтягивания широким хватом">${row?.note ?? ''}</textarea>
      <p class="error" id="dp-error" role="alert"></p>
      <button type="button" class="btn" id="dp-save">Сохранить план на ${dayTitle(date)}</button>
      ${custom || row?.note ? html`<button type="button" class="ghost" id="dp-reset">Вернуть ${generalName}</button>` : ''}`);
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
        dayEditor(body, ctx, date, ...await dayData(ctx.api, ctx.athleteId, date));
      } catch (x) { err.textContent = x.message; }
    }
    if (e.target.id === 'dp-reset') {
      try {
        await ctx.api.setDayPlan(ctx.athleteId, date, null, null);
        ctx.toast(`${dayTitle(date)}: ${generalName}`);
        dayEditor(body, ctx, date, ...await dayData(ctx.api, ctx.athleteId, date));
      } catch (x) { err.textContent = x.message; }
    }
  });
}

// Событие дня: звезда на ниточке у друга и мини-игра «Идеальный повтор». Ставится на сегодня или завтра.
const WD_GEN = ['понедельника', 'вторника', 'среды', 'четверга', 'пятницы', 'субботы', 'воскресенья'];

async function renderEvent(el, ctx, today, alive, date = today) {
  const { api } = ctx;
  const ev = await api.eventDay(date, ctx.athleteId);
  if (!alive()) return;
  const when = (d, label) => html`<button type="button" class="pill ${d === date ? 'pill-on' : ''}" data-ev-date="${d}">${label}</button>`;
  const g = ev && GAMES[ev.game];
  el.innerHTML = String(html`
    <h2 class="h2">⭐ Событие дня</h2>
    <p class="label">У друга на всех экранах повиснет звезда на ниточке. Нажмёт — мини-игра из 5 ходов:
      каждый верный ход даёт +0.1x к очкам дня, 5 из 5 — ×1.5. Попытка одна.
      Бонус ложится поверх серии и «Всё или ничего», начислится, когда день закончится и ты всё проверишь.</p>
    <div class="seg" role="group" aria-label="День события">${when(today, 'Сегодня')}${when(addDays(today, 1), 'Завтра')}</div>
    ${ev ? html`<div class="ev-state">
        <p class="em">${ev.title}</p>
        <p class="label">Игра: ${g ? `${g.icon} ${g.name}` : ev.game}</p>
        ${ev.score === null
          ? html`<p class="label">${date === today ? 'Ждёт, пока друг сыграет.' : `Звезда появится у друга ${dayTitle(date)}.`}</p>
            <button type="button" class="ghost ghost-bad" id="ev-off">Убрать событие</button>`
          : html`<p class="ok">Друг ${ev.done ? 'сыграл' : 'играет'}: ${ev.score} из 5 → очки дня ×${multOf(ev.score).toFixed(1)}</p>
            ${ev.bonus ? html`<p class="label">Бонус начислен: +${ev.bonus}</p>`
              : html`<p class="label">${ev.score ? 'Бонус начислится, когда день закончится и ты всё проверишь.' : 'Бонуса не будет.'}</p>`}`}
      </div>`
    : html`<p class="label">Игра: ${GAMES.a.icon} «${GAMES.a.name}» — бегунок ползает по линейке, жать, когда он в зелёной зоне.</p>
      <label class="label" for="ev-title">Название (друг увидит его над игрой)</label>
      <input class="input" id="ev-title" type="text" maxlength="40" value="Событие ${WD_GEN[isoDow(date) - 1]}">
      <button type="button" class="btn" id="ev-on">Запустить событие</button>`}
    <p class="error" id="ev-error" role="alert"></p>`);

  const err = el.querySelector('#ev-error');
  const run = async (fn) => {
    err.textContent = '';
    try { await fn(); renderEvent(el, ctx, today, alive, date); } catch (e) { err.textContent = e.message; }
  };
  el.querySelectorAll('[data-ev-date]').forEach((b) => b.addEventListener('click', () => renderEvent(el, ctx, today, alive, b.dataset.evDate)));
  el.querySelector('#ev-on')?.addEventListener('click', () => run(async () => {
    await api.setEvent(ctx.athleteId, date, 'a', el.querySelector('#ev-title').value);
    ctx.toast(date === today ? 'Событие запущено ⭐' : 'Событие поставлено на завтра ⭐');
  }));
  el.querySelector('#ev-off')?.addEventListener('click', () => run(() => api.setEvent(ctx.athleteId, date, null)));
}

// Видео из Telegram: подход с видео, где в подписи его номер (#5), бот подтверждает сам.
function videoCard(v) {
  return html`<section class="card video-set">
    <h2 class="h2">📹 Подтверждение по видео</h2>
    <label class="row switch-row"><span>Бот сам засчитывает подход с видео</span>
      <input type="checkbox" class="switch" id="video-auto" ${v.on ? html`checked` : ''}></label>
    <div class="vid-format">
      <p class="label">Подпись к видео</p>
      <p class="vid-format-big">#5 <span class="label">или</span> #5 Приседания</p>
      <p class="label">Номер подхода за день — друг видит его слева у каждого подхода. Бот смотрит только на номер,
        название можно не писать. Видео до 03:00 идут во вчерашний день.</p>
    </div>
    ${v.bot_sees ? html`<p class="ok">✅ Бот видит видео в группе</p>` : html`<div class="warn-box vid-steps">
      <p class="warn-strong">⚠️ Бот пока не видит видео в группе</p>
      <p>Один раз, с телефона:</p>
      <ol>
        <li>Открой группу → нажми на её название → <b>Изменить</b> (карандаш).</li>
        <li><b>Администраторы</b> → <b>Добавить администратора</b> → выбери бота.</li>
        <li>Права можно все выключить → <b>Сохранить</b>.</li>
      </ol>
      <p class="label">Как только бот увидит первое видео, здесь будет ✅.</p>
    </div>`}
  </section>`;
}
