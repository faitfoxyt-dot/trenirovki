// «План» (админ): старт калибровки, шаблон недели, комплекс и правка одного дня.

import { html, WEEKDAYS, dayTitle } from '../util.js';
import { DAY_STATUS } from '../logic.js';

const TEMPLATE_OPTIONS = [
  { value: '', label: 'Не задано' },
  { value: 'training', label: 'Тренировка' },
  { value: 'rest', label: 'Выходной' },
  { value: 'busy', label: 'Занят' },
];
const DAY_OPTIONS = ['training', 'rest', 'sick', 'busy'];

export async function render(el, ctx, args, alive) {
  const { api, clock, settings, me } = ctx;
  const [template, exercises] = await Promise.all([api.weekTemplate(), api.exercises()]);
  if (!alive()) return;

  const rows = exercises.filter((e) => e.active).map((e) => ({ ...e }));
  const hidden = exercises.filter((e) => !e.active);

  el.innerHTML = String(html`
    <header class="stack-8">
      <p class="sub">Что друг делает каждый день</p>
      <h1 class="h1">План</h1>
    </header>

    <section class="card">
      <h2 class="h2">Калибровка</h2>
      <p class="label">Первая неделя без очков: друг просто пишет, сколько сделал. По этим числам ты потом ставишь цели.</p>
      <label class="label" for="start-date">Старт калибровки</label>
      <input class="input" id="start-date" type="date" value="${settings.start_date ?? ''}">
      <p class="label ok" id="settings-saved" aria-live="polite"></p>
      <p class="label">Выключить калибровку и задать очки — во вкладке «Правила».</p>
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
      <p class="label">Один комплекс на все тренировочные дни. Пустая цель — калибровка: друг просто пишет, сколько сделал.
        Изменения попадут в дни, которые друг ещё не открывал.</p>
      <div id="ex-list"></div>
      <button type="button" class="ghost" id="ex-add">+ Упражнение</button>
      <p class="error" id="ex-error" role="alert"></p>
      <button type="button" class="btn" id="ex-save">Сохранить комплекс</button>
      ${hidden.length ? html`<details class="hidden-ex"><summary class="label">Убранные упражнения: ${hidden.length}</summary>
        ${hidden.map((e) => html`<div class="row"><span>${e.name}</span>
          <button type="button" class="ghost" data-restore="${e.id}">Вернуть</button></div>`)}
      </details>` : ''}
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

    <section class="card">
      <div class="row"><p class="label">Вошёл как ${me.name || 'админ'}</p>
      <button type="button" class="ghost" id="sign-out">Выйти</button></div>
    </section>
  `);

  // Калибровка
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

  // Комплекс
  const list = el.querySelector('#ex-list');
  const draw = () => {
    list.innerHTML = String(html`${rows.map((x, i) => html`<div class="ex-edit" data-i="${i}">
      <div class="field">
        <label class="label" for="ex-name-${i}">Упражнение</label>
        <input class="input" id="ex-name-${i}" data-k="name" type="text" maxlength="60" placeholder="Название" value="${x.name}">
      </div>
      <div class="grid-2">
        <div class="field"><label class="label" for="ex-sets-${i}">Подходов</label>
          <input class="input" id="ex-sets-${i}" data-k="sets" type="number" inputmode="numeric" min="1" max="10" value="${x.sets}"></div>
        <div class="field"><label class="label" for="ex-goal-${i}">Цель, повторов</label>
          <input class="input" id="ex-goal-${i}" data-k="target_reps" type="number" inputmode="numeric" min="1" max="1000" placeholder="калибровка" value="${x.target_reps ?? ''}"></div>
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

  list.addEventListener('input', (e) => {
    const i = Number(e.target.closest('.ex-edit')?.dataset.i);
    const k = e.target.dataset.k;
    if (!k) return;
    rows[i][k] = k === 'name' ? e.target.value : e.target.value === '' ? null : Number(e.target.value);
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
      if (rows[i].id) hidden.push({ ...rows[i], active: false, removed: true });
      rows.splice(i, 1);
      draw();
    }
  });
  el.querySelector('#ex-add').addEventListener('click', () => {
    rows.push({ name: '', sets: 3, target_reps: null, active: true });
    draw();
    list.querySelector(`#ex-name-${rows.length - 1}`).focus();
  });
  el.querySelector('#ex-save').addEventListener('click', async () => {
    const error = el.querySelector('#ex-error');
    const bad = rows.find((x) => !x.name.trim() || !Number.isInteger(x.sets) || x.sets < 1 || x.sets > 10
      || (x.target_reps !== null && (!Number.isInteger(x.target_reps) || x.target_reps < 1)));
    if (bad) {
      error.textContent = 'У каждого упражнения нужно название и от 1 до 10 подходов; цель — целое число или пусто';
      return;
    }
    error.textContent = '';
    try {
      for (const [i, x] of rows.entries()) {
        await api.saveExercise({ ...x, name: x.name.trim(), position: i, active: true });
      }
      for (const x of hidden.filter((h) => h.removed)) {
        await api.saveExercise({ ...x, active: false });
      }
      ctx.toast('Комплекс сохранён');
      ctx.refresh();
    } catch (err) { error.textContent = err.message; }
  });
  el.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
    const ex = hidden.find((h) => h.id === Number(b.dataset.restore));
    try {
      await api.saveExercise({ ...ex, active: true, position: rows.length });
      ctx.refresh();
    } catch (err) { ctx.toast(err.message); }
  }));

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

  el.querySelector('#sign-out').addEventListener('click', ctx.signOut);
}
