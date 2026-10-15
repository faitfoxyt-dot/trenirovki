// «Тело»: финальное взвешивание дня (вес и % жира), скан с рангом, графики и дисциплина.
// Друг пишет только за сегодня, это же уходит в итог дня в боте. Админ смотрит и может удалить запись.

import { html, raw, dayTitle, shortDate, addDays } from '../util.js';
import { confetti } from './goal.js';
import { num, signed, lean, RANKS, rankOf, scanCard, forecastCard, heatCard, weeksCard } from './body-parts.js';

const METRICS = [
  { k: 'weight', label: 'Вес', unit: 'кг', better: 0 },
  { k: 'fat', label: 'Жир', unit: '%', better: -1 },
  { k: 'lean', label: 'Сухая масса', unit: 'кг', better: 1 },
];
const RANGES = [
  { k: 14, label: '2 недели' },
  { k: 30, label: 'Месяц' },
  { k: 0, label: 'Всё' },
];

// Выбор метрики и периода живёт, пока открыт сайт.
const view = { metric: 'weight', range: 30, editing: false };

const value = (b, k) => (k === 'lean' ? lean(b) : b[k] === null || b[k] === undefined ? null : Number(b[k]));

// Цвет разницы: жир вниз и сухая масса вверх — хорошо. Вес — без оценки.
function tone(delta, better) {
  if (!better || Math.abs(delta) < 0.05) return '';
  return delta * better > 0 ? 'ok' : 'warn';
}

