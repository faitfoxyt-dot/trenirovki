// Куски вкладки «Тело»: скан с кольцом состава и рангом, прогноз, тепловая карта, недели.
// И ачивки за взвешивания — их показывает «Цель» (feats.js). rows — [{date, weight, fat|null}] по дате.

import { html, raw, dayTitle, shortDate, addDays, isoDow } from '../util.js';

export const num = (v) => Number(v).toFixed(1).replace('.', ',');
export const signed = (v) => (Math.abs(v) < 0.05 ? '±0' : `${v > 0 ? '+' : '−'}${num(Math.abs(v))}`);
export const lean = (b) => (b.fat === null || b.fat === undefined ? null : Math.round(b.weight * (100 - b.fat)) / 100);
const dayNo = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000;
const fromNo = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const withFat = (rows) => rows.filter((b) => b.fat !== null && b.fat !== undefined);

// Ранги по % жира: чем меньше, тем выше. max — верхняя граница ранга.
export const RANKS = [
  { name: 'Бронза', max: 99, color: '#C98A5B', icon: '🥉' },
  { name: 'Серебро', max: 20, color: '#B8C0CC', icon: '🥈' },
  { name: 'Золото', max: 17, color: '#FFC94D', icon: '🥇' },
  { name: 'Платина', max: 14, color: '#7FE7D9', icon: '💠' },
  { name: 'Алмаз', max: 11, color: '#8FB8FF', icon: '💎' },
  { name: 'Легенда', max: 8, color: '#C6F432', icon: '👑' },
];

export function rankOf(fat) {
  let i = 0;
  RANKS.forEach((r, k) => { if (fat <= r.max) i = k; });
  return i;
}

