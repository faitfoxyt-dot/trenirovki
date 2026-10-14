// «Правила»: тестовый период, список упражнений с очками, серия, штраф, цены.
// Админ меняет — действует сразу. Атлет видит только чтение, если Тимур включил показ.

import { html } from '../util.js';
import { POINTS, signed, amount, isSec } from '../logic.js';
import { howItWorks } from './goal.js';

// Числа у каждого упражнения свои.
// У упражнений на время те же поля, только за секунду.
const PER_EX = [
  { k: 'rep', label: 'За повтор', sec: 'За секунду', step: 0.1 },
  { k: 'set', label: 'За полный подход', step: 0.1 },
  { k: 'over', label: 'Сверх цели, за повтор', sec: 'Сверх цели, за секунду', step: 0.1 },
  { k: 'cap', label: 'Потолок в день', int: true },
];
const fieldLabel = (f, unit) => (isSec(unit) && f.sec ? f.sec : f.label);

// int — целое число в базе; иначе можно дробное (шаг step).
const GROUPS = [
  { title: 'Серия', note: 'Серия — тренировочные дни подряд, где сделан весь план. Выходные, купленные дни и больничный её не продлевают и не рвут. Множитель умножает все очки за подход и один на все подходы дня, когда бы ты их ни проверил.', fields: [
    { k: 'streak_from', label: 'Множитель растёт с дня', int: true, min: 1 },
    { k: 'streak_step', label: 'Шаг множителя', step: 0.05 },
    { k: 'streak_max', label: 'Потолок множителя', step: 0.1, min: 1 },
  ] },
  { title: 'Штраф', note: 'Пропуск — тренировочный день, где не сделан хоть один подход плана. Подход с 0 повторов или отклонённый не считается. Снимается процент от баланса, ниже нуля не падает. Примешь отклонённое позже — штраф за день вернётся.', fields: [
    { k: 'miss_penalty_pct', label: 'Штраф, % баланса', step: 1, max: 100 },
  ] },
  { title: 'Магазин', note: 'Пустой лимит — без ограничений.', fields: [
    { k: 'rest_day_price', label: 'Цена выходного', int: true, min: 1 },
    { k: 'purchase_limit_week', label: 'Лимит выходных в неделю', int: true },
  ] },
  { title: 'Цель', note: 'Вехи считаются сами: 25%, 50% и 75% от цены.', fields: [
    { k: 'phone_price', label: 'Цена телефона в очках', int: true, min: 1 },
  ] },
];
const FIELDS = GROUPS.flatMap((g) => g.fields);