export async function render(el, ctx, args, alive) {
  const { api, me, clock } = ctx;
  const isAdmin = me.role === 'admin';
  const athleteId = ctx.athleteId;
  if (!athleteId) {
    el.innerHTML = String(html`<section class="card"><h2 class="h2">Атлетов пока нет</h2></section>`);
    return;
  }

  const rows = (await api.body(athleteId)).map((b) => ({
    date: b.date, weight: Number(b.weight), fat: b.fat === null ? null : Number(b.fat),
  }));
  if (!alive()) return;

  const today = clock.today;
  const last = rows[rows.length - 1] ?? null;
  const todayRow = last?.date === today ? last : null;
  const hasFat = rows.some((b) => b.fat !== null);
  if (!hasFat && view.metric !== 'weight') view.metric = 'weight';

  el.innerHTML = String(html`
    <header class="stack-8">
      <p class="sub cx-kicker">${isAdmin ? 'Экран друга · только просмотр' : `BODY SCAN · ${dayTitle(today)}`}</p>
      <h1 class="h1">Тело</h1>
    </header>

    ${last ? scanCard(rows) : html`<section class="card body-hero body-empty">
      <span class="body-empty-ic" aria-hidden="true">⚖️</span>
      <h2 class="h2">Точка отсчёта</h2>
      <p class="label">${isAdmin ? 'Друг ещё не взвешивался. Первая запись появится здесь.'
        : 'Встань на весы и запиши вес и процент жира. Первое взвешивание — старт, дальше тут вырастет график твоего прогресса.'}</p>
    </section>`}

    ${isAdmin ? '' : html`<section class="card body-entry" id="entry"></section>`}

    ${rows.length >= 2 ? html`<section class="card" id="chart-card"></section>` : ''}

    ${forecastCard(rows, today)}
    ${last ? heatCard(rows, today) : ''}
    ${weeksCard(rows, today)}

    ${rows.length ? html`<section class="card">
      <h2 class="h2">История</h2>
      ${history(rows, isAdmin, today)}
    </section>` : ''}
  `);

  countUp(el.querySelector('[data-count]'));

  const entry = el.querySelector('#entry');
  if (entry) renderEntry(entry, ctx, todayRow, last, rows.filter((b) => b.date !== today));

  const chartCard = el.querySelector('#chart-card');
  if (chartCard) renderChart(chartCard, rows, hasFat, today);

  el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Удалить взвешивание за ${dayTitle(b.dataset.del)}?`)) return;
    try {
      await api.deleteBody(athleteId, b.dataset.del);
      ctx.toast('Взвешивание удалено');
      ctx.refresh();
    } catch (e) { ctx.toast(e.message); }
  }));
}

// Число «докручивается» от прошлого взвешивания до нынешнего.
function countUp(node) {
  if (!node) return;
  const to = Number(node.dataset.count);
  const from = Number(node.dataset.from);
  if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 900);
    const e = 1 - (1 - k) ** 3;
    node.textContent = num(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ── Запись за сегодня ──

function renderEntry(el, ctx, todayRow, last, before) {
  if (todayRow && !view.editing) {
    el.innerHTML = String(html`<div class="row"><h2 class="h2">Сегодня записано</h2><span class="chip chip-on">✓ в итоге дня</span></div>
      <p class="body-today"><b>${num(todayRow.weight)} кг</b>${todayRow.fat !== null ? html` · <b>${num(todayRow.fat)}%</b> жира` : ''}</p>
      <div class="row-gap"><button type="button" class="ghost" id="body-edit">Изменить</button>
        <button type="button" class="ghost" id="body-clear">Удалить</button></div>`);
    el.querySelector('#body-edit').addEventListener('click', () => { view.editing = true; renderEntry(el, ctx, todayRow, last, before); });
    el.querySelector('#body-clear').addEventListener('click', async () => {
      if (!confirm('Удалить сегодняшнее взвешивание?')) return;
      try {
        await ctx.api.deleteBody(ctx.athleteId, todayRow.date);
        ctx.toast('Удалено');
        ctx.refresh();
      } catch (e) { ctx.toast(e.message); }
    });
    return;
  }
  const base = todayRow ?? last;
  el.innerHTML = String(html`
    <div class="row"><h2 class="h2">Взвешивание за сегодня</h2></div>
    <p class="label">Запиши до 00:00 — цифры попадут в итог дня. Лучше взвешиваться в одно и то же время.</p>
    <div class="grid-2">
      ${stepper('weight', 'Вес, кг', base?.weight ?? '', 'например 72,4')}
      ${stepper('fat', 'Жир, %', base?.fat ?? '', 'например 15,0')}
    </div>
    <p class="error" id="body-error" role="alert"></p>
    <button type="button" class="btn" id="body-save">Записать в итог дня</button>
    ${todayRow ? html`<button type="button" class="ghost" id="body-cancel">Отмена</button>` : ''}`);

  el.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
    const input = el.querySelector(`#body-${b.dataset.field}`);
    const v = parse(input.value);
    const startAt = v ?? (b.dataset.field === 'weight' ? 70 : 15);
    input.value = num(Math.max(0, startAt + Number(b.dataset.step)));
    input.dispatchEvent(new Event('input'));
  }));
  el.querySelector('#body-cancel')?.addEventListener('click', () => { view.editing = false; renderEntry(el, ctx, todayRow, last, before); });
  el.querySelector('#body-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const err = el.querySelector('#body-error');
    const weight = parse(el.querySelector('#body-weight').value);
    const fatRaw = el.querySelector('#body-fat').value.trim();
    const fat = fatRaw === '' ? null : parse(fatRaw);
    if (weight === null || weight < 25 || weight > 300) { err.textContent = 'Вес — число от 25 до 300, например 72,4'; return; }
    if (fatRaw !== '' && (fat === null || fat < 2 || fat > 70)) { err.textContent = 'Жир — число от 2 до 70, например 15,5'; return; }
    err.textContent = '';
    btn.disabled = true;
    try {
      await ctx.api.saveBody(weight, fat);
      view.editing = false;
      const news = record(before, { weight, fat });
      if (news) confetti();
      ctx.toast(news ?? 'Записано в итог дня 💪');
      setTimeout(() => ctx.refresh(), news ? 1200 : 0);
    } catch (x) { err.textContent = x.message; btn.disabled = false; }
  });
}

