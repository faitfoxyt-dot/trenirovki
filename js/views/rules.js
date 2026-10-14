// «Правила»: калибровка, очки по каждому упражнению, серия, штраф, цены.
// Админ меняет — действует со следующего дня. Атлет видит только чтение, если Тимур включил показ.

import { html, dayTitle } from '../util.js';
import { POINTS, signed } from '../logic.js';

// Числа у каждого упражнения свои.
const PER_EX = [
  { k: 'rep', label: 'За повтор', step: 0.1 },
  { k: 'set', label: 'За полный подход', step: 0.1 },
  { k: 'over', label: 'За повтор сверх цели', step: 0.1 },
  { k: 'growth', label: 'За рост за неделю', int: true },
];

// int — целое число в базе; иначе можно дробное (шаг step).
const GROUPS = [
  { title: 'Серия', note: 'Серия — тренировочные дни подряд, где сделан весь план. Выходные, купленные дни и больничный её не продлевают и не рвут. Множитель умножает все очки за подход.', fields: [
    { k: 'streak_from', label: 'Множитель растёт с дня', int: true, min: 1 },
    { k: 'streak_step', label: 'Шаг множителя', step: 0.05 },
    { k: 'streak_max', label: 'Потолок множителя', step: 0.1, min: 1 },
  ] },
  { title: 'Бонус сверх цели', fields: [
    { k: 'bonus_cap_day', label: 'Потолок в день (до множителя)', int: true },
  ] },
  { title: 'Штраф', note: 'Пропуск — тренировочный день, где не сделан хоть один подход плана. Снимается процент от баланса, ниже нуля не падает.', fields: [
    { k: 'miss_penalty_pct', label: 'Минус за пропуск, % баланса', step: 1, max: 100 },
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
    el.innerHTML = String(html`<section class="card"><h2 class="h2">Правила скрыты</h2>
      <p class="label">Тимур пока не открыл числа правил. Как всё работает — во вкладке «Цель».</p>
      <a class="ghost link" href="#/goal">К цели</a></section>`);
    return;
  }
  const exercises = (await api.exercises()).filter((e) => e.active);
  if (!alive()) return;

  const next = (isAdmin ? rules?.next : rules?.current) ?? {};
  const per = next.per_exercise ?? {};
  const changed = isAdmin && rules?.next && rules.next.valid_from === rules.from;
  const ro = isAdmin ? '' : html`disabled`;

  el.innerHTML = String(html`
    <header class="stack-8">
      <p class="sub">${isAdmin ? 'Меняешь когда угодно — действует со следующего дня' : 'Как считаются очки · меняет Тимур'}</p>
      <h1 class="h1">Правила</h1>
    </header>
    ${changed ? html`<p class="notice">Новые правила начнут действовать с ${dayTitle(rules.from)}. Сегодня — прежние.</p>` : ''}

    ${isAdmin ? html`<section class="card">
      <h2 class="h2">Режим</h2>
      <label class="row switch-row"><span>Калибровка — очки не начисляются</span>
        <input type="checkbox" class="switch" id="calibration" ${next.calibration !== false ? html`checked` : ''}></label>
      <p class="label">Первая неделя идёт без очков. Ты при этом видишь, сколько друг заработал бы по этим числам.
        Выключишь — начисление начнётся со следующего дня.</p>
      <label class="row switch-row"><span>Показывать правила другу</span>
        <input type="checkbox" class="switch" id="show-rules" ${ctx.settings?.show_rules ? html`checked` : ''}></label>
      <p class="label">Друг увидит эту вкладку без права менять. Включается сразу.</p>
    </section>` : next.calibration !== false ? html`<p class="notice">Сейчас калибровка: очки не начисляются.</p>` : ''}

    <section class="card">
      <h2 class="h2">Очки по упражнениям</h2>
      <p class="label">Только за подходы, которые подтвердил Тимур. Полный подход — где цель по повторам выполнена.
        Рост — если лучший подход недели больше, чем на прошлой неделе; раз в неделю.</p>
      ${exercises.map((e) => html`<div class="ex-rules">
        <p class="em">${e.name}${e.target_reps ? html` <span class="label">· цель ${e.target_reps}</span>` : ''}</p>
        <div class="grid-2">${PER_EX.map((f) => html`<div class="field">
          <label class="label" for="p-${e.id}-${f.k}">${f.label}</label>
          <input class="input num-in" id="p-${e.id}-${f.k}" data-ex="${e.id}" data-pk="${f.k}" type="number" inputmode="decimal"
            min="0" step="${f.int ? 1 : f.step}" placeholder="—" value="${per[e.id]?.[f.k] ?? ''}" ${ro}></div>`)}
        </div>
      </div>`)}
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
      PER_EX.forEach((f) => {
        const { v, ok } = num(el.querySelector(`#p-${e.id}-${f.k}`), f);
        if (!ok) bad.push(`${e.name}: ${f.label.toLowerCase()}`);
        if (v !== null) row[f.k] = v;
      });
      if (Object.keys(row).length) out.per_exercise[e.id] = row;
    });
    return { values: out, bad };
  };

  // Пример на первом упражнении: подход на 2 повтора больше цели, без серии и на потолке серии.
  const example = () => {
    const { values: v } = read();
    const box = el.querySelector('#example');
    const ex = exercises.find((e) => v.per_exercise[e.id]) ?? exercises[0];
    const p = ex ? v.per_exercise[ex.id] ?? {} : {};
    if (!ex || !(p.rep || p.set)) { box.textContent = 'Впиши очки хотя бы одному упражнению — здесь появится пример.'; return; }
    const target = ex.target_reps ?? 8;
    const reps = target + 2;
    const base = reps * (p.rep ?? 0) + (p.set ?? 0);
    const over = p.over ? Math.min(2 * p.over, v.bonus_cap_day ?? Infinity) : 0;
    const top = v.streak_from && v.streak_step ? v.streak_max ?? null : null;
    box.textContent = `${ex.name}, подход ${reps} повторов при цели ${target}: ${POINTS(Math.round(base + over))}`
      + (over ? ` (из них ${signed(Math.round(over))} за повторы сверх цели)` : '')
      + (top ? `. На потолке серии всё ×${top}: ${POINTS(Math.round((base + over) * top))}.` : '.')
      + (v.calibration ? ' Пока идёт калибровка, это только теория.' : '');
  };
  example();
  // el — общий контейнер всех экранов: после ухода с «Правил» слушатель снимает себя.
  const onInput = () => (alive() ? example() : el.removeEventListener('input', onInput));
  el.addEventListener('input', onInput);
  el.querySelector('#calibration')?.addEventListener('change', example);

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
      await api.saveRules(values);
      ctx.rules = await api.rules();
      el.querySelector('#saved').textContent = `Сохранено · действует с ${dayTitle(ctx.rules.from)}`;
      ctx.toast('Правила сохранены');
    } catch (e) { err.textContent = e.message; }
  });
}
