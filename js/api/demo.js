// Демо-режим (?demo=1): те же функции, что и у Supabase, но данные живут
// в памяти вкладки. Правила дня и очков повторяют SQL-функции из supabase/migrations.

import { addDays, isoDow, tallinnNow, shortDate, WD_SHORT } from '../util.js';

const ADMIN = { id: 'admin', role: 'admin', name: 'Тимур' };
const ATHLETE = { id: 'athlete', role: 'athlete', name: 'Друг' };

const RULE_KEYS = ['calibration', 'points_per_rep', 'points_per_set', 'streak_from', 'streak_step', 'streak_max',
  'bonus_growth', 'bonus_over', 'bonus_cap_day', 'miss_penalty', 'rest_day_price', 'purchase_limit_week', 'phone_price'];

const db = {
  settings: { id: 1, start_date: null, grace_hours: 3 },
  rules: [{ valid_from: '2000-01-01', calibration: true }],
  template: [1, 2, 3, 4, 5, 6, 7].map((dow) => ({ dow, status: dow === 7 ? 'rest' : 'training' })),
  exercises: [
    { id: 1, name: 'Подтягивания', sets: 3, target_reps: null, position: 0, active: true },
    { id: 2, name: 'Пресс', sets: 3, target_reps: null, position: 1, active: true },
  ],
  days: [],
  logs: [],
  mornings: [],
  ledger: [],
  purchases: [],
  sick: [],
  ideas: [],
};
let current = ATHLETE;
let seq = 1;
let frozen = null; // «сегодня» во время заполнения истории

const clone = (x) => JSON.parse(JSON.stringify(x));
const fail = (message) => { throw new Error(message); };
const today = () => frozen ?? tallinnNow().today;
const stamp = () => new Date().toISOString();
const dayLabel = (date) => `${WD_SHORT[isoDow(date) - 1]}, ${shortDate(date)}`;
const weekStart = (date) => addDays(date, 1 - isoDow(date));

function clock() {
  const now = tallinnNow();
  return { today: now.today, time: now.time, grace: now.hour < db.settings.grace_hours };
}

// ── День ──

function currentPlan() {
  return db.exercises.filter((e) => e.active)
    .sort((a, b) => a.position - b.position || a.id - b.id)
    .map(({ id, name, sets, target_reps }) => ({ id, name, sets, target_reps }));
}

const findDay = (a, date) => db.days.find((x) => x.athlete_id === a && x.date === date);

function ensureDay(a, date) {
  let d = findDay(a, date);
  if (!d) {
    if (date > today()) return null;
    const t = db.template.find((x) => x.dow === isoDow(date));
    d = { athlete_id: a, date, status: t ? t.status : null, plan: null };
    db.days.push(d);
  }
  if (d.status === 'training' && !d.plan && date <= today()) d.plan = currentPlan();
  return d;
}

function dayStatusOf(a, date) {
  const d = findDay(a, date);
  if (d) return d.status ?? null;
  return db.template.find((t) => t.dow === isoDow(date))?.status ?? null;
}

function putStatus(a, date, status) {
  let d = findDay(a, date);
  if (!d) { d = { athlete_id: a, date, status, plan: null }; db.days.push(d); }
  d.status = status;
  if (status === 'training' && !d.plan && date <= today()) d.plan = currentPlan();
  return d;
}

// ── Очки ──

function rulesFor(date) {
  return db.rules.filter((r) => r.valid_from <= date)
    .sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0] ?? null;
}

const isCal = (r) => !r || r.calibration !== false;
const hasLogs = (a, date) => db.logs.some((l) => l.athlete_id === a && l.date === date && l.claimed !== null);
const balance = (a) => db.ledger.filter((x) => x.athlete_id === a).reduce((s, x) => s + x.amount, 0);
const rating = (a) => db.ledger.filter((x) => x.athlete_id === a).reduce((s, x) => s + x.rating, 0);
const hasKey = (a, key) => db.ledger.some((x) => x.athlete_id === a && x.key === key);

