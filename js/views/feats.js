// Ачивки во вкладке «Цель»: у каждой пять уровней — Бронза, Серебро, Золото, Алмаз и Легенда (это примерно полгода без пропусков).
// Всё считается на экране из истории (дни, подходы, журнал очков, взвешивания); в базе ничего не хранится.

import { html, addDays, isoDow } from '../util.js';
import { dayCounts } from '../logic.js';

export const TIERS = [
  { name: 'Бронза', color: '#C98A5B' },
  { name: 'Серебро', color: '#B8C0CC' },
  { name: 'Золото', color: '#FFC94D' },
  { name: 'Алмаз', color: '#8FB8FF' },
  { name: 'Легенда', color: '#C6F432' },
];
const ROMAN = ['I', 'II', 'III', 'IV', 'V'];
const TOP = TIERS.length;

// Линейки ачивок. tiers — пороги уровней, value — сколько уже есть.
// Пороги подогнаны под план: ~9 подходов и ~90 повторов за тренировку, ~3,5 тыс. очков в день.
export const TRACKS = [
  { k: 'streak', group: 'train', icon: '🔥', name: 'Серия', what: 'тренировок подряд без пропуска', tiers: [7, 14, 30, 60, 150] },
  { k: 'sets', group: 'train', icon: '💯', name: 'Принятые подходы', what: 'подходов принял генерал', tiers: [50, 150, 400, 800, 1600] },
  { k: 'reps', group: 'train', icon: '🏋️', name: 'Тонна повторов', what: 'повторов всего', tiers: [500, 2000, 5000, 10000, 20000] },
  { k: 'over', group: 'train', icon: '🦾', name: 'Сверх нормы', what: 'подходов больше цели', tiers: [10, 30, 75, 150, 400] },
  { k: 'perfect', group: 'train', icon: '🎯', name: 'Идеальный день', what: 'дней, где все подходы не меньше цели', tiers: [5, 15, 40, 100, 150] },
  { k: 'hundred', group: 'train', icon: '💥', name: 'Сотка за день', what: 'дней, где за день 100+ повторов', tiers: [5, 15, 40, 80, 120] },
  { k: 'clean', group: 'train', icon: '🧱', name: 'Железная дисциплина', what: 'дней подряд без пропуска', tiers: [14, 30, 60, 100, 180] },
  { k: 'fire', group: 'train', icon: '📅', name: 'Неделя огня', what: 'полных недель без единого пропуска', tiers: [2, 5, 10, 20, 26] },
  { k: 'nobuy', group: 'train', icon: '🛡️', name: 'Без поблажек', what: 'недель подряд без купленного выходного', tiers: [2, 4, 8, 12, 26] },
  { k: 'pb', group: 'train', icon: '📈', name: 'Личный рекорд', what: 'раз побил свой рекорд в подходе', tiers: [3, 10, 25, 50, 100] },
  { k: 'plank', group: 'train', icon: '⏱️', name: 'Каменная планка', what: 'секунд в лучшем подходе на время', tiers: [60, 120, 180, 300, 600] },
  { k: 'allin', group: 'train', icon: '🎲', name: 'Ва-банк', what: 'выигранных «Всё или ничего»', tiers: [1, 3, 7, 15, 25] },
  { k: 'rating', group: 'train', icon: '🏆', name: 'Рейтинг', what: 'очков заработано за всё время', tiers: [10000, 50000, 120000, 200000, 500000] },
  { k: 'bank', group: 'train', icon: '🐷', name: 'Копилка', what: 'очков на балансе одновременно', tiers: [10000, 40000, 100000, 150000, 300000] },
  { k: 'ninja', group: 'train', icon: '🥷', name: 'Ниндзя', what: 'подходов отмечено в 23:50 и позже', tiers: [1, 5, 15, 30, 60], secret: true },
  { k: 'weighs', group: 'body', icon: '⚖️', name: 'На весах', what: 'взвешиваний всего', tiers: [7, 30, 75, 150, 250] },
  { k: 'wstreak', group: 'body', icon: '🔁', name: 'Весы без пропуска', what: 'дней подряд на весах', tiers: [7, 14, 30, 60, 180] },
  { k: 'fatdrop', group: 'body', icon: '🧊', name: 'Сушка', what: '% жира сброшено от старта', tiers: [1, 2, 4, 6, 8], dec: true },
  { k: 'lean', group: 'body', icon: '💪', name: 'Мышцы растут', what: 'кг сухой массы прибавлено', tiers: [0.5, 1, 2, 3, 5], dec: true },
];

const tallinn = (ts, opt) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Tallinn', ...opt }).format(new Date(ts));