// Новый рекорд — салют. before — взвешивания до сегодняшнего.
function record(before, b) {
  if (!before.length) return 'Первое взвешивание — старт есть! 🚀';
  const fats = before.filter((x) => x.fat !== null);
  if (b.fat === null || !fats.length) return null;
  const was = Math.max(...fats.map((x) => rankOf(x.fat)));
  const now = rankOf(b.fat);
  if (now > was) return `Новый ранг: ${RANKS[now].name} ${RANKS[now].icon}`;
  if (b.fat < Math.min(...fats.map((x) => x.fat))) return 'Рекорд: меньше всего жира за всё время! 🔥';
  if (lean(b) > Math.max(...fats.map(lean))) return 'Рекорд сухой массы — мышцы растут! 💪';
  return null;
}

function stepper(field, label, v, placeholder) {
  return html`<div class="field"><label class="label" for="body-${field}">${label}</label>
    <div class="stepper">
      <button type="button" class="ghost icon" data-field="${field}" data-step="-0.1" aria-label="${label}: минус 0,1">−</button>
      <input class="input stepper-in" id="body-${field}" type="text" inputmode="decimal" autocomplete="off"
        value="${v === '' || v === null ? '' : num(v)}" placeholder="${placeholder}">
      <button type="button" class="ghost icon" data-field="${field}" data-step="0.1" aria-label="${label}: плюс 0,1">+</button>
    </div></div>`;
}

function parse(text) {
  const v = Number(String(text).trim().replace(',', '.'));
  return String(text).trim() === '' || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;
}

// ── График: одна метрика за раз, своя шкала ──

function renderChart(el, rows, hasFat, today) {
  const m = METRICS.find((x) => x.k === view.metric);
  const from = view.range ? addDays(today, -(view.range - 1)) : rows[0].date;
  const pts = rows.filter((b) => b.date >= from).map((b) => ({ date: b.date, v: value(b, m.k) })).filter((p) => p.v !== null);
  const change = pts.length >= 2 ? pts[pts.length - 1].v - pts[0].v : null;
  const g = pts.length >= 2 ? geom(pts, from, today) : null;

  el.innerHTML = String(html`
    <div class="row"><h2 class="h2">Динамика</h2>
      <div class="seg seg-sm" role="group" aria-label="Период">${RANGES.map((r) => html`<button type="button"
        class="pill ${view.range === r.k ? 'pill-on' : ''}" data-range="${r.k}" aria-pressed="${view.range === r.k}">${r.label}</button>`)}</div></div>
    <div class="seg" role="group" aria-label="Что показать">${METRICS.map((x) => html`<button type="button"
      class="pill ${view.metric === x.k ? 'pill-on' : ''}" data-metric="${x.k}" aria-pressed="${view.metric === x.k}"
      ${x.k !== 'weight' && !hasFat ? html`disabled` : ''}>${x.label}</button>`)}</div>
    ${change !== null ? html`<p class="body-change"><b class="${tone(change, m.better)}">${signed(change)} ${m.unit}</b>
      <span class="label">${view.range ? `за ${view.range === 14 ? '2 недели' : 'месяц'}` : `с ${shortDate(pts[0].date)}`}</span></p>` : ''}
    ${g ? chart(pts, m, g)
      : html`<p class="label">За этот период мало взвешиваний — выбери период побольше.</p>`}
  `);

  el.querySelectorAll('[data-metric]').forEach((b) => b.addEventListener('click', () => {
    view.metric = b.dataset.metric;
    renderChart(el, rows, hasFat, today);
  }));
  el.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => {
    view.range = Number(b.dataset.range);
    renderChart(el, rows, hasFat, today);
  }));
  if (g) wireTip(el, pts, m, g.xy);
}

const W = 340;
const H = 190;
const PAD = { l: 40, r: 14, t: 16, b: 26 };

const dayNo = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000;