export async function render(el, ctx, args, alive) {
  const { rules, api } = ctx;
  const isAdmin = ctx.me.role === 'admin';
  if (!isAdmin && !ctx.settings?.show_rules) {
    el.innerHTML = String(html`<header class="stack-8"><p class="sub">Точные цифры крутой генерал пока держит в секрете</p>
      <h1 class="h1">Правила</h1></header>
      <section class="card"><h2 class="h2">Как это работает</h2>
      ${howItWorks(ctx.rules?.current, { numbers: false })}</section>`);
    return;
  }
  // Список упражнений: всё, что не удалено. Новые строки получают id после сохранения.
  const exercises = (await api.exercises()).filter((e) => !e.archived).map((e) => ({ ...e }));
  if (!alive()) return;

  const next = rules?.current ?? {};
  const per = next.per_exercise ?? {};
  const ro = isAdmin ? '' : html`disabled`;
  const removed = [];
  let fresh = 0;

  el.innerHTML = String(html`
    <header class="stack-8">
      <p class="sub">${isAdmin ? 'Меняешь когда угодно — действует сразу' : 'Как считаются очки · меняет крутой генерал'}</p>
      <h1 class="h1">Правила</h1>
    </header>

    ${isAdmin ? html`<section class="card">
      <h2 class="h2">Режим</h2>
      <label class="row switch-row"><span>Тестовый период</span>
        <input type="checkbox" class="switch" id="calibration" ${next.calibration !== false ? html`checked` : ''}></label>
      <p class="label">Пока включён, очки не начисляются, а у друга написано «Тестовый период». Ты видишь теоретические очки:
        сколько он заработал бы по числам ниже. Переключается сразу.</p>
      <label class="row switch-row"><span>Показывать правила другу</span>
        <input type="checkbox" class="switch" id="show-rules" ${ctx.settings?.show_rules ? html`checked` : ''}></label>
      <p class="label">Друг увидит эту вкладку без права менять. Включается сразу.</p>
    </section>` : next.calibration !== false ? html`<p class="notice">Сейчас тестовый период: очки не начисляются.</p>` : ''}

    <section class="card">
      <h2 class="h2">Упражнения и очки</h2>
      <p class="label">Очки идут за подходы, которые проверил генерал. «Полный подход» — когда добил цель.
        «Сверх цели» — доплата за каждый лишний повтор (или секунду у упражнений на время), но за день по упражнению не больше потолка.
        ${isAdmin ? 'Отсюда упражнения попадают в «План».' : ''}</p>
      <div id="ex-rules"></div>
      ${isAdmin ? html`<button type="button" class="ghost" id="ex-new">+ Новое упражнение</button>` : ''}
    </section>

    ${GROUPS.map((g) => html`<section class="card">
      <h2 class="h2">${g.title}</h2>
      ${g.fields.map((f) => html`<label class="row rule-row" for="r-${f.k}"><span>${f.label}</span>
        <input class="input num-in" id="r-${f.k}" data-k="${f.k}" type="number" inputmode="decimal"
          min="${f.min ?? 0}" ${f.max ? html`max="${f.max}"` : ''} step="${f.int ? 1 : f.step}" placeholder="—" value="${next[f.k] ?? ''}" ${ro}></label>`)}
      ${g.note ? html`<p class="label">${g.note}</p>` : ''}
    </section>`)}

    <section class="card">
      <h2 class="h2">Пример</h2>
      <p class="label" id="example" aria-live="polite"></p>
    </section>

    ${isAdmin ? html`<p class="error" id="rules-error" role="alert"></p>
    <button type="button" class="btn" id="save">Сохранить правила</button>
    <p class="label ok center" id="saved" aria-live="polite"></p>` : ''}
  `);

  const num = (input, f) => {
    const raw = input.value.trim().replace(',', '.');
    if (raw === '') return { v: null, ok: true };
    const v = Number(raw);
    return { v, ok: Number.isFinite(v) && v >= (f.min ?? 0) && v <= (f.max ?? Infinity) && (!f.int || Number.isInteger(v)) };
  };

  // Строка упражнения: key — id или «new1» для ещё не сохранённого.
  const keyOf = (e) => e.id ?? e.tmp;
  const list = el.querySelector('#ex-rules');
  const draw = () => {
    list.innerHTML = String(html`${exercises.map((e) => html`<div class="ex-rules" data-key="${keyOf(e)}">
      ${isAdmin ? html`<div class="row-gap">
          <input class="input" data-name type="text" maxlength="60" placeholder="Название упражнения" value="${e.name}" aria-label="Название">
          <button type="button" class="ghost icon" data-del aria-label="Удалить ${e.name}">✕</button>
        </div>
        <div class="seg" role="group" aria-label="Как считать">
          <button type="button" class="pill ${isSec(e.unit) ? '' : 'pill-on'}" data-unit="reps" aria-pressed="${!isSec(e.unit)}">Повторы</button>
          <button type="button" class="pill ${isSec(e.unit) ? 'pill-on' : ''}" data-unit="sec" aria-pressed="${isSec(e.unit)}">На время</button>
        </div>`
        : html`<p class="em">${e.name}${isSec(e.unit) ? ' · на время' : ''}</p>`}
      ${e.active ? html`<p class="label">В общем комплексе${e.target_reps ? ` · цель ${amount(e.target_reps, e.unit)}` : ''}</p>` : ''}
      <div class="grid-2">${PER_EX.map((f) => html`<div class="field">
        <label class="label" for="p-${keyOf(e)}-${f.k}">${fieldLabel(f, e.unit)}</label>
        <input class="input num-in" id="p-${keyOf(e)}-${f.k}" data-pk="${f.k}" type="number" inputmode="decimal"
          min="0" step="${f.int ? 1 : f.step}" placeholder="—" value="${e.pts?.[f.k] ?? ''}" ${ro}></div>`)}
      </div>
    </div>`)}
    ${exercises.length ? '' : html`<p class="label">Упражнений пока нет.</p>`}`);
  };
  exercises.forEach((e) => { e.pts = { ...(per[e.id] ?? {}) }; e.orig = e.name; e.unit = e.unit ?? 'reps'; e.origUnit = e.unit; });
  draw();

  // Ввод сразу запоминаем в строке, чтобы перерисовка не теряла числа.
  list.addEventListener('input', (e) => {
    const ex = exercises.find((x) => String(keyOf(x)) === e.target.closest('[data-key]')?.dataset.key);
    if (!ex) return;
    if (e.target.matches('[data-name]')) ex.name = e.target.value;
    else if (e.target.dataset.pk) ex.pts[e.target.dataset.pk] = e.target.value;
  });
  list.addEventListener('click', (e) => {
    const unitBtn = e.target.closest('[data-unit]');
    if (unitBtn) {
      const ex = exercises.find((x) => String(keyOf(x)) === unitBtn.closest('[data-key]').dataset.key);
      ex.unit = unitBtn.dataset.unit;
      draw();
      example();
      return;
    }
    if (!e.target.closest('[data-del]')) return;
    const i = exercises.findIndex((x) => String(keyOf(x)) === e.target.closest('[data-key]').dataset.key);
    const ex = exercises[i];
    const warn = ex.active ? ' Оно уберётся и из общего комплекса.' : '';
    if (ex.id && !confirm(`Удалить «${ex.name}»?${warn} Старые подходы и очки останутся. Удалится после «Сохранить правила».`)) return;
    if (ex.id) removed.push(ex);
    exercises.splice(i, 1);
    draw();
    example();
  });
  el.querySelector('#ex-new')?.addEventListener('click', () => {
    fresh += 1;
    exercises.push({ tmp: `new${fresh}`, name: '', unit: 'reps', pts: {}, active: false });
    draw();
    list.querySelector(`[data-key="new${fresh}"] [data-name]`).focus();
  });

  const read = () => {
    const out = { calibration: el.querySelector('#calibration')?.checked ?? next.calibration !== false, per_exercise: {} };
    const bad = [];
    FIELDS.forEach((f) => {
      const { v, ok } = num(el.querySelector(`#r-${f.k}`), f);
      if (!ok) bad.push(f.label);
      out[f.k] = v;
    });
    exercises.forEach((e) => {
      const row = {};
      if (!e.name.trim()) bad.push('название упражнения');
      PER_EX.forEach((f) => {
        const { v, ok } = num({ value: String(e.pts[f.k] ?? '') }, f);
        if (!ok) bad.push(`${e.name || 'новое'}: ${fieldLabel(f, e.unit).toLowerCase()}`);
        if (v !== null) row[f.k] = v;
      });
      if (Object.keys(row).length) out.per_exercise[keyOf(e)] = row;
    });
    return { values: out, bad };
  };

  // Пример на первом упражнении: подход на 2 повтора больше цели, без серии и на потолке серии.
  const example = () => {
    const { values: v } = read();
    const box = el.querySelector('#example');
    const ex = exercises.find((e) => v.per_exercise[keyOf(e)]) ?? exercises[0];
    const p = ex ? v.per_exercise[keyOf(ex)] ?? {} : {};
    if (!ex || !(p.rep || p.set)) { box.textContent = 'Впиши очки хотя бы одному упражнению — здесь появится пример.'; return; }
    const sec = isSec(ex.unit);
    const target = ex.target_reps ?? (sec ? 60 : 8);
    const reps = target + (sec ? 10 : 2);
    const base = reps * (p.rep ?? 0) + (p.set ?? 0);
    const over = p.over ? Math.min(Math.round((reps - target) * p.over), p.cap ?? Infinity) : 0;
    const top = v.streak_from && v.streak_step ? v.streak_max ?? null : null;
    box.textContent = `${ex.name}, подход ${sec ? amount(reps, 'sec') : `${reps} повторов`} при цели ${amount(target, ex.unit)}: ${POINTS(Math.round(base + over))}`
      + (over ? ` (из них ${signed(Math.round(over))} за ${sec ? 'секунды' : 'повторы'} сверх цели)` : '')
      + (top ? `. На потолке серии всё ×${top}: ${POINTS(Math.round((base + over) * top))}.` : '.')
      + (v.calibration ? ' Пока тестовый период, это только теория.' : '');
  };
  example();
  // el — общий контейнер всех экранов: после ухода с «Правил» слушатель снимает себя.
  const onInput = () => (alive() ? example() : el.removeEventListener('input', onInput));
  el.addEventListener('input', onInput);
  // Тестовый период переключается сразу, с уже сохранёнными числами.
  el.querySelector('#calibration')?.addEventListener('change', async (e) => {
    try {
      await api.saveRules({ ...next, calibration: e.target.checked });
      ctx.rules = await api.rules();
      next.calibration = e.target.checked;
      ctx.toast(e.target.checked ? 'Тестовый период включён: очки не начисляются' : 'Тестовый период выключен: очки начисляются');
      example();
    } catch (err) { ctx.toast(err.message); e.target.checked = !e.target.checked; }
  });

  el.querySelector('#show-rules')?.addEventListener('change', async (e) => {
    try {
      await api.updateSettings({ show_rules: e.target.checked });
      ctx.settings.show_rules = e.target.checked;
      ctx.toast(e.target.checked ? 'Друг видит правила' : 'Правила скрыты от друга');
    } catch (err) { ctx.toast(err.message); e.target.checked = !e.target.checked; }
  });

  el.querySelector('#save')?.addEventListener('click', async () => {
    const err = el.querySelector('#rules-error');
    const { values, bad } = read();
    if (bad.length) { err.textContent = `Проверь: ${bad.join(', ')}. Нужны числа не меньше нуля, где-то — целые.`; return; }
    err.textContent = '';
    try {
      // Сначала упражнения: новым нужен id, удалённые уходят из списка и из комплекса.
      for (const e of exercises) {
        const name = e.name.trim();
        if (e.id) {
          if (name !== e.orig || e.unit !== e.origUnit) await api.saveExercise({ ...e, name });
        } else {
          const row = await api.saveExercise({ name, unit: e.unit, sets: 3, target_reps: null, position: 999, active: false });
          values.per_exercise[row.id] = values.per_exercise[e.tmp];
          delete values.per_exercise[e.tmp];
          Object.assign(e, { id: row.id, tmp: undefined });
        }
        e.orig = name;
        e.origUnit = e.unit;
      }
      for (const e of removed.splice(0)) await api.saveExercise({ ...e, active: false, archived: true });
      await api.saveRules(values);
      ctx.rules = await api.rules();
      el.querySelector('#saved').textContent = 'Сохранено · действует сразу';
      ctx.toast('Правила сохранены');
      draw();
    } catch (e) { err.textContent = e.message; }
  });
}