function streakAt(a, date) {
  const start = db.settings.start_date;
  if (!start) return 0;
  let n = 0;
  for (let d = date, i = 0; d >= start && i < 400; d = addDays(d, -1), i += 1) {
    if (dayStatusOf(a, d) !== 'training') continue;
    if (hasLogs(a, d)) n += 1;
    else if (d < today()) break;
  }
  return n;
}

function streakMult(r, s) {
  if (!r || r.streak_from == null || r.streak_step == null || s < r.streak_from) return 1;
  return Math.round(Math.min(r.streak_max ?? 1000, 1 + r.streak_step * (s - r.streak_from + 1)) * 100) / 100;
}

function addLedger(row) {
  if (row.key && hasKey(row.athlete_id, row.key)) return;
  db.ledger.push({ id: seq++, amount: 0, rating: 0, note: null, key: null, set_id: null, created_at: stamp(), ...row });
}

function awardSet(l) {
  const r = rulesFor(l.date);
  const ok = (l.review === 'accepted' || l.review === 'corrected') && l.confirmed !== null && !isCal(r);
  const ex = findDay(l.athlete_id, l.date)?.plan?.find((e) => e.id === l.exercise_id);
  const target = ex?.target_reps ?? null;
  const name = ex?.name ?? db.exercises.find((e) => e.id === l.exercise_id)?.name ?? 'Подход';
  let pts = 0;
  let bon = 0;
  let mult = 1;
  if (ok) {
    const full = l.confirmed > 0 && (target === null || l.confirmed >= target);
    const base = l.confirmed * (r.points_per_rep ?? 0) + (full ? r.points_per_set ?? 0 : 0);
    mult = streakMult(r, streakAt(l.athlete_id, l.date));
    pts = Math.round(base * mult);
    if (target !== null && l.confirmed > target && (r.bonus_over ?? 0) > 0) {
      bon = Math.round((l.confirmed - target) * r.bonus_over);
      if (r.bonus_cap_day != null) {
        const other = db.logs.filter((x) => x.athlete_id === l.athlete_id && x.date === l.date && x.id !== l.id)
          .reduce((s, x) => s + (x.bonus ?? 0), 0);
        bon = Math.max(0, Math.min(bon, r.bonus_cap_day - other));
      }
    }
  }
  const reviewed = l.points != null || l.bonus != null;
  const delta = pts + bon - (l.points ?? 0) - (l.bonus ?? 0);
  l.points = ok ? pts : null;
  l.bonus = ok ? bon : null;
  if (!delta) return;
  let note = `${reviewed ? 'Пересмотр: ' : ''}${name} · подход ${l.set_no}`;
  if (ok && mult > 1) note += ` · серия ×${mult}`;
  if (ok && bon > 0) note += ` · сверх цели +${bon}`;
  addLedger({ athlete_id: l.athlete_id, date: l.date, kind: 'set', amount: Math.max(delta, -balance(l.athlete_id)), rating: delta, note, set_id: l.id });
}