function scales(pts, from, today) {
  const x0 = dayNo(from);
  const x1 = Math.max(dayNo(today), dayNo(pts[pts.length - 1].date));
  const vs = pts.map((p) => p.v);
  let lo = Math.min(...vs);
  let hi = Math.max(...vs);
  const pad = Math.max((hi - lo) * 0.25, 0.4);
  lo -= pad;
  hi += pad;
  const x = (iso) => PAD.l + ((dayNo(iso) - x0) / Math.max(1, x1 - x0)) * (W - PAD.l - PAD.r);
  const y = (v) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  return { x, y, lo, hi };
}

// Плавная линия без «перелётов» (монотонная кубическая).
function smooth(p) {
  const n = p.length;
  if (n < 3) return `M${p.map((q) => `${q[0]},${q[1]}`).join('L')}`;
  const d = [];
  const t = [];
  for (let i = 0; i < n - 1; i += 1) d.push((p[i + 1][1] - p[i][1]) / (p[i + 1][0] - p[i][0] || 1));
  t.push(d[0]);
  for (let i = 1; i < n - 1; i += 1) t.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  t.push(d[n - 2]);
  let s = `M${p[0][0]},${p[0][1]}`;
  for (let i = 0; i < n - 1; i += 1) {
    const h = (p[i + 1][0] - p[i][0]) / 3;
    s += `C${p[i][0] + h},${p[i][1] + t[i] * h} ${p[i + 1][0] - h},${p[i + 1][1] - t[i + 1] * h} ${p[i + 1][0]},${p[i + 1][1]}`;
  }
  return s;
}

const r1 = (v) => Math.round(v * 10) / 10;

function geom(pts, from, today) {
  const s = scales(pts, from, today);
  return { ...s, xy: pts.map((p) => [r1(s.x(p.date)), r1(s.y(p.v))]) };
}

function chart(pts, m, { x, y, lo, hi, xy }) {
  const line = smooth(xy);
  const base = H - PAD.b;
  const area = `${line}L${xy[xy.length - 1][0]},${base}L${xy[0][0]},${base}Z`;
  const ticks = [0, 0.5, 1].map((k) => lo + (hi - lo) * (0.15 + 0.7 * k));
  const minI = pts.reduce((b, p, i) => (p.v < pts[b].v ? i : b), 0);
  const maxI = pts.reduce((b, p, i) => (p.v > pts[b].v ? i : b), 0);
  const lastP = xy[xy.length - 1];
  const xLabels = [pts[0].date, pts[pts.length - 1].date];
  return html`<div class="chart" data-unit="${m.unit}">
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="${m.label}: от ${num(pts[0].v)} до ${num(pts[pts.length - 1].v)} ${m.unit}, минимум ${num(pts[minI].v)}, максимум ${num(pts[maxI].v)}">
      <defs><linearGradient id="body-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#C6F432" stop-opacity=".32"/><stop offset="1" stop-color="#C6F432" stop-opacity="0"/>
      </linearGradient></defs>
      ${ticks.map((v) => html`<line class="grid-ln" x1="${PAD.l}" x2="${W - PAD.r}" y1="${r1(y(v))}" y2="${r1(y(v))}"/>
        <text class="axis-tx" x="${PAD.l - 6}" y="${r1(y(v)) + 4}" text-anchor="end">${num(v)}</text>`)}
      ${xLabels.map((d, i) => html`<text class="axis-tx" x="${r1(x(d))}" y="${H - 6}" text-anchor="${i ? 'end' : 'start'}">${shortDate(d)}</text>`)}
      <path class="chart-area" d="${area}" fill="url(#body-grad)"/>
      <path class="chart-line" d="${line}" pathLength="1"/>
      ${pts.length <= 40 ? xy.slice(0, -1).map((q) => html`<circle class="chart-dot" cx="${q[0]}" cy="${q[1]}" r="3"/>`) : ''}
      <circle class="chart-halo" cx="${lastP[0]}" cy="${lastP[1]}" r="6"/>
      <circle class="chart-last" cx="${lastP[0]}" cy="${lastP[1]}" r="5"/>
      <line class="chart-cross" id="cross" x1="0" x2="0" y1="${PAD.t}" y2="${base}" visibility="hidden"/>
      <circle class="chart-pick" id="pick" r="5" cx="0" cy="0" visibility="hidden"/>
      <rect class="chart-hit" x="${PAD.l}" y="0" width="${W - PAD.l - PAD.r}" height="${H}"/>
    </svg>
    <div class="chart-tip" id="tip" hidden></div>
  </div>
  <p class="label chart-note">Мин. ${num(pts[minI].v)} ${m.unit} (${shortDate(pts[minI].date)}) · Макс. ${num(pts[maxI].v)} ${m.unit} (${shortDate(pts[maxI].date)})</p>`;
}

