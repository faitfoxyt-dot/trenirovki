// Демо-режим (?demo=1): те же функции, что и у Supabase, но данные живут
// в памяти вкладки. Правила дня и очков повторяют SQL-функции из supabase/migrations.

import { addDays, isoDow, tallinnNow, shortDate, WD_SHORT } from '../util.js';

const ADMIN = { id: 'admin', role: 'admin', name: 'Тимур' };
const ATHLETE = { id: 'athlete', role: 'athlete', name: 'Друг' };

const RULE_KEYS = ['calibration', 'per_exercise', 'streak_from', 'streak_step', 'streak_max',
  'miss_penalty_pct', 'rest_day_price', 'purchase_limit_week', 'phone_price'];

const db = {
  settings: { id: 1, start_date: null, grace_hours: 3, show_rules: false },
  rules: [{ valid_from: '2000-01-01', calibration: true }],
  template: [1, 2, 3, 4, 5, 6, 7].map((dow) => ({ dow, status: dow === 7 ? 'rest' : 'training' })),
  exercises: [
    { id: 1, name: 'Подтягивания', unit: 'reps', sets: 3, target_reps: null, position: 0, active: true, archived: false },
    { id: 2, name: 'Пресс', unit: 'reps', sets: 3, target_reps: null, position: 1, active: true, archived: false },
    { id: 3, name: 'Отжимания на брусьях', unit: 'reps', sets: 3, target_reps: null, position: 2, active: false, archived: false },
    { id: 4, name: 'Планка', unit: 'sec', sets: 2, target_reps: 60, position: 3, active: false, archived: false },
  ],
  days: [],
  logs: [],
  mornings: [],
  ledger: [],
  purchases: [],
  sick: [],
  ideas: [],
  theory: [],
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
    .map(({ id, name, unit, sets, target_reps }) => ({ id, name, unit, sets, target_reps }));
}

const findDay = (a, date) => db.days.find((x) => x.athlete_id === a && x.date === date);