// Штрафы за пропуск, бонус за рост, вехи — как settle() в базе.
function settle(a) {
  const start = db.settings.start_date;
  if (!start) return;
  const t = today();
  for (let d = start > addDays(t, -30) ? start : addDays(t, -30); d < t; d = addDays(d, 1)) {
    const r = rulesFor(d);
    if (isCal(r) || !(r.miss_penalty > 0) || dayStatusOf(a, d) !== 'training' || hasLogs(a, d) || hasKey(a, `penalty:${d}`)) continue;
    ensureDay(a, d);
    const pen = Math.min(r.miss_penalty, balance(a));
    addLedger({ athlete_id: a, date: d, kind: 'penalty', amount: -pen,
      note: `Пропуск тренировки${pen < r.miss_penalty ? ' · баланс не уходит ниже нуля' : ''}`, key: `penalty:${d}` });
  }

  for (let i = 1; i <= 5; i += 1) {
    const wk = addDays(weekStart(t), -7 * i);
    const end = addDays(wk, 6);
    if (end < start) continue;
    const r = rulesFor(end);
    if (isCal(r) || !(r.bonus_growth > 0) || hasKey(a, `growth:${wk}`)) continue;
    const prevStart = addDays(wk, -7);
    if (db.logs.some((l) => l.athlete_id === a && l.date >= prevStart && l.date <= end && l.review === 'pending' && l.claimed !== null)) continue;
    const best = (from, to) => {
      const m = new Map();
      db.logs.filter((l) => l.athlete_id === a && l.date >= from && l.date <= to && (l.review === 'accepted' || l.review === 'corrected'))
        .forEach((l) => m.set(l.exercise_id, Math.max(m.get(l.exercise_id) ?? -1, l.confirmed)));
      return m;
    };
    const cur = best(wk, end);
    const prev = best(prevStart, addDays(wk, -1));
    const cnt = [...cur].filter(([id, b]) => prev.has(id) && b > prev.get(id)).length;
    if (cnt > 0) {
      addLedger({ athlete_id: a, date: end, kind: 'bonus_growth', amount: cnt * r.bonus_growth, rating: cnt * r.bonus_growth,
        note: `Рост за неделю: лучший подход вырос в ${cnt} упр.`, key: `growth:${wk}` });
    }
  }

  const price = rulesFor(t)?.phone_price;
  if (price > 0) {
    [25, 50, 75, 100].forEach((pct) => {
      if (balance(a) * 100 >= price * pct) {
        addLedger({ athlete_id: a, date: t, kind: 'milestone', key: `milestone:${pct}`,
          note: pct === 100 ? 'Цель: на телефон хватает' : `Веха: ${pct}% пути к телефону` });
      }
    });
  }
}

// ── Действия (общие для истории и для кнопок) ──

function review(l, decision, confirmed, comment) {
  l.review = decision;
  l.confirmed = { accepted: l.claimed, corrected: confirmed, rejected: 0 }[decision] ?? null;
  l.comment = (comment || '').trim() || null;
  awardSet(l);
  settle(l.athlete_id);
}

function buy(a, date) {
  const t = today();
  const r = rulesFor(t);
  if (date <= t) fail('Выходной покупается заранее, до начала дня');
  if (date > addDays(t, 60)) fail('Можно купить не дальше чем на 60 дней вперёд');
  if (r?.rest_day_price == null) fail('Цену выходного Тимур ещё не задал');
  const st = dayStatusOf(a, date);
  if (st !== 'training') fail('В этот день и так нет тренировки');
  if (r.purchase_limit_week != null) {
    const cnt = db.purchases.filter((p) => p.athlete_id === a && p.status === 'active' && weekStart(p.date) === weekStart(date)).length;
    if (cnt >= r.purchase_limit_week) fail(`На этой неделе лимит: ${r.purchase_limit_week} вых.`);
  }
  const bal = balance(a);
  if (bal < r.rest_day_price) fail(`Не хватает очков: нужно ${r.rest_day_price}, на балансе ${bal}`);
  const p = { id: seq++, athlete_id: a, date, price: r.rest_day_price, prev_status: st, status: 'active', created_at: stamp() };
  db.purchases.push(p);
  putStatus(a, date, 'bought');
  addLedger({ athlete_id: a, date, kind: 'purchase', amount: -p.price, note: `Выходной на ${dayLabel(date)}` });
  return p;
}

function setStatus(a, date, status) {
  if (status === 'bought') fail('Купленный выходной ставит атлет в магазине');
  const d = putStatus(a, date, status);
  const p = db.purchases.find((x) => x.athlete_id === a && x.date === date && x.status === 'active');
  if (p) {
    p.status = 'cancelled';
    addLedger({ athlete_id: a, date, kind: 'refund', amount: p.price, note: 'Тимур поменял день: очки за выходной вернулись' });
  }
  const pen = db.ledger.find((x) => x.athlete_id === a && x.key === `penalty:${date}`);
  if (status !== 'training' && pen && pen.amount < 0) {
    const word = { sick: 'больничный', rest: 'выходной', busy: 'занят' }[status];
    addLedger({ athlete_id: a, date, kind: 'refund', amount: -pen.amount, note: `Штраф снят: день стал «${word}»`, key: `unpenalty:${date}` });
  }
  return d;
}