// Все числа для ачивок одним проходом по истории.
export function stats({ days, logs, ledger, catalog, start, today, rating }, body) {
  const ok = logs.filter((l) => (l.review === 'accepted' || l.review === 'corrected') && l.confirmed > 0);
  const sec = new Set(catalog.filter((e) => e.unit === 'sec').map((e) => e.id));
  const byDay = new Map(days.map((d) => [d.date, d]));
  const logsBy = new Map();
  logs.forEach((l) => { if (!logsBy.has(l.date)) logsBy.set(l.date, []); logsBy.get(l.date).push(l); });

  let s = 0; let streak = 0; let clean = 0; let cleanBest = 0; let perfect = 0;
  let fire = 0; let nobuy = 0; let nobuyBest = 0;
  let wk = { trained: false, missed: false, bought: false };
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const row = byDay.get(d);
    let missed = false;
    if (row?.status === 'bought') wk.bought = true;
    if (row?.status === 'training' && row.plan?.length) {
      const dl = logsBy.get(d) ?? [];
      const c = dayCounts(row.plan, dl);
      if (c.done >= c.total) {
        s += 1; streak = Math.max(streak, s);
        const full = row.plan.every((e) => Array.from({ length: e.sets }, (_, i) => dl.find((l) => l.exercise_id === e.id && l.set_no === i + 1))
          .every((l) => l && (l.review === 'accepted' || l.review === 'corrected') && l.confirmed >= (e.target_reps || 1)));
        if (full) perfect += 1;
      } else if (d < today) { s = 0; missed = true; }
    }
    if (d < today) { clean = missed ? 0 : clean + 1; cleanBest = Math.max(cleanBest, clean); }
    if (row?.status === 'training' && row.plan?.length) wk.trained = true;
    if (missed) wk.missed = true;
    // Неделя закрывается в воскресенье, если оно уже прошло.
    if (isoDow(d) === 7 && d < today) {
      if (wk.trained && !wk.missed) fire += 1;
      nobuy = wk.bought ? 0 : nobuy + 1; nobuyBest = Math.max(nobuyBest, nobuy);
      wk = { trained: false, missed: false, bought: false };
    }
  }

  const over = ok.filter((l) => {
    const t = byDay.get(l.date)?.plan?.find((e) => e.id === l.exercise_id)?.target_reps;
    return t && l.confirmed > t;
  }).length;
  let pb = 0;
  const best = new Map();
  ok.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.set_no - b.set_no)).forEach((l) => {
    const was = best.get(l.exercise_id);
    if (was !== undefined && l.confirmed > was) pb += 1;
    if (was === undefined || l.confirmed > was) best.set(l.exercise_id, l.confirmed);
  });
  const repsBy = new Map();
  ok.filter((l) => !sec.has(l.exercise_id)).forEach((l) => repsBy.set(l.date, (repsBy.get(l.date) ?? 0) + l.confirmed));
  let bal = 0; let bank = 0;
  ledger.slice().sort((a, b) => a.id - b.id).forEach((x) => { bal += x.amount ?? 0; bank = Math.max(bank, bal); });
  const mod = new Map();
  ledger.filter((x) => x.kind === 'modifier').forEach((x) => mod.set(x.date, (mod.get(x.date) ?? 0) + x.rating));

  const dayNo = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000;
  let ws = body.length ? 1 : 0; let wstreak = ws;
  for (let i = 1; i < body.length; i += 1) {
    ws = dayNo(body[i].date) - dayNo(body[i - 1].date) === 1 ? ws + 1 : 1;
    wstreak = Math.max(wstreak, ws);
  }
  const fats = body.filter((b) => b.fat !== null);
  const lean = (b) => b.weight * (100 - b.fat) / 100;

  return {
    streak,
    sets: ok.length,
    reps: ok.filter((l) => !sec.has(l.exercise_id)).reduce((a, l) => a + l.confirmed, 0),
    over,
    perfect,
    hundred: [...repsBy.values()].filter((v) => v >= 100).length,
    clean: cleanBest,
    fire,
    nobuy: nobuyBest,
    pb,
    plank: Math.max(0, ...ok.filter((l) => sec.has(l.exercise_id)).map((l) => l.confirmed)),
    allin: [...mod.values()].filter((v) => v > 0).length,
    rating: rating ?? 0,
    bank,
    weighs: body.length,
    wstreak,
    fatdrop: fats.length ? Math.round((fats[0].fat - Math.min(...fats.map((b) => b.fat))) * 10) / 10 : 0,
    lean: fats.length ? Math.max(0, Math.round((Math.max(...fats.map(lean)) - lean(fats[0])) * 10) / 10) : 0,
    ninja: logs.filter((l) => l.claimed > 0 && l.updated_at && tallinn(l.updated_at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) >= '23:50'
      && tallinn(l.updated_at, { year: 'numeric', month: '2-digit', day: '2-digit' }) === l.date).length,
  };
}