// Палец или мышь над графиком — вертикальная линия и подсказка с датой и числом.
function wireTip(el, pts, m, xy) {
  const svg = el.querySelector('.chart-svg');
  const tip = el.querySelector('#tip');
  const cross = svg.querySelector('#cross');
  const pick = svg.querySelector('#pick');
  const dots = xy.map(([cx, cy]) => ({ cx, cy }));
  const show = (ev) => {
    const box = svg.getBoundingClientRect();
    const vx = ((ev.clientX - box.left) / box.width) * W;
    let best = 0;
    dots.forEach((d, i) => { if (Math.abs(d.cx - vx) < Math.abs(dots[best].cx - vx)) best = i; });
    const d = dots[best];
    const p = pts[best];
    cross.setAttribute('x1', d.cx); cross.setAttribute('x2', d.cx); cross.setAttribute('visibility', 'visible');
    pick.setAttribute('cx', d.cx); pick.setAttribute('cy', d.cy); pick.setAttribute('visibility', 'visible');
    const prevP = pts[best - 1];
    tip.innerHTML = String(html`<b>${num(p.v)} ${m.unit}</b><span>${dayTitle(p.date)}</span>
      ${prevP ? html`<span class="${tone(p.v - prevP.v, m.better)}">${signed(p.v - prevP.v)} ${m.unit} к прошлому</span>` : ''}`);
    tip.hidden = false;
    const left = (d.cx / W) * box.width;
    tip.style.left = `${Math.min(Math.max(left, 70), box.width - 70)}px`;
    tip.style.top = `${(d.cy / H) * box.height}px`;
  };
  const hide = () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    pick.setAttribute('visibility', 'hidden');
  };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', hide);
}

// ── История: последние 7 сразу, остальное под «Показать все» ──

function history(rows, isAdmin, today) {
  const list = rows.slice().reverse();
  const item = (b, i) => histRow(b, list[i + 1], isAdmin, today);
  const head = list.slice(0, 7);
  const rest = list.slice(7);
  return html`<ul class="ledger body-list">${head.map((b, i) => item(b, i))}</ul>
    ${rest.length ? html`<details class="more"><summary class="label">Показать все (${list.length})</summary>
      <ul class="ledger body-list">${rest.map((b, i) => item(b, i + 7))}</ul></details>` : ''}`;
}

function histRow(b, older, isAdmin, today) {
  const dw = older ? b.weight - older.weight : null;
  const df = older && b.fat !== null && older.fat !== null ? b.fat - older.fat : null;
  return html`<li>
    <div class="row"><span><b>${num(b.weight)} кг</b>${b.fat !== null ? html` · ${num(b.fat)}%` : ''}</span>
      <span class="row-gap nowrap">
        ${dw !== null ? html`<span class="label">${signed(dw)} кг</span>` : ''}
        ${df !== null ? html`<span class="label ${tone(df, -1)}">${signed(df)}%</span>` : ''}
        ${isAdmin ? html`<button type="button" class="ghost icon del-led" data-del="${b.date}" aria-label="Удалить взвешивание">✕</button>` : ''}
      </span></div>
    <p class="label">${b.date === today ? 'Сегодня' : dayTitle(b.date)}</p>
  </li>`;
}