// Линейный тренд: наклон в единицах за день.
function trend(pts) {
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const my = pts.reduce((a, p) => a + p.y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  pts.forEach((p) => { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; });
  const k = sxx ? sxy / sxx : 0;
  return { k, b: my - k * mx };
}

// ── Скан: вес в центре кольца, кольцо — сухая масса и жир, внешняя дуга — путь до следующего ранга ──

export function scanCard(rows) {
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2] ?? null;
  const first = rows[0];
  const hasFat = last.fat !== null;
  const l = lean(last);
  const fatKg = hasFat ? Math.round((last.weight - l) * 10) / 10 : null;
  const r = hasFat ? rankOf(last.fat) : null;
  const rank = hasFat ? RANKS[r] : null;
  const next = hasFat ? RANKS[r + 1] : null;
  const top = hasFat ? (rank.max === 99 ? 25 : rank.max) : 0;
  const toNext = next ? last.fat - next.max : 0;
  const rankPct = !hasFat ? 0 : next ? Math.max(4, Math.min(100, ((top - last.fat) / (top - next.max)) * 100)) : 100;
  const R = 78;
  const C = 2 * Math.PI * R;
  const leanLen = hasFat ? (C * (100 - last.fat)) / 100 : C;
  const R2 = 92;
  const C2 = 2 * Math.PI * R2;
  const firstFat = withFat(rows)[0];
  return html`<section class="card cx-scan" style="--rank: ${rank ? rank.color : '#C6F432'}">
    <span class="cx-corner tl"></span><span class="cx-corner tr"></span><span class="cx-corner bl"></span><span class="cx-corner br"></span>
    <div class="cx-ring-wrap">
      <svg class="cx-ring" viewBox="0 0 220 220" aria-hidden="true">
        <defs>
          <linearGradient id="cx-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#E2FF7A"/><stop offset="1" stop-color="#9BD40F"/></linearGradient>
          <linearGradient id="cx-sweep-g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#C6F432" stop-opacity="0"/><stop offset="1" stop-color="#C6F432" stop-opacity=".18"/></linearGradient>
          <filter id="cx-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>
        ${Array.from({ length: 60 }, (_, i) => {
          const a = (i / 60) * Math.PI * 2;
          const r2 = i % 5 ? 101 : 97;
          const p = (v) => Math.round(v * 10) / 10;
          return html`<line class="cx-tick" x1="${p(110 + 104 * Math.cos(a))}" y1="${p(110 + 104 * Math.sin(a))}" x2="${p(110 + r2 * Math.cos(a))}" y2="${p(110 + r2 * Math.sin(a))}"/>`;
        })}
        <circle cx="110" cy="110" r="${R2}" class="cx-track2"/>
        ${hasFat ? html`<circle cx="110" cy="110" r="${R2}" class="cx-rank-arc" stroke-dasharray="${(C2 * rankPct) / 100} ${C2}" transform="rotate(-90 110 110)"/>` : ''}
        <circle cx="110" cy="110" r="${R}" class="cx-track"/>
        ${hasFat ? html`<circle cx="110" cy="110" r="${R}" class="cx-fat" stroke-dasharray="${Math.max(0, C - leanLen - 4)} ${C}" stroke-dashoffset="${-leanLen - 2}" transform="rotate(-90 110 110)"/>` : ''}
        <circle cx="110" cy="110" r="${R}" class="cx-lean" stroke="url(#cx-g)" filter="url(#cx-glow)" stroke-dasharray="${leanLen} ${C}" transform="rotate(-90 110 110)"/>
        <g class="cx-sweep"><path d="M110 110 L110 18 A92 92 0 0 1 175 45 Z" fill="url(#cx-sweep-g)"/></g>
      </svg>
      <div class="cx-center">
        <span class="cx-w" data-count="${last.weight}" data-from="${prev ? prev.weight : last.weight}">${num(last.weight)}</span>
        <span class="cx-unit">кг</span>
        ${prev ? html`<span class="cx-dw">${signed(last.weight - prev.weight)} к прошлому</span>` : ''}
      </div>
    </div>

    ${hasFat ? html`<div class="cx-legend">
      <span><i class="dot dot-lean"></i>Сухая масса <b>${num(l)} кг</b></span>
      <span><i class="dot dot-fat"></i>Жир <b>${num(fatKg)} кг · ${num(last.fat)}%</b></span>
    </div>

    <div class="cx-rank">
      <span class="cx-rank-ic" aria-hidden="true">${rank.icon}</span>
      <div class="cx-rank-txt"><span class="label">Ранг рельефа</span><b>${rank.name}</b></div>
      ${next ? html`<div class="cx-rank-next"><span class="label">до «${next.name}»</span><b>−${num(toNext)}%</b></div>`
        : html`<div class="cx-rank-next"><span class="label">высший ранг</span><b>MAX</b></div>`}
    </div>
    <div class="cx-rank-bar" role="progressbar" aria-label="Путь до следующего ранга" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(rankPct)}"><span style="width: ${rankPct}%"></span></div>`
    : html`<p class="label center">Впиши и % жира — появятся состав тела и ранг рельефа.</p>`}

    ${rows.length > 1 ? html`<div class="cx-chips">
      <span class="cx-chip">С ${shortDate(first.date)}: <b>${signed(last.weight - first.weight)} кг</b></span>
      ${hasFat && firstFat && firstFat.date !== last.date ? html`<span class="cx-chip">Жир: <b class="${last.fat <= firstFat.fat ? 'ok' : 'warn'}">${signed(last.fat - firstFat.fat)}%</b></span>
        <span class="cx-chip">Сухая масса: <b class="${l >= lean(firstFat) ? 'ok' : 'warn'}">${signed(l - lean(firstFat))} кг</b></span>` : ''}
    </div>` : ''}
  </section>`;
}

// ── Прогноз: жир за 4 недели и пунктир тренда до следующего ранга ──

export function forecastCard(rows, today) {
  const recent = withFat(rows).filter((b) => b.date >= addDays(today, -27));
  if (recent.length < 5) return '';
  const pts = recent.map((b) => ({ x: dayNo(b.date), y: Number(b.fat) }));
  const t = trend(pts);
  const lastP = pts[pts.length - 1];
  const next = RANKS[rankOf(lastP.y) + 1];
  const goal = next ? next.max : null;
  const perWeek = t.k * 7;
  const x0 = pts[0].x;
  const xNow = dayNo(today);
  const reach = goal !== null && t.k < -0.001 ? Math.ceil((goal - t.b) / t.k) : null;
  const near = reach !== null && reach - xNow <= 90;
  const x1 = near ? Math.max(xNow + 14, reach + 4) : xNow + 21;
  const W = 340;
  const H = 200;
  const P = { l: 34, r: 12, t: 14, b: 26 };
  const ys = [...pts.map((p) => p.y), t.k * x1 + t.b, ...(near ? [goal] : [])];
  const lo = Math.min(...ys) - 0.5;
  const hi = Math.max(...ys) + 0.5;
  const X = (x) => Math.round((P.l + ((x - x0) / (x1 - x0)) * (W - P.l - P.r)) * 10) / 10;
  const Y = (y) => Math.round((P.t + (1 - (y - lo) / (hi - lo)) * (H - P.t - P.b)) * 10) / 10;
  const line = `M${pts.map((p) => `${X(p.x)},${Y(p.y)}`).join('L')}`;
  const y0 = t.k * lastP.x + t.b;
  const y1 = t.k * x1 + t.b;
  const proj = `M${X(lastP.x)},${Y(y0)}L${X(x1)},${Y(y1)}`;
  const band = `M${X(lastP.x)},${Y(y0)}L${X(x1)},${Y(y1 - 0.6)}L${X(x1)},${Y(y1 + 0.6)}Z`;
  const ticks = [lo + 0.5, (lo + hi) / 2, hi - 0.5];
  const good = perWeek < -0.02;
  return html`<section class="card cx-forecast">
    <div class="row"><h2 class="h2">Прогноз</h2><span class="cx-pill">тренд · 4 недели</span></div>
    <p class="cx-headline">Темп <b class="${good ? 'ok' : 'warn'}">${signed(perWeek)}%</b> жира в неделю</p>
    <p class="label">${near ? html`Так держать — ранг «${next.name}» (${num(goal)}%) будет примерно <b class="em">${dayTitle(fromNo(reach))}</b>.`
      : next ? html`Чтобы дойти до «${next.name}» (${num(goal)}%), жир должен идти вниз.` : 'Высший ранг уже твой. Держи форму.'}</p>
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Жир за 4 недели и прогноз: ${signed(perWeek)}% в неделю">
      <defs><linearGradient id="cx-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C6F432" stop-opacity=".28"/><stop offset="1" stop-color="#C6F432" stop-opacity="0"/></linearGradient></defs>
      ${ticks.map((v) => html`<line class="grid-ln" x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="axis-tx" x="${P.l - 6}" y="${Y(v) + 4}" text-anchor="end">${num(v)}</text>`)}
      <rect x="${X(xNow)}" y="${P.t}" width="${X(x1) - X(xNow)}" height="${H - P.t - P.b}" class="cx-future"/>
      <text class="axis-tx" x="${X(xNow) + 6}" y="${P.t + 10}">будущее</text>
      ${near ? html`<line class="cx-target" x1="${P.l}" x2="${W - P.r}" y1="${Y(goal)}" y2="${Y(goal)}"/>
        <text class="cx-target-tx" x="${W - P.r}" y="${Y(goal) - 6}" text-anchor="end">${next.name} · ${num(goal)}%</text>` : ''}
      <path d="${line}L${X(lastP.x)},${H - P.b}L${X(x0)},${H - P.b}Z" fill="url(#cx-area)"/>
      <path class="chart-line" d="${line}" pathLength="1"/>
      <path class="cx-band" d="${band}"/>
      <path class="cx-proj" d="${proj}"/>
      ${near ? html`<circle class="cx-goal-dot" cx="${X(reach)}" cy="${Y(goal)}" r="6"/>` : ''}
      <circle class="chart-halo" cx="${X(lastP.x)}" cy="${Y(lastP.y)}" r="6"/>
      <circle class="chart-last" cx="${X(lastP.x)}" cy="${Y(lastP.y)}" r="5"/>
      <text class="axis-tx" x="${P.l}" y="${H - 6}">${shortDate(fromNo(x0))}</text>
      <text class="axis-tx" x="${X(xNow)}" y="${H - 6}" text-anchor="middle">сегодня</text>
      <text class="axis-tx" x="${W - P.r}" y="${H - 6}" text-anchor="end">${shortDate(fromNo(x1))}</text>
    </svg>
  </section>`;
}

// ── Дисциплина: 12 недель клетками, цвет — куда ушёл жир ──

export function heatCard(rows, today) {
  const by = new Map(rows.map((b, i) => [b.date, { b, prev: rows[i - 1] }]));
  const end = addDays(today, 7 - isoDow(today));
  const start = addDays(end, -83);
  const weeks = [];
  for (let w = 0; w < 12; w += 1) weeks.push(Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)));
  const cls = (d) => {
    if (d > today) return 'cx-h-future';
    const x = by.get(d);
    if (!x) return 'cx-h-none';
    if (!x.prev || x.b.fat === null || x.prev.fat === null) return 'cx-h-1';
    const df = x.b.fat - x.prev.fat;
    if (df <= -0.3) return 'cx-h-3';
    if (df < 0) return 'cx-h-2';
    if (df === 0) return 'cx-h-1';
    return 'cx-h-up';
  };
  const count = rows.filter((b) => b.date >= start).length;
  return html`<section class="card">
    <div class="row"><h2 class="h2">Дисциплина</h2><span class="label">${count} за 12 недель</span></div>
    <div class="cx-heat" role="img" aria-label="Взвешивания за 12 недель: ${count}">
      <div class="cx-heat-dow">${['Пн', '', 'Ср', '', 'Пт', '', 'Вс'].map((x) => html`<span>${x}</span>`)}</div>
      ${weeks.map((w) => html`<div class="cx-heat-col">${w.map((d) => html`<span class="cx-h ${cls(d)} ${d === today ? 'cx-h-today' : ''}"></span>`)}</div>`)}
    </div>
    <div class="cx-heat-legend label">
      <span><i class="cx-h cx-h-none"></i>не взвешивался</span>
      <span><i class="cx-h cx-h-1"></i>взвесился</span>
      <span><i class="cx-h cx-h-up"></i>жир вверх</span>
      <span><i class="cx-h cx-h-2"></i>жир вниз</span>
      <span><i class="cx-h cx-h-3"></i>сильно вниз</span>
    </div>
  </section>`;
}

// ── Неделя к неделе: средний % жира (или вес, если жира нет) ──

export function weeksCard(rows, today) {
  const fat = withFat(rows).length >= rows.length / 2;
  const weeks = [];
  for (let w = 3; w >= 0; w -= 1) {
    const to = addDays(today, -7 * w);
    const from = addDays(to, -6);
    const ws = (fat ? withFat(rows) : rows).filter((b) => b.date >= from && b.date <= to);
    if (!ws.length) continue;
    weeks.push({ label: w === 0 ? 'Эта' : `−${w} нед`, v: ws.reduce((a, b) => a + (fat ? b.fat : b.weight), 0) / ws.length });
  }
  if (weeks.length < 2) return '';
  const max = Math.max(...weeks.map((x) => x.v));
  const min = Math.min(...weeks.map((x) => x.v));
  const unit = fat ? '%' : ' кг';
  return html`<section class="card">
    <div class="row"><h2 class="h2">Неделя к неделе</h2><span class="label">${fat ? 'средний % жира' : 'средний вес'}</span></div>
    <div class="cx-weeks">${weeks.map((x, i) => {
      const h = 40 + ((x.v - min + 0.2) / (max - min + 0.2)) * 60;
      const d = i ? x.v - weeks[i - 1].v : null;
      return html`<div class="cx-wk ${i === weeks.length - 1 ? 'cx-wk-now' : ''}">
        <span class="cx-wk-v">${num(x.v)}${unit}</span>
        <span class="cx-wk-bar" style="height: ${Math.round(h)}px"></span>
        <span class="label">${x.label}</span>
        <span class="cx-wk-d ${d === null ? '' : !fat ? '' : d < 0 ? 'ok' : 'warn'}">${d === null ? raw('&nbsp;') : signed(d)}</span>
      </div>`;
    })}</div>
  </section>`;
}

// ── Ачивки за взвешивания (показывает «Цель» вместе с ачивками за тренировки) ──

export function bodyBadges(rows) {
  const first = rows[0];
  const fats = withFat(rows);
  let streak = rows.length ? 1 : 0;
  let best = streak;
  for (let i = 1; i < rows.length; i += 1) {
    streak = dayNo(rows[i].date) - dayNo(rows[i - 1].date) === 1 ? streak + 1 : 1;
    best = Math.max(best, streak);
  }
  const minFat = fats.length ? Math.min(...fats.map((b) => b.fat)) : null;
  const dropFat = fats.length ? fats[0].fat - minFat : 0;
  return [
    { icon: '⚖️', name: 'Старт', sub: 'первое взвешивание', on: rows.length >= 1 },
    { icon: '🔁', name: 'Неделя', sub: '7 дней подряд на весах', on: best >= 7, progress: [best, 7] },
    { icon: '📉', name: '−2 кг', sub: 'от первого взвешивания', on: rows.length > 1 && first.weight - Math.min(...rows.map((b) => b.weight)) >= 2 },
    { icon: '🧊', name: 'Сушка', sub: '−2% жира', on: dropFat >= 2 },
    { icon: '🎯', name: '50 раз', sub: 'на весах', on: rows.length >= 50, progress: [rows.length, 50] },
    { icon: '💠', name: 'Платина', sub: 'жир ≤ 14%', on: minFat !== null && minFat <= 14 },
    { icon: '🗓️', name: 'Месяц', sub: '30 дней подряд на весах', on: best >= 30, progress: [best, 30] },
    { icon: '💎', name: 'Алмаз', sub: 'жир ≤ 11%', on: minFat !== null && minFat <= 11 },
    { icon: '👑', name: 'Легенда', sub: 'жир ≤ 8%', on: minFat !== null && minFat <= 8 },
  ];
}
