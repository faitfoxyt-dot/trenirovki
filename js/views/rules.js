// «Правила»: тестовый период, список упражнений с очками, серия, штраф, цены, «Всё или ничего».
// Админ меняет — действует сразу. Атлет видит только чтение, если Тимур включил показ.

import { html } from '../util.js';
import { POINTS, signed, amount, isSec, cxLetter, unitText } from '../logic.js';
import { howItWorks } from './goal.js';

// Числа у каждого упражнения свои.
// У упражнений на время те же поля, только за секунду.
const PER_EX = [
  { k: 'rep', label: 'За повтор', sec: 'За секунду', step: 0.1 },
  { k: 'set', label: 'За полный подход', step: 0.1 },
  { k: 'over', label: 'Сверх цели, за повтор', sec: 'Сверх цели, за секунду', step: 0.1 },
  { k: 'cap', label: 'Потолок бонуса в день (очки)', int: true },
];
const fieldLabel = (f, unit) => (isSec(unit) && f.sec ? f.sec : f.label);

// int — целое число в базе; иначе можно дробное (шаг step).
const GROUPS = [
  { title: '🎯 Выбор упражнения', note: 'Работает, когда в «Плане» включён «Выбор упражнения». Тогда каждое упражнение стоит одинаково: цена ниже — за все подходы в цель, меньше цели — по доле, сверх цели — до +10% за день (при 1000 максимум 1100). Берёт одно и то же подряд — эффективность каждый раз падает на «минус за повтор»: 100% → 90% → 80% → … но не ниже порога. Возьмёт другой вариант — снова 100%. Где выбора нет, всегда 100%. Замена по просьбе — 75%. Цены упражнений выше тогда не действуют. Пустая цена — всё по ценам упражнений.', fields: [
    { k: 'choice_price', label: 'Цена упражнения, очков', int: true, min: 1 },
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
  { title: 'Магазин', note: 'Пустой лимит — без ограничений.', fields: [
    { k: 'rest_day_price', label: 'Цена выходного', int: true, min: 1 },
    { k: 'purchase_limit_week', label: 'Лимит выходных в неделю', int: true },
  ] },
  { title: 'Всё или ничего', note: 'Модификатор дня в магазине. Упражнение сделано — все подходы не меньше цели. Добавка складывается с серией, итог не ниже ×0.1 и действует на все очки дня. Считается, когда день закончился и всё проверено. Пустая цена — не продаётся.', fields: [
    { k: 'allin_price', label: 'Цена', int: true, min: 1 },
    { k: 'allin_up', label: 'Плюс за сделанное упражнение', step: 0.05 },
    { k: 'allin_down', label: 'Минус за несделанное', step: 0.05 },
    { k: 'allin_limit_week', label: 'Лимит в неделю', int: true },
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
    return x && (x.id === id ? x : { sets: x.sets, target_reps: x.alt.target_reps });
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
      <p class="label">Очки идут за подходы, которые проверил генерал. «Полный подход» — когда добил цель.
        «Сверх цели» — доплата за каждый лишний повтор (или секунду у упражнений на время), но за день по упражнению бонус не больше потолка. Потолок — в очках, не в повторах.
        ${isAdmin ? 'Отсюда упражнения попадают в «План». Выбери упражнение, чтобы поменять очки и замену, или добавь новое.' : ''}</p>
      <div id="ex-rules"></div>
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
  // Админ работает с одним упражнением за раз: выбрать и настроить, добавить новое или удалить.
  let mode = 'pick';
  let sel = exercises[0] ? keyOf(exercises[0]) : null;
  const MODES = [{ k: 'pick', label: 'Выбрать' }, { k: 'add', label: 'Добавить' }, { k: 'del', label: 'Удалить' }];
  const saved = () => exercises.filter((e) => e.id);
  const pickOptions = (cur) => saved().map((e) => html`<option value="${e.id}" ${keyOf(e) === cur ? html`selected` : ''}>${e.name}${
    inCx(e).length ? ` · ${inCx(e).join(' ')}` : ''}</option>`);
  // У кого это упражнение стоит заменой.
  const swapOf = (e) => exercises.filter((x) => x.swap_id === e.id && x !== e);

  const rowHtml = (e) => html`<div class="ex-rules" data-key="${keyOf(e)}">
      ${isAdmin ? html`<label class="label" for="name-${keyOf(e)}">Название</label>
        <input class="input" id="name-${keyOf(e)}" data-name type="text" maxlength="60" placeholder="Например: Отжимания на брусьях" value="${e.name}">
        <div class="seg" role="group" aria-label="Как считать">
          <button type="button" class="pill ${isSec(e.unit) ? '' : 'pill-on'}" data-unit="reps" aria-pressed="${!isSec(e.unit)}">Повторы</button>
          <button type="button" class="pill ${isSec(e.unit) ? 'pill-on' : ''}" data-unit="sec" aria-pressed="${isSec(e.unit)}">На время</button>
        </div>`
        : html`<p class="em">${e.name}${isSec(e.unit) ? ' · на время' : ''}</p>`}
      ${cxNote(e) ? html`<p class="label">${cxNote(e)}</p>` : ''}
      ${cxTarget(e) ? html`<p class="label">Цель — в «Плане»: ${cxTarget(e).text}</p>` : ''}
      <div class="grid-2">${PER_EX.map((f) => html`<div class="field">
        <label class="label" for="p-${keyOf(e)}-${f.k}">${fieldLabel(f, e.unit)}</label>
        <input class="input num-in" id="p-${keyOf(e)}-${f.k}" data-pk="${f.k}" type="number" inputmode="decimal"
          min="0" step="${f.int ? 1 : f.step}" placeholder="—" value="${e.pts?.[f.k] ?? ''}" ${ro}></div>`)}
      </div>
      ${!hasSwap ? '' : isAdmin ? swapRow(e) : swapText(e)}
    </div>`;

  const draw = () => {
    if (!isAdmin) {
      list.innerHTML = String(html`${exercises.map(rowHtml)}${exercises.length ? '' : html`<p class="label">Упражнений пока нет.</p>`}`);
      return;
    }
    // Недописанное новое упражнение без названия не держим, когда ушли с «Добавить».
    if (mode !== 'add') exercises.splice(0, exercises.length, ...exercises.filter((e) => e.id || e.name.trim()));
    let body;
    if (mode === 'add') {
      let e = exercises.find((x) => !x.id);
      if (!e) { fresh += 1; e = { tmp: `new${fresh}`, name: '', unit: 'reps', pts: {}, active: false, swap_id: null, swap_target: null }; exercises.push(e); }
      body = html`${rowHtml(e)}<button type="button" class="btn" id="ex-add">Добавить упражнение</button>`;
    } else if (!saved().length) {
      body = html`<p class="label">Упражнений пока нет. Нажми «Добавить».</p>`;
    } else if (mode === 'del') {
      const e = saved().find((x) => keyOf(x) === sel) ?? saved()[0];
      sel = keyOf(e);
      const warn = [cxNote(e) ? `${cxNote(e)} — оттуда уберётся.` : '',
        swapOf(e).length ? `Оно замена для: ${swapOf(e).map((x) => x.name).join(', ')} — там замены не станет.` : ''].filter(Boolean);
      body = html`<label class="label" for="ex-del-pick">Какое удалить</label>
        <select class="input" id="ex-del-pick">${pickOptions(sel)}</select>
        ${warn.length ? html`<p class="label bad">${warn.join(' ')}</p>` : ''}
        <p class="label">Старые подходы и очки останутся.</p>
        <button type="button" class="ghost ghost-bad" id="ex-del">Удалить «${e.name}»</button>`;
    } else {
      const e = saved().find((x) => keyOf(x) === sel) ?? saved()[0];
      sel = keyOf(e);
      body = html`<label class="label" for="ex-pick">Упражнение · всего ${saved().length}</label>
        <select class="input" id="ex-pick">${pickOptions(sel)}</select>
        ${rowHtml(e)}<button type="button" class="btn" id="ex-save">Сохранить упражнение</button>`;
    }
    list.innerHTML = String(html`<div class="seg ex-mode" role="group" aria-label="Что сделать">
        ${MODES.map((m) => html`<button type="button" class="pill ${mode === m.k ? 'pill-on' : ''}" data-mode="${m.k}" aria-pressed="${mode === m.k}">${m.label}</button>`)}
      </div>${body}`);
  };
  // Замена по просьбе (нет турника, болит): другое упражнение из списка и цель для него; подходов — сколько в плане.
  // Цель упражнения живёт в комплексах («План»): первая, где оно есть.
  const cxTarget = (e) => {
    const i = complexes.findIndex((c) => cxItem(c, e.id));
    if (i < 0) return null;
    const it = cxItem(complexes[i], e.id);
    return { target: it.target_reps, text: `${complexes.length > 1 ? `комплекс ${cxLetter(i)}, ` : ''}${it.sets}×${amount(it.target_reps, e.unit)}` };
  };
  // Сколько стоит подход ровно в цель (без бонуса и серии).
  const setCost = (e, target) => {
    const n = (k) => Number(String(e.pts?.[k] ?? '').replace(',', '.')) || 0;
    return target ? Math.round(target * n('rep') + n('set')) : null;
  };
  // Замена по просьбе: другое упражнение из списка, цель для него и сравнение очков.
  const swapRow = (e) => {
    const to = exercises.find((x) => x.id === e.swap_id);
    const tgt = Number(e.swap_target) || null;
    const mine = setCost(e, cxTarget(e)?.target);
    const theirs = to ? setCost(to, tgt) : null;
    return html`<div class="swap-box">
      <p class="em">🔁 Замена по просьбе</p>
      <p class="label">Когда друг попросит (нет турника, болит), вместо «${e.name || 'этого упражнения'}» будет это. Подходов — столько же.</p>
      <select class="input" id="sw-${keyOf(e)}" data-swap aria-label="Замена">
        <option value="">— без замены —</option>
        ${exercises.filter((x) => x !== e && x.id).map((x) => html`<option value="${x.id}" ${e.swap_id === x.id ? html`selected` : ''}>${x.name}</option>`)}
      </select>
      ${to ? html`<div class="swap-row">
        <label class="label" for="swt-${keyOf(e)}">Цель замены, ${unitText(to.unit).many}</label>
        <input class="input num-in" id="swt-${keyOf(e)}" data-swap-target type="number" inputmode="numeric" min="1" max="1000" step="1"
          placeholder="—" value="${e.swap_target ?? ''}"></div>
        <p class="label swap-cmp">Подход ровно в цель:<br>
          ${e.name}${cxTarget(e) ? ` · ${amount(cxTarget(e).target, e.unit)}` : ''} — ${mine === null ? 'цель не задана' : POINTS(mine)}<br>
          ${to.name}${tgt ? ` · ${amount(tgt, to.unit)}` : ''} — ${theirs === null ? 'впиши цель' : POINTS(theirs)}</p>
        <p class="label">Очки замены — у неё самой. <button type="button" class="swap-go" data-goto="${to.id}">Настроить очки «${to.name}» →</button></p>` : ''}
    </div>`;
  };
  const swapText = (e) => {
    const to = exercises.find((x) => x.id === e.swap_id);
    return to ? html`<p class="label">Замена по просьбе: ${to.name}${e.swap_target ? ` · цель ${amount(e.swap_target, to.unit)}` : ''}</p>` : '';
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
    const go = e.target.closest('[data-goto]');
    if (go) { mode = 'pick'; sel = Number(go.dataset.goto); draw(); example(); list.scrollIntoView({ block: 'start' }); return; }
    const m = e.target.closest('[data-mode]');
    if (m) { mode = m.dataset.mode; draw(); example(); return; }
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
    if (e.target.matches('#ex-pick, #ex-del-pick')) { sel = Number(e.target.value); draw(); example(); }
    // Сменили замену или числа — пересчитать сравнение очков.
    if (e.target.matches('[data-swap], [data-swap-target], [data-pk]') && mode !== 'del' && isAdmin) {
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
          if (mode === 'add') { mode = 'pick'; sel = row.id; }
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
