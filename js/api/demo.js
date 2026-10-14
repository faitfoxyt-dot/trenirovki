// Демо-режим (?demo=1): те же функции, что и у Supabase, но данные живут
// в памяти вкладки. Правила дня повторяют SQL-функции из supabase/migrations.

import { addDays, isoDow, tallinnNow } from '../util.js';

const ADMIN = { id: 'admin', role: 'admin', name: 'Тимур' };
const ATHLETE = { id: 'athlete', role: 'athlete', name: 'Друг' };

const db = seed();
let current = ATHLETE;
let seq = 1000;

function seed() {
  const { today } = tallinnNow();
  const s = {
    settings: { id: 1, start_date: addDays(today, -6), calibration: true, grace_hours: 3 },
    template: [1, 2, 3, 4, 5, 6, 7].map((dow) => ({ dow, status: dow === 7 ? 'rest' : 'training' })),
    exercises: [
      { id: 1, name: 'Подтягивания', sets: 3, target_reps: null, position: 0, active: true },
      { id: 2, name: 'Пресс', sets: 3, target_reps: null, position: 1, active: true },
    ],
    days: [],
    logs: [],
    mornings: [],
  };

  const plan = () => s.exercises.filter((e) => e.active)
    .map(({ id, name, sets, target_reps }) => ({ id, name, sets, target_reps }));
  const day = (date, status) => s.days.push({ athlete_id: ATHLETE.id, date, status, plan: status === 'training' ? plan() : null });
  const statusOf = (date) => s.template.find((t) => t.dow === isoDow(date)).status;
  let id = 1;
  const log = (date, ex, n, claimed, video, review, confirmed, comment) => s.logs.push({
    id: id++, athlete_id: ATHLETE.id, date, exercise_id: ex, set_no: n, claimed, has_video: video,
    review, confirmed: confirmed ?? null, comment: comment ?? null,
  });

  // Неделя калибровки: всё принято, одна правка, пропуск, «занят», отказ, вчера ждёт проверки.
  const story = [
    (d) => { [8, 7, 6].forEach((r, i) => log(d, 1, i + 1, r, true, 'accepted', r)); [25, 22, 20].forEach((r, i) => log(d, 2, i + 1, r, true, 'accepted', r)); },
    (d) => { [9, 7, 7].forEach((r, i) => log(d, 1, i + 1, r, true, i === 1 ? 'corrected' : 'accepted', i === 1 ? 6 : r, i === 1 ? 'Последний повтор без полной амплитуды' : null)); },
    () => {},
    'busy',
    (d) => { [9, 8, 6].forEach((r, i) => log(d, 1, i + 1, r, i !== 2, i === 2 ? 'rejected' : 'accepted', i === 2 ? 0 : r, i === 2 ? 'Видео не пришло' : null)); },
    (d) => { [10, 8].forEach((r, i) => log(d, 1, i + 1, r, true, 'pending')); log(d, 2, 1, 26, true, 'pending'); },
  ];
  story.forEach((step, i) => {
    const date = addDays(today, i - 6);
    if (step === 'busy') { day(date, 'busy'); return; }
    const status = statusOf(date);
    day(date, status);
    if (status === 'training') step(date);
  });
  s.mornings.push({ athlete_id: ATHLETE.id, date: addDays(today, -1), muscles: 'sore', energy: 4, note: null });
  if (statusOf(today) !== 'training') day(today, 'training');
  return s;
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const fail = (message) => { throw new Error(message); };

function clock() {
  const now = tallinnNow();
  return { today: now.today, time: now.time, grace: now.hour < db.settings.grace_hours };
}

function currentPlan() {
  return db.exercises.filter((e) => e.active)
    .sort((a, b) => a.position - b.position || a.id - b.id)
    .map(({ id, name, sets, target_reps }) => ({ id, name, sets, target_reps }));
}

function ensureDay(athleteId, date) {
  let d = db.days.find((x) => x.athlete_id === athleteId && x.date === date);
  if (!d) {
    if (date > clock().today) return null;
    const t = db.template.find((x) => x.dow === isoDow(date));
    d = { athlete_id: athleteId, date, status: t ? t.status : null, plan: null };
    db.days.push(d);
  }
  if (d.status === 'training' && !d.plan && date <= clock().today) d.plan = currentPlan();
  return d;
}

const inRange = (rows, athleteId, from, to) =>
  clone(rows.filter((r) => r.athlete_id === athleteId && r.date >= from && r.date <= to));

const needAdmin = () => { if (current.role !== 'admin') fail('Только для админа'); };

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
      const row = { id: seq++, athlete_id: uid, date, exercise_id: exerciseId, set_no: setNo, claimed, has_video: hasVideo, review: 'pending', confirmed: null, comment: null };
      db.logs.push(row);
      return clone(row);
    }
    if (prev.claimed !== claimed) Object.assign(prev, { review: 'pending', confirmed: null });
    Object.assign(prev, { claimed, has_video: hasVideo });
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
    l.review = decision;
    l.confirmed = { accepted: l.claimed, corrected: confirmed, rejected: 0 }[decision] ?? null;
    l.comment = (comment || '').trim() || null;
    return clone(l);
  },

  async setDayStatus(athleteId, date, status) {
    needAdmin();
    let d = db.days.find((x) => x.athlete_id === athleteId && x.date === date);
    if (!d) { d = { athlete_id: athleteId, date, status, plan: null }; db.days.push(d); }
    d.status = status;
    if (status === 'training' && !d.plan && date <= clock().today) d.plan = currentPlan();
    return clone(d);
  },
};
