// «Правила» (админ): калибровка, очки, серия, бонусы, штраф, цены.
// Сохранённые правила действуют со следующего дня; уже начисленные очки не меняются.

import { html, dayTitle } from '../util.js';
import { POINTS } from '../logic.js';

// int — целое число в базе; иначе можно дробное (шаг step).
const GROUPS = [
  { title: 'Начисление', fields: [
    { k: 'points_per_rep', label: 'Очки за повтор', step: 0.1 },
    { k: 'points_per_set', label: 'Очки за полный подход', step: 0.1, hint: 'Подход, где цель по повторам выполнена.' },
  ] },
  { title: 'Серия', note: 'Серия — тренировочные дни подряд с отметками. Выходные, купленные дни и больничный её не рвут.', fields: [
    { k: 'streak_from', label: 'Множитель растёт с дня', int: true, min: 1 },
    { k: 'streak_step', label: 'Шаг множителя', step: 0.05 },
    { k: 'streak_max', label: 'Потолок множителя', step: 0.1, min: 1 },
  ] },
  { title: 'Бонусы', fields: [
    { k: 'bonus_growth', label: 'За рост неделя к неделе', int: true,
      hint: 'За каждое упражнение, где лучший подход недели больше, чем на прошлой.' },
    { k: 'bonus_over', label: 'За повтор сверх цели', step: 0.1 },
    { k: 'bonus_cap_day', label: 'Потолок бонуса сверх цели в день', int: true },
  ] },
  { title: 'Штраф', note: 'Совет: не больше, чем даёт день тренировки. Баланс ниже нуля не падает.', fields: [
    { k: 'miss_penalty', label: 'Минус за пропуск', int: true },
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

export async function render(el, ctx) {
  const { rules } = ctx;
  const next = rules?.next ?? {};
  const changed = rules?.next && rules.next.valid_from === rules.from;

  el.innerHTML = String(html`
    <header class="stack-8">
      <p class="sub">Меняешь когда угодно — действует со следующего дня</p>
      <h1 class="h1">Правила</h1>
    </header>
    ${changed ? html`<p class="notice">Новые правила начнут действовать с ${dayTitle(rules.from)}. Сегодня — прежние.</p>` : ''}

    <section class="card">
      <h2 class="h2">Режим</h2>
      <label class="row switch-row"><span>Калибровка — очки не начисляются</span>
        <input type="checkbox" class="switch" id="calibration" ${next.calibration !== false ? html`checked` : ''}></label>
      <p class="label">Первая неделя идёт без очков. Выключишь — начисление начнётся со следующего дня.</p>
    </section>

    ${GROUPS.map((g) => html`<section class="card">
      <h2 class="h2">${g.title}</h2>
      ${g.fields.map((f) => html`<div class="stack-4">
        <label class="row rule-row" for="r-${f.k}"><span>${f.label}</span>
          <input class="input num-in" id="r-${f.k}" data-k="${f.k}" type="number" inputmode="decimal"
            min="${f.min ?? 0}" step="${f.int ? 1 : f.step}" placeholder="—" value="${next[f.k] ?? ''}"></label>
        ${f.hint ? html`<p class="label">${f.hint}</p>` : ''}
      </div>`)}
      ${g.note ? html`<p class="label">${g.note}</p>` : ''}
    </section>`)}

    <section class="card">
      <h2 class="h2">Пример</h2>
      <p class="label" id="example" aria-live="polite"></p>
    </section>

    <p class="error" id="rules-error" role="alert"></p>
    <button type="button" class="btn" id="save">Сохранить правила</button>
    <p class="label ok center" id="saved" aria-live="polite"></p>
  `);

  const read = () => {
    const out = { calibration: el.querySelector('#calibration').checked };
    const bad = [];
    FIELDS.forEach((f) => {
      const raw = el.querySelector(`#r-${f.k}`).value.trim().replace(',', '.');
      if (raw === '') { out[f.k] = null; return; }
      const v = Number(raw);
      if (!Number.isFinite(v) || v < (f.min ?? 0) || (f.int && !Number.isInteger(v))) bad.push(f.label);
      out[f.k] = v;
    });
    return { values: out, bad };
  };

  const example = () => {
    const { values: v } = read();
    const box = el.querySelector('#example');
    if (v.calibration) { box.textContent = 'Идёт калибровка: очки не начисляются.'; return; }
    const base = 10 * (v.points_per_rep ?? 0) + (v.points_per_set ?? 0);
    const over = v.bonus_over ? Math.min(2 * v.bonus_over, v.bonus_cap_day ?? Infinity) : 0;
    const top = v.streak_from && v.streak_step ? v.streak_max ?? null : null;
    box.textContent = `Подход 10 повторов при цели 8: ${POINTS(Math.round(base + over))}`
      + (over ? ` (из них +${Math.round(over)} за повторы сверх цели)` : '')
      + (top ? `. На потолке серии (×${top}) — ${POINTS(Math.round(base * top + over))}.` : '.');
  };
  example();
  el.addEventListener('input', example);
  el.querySelector('#calibration').addEventListener('change', example);

  el.querySelector('#save').addEventListener('click', async () => {
    const err = el.querySelector('#rules-error');
    const { values, bad } = read();
    if (bad.length) { err.textContent = `Проверь: ${bad.join(', ')}. Нужны числа не меньше минимума, где-то — целые.`; return; }
    err.textContent = '';
    try {
      await ctx.api.saveRules(values);
      ctx.rules = await ctx.api.rules();
      el.querySelector('#saved').textContent = `Сохранено · действует с ${dayTitle(ctx.rules.from)}`;
      ctx.toast('Правила сохранены');
    } catch (e) { err.textContent = e.message; }
  });
}