const fmt = (v, dec) => (dec ? String(v).replace('.', ',') : Number(v).toLocaleString('ru-RU'));
const levelOf = (t, v) => t.tiers.filter((x) => v >= x).length;

// Медаль: шестиугольник цвета уровня, внутри значок, снизу римская цифра.
function medal(t, lvl, hidden) {
  const c = lvl ? TIERS[lvl - 1].color : '#3A3F4A';
  return html`<span class="fx-medal ${lvl ? 'fx-medal-on' : ''} ${lvl === TOP ? 'fx-medal-max' : ''}" style="--c: ${c}">
    <svg viewBox="0 0 56 62" aria-hidden="true"><path d="M28 2 L53 16 L53 46 L28 60 L3 46 L3 16 Z"/></svg>
    <span class="fx-medal-ic">${hidden ? '❓' : t.icon}</span>
    ${lvl ? html`<span class="fx-medal-lv">${ROMAN[lvl - 1]}</span>` : ''}
  </span>`;
}

export function row(t, v, open) {
  const lvl = levelOf(t, v);
  const hidden = t.secret && !lvl;
  const next = t.tiers[lvl];
  const prevT = lvl ? t.tiers[lvl - 1] : 0;
  const pct = next === undefined ? 100 : Math.max(2, Math.min(100, ((v - prevT) / (next - prevT)) * 100));
  return html`<details class="fx-row ${lvl === TOP ? 'fx-row-max' : ''}" style="--c: ${TIERS[TOP - 1].color}" ${open ? html`open` : ''}>
    <summary>
      ${medal(t, lvl, hidden)}
      <span class="fx-body">
        <span class="fx-top"><b>${hidden ? '???' : t.name}</b>
          <span class="fx-tier" style="--c: ${lvl ? TIERS[lvl - 1].color : 'var(--dim)'}">${hidden ? 'секрет' : lvl ? TIERS[lvl - 1].name : 'закрыто'}</span></span>
        <span class="label">${hidden ? 'Откроется сама. Ищи.' : next === undefined ? `${fmt(v, t.dec)} ${t.what} · всё взято`
          : `${fmt(Math.min(v, next), t.dec)} из ${fmt(next, t.dec)} · ${t.what}`}</span>
        <span class="fx-bar"><i style="width: ${pct}%; --c: ${next === undefined ? TIERS[TOP - 1].color : TIERS[lvl].color}"></i></span>
        <span class="fx-pips" aria-hidden="true">${t.tiers.map((_, i) => html`<i class="${i < lvl ? 'on' : ''}" style="--c: ${TIERS[i].color}"></i>`)}</span>
      </span>
    </summary>
    ${hidden ? '' : html`<ol class="fx-steps">${t.tiers.map((x, i) => html`<li class="${i < lvl ? 'done' : ''}" style="--c: ${TIERS[i].color}">
      <span class="fx-step-dot">${i < lvl ? '✓' : ROMAN[i]}</span><span>${TIERS[i].name}</span><b>${fmt(x, t.dec)}</b></li>`)}</ol>`}
  </details>`;
}

export function featsCard(data, body, { open = null } = {}) {
  const st = stats(data, body);
  const stars = TRACKS.reduce((a, t) => a + levelOf(t, st[t.k]), 0);
  const max = TRACKS.length * TOP;
  const level = Math.floor(stars / 4) + 1;
  const into = stars % 4;
  const counts = TIERS.map((_, i) => i + 1).map((l) => TRACKS.filter((t) => levelOf(t, st[t.k]) >= l).length);
  const group = (g, title) => html`<h3 class="cx-feat-h">${title}</h3>
    <div class="fx-list">${TRACKS.filter((t) => t.group === g).map((t) => row(t, st[t.k], t.k === open))}</div>`;
  return html`<section class="card fx-card">
    <div class="fx-head">
      <div class="fx-lvl"><span class="label">Уровень атлета</span><b>${level}</b></div>
      <div class="fx-xp">
        <div class="row"><span class="label">★ ${stars} из ${max}</span><span class="label">ещё ${4 - into} ★ до ${level + 1}-го</span></div>
        <span class="fx-xp-bar"><i style="width: ${(into / 4) * 100}%"></i></span>
        <div class="fx-counts">${TIERS.map((x, i) => html`<span style="--c: ${x.color}"><i></i>${counts[i]}</span>`)}</div>
      </div>
    </div>
    ${group('train', '💪 Тренировки')}
    ${group('body', '⚖️ Весы')}
  </section>`;
}