// ── История для демо: калибровка, потом 2 недели с очками ──

(function seed() {
  const T = tallinnNow().today;
  const a = ATHLETE.id;
  const start = addDays(T, -20);
  const rulesFrom = addDays(start, 7);
  db.settings.start_date = start;
  db.rules.push({ valid_from: rulesFrom, calibration: false, points_per_rep: 1, points_per_set: 5,
    streak_from: 3, streak_step: 0.1, streak_max: 1.5, bonus_growth: 20, bonus_over: 1, bonus_cap_day: 5,
    miss_penalty: 100, rest_day_price: 150, purchase_limit_week: 2, phone_price: 4000 });

  let j = 0; // номер тренировочного дня
  const log = (date, ex, n, claimed, video = true) => {
    const row = { id: seq++, athlete_id: a, date, exercise_id: ex, set_no: n, claimed, has_video: video,
      review: 'pending', confirmed: null, comment: null, points: null, bonus: null };
    db.logs.push(row);
    return row;
  };

  for (let k = 0; k < 20; k += 1) {
    const d = addDays(start, k);
    frozen = d;
    settle(a);
    if (d === addDays(rulesFrom, -1)) {
      db.exercises[0].target_reps = 8;
      db.exercises[1].target_reps = 20;
    }
    if (dayStatusOf(a, d) !== 'training') { ensureDay(a, d); continue; }
    j += 1;
    if (j === 4) { putStatus(a, d, 'busy'); continue; }
    if (j === 10) { ensureDay(a, d); continue; } // пропуск
    if (j === 15) {
      db.sick.push({ id: seq++, athlete_id: a, date: d, note: 'Потянул плечо', status: 'approved', created_at: stamp(), decided_at: stamp() });
      setStatus(a, d, 'sick');
      continue;
    }
    ensureDay(a, d);
    const pull = [8 + Math.floor(j / 4), 7 + Math.floor(j / 4), 6 + Math.floor(j / 5)];
    const abs = [19 + Math.floor(j / 3), 18 + Math.floor(j / 3), 15 + Math.floor(j / 4)];
    const rows = [
      ...pull.map((r, i) => log(d, 1, i + 1, r)),
      ...abs.map((r, i) => log(d, 2, i + 1, r, !(j === 12 && i === 2))),
    ];
    if (k === 19) continue; // вчера: ждёт проверки
    rows.forEach((row) => {
      if (j === 12 && row.exercise_id === 1 && row.set_no === 2) review(row, 'corrected', row.claimed - 1, 'Последний повтор без полной амплитуды');
      else if (j === 12 && row.exercise_id === 2 && row.set_no === 3) review(row, 'rejected', null, 'Видео не пришло');
      else review(row, 'accepted');
    });
    if (j === 13) {
      // Купил выходной на ближайший тренировочный день через два дня.
      let date = addDays(d, 2);
      while (dayStatusOf(a, date) !== 'training') date = addDays(date, 1);
      buy(a, date);
    }
  }
  frozen = null;
  if (dayStatusOf(a, T) !== 'training') putStatus(a, T, 'training');
  ensureDay(a, T);
  db.mornings.push({ athlete_id: a, date: addDays(T, -1), muscles: 'sore', energy: 4, note: null });
  db.ideas.push({ id: seq++, athlete_id: a, text: 'Читмил в субботу за очки', status: 'new', created_at: stamp(), decided_at: null });
  settle(a);
}());

const inRange = (rows, a, from, to) =>
  clone(rows.filter((r) => r.athlete_id === a && r.date >= from && r.date <= to));

const needAdmin = () => { if (current.role !== 'admin') fail('Только для админа'); };
const needAthlete = () => { if (current.role !== 'athlete') fail('Это делает атлет'); };