function ensureDay(a, date) {
  let d = findDay(a, date);
  if (!d) {
    if (date > today()) return null;
    const t = db.template.find((x) => x.dow === isoDow(date));
    d = { athlete_id: a, date, status: t ? t.status : null, plan: null, note: null };
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
  if (!d) { d = { athlete_id: a, date, status, plan: null, note: null }; db.days.push(d); }
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
// [засчитано подходов из плана, всего подходов в плане] — как day_counts в базе:
// засчитан подход больше чем с 0 повторов (по числу Тимура, если проверен).
function dayCounts(a, date) {
  const plan = findDay(a, date)?.plan ?? currentPlan();
  const done = db.logs.filter((l) => l.athlete_id === a && l.date === date && (l.confirmed ?? l.claimed ?? 0) > 0
    && plan.some((e) => e.id === l.exercise_id && l.set_no <= e.sets)).length;
  return [done, plan.reduce((s, e) => s + e.sets, 0)];
}
const dayDone = (a, date) => { const c = dayCounts(a, date); return c[0] >= c[1]; };
const balance = (a) => db.ledger.filter((x) => x.athlete_id === a).reduce((s, x) => s + x.amount, 0);
const rating = (a) => db.ledger.filter((x) => x.athlete_id === a).reduce((s, x) => s + x.rating, 0);
const hasKey = (a, key) => db.ledger.some((x) => x.athlete_id === a && x.key === key);

// Серия считается по дням того же режима (тестовый или настоящий), что и сам день, — как streak_in в базе.
const isTestDay = (date) => isCal(rulesFor(date));
function streakIn(a, date, test) {
  const start = db.settings.start_date;
  if (!start) return 0;
  let n = 0;
  for (let d = date, i = 0; d >= start && i < 400; d = addDays(d, -1), i += 1) {
    if (isTestDay(d) !== test || dayStatusOf(a, d) !== 'training') continue;
    if (dayDone(a, d)) n += 1;
    else if (d < today()) break;
  }
  return n;
}
const streakAt = (a, date) => streakIn(a, date, isTestDay(date));

// Серия дня, если он будет сделан: дни того же режима до него + он сам — как day_streak в базе.
const dayStreak = (a, date) => streakIn(a, addDays(date, -1), isTestDay(date)) + 1;

function streakMult(r, s) {
  if (!r || r.streak_from == null || r.streak_step == null || s < r.streak_from) return 1;
  return Math.round(Math.min(r.streak_max ?? 1000, 1 + r.streak_step * (s - r.streak_from + 1)) * 100) / 100;
}

function addLedger(row) {
  if (row.key && hasKey(row.athlete_id, row.key)) return;
  db.ledger.push({ id: seq++, amount: 0, rating: 0, note: null, key: null, set_id: null, created_at: stamp(), ...row });
}

function awardSet(l) {
  let r = rulesFor(l.date);
  const cal = isCal(r);
  // В тестовый период теорию считаем по текущим числам.
  if (cal) r = rulesFor(today());
  let ok = (l.review === 'accepted' || l.review === 'corrected') && l.confirmed !== null;
  const pe = r?.per_exercise?.[l.exercise_id] ?? {};
  const ex = findDay(l.athlete_id, l.date)?.plan?.find((e) => e.id === l.exercise_id);
  const target = ex?.target_reps ?? null;
  const name = ex?.name ?? db.exercises.find((e) => e.id === l.exercise_id)?.name ?? 'Подход';
  let total = 0;
  let bon = 0;
  let mult = 1;
  if (ok) {
    const full = l.confirmed > 0 && (target === null || l.confirmed >= target);
    const base = l.confirmed * (pe.rep ?? 0) + (full ? pe.set ?? 0 : 0);
    if (target !== null && l.confirmed > target && (pe.over ?? 0) > 0) {
      bon = Math.round((l.confirmed - target) * pe.over);
      if (pe.cap != null) {
        const other = (cal ? db.theory : db.logs)
          .filter((x) => x.athlete_id === l.athlete_id && x.date === l.date && x.exercise_id === l.exercise_id && (x.set_id ?? x.id) !== l.id)
          .reduce((s, x) => s + (x.bonus ?? 0), 0);
        bon = Math.max(0, Math.min(bon, pe.cap - other));
      }
    }
    mult = streakMult(r, dayStreak(l.athlete_id, l.date));
    total = Math.round((base + bon) * mult);
  }

  db.theory = db.theory.filter((x) => x.set_id !== l.id);
  if (ok && cal) db.theory.push({ set_id: l.id, athlete_id: l.athlete_id, date: l.date, exercise_id: l.exercise_id, points: total, bonus: bon, mult });

  ok = ok && !cal;
  const reviewed = l.points != null;
  const delta = (ok ? total : 0) - (l.points ?? 0);
  l.points = ok ? total : null;
  l.bonus = ok ? bon : null;
  l.mult = ok ? mult : null;
  if (!delta) return;
  let note = `${reviewed ? 'Пересмотр: ' : ''}${name} · подход ${l.set_no}`;
  if (ok && mult > 1) note += ` · серия ×${mult}`;
  if (ok && bon > 0) note += ` · сверх цели +${bon}`;
  addLedger({ athlete_id: l.athlete_id, date: l.date, kind: 'set', amount: Math.max(delta, -balance(l.athlete_id)), rating: delta, note, set_id: l.id });
}

// Штрафы за пропуск и вехи — как settle() в базе.
function settle(a) {
  const start = db.settings.start_date;
  if (!start) return;
  const t = today();
  for (let d = start > addDays(t, -30) ? start : addDays(t, -30); d < t; d = addDays(d, 1)) {
    const r = rulesFor(d);
    if (isCal(r) || !(r.miss_penalty_pct > 0) || dayStatusOf(a, d) !== 'training' || hasKey(a, `penalty:${d}`)) continue;
    const c = dayCounts(a, d);
    if (c[0] >= c[1]) continue;
    ensureDay(a, d);
    const bal = balance(a);
    const pen = Math.min(bal, Math.round((bal * r.miss_penalty_pct) / 100));
    addLedger({ athlete_id: a, date: d, kind: 'penalty', amount: -pen,
      note: `Пропуск: сделано ${c[0]} из ${c[1]} подходов · −${r.miss_penalty_pct}% баланса`, key: `penalty:${d}` });
  }

  // Тимур передумал и день снова засчитан — штраф возвращается.
  db.ledger.filter((x) => x.athlete_id === a && x.kind === 'penalty' && x.amount < 0 && x.date >= addDays(t, -60)
    && !hasKey(a, `unpenalty:${x.date}`) && dayDone(a, x.date)).forEach((x) => {
    addLedger({ athlete_id: a, date: x.date, kind: 'refund', amount: -x.amount,
      note: 'Штраф снят: день засчитан после проверки', key: `unpenalty:${x.date}` });
  });

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

// ── История для демо: тестовая неделя, потом 2 недели с очками ──

(function seed() {
  const T = tallinnNow().today;
  const a = ATHLETE.id;
  const start = addDays(T, -20);
  const rulesFrom = addDays(start, 7);
  db.settings.start_date = start;
  db.rules.push({ valid_from: rulesFrom, calibration: false,
    per_exercise: { 1: { rep: 2, set: 5, over: 2, cap: 6 }, 2: { rep: 0.5, set: 5, over: 0.5, cap: 3 }, 3: { rep: 1, set: 5 }, 4: { rep: 0.2, set: 5, over: 0.2, cap: 4 } },
    streak_from: 3, streak_step: 0.1, streak_max: 1.5,
    miss_penalty_pct: 10, rest_day_price: 150, purchase_limit_week: 2, phone_price: 4000 });

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
    const partial = j === 7; // сделал не всё — тоже пропуск
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
      ...abs.slice(0, partial ? 1 : 3).map((r, i) => log(d, 2, i + 1, r, !(j === 12 && i === 2))),
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
  // Теория для тестовой недели — как пересчёт в save_rules.
  db.logs.filter((l) => isCal(rulesFor(l.date))).forEach(awardSet);
  if (dayStatusOf(a, T) !== 'training') putStatus(a, T, 'training');
  ensureDay(a, T).note = 'Подтягивания — медленный негатив, 3 секунды вниз';
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
    const t = db.template.find((x) => x.dow === dow);
    // Прошедшие дни остаются со старым статусом — как триггер freeze_past_days в базе.
    const start = db.settings.start_date;
    if (start && t.status !== status) {
      for (let d = start; d < today(); d = addDays(d, 1)) {
        if (isoDow(d) === dow && !findDay(ATHLETE.id, d)) {
          db.days.push({ athlete_id: ATHLETE.id, date: d, status: t.status, plan: t.status === 'training' ? currentPlan() : null, note: null });
        }
      }
    }
    t.status = status;
  },

  async exercises() {
    return clone(db.exercises.slice().sort((a, b) => a.position - b.position || a.id - b.id));
  },

  async saveExercise(ex) {
    needAdmin();
    if (!ex.name || !ex.name.trim()) fail('Нужно название');
    if (ex.id) return clone(Object.assign(db.exercises.find((e) => e.id === ex.id), ex));
    const row = { unit: 'reps', ...ex, id: seq++ };
    db.exercises.push(row);
    return clone(row);
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
    if (db.settings.start_date && date < db.settings.start_date) fail('Старт ещё не наступил');
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
      if (prev.points != null || prev.bonus != null || db.theory.some((x) => x.set_id === prev.id)) awardSet(prev);
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
    return clone({ current: rulesFor(t), next: rulesFor(t), from: t });
  },

  async saveRules(p) {
    needAdmin();
    const row = { valid_from: today() };
    RULE_KEYS.forEach((k) => { row[k] = p[k] ?? null; });
    row.calibration = p.calibration ?? true;
    row.per_exercise = p.per_exercise ?? {};
    db.rules = db.rules.filter((r) => r.valid_from < row.valid_from).concat(row);
    db.logs.filter((l) => l.date > addDays(today(), -60) && (l.review === 'accepted' || l.review === 'corrected')
      && (isCal(rulesFor(l.date)) || db.theory.some((x) => x.set_id === l.id))).forEach(awardSet);
    return clone(row);
  },

  async wallet(athleteId) {
    const a = athleteId ?? current.id;
    if (a !== current.id) needAdmin();
    settle(a);
    const r = rulesFor(today());
    const s = streakAt(a, today());
    const mult = streakMult(r, dayStreak(a, today()));
    const theory = current.role === 'admin' ? db.theory.filter((x) => x.athlete_id === a).reduce((n, x) => n + x.points, 0) : null;
    const phone = db.ledger.find((x) => x.athlete_id === a && x.key === 'phone');
    return { balance: balance(a), rating: rating(a), streak: s, mult, phone_price: r?.phone_price ?? null,
      phone_bought: phone?.date ?? null, theory };
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

  // ── v3.1 ──

  async theory(a, from, to) {
    if (current.role !== 'admin') return [];
    return inRange(db.theory, a, from, to);
  },

  async setDayPlan(a, date, plan, note) {
    needAdmin();
    if (date < today()) fail('Прошедший день менять нельзя');
    let full = null;
    if (plan !== null) {
      if (!plan.length) fail('В плане дня нужно хотя бы одно упражнение');
      full = plan.map((x) => {
        const e = db.exercises.find((y) => y.id === x.id) ?? fail('В плане есть неизвестное упражнение');
        if (x.sets < 1 || x.sets > 10 || (x.target_reps != null && (x.target_reps < 1 || x.target_reps > 1000))) {
          fail('Подходов — от 1 до 10, цель — от 1 до 1000');
        }
        return { id: e.id, name: e.name, unit: e.unit, sets: x.sets, target_reps: x.target_reps ?? null };
      });
    }
    const d = setStatus(a, date, 'training');
    d.plan = full ?? (date === today() ? currentPlan() : null);
    d.note = (note || '').trim() || null;
    return clone(d);
  },

  async grantPoints(a, amount, note, withRating) {
    needAdmin();
    if (!amount) fail('Укажи число очков');
    if (!note || !note.trim()) fail('Напиши причину');
    const row = { athlete_id: a, date: today(), kind: 'manual', amount: Math.max(amount, -balance(a)),
      rating: withRating ? Math.max(amount, -rating(a)) : 0, note: `Тимур: ${note.trim()}` };
    addLedger(row);
    settle(a);
    return clone(row);
  },

  async deleteIdea(id) {
    needAdmin();
    db.ideas = db.ideas.filter((i) => i.id !== id);
  },

  async resetAthlete(a) {
    needAdmin();
    ['ledger', 'purchases', 'sick', 'ideas', 'logs', 'mornings', 'days', 'theory'].forEach((k) => {
      db[k] = db[k].filter((x) => x.athlete_id !== a);
    });
  },

  // ── v3.2 ──

  async clearAthlete(a, what, from, to) {
    needAdmin();
    if (!what?.length) fail('Выбери, что стереть');
    const f = from || '1900-01-01';
    const t = to || '2999-12-31';
    if (f > t) fail('Дата «с» позже даты «по»');
    const inR = (x) => x.athlete_id === a && x.date >= f && x.date <= t;
    const res = {};
    const drop = (key, table, test = inR) => {
      const before = db[table].length;
      db[table] = db[table].filter((x) => !test(x));
      res[key] = before - db[table].length;
    };
    if (what.includes('purchases')) {
      db.purchases.filter((p) => inR(p) && p.status === 'active').forEach((p) => {
        const d = findDay(a, p.date);
        if (d && d.status === 'bought') d.status = p.prev_status;
      });
      drop('purchases', 'purchases');
    }
    if (what.includes('points')) {
      drop('points', 'ledger');
      db.logs.filter(inR).forEach((l) => { l.points = null; l.bonus = null; });
    }
    if (what.includes('sets')) {
      const gone = new Set(db.logs.filter(inR).map((l) => l.id));
      drop('sets', 'logs');
      db.theory = db.theory.filter((x) => !gone.has(x.set_id));
      db.ledger.forEach((x) => { if (gone.has(x.set_id)) x.set_id = null; });
    }
    if (what.includes('sick')) drop('sick', 'sick');
    if (what.includes('ideas')) drop('ideas', 'ideas', (i) => i.athlete_id === a && i.created_at.slice(0, 10) >= f && i.created_at.slice(0, 10) <= t);
    if (what.includes('mornings')) drop('mornings', 'mornings');
    if (what.includes('days')) drop('days', 'days');
    return res;
  },

  async deleteLedger(id) {
    needAdmin();
    const x = db.ledger.find((r) => r.id === id) ?? fail('Запись не найдена');
    if (x.key && x.key !== 'phone') {
      x.amount = 0;
      x.rating = 0;
      if (!x.note?.startsWith('Удалено Тимуром: ')) x.note = `Удалено Тимуром: ${x.note ?? ''}`;
      return;
    }
    db.ledger = db.ledger.filter((r) => r.id !== id);
    // У подхода остаются очки других его записей — как в базе.
    const l = x.set_id && db.logs.find((s) => s.id === x.set_id);
    if (l) {
      const rest = db.ledger.filter((r) => r.set_id === l.id);
      l.points = rest.length ? rest.reduce((n, r) => n + r.rating, 0) : null;
      if (l.points === null) { l.bonus = null; l.mult = null; }
    }
  },

  // ── v3.3 ──

  async buyPhone() {
    needAthlete();
    const a = current.id;
    const price = rulesFor(today())?.phone_price ?? fail('Цену телефона Тимур ещё не поставил');
    if (hasKey(a, 'phone')) fail('Телефон уже куплен');
    if (balance(a) < price) fail(`Не хватает очков: нужно ${price}, на балансе ${balance(a)}`);
    const row = { athlete_id: a, date: today(), kind: 'purchase', amount: -price, note: 'Покупка: телефон', key: 'phone' };
    addLedger(row);
    return clone(row);
  },
};
