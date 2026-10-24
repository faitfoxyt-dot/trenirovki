// «Правила»: тестовый период, список упражнений с очками, серия, штраф, цены, «Всё или ничего», «За гранью предела».
// Админ меняет — действует сразу. Атлет видит только чтение, если Тимур включил показ.

import { html } from '../util.js';
import { POINTS, signed, amount, isSec, cxLetter, unitText, ruleSetPoints } from '../logic.js';
import { howItWorks } from './goal.js';

// Числа у каждого упражнения свои.
// У упражнений на время те же поля, только за секунду.
const PER_EX = [
  { k: 'rep', label: 'За повтор до цели', sec: 'За секунду до цели', step: 0.1 },
  { k: 'over', label: 'За повтор сверх цели', sec: 'За секунду сверх цели', step: 0.1 },
  { k: 'cap', label: 'Сверх цели в подходе, максимум повторов', sec: 'Сверх цели в подходе, максимум секунд', int: true },
];
const fieldLabel = (f, unit) => (isSec(unit) && f.sec ? f.sec : f.label);
// Дробные показываем через запятую, как их удобнее вписывать.
const comma = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));

// int — целое число в базе; иначе можно дробное (шаг step).
const GROUPS = [
  { title: '🎯 Выбор упражнения', note: 'Работает, когда в «Плане» включён «Выбор упражнения». Очки — по ценам упражнений выше. Берёт одно и то же подряд — эффективность каждый раз падает на «минус за повтор»: 100% → 90% → 80% → … но не ниже порога; все очки подхода умножаются на неё. Возьмёт другой вариант — снова 100%. Где выбора нет, всегда 100%. Друг видит только эффективность в %, без очков.', fields: [
    { k: 'choice_drop', label: 'Минус за повтор выбора, %', int: true, max: 50 },
    { k: 'choice_floor', label: 'Не ниже, % цены', int: true, max: 100 },
  ] },
  { title: 'Серия', note: 'Серия — тренировочные дни подряд, где сделан весь план. Выходные, купленные дни и больничный её не продлевают и не рвут. Множитель умножает все очки за подход и один на все подходы дня, когда бы ты их ни проверил.', fields: [
    { k: 'streak_from', label: 'Множитель растёт с дня', int: true, min: 1 },
    { k: 'streak_step', label: 'Шаг множителя', step: 0.05 },
    { k: 'streak_max', label: 'Потолок множителя', step: 0.1, min: 1 },
  ] },
  { title: 'Штраф', note: 'Пропуск — тренировочный день, где не сделан хоть один подход плана. Подход с 0 повторов или отклонённый не считается. Снимается процент от баланса, ниже нуля не падает. Примешь отклонённое позже — штраф за день вернётся.', fields: [
    { k: 'miss_penalty_pct', label: 'Штраф, % баланса', step: 1, max: 100 },
  ] },
  { title: 'Магазин', note: 'Пустой лимит — без ограничений. Выходной на сегодня покупается в тот же день, до полуночи: цена — процент от баланса, но не меньше минимума. Серию не рвёт и не продлевает, штрафа нет, отменить нельзя, в лимит выходных не входит. Оба поля пустые — не продаётся.', fields: [
    { k: 'rest_day_price', label: 'Цена выходного', int: true, min: 1 },
    { k: 'purchase_limit_week', label: 'Лимит выходных в неделю', int: true },
    { k: 'rest_today_pct', label: 'Выходной на сегодня, % баланса', int: true, max: 100 },
    { k: 'rest_today_min', label: 'Выходной на сегодня, не меньше (очки)', int: true },
  ] },
  { title: 'Всё или ничего', note: 'Модификатор дня в магазине. Упражнение сделано — все подходы не меньше цели. Добавка складывается с серией, итог не ниже ×0.1 и действует на все очки дня. Считается, когда день закончился и всё проверено. Пустая цена — не продаётся.', fields: [
    { k: 'allin_price', label: 'Цена', int: true, min: 1 },
    { k: 'allin_up', label: 'Плюс за сделанное упражнение', step: 0.05 },
    { k: 'allin_down', label: 'Минус за несделанное', step: 0.05 },
    { k: 'allin_limit_week', label: 'Лимит в неделю', int: true },
    { k: 'allin_streak', label: 'Открывается с серии, дней', int: true },
  ] },
  { title: 'За гранью предела', note: 'Пари на 3 тренировки подряд: на каждую друг выбирает упражнение и число за один подход, минимум на 10% больше рекорда (или цели, если рекорд меньше). Сделал — приз по ставке, умножается на серию; не сделал — приза нет. Раз в неделю, не вместе с «Всё или ничего». Подход на ставку бот не принимает — проверяешь ты. Пустая цена — не продаётся.', fields: [
    { k: 'pari_price', label: 'Цена', int: true, min: 1 },
    { k: 'pari_streak', label: 'Открывается с серии, дней', int: true },
    { k: 'pari_p10', label: 'Приз за ставку +10%', int: true },
    { k: 'pari_p25', label: 'Приз за ставку +25%', int: true },
    { k: 'pari_p50', label: 'Приз за ставку +50%', int: true },
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
  const [all, complexes] = await Promise.all([api.exercises(), api.complexes()]);
  if (!alive()) return;
  const exercises = all.filter((e) => !e.archived).map((e) => ({ ...e }));
  // Замена по просьбе есть, когда в базе уже выполнена миграция 0014 (в демо — всегда).
  const hasSwap = all.some((e) => 'swap_id' in e);
  // В каких комплексах упражнение: «А · В».
  // Пункт комплекса с этим упражнением: основной вариант или второй (для «Выбора»).
  const cxItem = (c, id) => {
    const x = c.items.find((y) => y.id === id || y.alt?.id === id);
    return x && (x.id === id ? x : { sets: x.alt.sets ?? x.sets, target_reps: x.alt.target_reps });
  };
  const inCx = (e) => complexes.map((c, i) => (cxItem(c, e.id) ? cxLetter(i) : null)).filter(Boolean);
  const cxNote = (e) => {
    const l = inCx(e);
    if (!l.length) return '';
    return complexes.length > 1 ? `В ${l.length > 1 ? 'комплексах' : 'комплексе'} ${l.join(' · ')}` : 'В комплексе';
  };

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
      <p class="label">Очки идут за подходы, которые проверил генерал. Повторы до цели — по первой цене, сверх цели — по второй,
        но в каждом подходе сверх цели считается не больше максимума (у упражнений на время всё в секундах).${isAdmin ? ' Дробные можно через запятую. Подходы и цели — в «Плане».' : ''}</p>
      <div id="ex-rules"></div>
    </section>

    ${GROUPS.map((g) => html`<section class="card">
      <h2 class="h2">${g.title}</h2>
      ${g.fields.map((f) => html`<label class="row rule-row" for="r-${f.k}"><span>${f.label}</span>
        <input class="input num-in" id="r-${f.k}" data-k="${f.k}" type="text" inputmode="decimal"
          placeholder="—" value="${comma(next[f.k])}" ${ro}></label>`)}
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
    const raw = input.value.trim().replace(/\s/g, '').replace(',', '.');
    if (raw === '') return { v: null, ok: true };
    const v = Number(raw);
    return { v, ok: Number.isFinite(v) && v >= (f.min ?? 0) && v <= (f.max ?? Infinity) && (!f.int || Number.isInteger(v)) };
  };

  // Строка упражнения: key — id или «new1» для ещё не сохранённого.
  const keyOf = (e) => e.id ?? e.tmp;
  const list = el.querySelector('#ex-rules');
  // Одно упражнение за раз: выбрал в списке — три цены. Последний пункт списка — новое упражнение.
  let sel = exercises[0] ? keyOf(exercises[0]) : 'new';
  const saved = () => exercises.filter((e) => e.id);
  const option = (e) => html`<option value="${e.id}" ${keyOf(e) === sel ? html`selected` : ''}>${e.name}${isSec(e.unit) ? ' · на время' : ''}</option>`;
  const pickHtml = () => {
    const inProg = saved().filter((e) => inCx(e).length);
    const rest = saved().filter((e) => !inCx(e).length);
    return html`<label class="label" for="ex-pick">Упражнение</label>
      <select class="input" id="ex-pick">
        ${inProg.length ? html`<optgroup label="В программе">${inProg.map(option)}</optgroup>` : ''}
        ${rest.length ? html`<optgroup label="Не в программе">${rest.map(option)}</optgroup>` : ''}
        ${isAdmin ? html`<option value="new" ${sel === 'new' ? html`selected` : ''}>+ Новое упражнение</option>` : ''}
      </select>`;
  };

  const rowHtml = (e) => html`<div class="ex-rules" data-key="${keyOf(e)}">
      ${!e.id ? html`<label class="label" for="name-${keyOf(e)}">Название</label>
        <input class="input" id="name-${keyOf(e)}" data-name type="text" maxlength="60" placeholder="Например: Отжимания на брусьях" value="${e.name}">
        <div class="seg" role="group" aria-label="Как считать">
          <button type="button" class="pill ${isSec(e.unit) ? '' : 'pill-on'}" data-unit="reps" aria-pressed="${!isSec(e.unit)}">Повторы</button>
          <button type="button" class="pill ${isSec(e.unit) ? 'pill-on' : ''}" data-unit="sec" aria-pressed="${isSec(e.unit)}">На время</button>
        </div>`
        : html`<p class="label">${cxTarget(e) ? `Цель в «Плане»: ${cxTarget(e).text}` : 'Пока нет в комплексах — добавь в «Плане».'}</p>`}
      ${PER_EX.map((f) => html`<div class="field">
        <label class="label" for="p-${keyOf(e)}-${f.k}">${fieldLabel(f, e.unit)}</label>
        <input class="input num-in" id="p-${keyOf(e)}-${f.k}" data-pk="${f.k}" type="text" inputmode="decimal"
          placeholder="—" value="${comma(e.pts?.[f.k])}" ${ro}></div>`)}
      ${costLine(e)}
    </div>`;

  const draw = () => {
    if (sel === 'new' && isAdmin) {
      let e = exercises.find((x) => !x.id);
      if (!e) { fresh += 1; e = { tmp: `new${fresh}`, name: '', unit: 'reps', pts: {}, active: false }; exercises.push(e); }
      list.innerHTML = String(html`${pickHtml()}${rowHtml(e)}<button type="button" class="btn" id="ex-add">Добавить упражнение</button>`);
      return;
    }
    // Недописанное новое упражнение без названия не держим, когда ушли с него.
    exercises.splice(0, exercises.length, ...exercises.filter((e) => e.id || e.name.trim()));
    const e = saved().find((x) => keyOf(x) === sel) ?? saved()[0];
    if (!e) { list.innerHTML = String(html`<p class="label">Упражнений пока нет.</p>`); return; }
    sel = keyOf(e);
    list.innerHTML = String(html`${pickHtml()}${rowHtml(e)}${isAdmin ? html`
      <button type="button" class="btn" id="ex-save">Сохранить</button>
      <button type="button" class="text-btn bad" id="ex-del">Удалить «${e.name}»</button>` : ''}`);
  };
  // Цель упражнения живёт в комплексах («План»): первая, где оно есть.
  const cxTarget = (e) => {
    const i = complexes.findIndex((c) => cxItem(c, e.id));
    if (i < 0) return null;
    const it = cxItem(complexes[i], e.id);
    return { target: it.target_reps, text: `${complexes.length > 1 ? `комплекс ${cxLetter(i)}, ` : ''}${it.sets}×${amount(it.target_reps, e.unit)}` };
  };
  // Цены упражнения числами: в полях может быть «5,7».
  const ptsOf = (e) => Object.fromEntries(PER_EX.map((f) => [f.k, num({ value: String(e.pts?.[f.k] ?? '') }, f).v ?? undefined]));
  // Сколько стоит подход ровно в цель (без бонуса и серии).
  const setCost = (e, target) => (target ? Math.round(ruleSetPoints(ptsOf(e), target, target).base) : null);
  // Подход в цель и подход с максимумом сверх цели — по цели из «Плана».
  const costLine = (e) => {
    const t = cxTarget(e)?.target;
    if (!t) return '';
    const p = ptsOf(e);
    const top = p.cap != null ? t + p.cap : null;
    const best = top ? ruleSetPoints(p, t, top) : null;
    return html`<p class="label">Подход в цель (${amount(t, e.unit)}) — ${POINTS(setCost(e, t))}${
      best ? html` · ${amount(top, e.unit)} и больше — ${POINTS(Math.round(best.base + best.bonus))}` : ''}</p>`;
  };
  exercises.forEach((e) => {
    e.pts = { ...(per[e.id] ?? {}) }; e.orig = e.name; e.unit = e.unit ?? 'reps'; e.origUnit = e.unit;
    if (hasSwap) { e.swap_id = e.swap_id ?? null; e.swap_target = e.swap_target ?? null; }
    e.origSwap = `${e.swap_id}|${e.swap_target}`;
  });
  draw();

  // Ввод сразу запоминаем в строке, чтобы перерисовка не теряла числа.
  list.addEventListener('input', (e) => {
    const ex = exercises.find((x) => String(keyOf(x)) === e.target.closest('[data-key]')?.dataset.key);
    if (!ex) return;
    if (e.target.matches('[data-name]')) ex.name = e.target.value;
    else if (e.target.matches('[data-swap]')) ex.swap_id = e.target.value ? Number(e.target.value) : null;
    else if (e.target.matches('[data-swap-target]')) ex.swap_target = e.target.value;
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
    if (e.target.closest('#ex-add')) {
      if (!exercises.find((x) => !x.id)?.name.trim()) { ctx.toast('Напиши название'); return; }
      save('Упражнение добавлено');
      return;
    }
    if (e.target.closest('#ex-save')) { save('Упражнение сохранено'); return; }
    if (e.target.closest('#ex-del')) {
      const ex = saved().find((x) => keyOf(x) === sel);
      if (!ex || !confirm(`Удалить «${ex.name}»? Старые подходы и очки останутся.`)) return;
      removed.push(ex);
      exercises.splice(exercises.indexOf(ex), 1);
      sel = saved()[0] ? keyOf(saved()[0]) : null;
      save(`«${ex.name}» удалено`);
    }
  });
  list.addEventListener('change', (e) => {
    if (e.target.matches('#ex-pick')) { sel = e.target.value === 'new' ? 'new' : Number(e.target.value); draw(); example(); }
    // Сменили числа — пересчитать очки за подход.
    if (e.target.matches('[data-pk]') && isAdmin) {
      const id = e.target.id;
      draw();
      document.getElementById(id)?.focus();
    }
  });

  const read = () => {
    const out = { calibration: el.querySelector('#calibration')?.checked ?? next.calibration !== false, per_exercise: {} };
    const bad = [];
    FIELDS.forEach((f) => {
      const { v, ok } = num(el.querySelector(`#r-${f.k}`), f);
      if (!ok) bad.push(f.label);
      out[f.k] = v;
    });
    exercises.filter((e) => e.id || e.name.trim()).forEach((e) => {
      const row = {};
      if (!e.name.trim()) bad.push('название упражнения');
      const st = String(e.swap_target ?? '').trim();
      if (st && !(Number.isInteger(Number(st)) && Number(st) >= 1 && Number(st) <= 1000)) bad.push(`${e.name || 'новое'}: цель замены`);
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
    if (!ex || !p.rep) { box.textContent = 'Впиши очки хотя бы одному упражнению — здесь появится пример.'; return; }
    const sec = isSec(ex.unit);
    const target = cxTarget(ex)?.target ?? ex.target_reps ?? (sec ? 60 : 8);
    const reps = target + (sec ? 10 : 2);
    const { base, bonus: over } = ruleSetPoints(p, target, reps);
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

  // Сохраняет всё сразу: упражнения (новые, изменённые, удалённые) и числа правил.
  const save = async (okText = 'Правила сохранены') => {
    const err = el.querySelector('#rules-error');
    const { values, bad } = read();
    if (bad.length) { err.textContent = `Проверь: ${bad.join(', ')}. Нужны числа не меньше нуля, где-то — целые.`; return; }
    err.textContent = '';
    try {
      // Сначала упражнения: новым нужен id, удалённые уходят из списка и из комплекса.
      for (const e of exercises) {
        const name = e.name.trim();
        if (!e.id && !name) continue;
        if (e.id) {
          const sw = hasSwap ? {
            swap_id: removed.some((r) => r.id === e.swap_id) ? null : e.swap_id,
            swap_target: String(e.swap_target ?? '').trim() === '' ? null : Number(e.swap_target),
          } : {};
          if (name !== e.orig || e.unit !== e.origUnit || `${sw.swap_id}|${sw.swap_target}` !== e.origSwap) {
            await api.saveExercise({ ...e, name, ...sw });
          }
          Object.assign(e, sw, { origSwap: `${sw.swap_id}|${sw.swap_target}` });
        } else {
          const sw = hasSwap ? { swap_id: e.swap_id ?? null,
            swap_target: String(e.swap_target ?? '').trim() === '' ? null : Number(e.swap_target) } : {};
          const row = await api.saveExercise({ name, unit: e.unit, sets: 3, target_reps: null, position: 999, active: false, ...sw });
          values.per_exercise[row.id] = values.per_exercise[e.tmp];
          delete values.per_exercise[e.tmp];
          Object.assign(e, { id: row.id, tmp: undefined, origSwap: `${sw.swap_id}|${sw.swap_target}` });
          if (sel === 'new') sel = row.id;
        }
        e.orig = name;
        e.origUnit = e.unit;
      }
      for (const e of removed.splice(0)) await api.saveExercise({ ...e, active: false, archived: true });
      await api.saveRules(values);
      ctx.rules = await api.rules();
      el.querySelector('#saved').textContent = 'Сохранено · действует сразу';
      ctx.toast(okText);
      draw();
    } catch (e) { err.textContent = e.message; ctx.toast(e.message); }
  };
  el.querySelector('#save')?.addEventListener('click', () => save());
}