export const api = {
  demo: true,

  get role() { return current.role; },

  switchRole() {
    current = current.role === 'admin' ? ATHLETE : ADMIN;
  },

  async session() { return { id: current.id }; },
  async signIn() {},
  async signOut() {},
  async me() { return clone(current); },
  async athletes() { return [clone({ id: ATHLETE.id, name: ATHLETE.name })]; },
  async clock() { return clock(); },
  async settings() { return clone(db.settings); },

  async updateSettings(patch) {
    needAdmin();
    Object.assign(db.settings, patch);
  },

  async weekTemplate() { return clone(db.template); },

  async setWeekday(dow, status) {
    needAdmin();
    db.template.find((t) => t.dow === dow).status = status;
  },

  async exercises() {
    return clone(db.exercises.slice().sort((a, b) => a.position - b.position || a.id - b.id));
  },

  async saveExercise(ex) {
    needAdmin();
    if (!ex.name || !ex.name.trim()) fail('Нужно название');
    if (ex.id) Object.assign(db.exercises.find((e) => e.id === ex.id), ex);
    else db.exercises.push({ ...ex, id: seq++ });
  },

  async openDay(date, athleteId) {
    const who = athleteId ?? current.id;
    if (who !== current.id) needAdmin();
    return clone(ensureDay(who, date));
  },

  async days(a, from, to) { return inRange(db.days, a, from, to); },
  async logs(a, from, to) { return inRange(db.logs, a, from, to); },
  async mornings(a, from, to) { return inRange(db.mornings, a, from, to); },

  async logSet(date, exerciseId, setNo, claimed, hasVideo) {
    const c = clock();
    const uid = current.id;
    let grace;
    if (date === c.today) grace = false;
    else if (date === addDays(c.today, -1) && c.grace) grace = true;
    else fail('День закрыт');
    if (db.settings.start_date && date < db.settings.start_date) fail('Калибровка ещё не началась');
    const d = ensureDay(uid, date);
    if (!d || d.status !== 'training') fail('В этот день нет тренировки');
    const ex = d.plan.find((e) => e.id === exerciseId);
    if (!ex) fail('Этого упражнения нет в плане дня');
    if (setNo < 1 || setNo > ex.sets) fail('Лишний подход');
    if (claimed !== null && (claimed < 0 || claimed > 1000)) fail('Число повторов вне диапазона');

    const prev = db.logs.find((l) => l.athlete_id === uid && l.date === date && l.exercise_id === exerciseId && l.set_no === setNo);
    if (grace) {
      if (!prev) fail('День закрыт, можно только отметить видео');
      prev.has_video = hasVideo;
      return clone(prev);
    }
    if (!prev) {
      const row = { id: seq++, athlete_id: uid, date, exercise_id: exerciseId, set_no: setNo, claimed, has_video: hasVideo,
        review: 'pending', confirmed: null, comment: null, points: null, bonus: null };
      db.logs.push(row);
      return clone(row);
    }
    const changed = prev.claimed !== claimed;
    Object.assign(prev, { claimed, has_video: hasVideo });
    if (changed) {
      Object.assign(prev, { review: 'pending', confirmed: null });
      if (prev.points != null || prev.bonus != null) awardSet(prev);
    }
    return clone(prev);
  },

  async saveMorning({ muscles = null, energy = null, note = null }) {
    const date = clock().today;
    let m = db.mornings.find((x) => x.athlete_id === current.id && x.date === date);
    if (!m) { m = { athlete_id: current.id, date, muscles: null, energy: null, note: null }; db.mornings.push(m); }
    if (muscles !== null) m.muscles = muscles;
    if (energy !== null) m.energy = energy;
    if (note !== null) m.note = note.trim() || null;
    return clone(m);
  },

  async pendingLogs() {
    needAdmin();
    return clone(db.logs.filter((l) => l.review === 'pending' && l.claimed !== null)
      .sort((a, b) => a.date.localeCompare(b.date) || a.exercise_id - b.exercise_id || a.set_no - b.set_no));
  },

  async reviewSet(id, decision, confirmed, comment) {
    needAdmin();
    const l = db.logs.find((x) => x.id === id) ?? fail('Подход не найден');
    if (decision === 'corrected' && (confirmed === null || confirmed === undefined)) fail('Укажи подтверждённое число');
    review(l, decision, confirmed, comment);
    return clone(l);
  },

  async setDayStatus(athleteId, date, status) {
    needAdmin();
    return clone(setStatus(athleteId, date, status));
  },

  // ── v3 ──

  async rules() {
    const t = today();
    return clone({ current: rulesFor(t), next: rulesFor(addDays(t, 1)), from: addDays(t, 1) });
  },

  async saveRules(p) {
    needAdmin();
    const row = { valid_from: addDays(today(), 1) };
    RULE_KEYS.forEach((k) => { row[k] = p[k] ?? null; });
    row.calibration = p.calibration ?? true;
    db.rules = db.rules.filter((r) => r.valid_from !== row.valid_from).concat(row);
    return clone(row);
  },

  async wallet(athleteId) {
    const a = athleteId ?? current.id;
    if (a !== current.id) needAdmin();
    settle(a);
    const r = rulesFor(today());
    const s = streakAt(a, today());
    return { balance: balance(a), rating: rating(a), streak: s, mult: streakMult(r, s), phone_price: r?.phone_price ?? null };
  },

  async ledger(a, limit = 60) {
    return clone(db.ledger.filter((x) => x.athlete_id === a).sort((x, y) => y.id - x.id).slice(0, limit));
  },

  async purchases(a, from) {
    return clone(db.purchases.filter((p) => p.athlete_id === a && p.status === 'active' && p.date >= from)
      .sort((x, y) => x.date.localeCompare(y.date)));
  },

  async buyRestDay(date) {
    needAthlete();
    return clone(buy(current.id, date));
  },

  async cancelPurchase(id) {
    const p = db.purchases.find((x) => x.id === id && (x.athlete_id === current.id || current.role === 'admin'));
    if (!p) fail('Покупка не найдена');
    if (p.status === 'cancelled') fail('Покупка уже отменена');
    if (p.date <= today()) fail('Отменить можно только до начала дня');
    p.status = 'cancelled';
    const d = findDay(p.athlete_id, p.date);
    if (d && d.status === 'bought') d.status = p.prev_status;
    addLedger({ athlete_id: p.athlete_id, date: p.date, kind: 'refund', amount: p.price, note: `Отмена выходного на ${dayLabel(p.date)}` });
    return clone(p);
  },

  async sickRequests(a, from) {
    return clone(db.sick.filter((s) => s.athlete_id === a && s.date >= from).sort((x, y) => y.date.localeCompare(x.date)));
  },

  async pendingSick() {
    needAdmin();
    return clone(db.sick.filter((s) => s.status === 'pending'));
  },

  async requestSick(note) {
    needAthlete();
    const t = today();
    if (dayStatusOf(current.id, t) !== 'training') fail('Сегодня и так нет тренировки');
    let s = db.sick.find((x) => x.athlete_id === current.id && x.date === t);
    if (s && s.status !== 'declined') fail('Запрос на сегодня уже отправлен');
    if (!s) { s = { id: seq++, athlete_id: current.id, date: t }; db.sick.push(s); }
    Object.assign(s, { note: (note || '').trim() || null, status: 'pending', created_at: stamp(), decided_at: null });
    return clone(s);
  },

  async decideSick(id, approve) {
    needAdmin();
    const s = db.sick.find((x) => x.id === id) ?? fail('Запрос не найден');
    s.status = approve ? 'approved' : 'declined';
    s.decided_at = stamp();
    if (approve) setStatus(s.athlete_id, s.date, 'sick');
    return clone(s);
  },

  async ideas(a) {
    return clone(db.ideas.filter((i) => i.athlete_id === a).sort((x, y) => y.id - x.id));
  },

  async addIdea(text) {
    if (!text || !text.trim()) fail('Напиши идею');
    const i = { id: seq++, athlete_id: current.id, text: text.trim().slice(0, 300), status: 'new', created_at: stamp(), decided_at: null };
    db.ideas.push(i);
    return clone(i);
  },

  async setIdeaStatus(id, status) {
    needAdmin();
    const i = db.ideas.find((x) => x.id === id) ?? fail('Идея не найдена');
    i.status = status;
    i.decided_at = status === 'new' ? null : stamp();
    return clone(i);
  },
};
