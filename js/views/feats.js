// Ачивки во вкладке «Цель»: за тренировки и за весы. Всё считается на экране из истории —
// дни, подходы, журнал очков и взвешивания; в базе отдельно ничего не хранится.

import { html, addDays } from '../util.js';
import { dayCounts } from '../logic.js';
import { bodyBadges } from './body-parts.js';

const tallinnTime = (ts) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Tallinn', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(ts));

// Серии и дни без пропуска по истории. Выходной, больничный и купленный день серию не рвут и не продлевают.
function streaks(days, logs, start, today) {
  const byDay = new Map(days.map((d) => [d.date, d]));
  const logsBy = new Map();
  logs.forEach((l) => { if (!logsBy.has(l.date)) logsBy.set(l.date, []); logsBy.get(l.date).push(l); });
  let s = 0;
  let best = 0;
  let clean = 0;
  let bestClean = 0;
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const row = byDay.get(d);
    let missed = false;
    if (row?.status === 'training' && row.plan?.length) {
      const c = dayCounts(row.plan, logsBy.get(d) ?? []);
      if (c.done >= c.total) { s += 1; best = Math.max(best, s); } else if (d < today) { s = 0; missed = true; }
    }
    if (d < today) {
      clean = missed ? 0 : clean + 1;
      bestClean = Math.max(bestClean, clean);
    }
  }
  return { best, bestClean };
}

export function trainingBadges({ days, logs, ledger, catalog, start, today }) {
  const ok = logs.filter((l) => (l.review === 'accepted' || l.review === 'corrected') && l.confirmed > 0);
  const { best, bestClean } = start ? streaks(days, logs, start, today) : { best: 0, bestClean: 0 };
  const plans = new Map(days.map((d) => [d.date, d.plan ?? []]));
  const over = ok.filter((l) => {
    const t = plans.get(l.date)?.find((e) => e.id === l.exercise_id)?.target_reps;
    return t && l.confirmed > t;
  }).length;
  const sec = new Set(catalog.filter((e) => e.unit === 'sec').map((e) => e.id));
  const plank = ok.some((l) => sec.has(l.exercise_id) && l.confirmed >= 120);
  const mod = new Map();
  ledger.filter((x) => x.kind === 'modifier').forEach((x) => mod.set(x.date, (mod.get(x.date) ?? 0) + x.rating));
  const allin = [...mod.values()].some((v) => v > 0);
  const ninja = logs.some((l) => l.claimed > 0 && l.updated_at && tallinnTime(l.updated_at) >= '23:50'
    && new Date(l.updated_at).toLocaleDateString('en-CA', { timeZone: 'Europe/Tallinn' }) === l.date);
  return [
    { icon: '🔥', name: 'Серия 7', sub: '7 тренировок подряд', on: best >= 7 },
    { icon: '⚡', name: 'Серия 14', sub: '14 тренировок подряд', on: best >= 14 },
    { icon: '☄️', name: 'Серия 30', sub: '30 тренировок подряд', on: best >= 30 },
    { icon: '💯', name: 'Сотня', sub: '100 принятых подходов', on: ok.length >= 100, progress: [ok.length, 100] },
    { icon: '🦾', name: 'Сверх нормы', sub: '10 подходов больше цели', on: over >= 10, progress: [over, 10] },
    { icon: '🎲', name: 'Ва-банк', sub: 'выиграл «Всё или ничего»', on: allin },
    { icon: '⏱️', name: 'Каменная планка', sub: 'подход на время от 2 мин', on: plank },
    { icon: '🧱', name: 'Железный месяц', sub: '30 дней без пропуска', on: bestClean >= 30, progress: [bestClean, 30] },
    { icon: '🥷', name: 'Ниндзя', sub: 'отметил подход в 23:50+', on: ninja, secret: true },
  ];
}

function grid(list) {
  return html`<div class="cx-badges">${list.map((b) => {
    const hidden = b.secret && !b.on;
    const p = !b.on && b.progress && b.progress[0] > 0 ? Math.min(99, Math.floor((b.progress[0] * 100) / b.progress[1])) : null;
    return html`<div class="cx-badge ${b.on ? 'cx-badge-on' : ''} ${hidden ? 'cx-badge-secret' : ''}">
      <span class="cx-badge-ic" aria-hidden="true">${b.on ? b.icon : hidden ? '❓' : '🔒'}</span>
      <b>${hidden ? '???' : b.name}</b><span class="label">${hidden ? 'секретная — откроется сама' : b.sub}</span>
      ${p !== null ? html`<span class="cx-badge-bar" aria-label="${b.progress[0]} из ${b.progress[1]}"><i style="width: ${p}%"></i></span>` : ''}
    </div>`;
  })}</div>`;
}

export function featsCard(data, body) {
  const train = trainingBadges(data);
  const scale = bodyBadges(body);
  const got = [...train, ...scale].filter((b) => b.on).length;
  return html`<section class="card">
    <div class="row"><h2 class="h2">Ачивки</h2><span class="chip ${got ? 'chip-on' : ''}">${got} из ${train.length + scale.length}</span></div>
    <h3 class="cx-feat-h">💪 Тренировки</h3>
    ${grid(train)}
    <h3 class="cx-feat-h">⚖️ Весы</h3>
    ${body.length ? '' : html`<p class="label">Открываются во вкладке «Тело»: взвешивайся, держи серию, сушись.</p>`}
    ${grid(scale)}
  </section>`;
}
