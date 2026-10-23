// Демо-режим (?demo=1): те же функции, что и у Supabase, но данные живут
// в памяти вкладки. Правила дня и очков повторяют SQL-функции из supabase/migrations.

import { addDays, isoDow, tallinnNow, shortDate, WD_SHORT } from '../util.js';
import { swapItems as planSwaps, pickLocked, choiceIds, setNumber, choiceEff, ruleSetPoints } from '../logic.js';

const ADMIN = { id: 'admin', role: 'admin', name: 'Тимур' };
const ATHLETE = { id: 'athlete', role: 'athlete', name: 'Друг' };

const RULE_KEYS = ['calibration', 'per_exercise', 'streak_from', 'streak_step', 'streak_max',
  'miss_penalty_pct', 'rest_day_price', 'purchase_limit_week', 'phone_price',
  'allin_price', 'allin_up', 'allin_down', 'allin_limit_week', 'choice_drop', 'choice_floor',
  'allin_streak', 'pari_streak', 'pari_price', 'pari_p10', 'pari_p25', 'pari_p50'];

// Строка каталога: swap — замена по просьбе (id) и её цель.
const ex = (id, name, sets, target, swap = null, swapTarget = null, unit = 'reps') => ({
  id, name, unit, sets, target_reps: target, position: id, active: id <= 2, archived: false, swap_id: swap, swap_target: swapTarget });

const db = {
  settings: { id: 1, start_date: null, grace_hours: 3, show_rules: false, rotation_from: null, rotation_shift: 0, choice: false,
    video_auto: false, bot_sees: false },
  rules: [{ valid_from: '2000-01-01', calibration: true }],
  template: [1, 2, 3, 4, 5, 6, 7].map((dow) => ({ dow, status: dow === 7 ? 'rest' : 'training' })),
  exercises: [
    ex(1, 'Подтягивания широким хватом', 3, null, 11, 15),
    ex(2, 'Пресс', 3, null, 15, 12),
    ex(3, 'Подтягивания обратным хватом', 3, 9, 12, 15),
    ex(4, 'Планка', 2, 90, 16, 90, 'sec'),
    ex(5, 'Отжимания', 3, 12, 13, 18),
    ex(6, 'Приседания', 3, 20, 14, 25),
    ex(7, 'Лодочка', 3, 15, 17, 20),
    ex(8, 'Обратные отжимания от стула', 3, 12, 18, 8),
    ex(9, 'Пайк-отжимания', 3, 8, 19, 20),
    ex(10, 'Выпады', 3, 10, 20, 60),
    // Замены по просьбе: в комплексах их нет.
    ex(11, 'Тяга рюкзака в наклоне, широкий хват', 3, 15),
    ex(12, 'Тяга рюкзака в наклоне, ладони к себе', 3, 15),
    ex(13, 'Отжимания с колен', 3, 18),
    ex(14, 'Ягодичный мост', 3, 25),
    ex(15, 'Подъём ног лёжа', 3, 12),
    ex(16, 'Боковая планка', 2, 90, null, null, 'sec'),
    ex(17, 'Пловец', 3, 20),
    ex(18, 'Узкие отжимания', 3, 8),
    ex(19, 'Касания плеч в планке', 3, 20),
    ex(20, 'Стульчик у стены', 3, 60, null, null, 'sec'),
    // Для пробного «Выбора упражнения»: второй вариант в паре.
    ex(21, 'Сгибания рук с рюкзаком', 2, 15),
    ex(22, 'Вис на турнике', 2, 45, null, null, 'sec'),
    ex(23, 'Отжимания ноги на диване', 2, 10),
    ex(24, 'Французский жим рюкзака лёжа', 2, 15),
    ex(25, 'Жим рюкзака над головой', 2, 15),
    ex(26, 'Болгарские выпады (нога на диване)', 2, 8),
    ex(27, 'Прыжки из приседа', 2, 12),
    ex(28, 'Подъём ног в висе на турнике', 2, 10),
  ],
  // Комплексы по кругу: items — [{id, sets, target_reps, alt}], alt — второй вариант {id, target_reps} для «Выбора».
  complexes: [{ id: 1, position: 0, items: [{ id: 1, sets: 3, target_reps: null }, { id: 2, sets: 3, target_reps: null }] }],
  days: [],
  logs: [],
  mornings: [],
  ledger: [],
  purchases: [],
  sick: [],
  swaps: [],
  ideas: [],
  theory: [],
  body: [],
  pari: [], // «За гранью предела»: {id, athlete_id, start, price, status, bets: [{n, exercise_id, name, unit, reps, base, pct, prize}]}
  events: [], // события дня: {athlete_id, date, title, game, score} — score null, пока не сыграл
  videos: [], // видео из Telegram, к которым ещё нет повторов: {athlete_id, date, no, url}
};
let current = ATHLETE;
let seq = 100;
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

const findDay = (a, date) => db.days.find((x) => x.athlete_id === a && x.date === date);

// Какой по счёту комплекс в этот день — как complex_index в базе: от точки отсчёта
// считаются только тренировочные дни.
function complexIndex(a, date) {
  const n = db.complexes.length;
  if (!n) return null;
  const anchor = db.settings.rotation_from ?? db.settings.start_date ?? today();
  let k = 0;
  const [from, to] = date < anchor ? [date, anchor] : [anchor, date];
  for (let d = from; d < to; d = addDays(d, 1)) if (dayStatusOf(a, d) === 'training') k += 1;
  if (date < anchor) k = -k;
  return (((db.settings.rotation_shift ?? 0) + k) % n + n) % n;
}

// Сколько раз подряд друг брал этот вариант в этом месте — как choice_times в базе: идём по прошлым дням назад,
// где было место с той же парой. Не выбрал и ничего не отметил — день не считаем; не выбрал, но отмечал —
// это первый вариант; взял другой — цепочка кончилась.
function choiceTimes(a, date, pair, id) {
  const key = [...pair].sort((x, y) => x - y).join('-');
  const days = db.days.filter((d) => d.athlete_id === a && d.date < date && d.plan)
    .sort((x, y) => y.date.localeCompare(x.date));
  let n = 0;
  for (const d of days) {
    const x = d.plan.find((y) => y.pick && y.pick.map((o) => o.id).sort((p, q) => p - q).join('-') === key);
    if (!x) continue;
    let took = null;
    if (x.chosen !== null && x.chosen !== undefined) took = x.pick[x.chosen].id;
    else if (db.logs.some((l) => l.athlete_id === a && l.date === d.date && l.exercise_id === x.id && l.claimed != null)) took = x.id;
    if (took === null) continue;
    if (took !== id) break;
    n += 1;
  }
  return n;
}

// Пункт плана из комплекса. В режиме «Выбор» с двумя вариантами: pick и chosen (пока не выбрал — первый).
// При «Выборе» у каждого пункта и варианта — times (сколько раз подряд уже брал) и eff (эффективность, %).
function currentPlan(a, date) {
  const c = db.complexes[complexIndex(a, date) ?? 0];
  const r = rulesFor(date);
  const opt = (id, target, sets) => {
    const e = db.exercises.find((y) => y.id === id && !y.archived);
    return e && { id: e.id, name: e.name, unit: e.unit, target_reps: target ?? null, sets };
  };
  const priced = db.settings.choice;
  return (c?.items ?? []).map((x) => {
    const main = opt(x.id, x.target_reps, x.sets);
    if (!main) return null;
    const alt = db.settings.choice && x.alt ? opt(x.alt.id, x.alt.target_reps, x.alt.sets ?? x.sets) : null;
    if (!alt) return { ...main, sets: x.sets, ...(priced ? { times: 0, eff: 100 } : {}) };
    const pick = [main, alt].map((o) => {
      if (!priced) return o;
      const times = choiceTimes(a, date, [main.id, alt.id], o.id);
      return { ...o, times, eff: choiceEff(r, times) };
    });
    return { ...pick[0], sets: x.sets, pick, chosen: null };
  }).filter(Boolean);
}

// Сегодня друг ещё ничего не отметил и план не меняли вручную — день получает новый план.
function replanToday(old) {
  const t = today();
  const a = ATHLETE.id;
  const d = findDay(a, t);
  if (d && d.status === 'training' && JSON.stringify(d.plan) === old
    && !db.logs.some((l) => l.athlete_id === a && l.date === t && l.claimed != null)) d.plan = currentPlan(a, t);
}
const markActive = () => db.exercises.forEach((e) => { e.active = db.complexes.some((c) => choiceIds(c).includes(e.id)); });

function ensureDay(a, date) {
  let d = findDay(a, date);
  if (!d) {
    if (date > today()) return null;
    const t = db.template.find((x) => x.dow === isoDow(date));
    d = { athlete_id: a, date, status: t ? t.status : null, plan: null, note: null };
    db.days.push(d);
  }
  if (d.status === 'training' && !d.plan && date <= today()) d.plan = currentPlan(a, date);
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
  if (status === 'training' && !d.plan && date <= today()) d.plan = currentPlan(a, date);
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
  const plan = findDay(a, date)?.plan ?? currentPlan(a, date);
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

// «Всё или ничего» — как allin_state в базе. null — на этот день не куплено.
function allinState(a, date) {
  const p = db.purchases.find((x) => x.athlete_id === a && x.date === date && x.status === 'active' && x.kind === 'allin');
  if (!p) return null;
  const test = isTestDay(date);
  const r = rulesFor(test ? today() : date);
  const up = Number(r?.allin_up ?? 0);
  const down = Number(r?.allin_down ?? 0);
  const ended = date < today();
  const plan = findDay(a, date)?.plan ?? currentPlan(a, date);
  const logs = db.logs.filter((l) => l.athlete_id === a && l.date === date);
  let done = 0;
  let miss = 0;
  let wait = 0;
  const items = plan.map((ex) => {
    const tgt = Math.max(ex.target_reps ?? 1, 1);
    const sets = logs.filter((l) => l.exercise_id === ex.id && l.set_no <= ex.sets);
    const yes = sets.filter((l) => (l.review === 'accepted' || l.review === 'corrected') && (l.confirmed ?? 0) >= tgt).length;
    const no = sets.filter((l) => l.review !== 'pending' && (l.confirmed ?? 0) < tgt).length
      + (ended ? ex.sets - sets.filter((l) => l.claimed != null).length : 0);
    const state = no > 0 ? 'miss' : yes >= ex.sets ? 'done' : 'wait';
    if (state === 'done') done += 1; else if (state === 'miss') miss += 1; else wait += 1;
    return { id: ex.id, name: ex.name, state };
  });
  const rows = test ? db.theory.filter((t) => t.athlete_id === a && t.date === date)
    : logs.filter((l) => l.points != null);
  const points = rows.reduce((n, x) => n + x.points, 0);
  const k = rows.length ? Math.max(...rows.map((x) => Number(x.mult ?? 1))) : streakMult(r, dayStreak(a, date));
  const round2 = (v) => Math.round(v * 100) / 100;
  const m = Math.max(0.1, k + up * done - down * miss);
  const best = Math.max(0.1, k + up * (done + wait) - down * miss);
  const applied = db.ledger.filter((x) => x.athlete_id === a && x.date === date && x.kind === 'modifier').reduce((n, x) => n + x.rating, 0);
  return { price: p.price, up, down, k, done, missed: miss, waiting: wait, total: plan.length, items,
    mult: round2(m), best: round2(best), points, bonus: Math.round(points * (m / k - 1)),
    final: ended && wait === 0, test, applied };
}

// Записать разницу между тем, что модификатор должен дать, и тем, что уже в журнале, — как allin_apply.
function allinApply(a, date) {
  const s = allinState(a, date);
  if (s?.test) return;
  const want = s?.final ? s.bonus : 0;
  const have = db.ledger.filter((x) => x.athlete_id === a && x.date === date && x.kind === 'modifier').reduce((n, x) => n + x.rating, 0);
  const delta = want - have;
  if (!delta) return;
  addLedger({ athlete_id: a, date, kind: 'modifier', amount: Math.max(delta, -balance(a)), rating: delta,
    note: s ? `${have ? 'Пересмотр: ' : ''}Всё или ничего: сделано ${s.done} из ${s.total} упражнений · очки дня ×${s.mult}`
      : 'Всё или ничего отменено' });
}

// Бонус события дня — как event_apply в базе: (подходы + «Всё или ничего») × 0.1 × score.
function eventApply(a, date) {
  if (isCal(rulesFor(date))) return;
  const e = db.events.find((x) => x.athlete_id === a && x.date === date);
  const pending = db.logs.some((l) => l.athlete_id === a && l.date === date && l.review === 'pending');
  const base = db.ledger.filter((x) => x.athlete_id === a && x.date === date && (x.kind === 'set' || x.kind === 'modifier'))
    .reduce((n, x) => n + x.rating, 0);
  const want = e?.score > 0 && date < today() && !pending ? Math.max(Math.round((base * e.score) / 10), 0) : 0;
  const have = db.ledger.filter((x) => x.athlete_id === a && x.date === date && x.kind === 'event').reduce((n, x) => n + x.rating, 0);
  const delta = want - have;
  if (!delta) return;
  addLedger({ athlete_id: a, date, kind: 'event', amount: Math.max(delta, -balance(a)), rating: delta,
    note: e ? `${have ? 'Пересмотр: ' : ''}${e.title}: ${e.score} из 5 · очки дня ×${(1 + e.score / 10).toFixed(1)}` : 'Событие убрано' });
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
    // Повторы до цели по цене повтора, сверх цели — по своей цене, но не больше лимита в подходе.
    // При «Выборе» всё умножается на эффективность.
    const p = ruleSetPoints(pe, target, l.confirmed, ex?.eff ?? 100);
    bon = p.bonus;
    mult = streakMult(r, dayStreak(l.athlete_id, l.date));
    total = Math.round((p.base + bon) * mult);
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

  [...new Set(db.purchases.filter((p) => p.athlete_id === a && p.kind === 'allin' && p.date < t && p.date >= addDays(t, -60))
    .map((p) => p.date))].forEach((d) => allinApply(a, d));
  [...new Set([...db.events.filter((e) => e.athlete_id === a).map((e) => e.date),
    ...db.ledger.filter((x) => x.athlete_id === a && x.kind === 'event').map((x) => x.date)])]
    .filter((d) => d < t && d >= addDays(t, -60)).forEach((d) => eventApply(a, d));
  [...new Set([...db.pari.filter((p) => p.athlete_id === a && p.start <= t && p.start >= addDays(t, -60)).flatMap((p) => pariDays(a, p.start)),
    ...db.ledger.filter((x) => x.athlete_id === a && x.kind === 'pari' && x.date >= addDays(t, -60)).map((x) => x.date)])]
    .filter((d) => d <= t).forEach((d) => pariApply(a, d));

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

// Что заменится в плане дня — как swap_items в базе.
const swapItems = (a, date, ids) => planSwaps(findDay(a, date)?.plan,
  db.logs.filter((l) => l.athlete_id === a && l.date === date), db.exercises, ids);

// ── Действия (общие для истории и для кнопок) ──

function review(l, decision, confirmed, comment) {
  l.review = decision;
  l.confirmed = { accepted: l.claimed, corrected: confirmed, rejected: 0 }[decision] ?? null;
  l.comment = (comment || '').trim() || null;
  awardSet(l);
  settle(l.athlete_id);
}

// Видео с номером подхода пришло, и повторы уже вписаны — бот принимает подход сам.
function videoAccept(l, url) {
  const b = pariBetAt(l.athlete_id, l.date);
  if (b && b.exercise_id === l.exercise_id && l.claimed >= b.reps) {
    // Подход на ставку «За гранью предела» смотрит генерал — бот только прикрепляет видео.
    Object.assign(l, { has_video: true, video_url: url });
    return;
  }
  Object.assign(l, { has_video: true, video_url: url, auto: true });
  review(l, 'accepted');
}
const tgLink = (msg) => `https://t.me/c/3987236163/${msg}`;

// Повторы вписаны, а видео с этим номером уже ждёт — подход подтверждается сразу.
function waitingVideo(l, plan) {
  if (!db.settings.video_auto || l.claimed == null) return;
  const no = setNumber(plan, l.exercise_id, l.set_no);
  const v = db.videos.find((x) => x.athlete_id === l.athlete_id && x.date === l.date && x.no === no);
  if (!v) return;
  db.videos = db.videos.filter((x) => x !== v);
  videoAccept(l, v.url);
}

function buy(a, date) {
  const t = today();
  const r = rulesFor(t);
  if (date <= t) fail('Выходной покупается заранее, до начала дня');
  if (date > addDays(t, 60)) fail('Можно купить не дальше чем на 60 дней вперёд');
  if (r?.rest_day_price == null) fail('Цену выходного Тимур ещё не задал');
  const st = dayStatusOf(a, date);
  if (st !== 'training') fail('В этот день и так нет тренировки');
  if (db.purchases.some((p) => p.athlete_id === a && p.date === date && p.status === 'active')) {
    fail('На этот день уже куплено «Всё или ничего». Отмени его, если хочешь выходной');
  }
  if (pariBetAt(a, date)) fail('В этот день идёт «За гранью предела» — выходной не купить');
  if (r.purchase_limit_week != null) {
    const cnt = db.purchases.filter((p) => p.athlete_id === a && p.status === 'active' && p.kind === 'rest' && weekStart(p.date) === weekStart(date)).length;
    if (cnt >= r.purchase_limit_week) fail(`На этой неделе лимит: ${r.purchase_limit_week} вых.`);
  }
  const bal = balance(a);
  if (bal < r.rest_day_price) fail(`Не хватает очков: нужно ${r.rest_day_price}, на балансе ${bal}`);
  const p = { id: seq++, athlete_id: a, date, price: r.rest_day_price, prev_status: st, status: 'active', kind: 'rest', created_at: stamp() };
  db.purchases.push(p);
  putStatus(a, date, 'bought');
  addLedger({ athlete_id: a, date, kind: 'purchase', amount: -p.price, note: `Выходной на ${dayLabel(date)}` });
  return p;
}

function buyAllin(a, date) {
  const t = today();
  const r = rulesFor(t);
  if (date <= t) fail('«Всё или ничего» покупается заранее, до начала дня');
  if (date > addDays(t, 7)) fail('«Всё или ничего» можно купить не дальше чем на неделю вперёд');
  if (r?.allin_price == null) fail('Цену «Всё или ничего» Тимур ещё не задал');
  if (dayStatusOf(a, date) !== 'training') fail('В этот день нет тренировки');
  if (db.purchases.some((p) => p.athlete_id === a && p.date === date && p.status === 'active')) fail('На этот день уже есть покупка');
  if (pariBetAt(a, date)) fail('В этот день идёт «За гранью предела» — вместе нельзя');
  if (r.allin_limit_week != null) {
    const cnt = db.purchases.filter((p) => p.athlete_id === a && p.status === 'active' && p.kind === 'allin' && weekStart(p.date) === weekStart(date)).length;
    if (cnt >= r.allin_limit_week) fail(`На этой неделе лимит «Всё или ничего»: ${r.allin_limit_week}`);
  }
  const bal = balance(a);
  if (bal < r.allin_price) fail(`Не хватает очков: нужно ${r.allin_price}, на балансе ${bal}`);
  const p = { id: seq++, athlete_id: a, date, price: r.allin_price, prev_status: 'training', status: 'active', kind: 'allin', created_at: stamp() };
  db.purchases.push(p);
  addLedger({ athlete_id: a, date, kind: 'purchase', amount: -p.price, note: `Всё или ничего на ${dayLabel(date)}` });
  return p;
}

// «За гранью предела» — как pari_* в базе.
// 3 тренировочных дня пари начиная со start: больничный посреди — ставка переезжает на следующую тренировку.
function pariDays(a, start) {
  const res = [];
  for (let d = start; res.length < 3 && d < addDays(start, 21); d = addDays(d, 1)) if (dayStatusOf(a, d) === 'training') res.push(d);
  return res;
}
const pariRecord = (a, id) => Math.max(0, ...db.logs.filter((l) => l.athlete_id === a && l.exercise_id === id
  && (l.review === 'accepted' || l.review === 'corrected')).map((l) => l.confirmed ?? l.claimed ?? 0));
const pariOptions = (a, date) => (findDay(a, date)?.plan ?? currentPlan(a, date)).flatMap((x) => x.pick ?? [x])
  .map((y) => ({ id: y.id, name: y.name, unit: y.unit ?? 'reps', target_reps: y.target_reps ?? null }));
const pariBase = (a, o) => Math.max(pariRecord(a, o.id), o.target_reps ?? 0, 1);
function pariPrize(r, pct) {
  if (pct >= 50) return r?.pari_p50 ?? 0;
  if (pct >= 25) return r?.pari_p25 ?? 0;
  return pct >= 10 ? r?.pari_p10 ?? 0 : 0;
}
function pariBetAt(a, date) {
  for (const p of db.pari.filter((x) => x.athlete_id === a && x.status === 'active' && x.start <= date && x.start > addDays(date, -21))) {
    const i = pariDays(a, p.start).indexOf(date);
    if (i >= 0) return { ...p.bets[i], pari_id: p.id };
  }
  return null;
}
function pariState(a, date) {
  const b = pariBetAt(a, date);
  if (!b) return null;
  const logs = db.logs.filter((l) => l.athlete_id === a && l.date === date && l.exercise_id === b.exercise_id);
  const ok = logs.filter((l) => l.review === 'accepted' || l.review === 'corrected').map((l) => l.confirmed ?? l.claimed ?? 0);
  const best = ok.length ? Math.max(...ok) : null;
  let state = 'wait';
  if ((best ?? 0) >= b.reps) state = 'won';
  else if (logs.some((l) => l.review === 'pending' && l.claimed >= b.reps)) state = 'check';
  else if (date < today()) state = 'lost';
  const mult = streakMult(rulesFor(date), dayStreak(a, date));
  return { ...b, date, best, state, mult, points: Math.round(b.prize * mult), test: isTestDay(date) };
}
function pariApply(a, date) {
  if (isTestDay(date)) return;
  const s = pariState(a, date);
  const want = s?.state === 'won' ? s.points : 0;
  const have = db.ledger.filter((x) => x.athlete_id === a && x.date === date && x.kind === 'pari').reduce((n, x) => n + x.rating, 0);
  const delta = want - have;
  if (!delta) return;
  addLedger({ athlete_id: a, date, kind: 'pari', amount: Math.max(delta, -balance(a)), rating: delta,
    note: want === 0 ? 'За гранью предела: приз снят'
      : `${have ? 'Пересмотр: ' : ''}За гранью предела: ${s.name} ${s.best} при ставке ${s.reps} · приз ${s.prize} ×${s.mult}` });
}
function pariPlan(a, start) {
  const r = rulesFor(today());
  return { start, price: r?.pari_price ?? null, prizes: [r?.pari_p10, r?.pari_p25, r?.pari_p50],
    days: pariDays(a, start).map((date, i) => ({ n: i + 1, date, items: pariOptions(a, date).map((o) => {
      const base = pariBase(a, o);
      return { id: o.id, name: o.name, unit: o.unit, target: o.target_reps, record: pariRecord(a, o.id), base, min: Math.ceil(base * 1.1) };
    }) })) };
}
function buyPari(a, start, bets) {
  const t = today();
  const r = rulesFor(t);
  if (r?.pari_price == null) fail('«За гранью предела» пока не продаётся');
  if (start <= t) fail('«За гранью предела» покупается заранее, до начала дня');
  if (start > addDays(t, 7)) fail('Начать можно не дальше чем через неделю');
  const s = streakAt(a, t);
  if (s < (r.pari_streak ?? 0)) fail(`«За гранью предела» открывается при серии от ${r.pari_streak} дней, сейчас ${s}`);
  if (db.pari.some((p) => p.athlete_id === a && p.status === 'active' && weekStart(p.start) === weekStart(start))) {
    fail('«За гранью предела» — раз в неделю, на эту неделю уже куплено');
  }
  const days = pariDays(a, start);
  if (days.length < 3) fail('Впереди меньше трёх тренировок');
  days.forEach((d) => {
    if (pariBetAt(a, d)) fail(`${dayLabel(d)} уже в другом пари`);
    if (db.purchases.some((p) => p.athlete_id === a && p.date === d && p.status === 'active')) fail(`На ${dayLabel(d)} уже куплено «Всё или ничего» — вместе нельзя`);
  });
  if (!Array.isArray(bets) || bets.length !== 3) fail('Нужно три ставки — по одной на тренировку');
  if (balance(a) < r.pari_price) fail(`Не хватает очков: нужно ${r.pari_price}, на балансе ${balance(a)}`);
  const rows = days.map((d, i) => {
    const bet = bets.find((x) => x.n === i + 1);
    if (!bet) fail(`Нет ставки на тренировку ${i + 1}`);
    const o = pariOptions(a, d).find((y) => y.id === bet.exercise_id);
    if (!o) fail(`Этого упражнения нет в плане на ${dayLabel(d)}`);
    const base = pariBase(a, o);
    if (!(bet.reps >= Math.ceil(base * 1.1))) fail(`${o.name}: ставка минимум ${Math.ceil(base * 1.1)}`);
    const pct = Math.floor((bet.reps * 100) / base - 100);
    return { n: i + 1, exercise_id: o.id, name: o.name, unit: o.unit, reps: bet.reps, base, pct, prize: pariPrize(r, pct) };
  });
  const p = { id: seq++, athlete_id: a, start, price: r.pari_price, status: 'active', bets: rows, created_at: stamp() };
  db.pari.push(p);
  addLedger({ athlete_id: a, date: start, kind: 'purchase', amount: -p.price, note: `За гранью предела с ${dayLabel(start)}` });
  return p;
}
function pariList(a, from) {
  return db.pari.filter((p) => p.athlete_id === a && p.start >= from).sort((x, y) => x.start.localeCompare(y.start)).map((p) => {
    const days = pariDays(a, p.start);
    return { id: p.id, start: p.start, price: p.price, status: p.status, days,
      bets: p.bets.map((b) => (p.status === 'active' ? pariState(a, days[b.n - 1]) ?? { ...b, state: 'wait' } : { ...b, state: 'cancelled' })) };
  });
}

function setStatus(a, date, status) {
  if (status === 'bought') fail('Купленный выходной ставит атлет в магазине');
  const d = putStatus(a, date, status);
  const p = db.purchases.find((x) => x.athlete_id === a && x.date === date && x.status === 'active');
  if (p && !(p.kind === 'allin' && status === 'training')) {
    p.status = 'cancelled';
    addLedger({ athlete_id: a, date, kind: 'refund', amount: p.price,
      note: p.kind === 'allin' ? 'Тимур поменял день: очки за «Всё или ничего» вернулись' : 'Тимур поменял день: очки за выходной вернулись' });
    if (p.kind === 'allin') allinApply(a, date);
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
    // Подход ровно в цель — 400 (замены по просьбе — 300), сверх цели в подходе — до +100 (замены — до +75).
    per_exercise: Object.fromEntries([
      [1, 6], [2, 15], [3, 9], [4, 90], [5, 12], [6, 20], [7, 15], [8, 12], [9, 8], [10, 10], [11, 15],
      [21, 15], [22, 45], [23, 10], [24, 15], [25, 15], [26, 8], [27, 12], [28, 10],
      [12, 15, 300], [13, 18, 300], [14, 25, 300], [15, 12, 300], [16, 90, 300], [17, 20, 300], [18, 8, 300],
      [19, 20, 300], [20, 60, 300],
    ].map(([id, t, k = 400]) => {
      const cap = Math.ceil(t / 2);
      return [id, { rep: Math.round((k / t) * 100) / 100, over: Math.round((k / 4 / cap) * 100) / 100, cap }];
    })),
    streak_from: 3, streak_step: 0.1, streak_max: 1.5,
    miss_penalty_pct: 10, rest_day_price: 4000, purchase_limit_week: 2, phone_price: 150000,
    allin_price: 2000, allin_up: 0.3, allin_down: 0.7, allin_limit_week: 1, allin_streak: 5,
    pari_streak: 10, pari_price: 5000, pari_p10: 2500, pari_p25: 3500, pari_p50: 5000 });
  // «Выбор» с сегодняшнего дня: повтор того же −10% эффективности, не ниже 50%.
  db.rules.push({ ...db.rules[db.rules.length - 1], valid_from: T, choice_drop: 10, choice_floor: 50 });

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
    if (j === 11) {
      // «Всё или ничего» на следующую тренировку (там один подход отклонят — «ничего»).
      let date = addDays(d, 1);
      while (dayStatusOf(a, date) !== 'training') date = addDays(date, 1);
      buyAllin(a, date);
    }
    if (j === 13) {
      // Купил выходной на ближайший тренировочный день через два дня.
      let date = addDays(d, 2);
      while (dayStatusOf(a, date) !== 'training') date = addDays(date, 1);
      buy(a, date);
    }
  }
  // «Всё или ничего» и на сегодня — куплено вчера.
  frozen = addDays(T, -1);
  if (dayStatusOf(a, T) !== 'training') putStatus(a, T, 'training');
  try { buyAllin(a, T); } catch { /* лимит недели уже занят — не страшно */ }
  frozen = null;
  // Теория для тестовой недели — как пересчёт в save_rules.
  db.logs.filter((l) => isCal(rulesFor(l.date))).forEach(awardSet);
  if (dayStatusOf(a, T) !== 'training') putStatus(a, T, 'training');
  // С сегодняшнего дня — три комплекса по кругу, сегодня «Спина и бицепс». Включён пробный «Выбор»:
  // в каждом месте два варианта, подход ровно в цель у всех стоит 400.
  const it = (id, target_reps, alt, altTarget) => ({ id, sets: 2, target_reps, alt: { id: alt, target_reps: altTarget } });
  // Две последние тренировки друг в первом месте брал подтягивания, а не тягу рюкзака — сегодня они дешевле.
  const opt = (id, target_reps) => { const e = db.exercises.find((y) => y.id === id); return { id, name: e.name, unit: e.unit, target_reps }; };
  db.days.filter((d) => d.athlete_id === a && d.date < T && d.plan?.some((x) => x.id === 1)
    && db.logs.some((l) => l.athlete_id === a && l.date === d.date && l.exercise_id === 1))
    .sort((x, y) => y.date.localeCompare(x.date)).slice(0, 2)
    .forEach((d) => { d.plan = d.plan.map((x) => (x.id === 1 ? { ...x, pick: [opt(1, x.target_reps), opt(11, 15)], chosen: 0 } : x)); });
  db.complexes = [
    [it(1, 6, 11, 15), it(3, 9, 21, 15), it(7, 15, 22, 45)],
    [it(5, 12, 23, 10), it(8, 12, 24, 15), it(9, 8, 25, 15)],
    [it(6, 20, 26, 8), it(10, 10, 27, 12), it(2, 15, 4, 90)],
  ].map((items, i) => ({ id: seq++, position: i, items }));
  Object.assign(db.settings, { rotation_from: T, rotation_shift: 0, choice: true });
  markActive();
  ensureDay(a, T).note = 'Подтягивания — медленный негатив, 3 секунды вниз';
  db.mornings.push({ athlete_id: a, date: addDays(T, -1), muscles: 'sore', energy: 4, note: null });
  // Взвешивания за четыре недели: вес и жир понемногу снижаются, пару дней пропущено.
  for (let k = 69; k >= 1; k -= 1) {
    if ([62, 55, 48, 47, 33, 20, 9].includes(k)) continue;
    const t = 69 - k;
    db.body.push({
      athlete_id: a, date: addDays(T, -k),
      weight: Math.round((75.9 - t * 0.055 + Math.sin(t * 1.7) * 0.35) * 10) / 10,
      fat: Math.round((18.9 - t * 0.052 + Math.sin(t * 2.3) * 0.2) * 10) / 10,
    });
  }
  db.ideas.push({ id: seq++, athlete_id: a, text: 'Читмил в субботу за очки', status: 'new', created_at: stamp(), decided_at: null });
  // Видео из Telegram (концепт): сегодня друг взял варианты без турника и прислал 4 видео.
  // #1–#3 подтвердил бот, к #4 повторы ещё не вписаны.
  Object.assign(db.settings, { video_auto: true });
  const day = ensureDay(a, T);
  // Первое место (подтягивания или тяга) друг ещё не выбрал, во втором взял сгибания, в третьем лодочку.
  [[1, 1], [2, 0]].forEach(([i, k]) => { const x = day.plan[i]; const o = x.pick[k];
    day.plan[i] = { ...x, id: o.id, name: o.name, unit: o.unit, target_reps: o.target_reps, sets: o.sets ?? x.sets, chosen: k,
      ...(o.eff != null ? { times: o.times, eff: o.eff } : {}) }; });
  [[day.plan[1].id, 1, 15], [day.plan[1].id, 2, 16], [day.plan[2].id, 1, 15]].forEach(([id, n, r], i) => {
    const row = { id: seq++, athlete_id: a, date: T, exercise_id: id, set_no: n, claimed: r, has_video: false,
      review: 'pending', confirmed: null, comment: null, points: null, bonus: null };
    db.logs.push(row);
    videoAccept(row, tgLink(412 + i));
  });
  db.videos.push({ athlete_id: a, date: T, no: 6, url: tgLink(416) });
  // Событие понедельника: звезда на ниточке, мини-игра «Идеальный повтор» на ×1.5.
  db.events.push({ athlete_id: a, date: T, title: 'Событие понедельника', game: 'a', score: null, done: false });
  db.events.push({ athlete_id: a, date: addDays(T, -2), title: 'Событие субботы', game: 'b', score: 4, done: true });
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

  async setChoice(on) {
    needAdmin();
    const old = JSON.stringify(currentPlan(ATHLETE.id, today()));
    db.settings.choice = Boolean(on);
    replanToday(old);
  },

  async weekTemplate() { return clone(db.template); },

  async setWeekday(dow, status) {
    needAdmin();
    const t = db.template.find((x) => x.dow === dow);
    // Прошедшие дни остаются со старым статусом — как триггер freeze_past_days в базе.
    const start = db.settings.start_date;
    if (start && t.status !== status) {
      const add = [];
      for (let d = start; d < today(); d = addDays(d, 1)) {
        if (isoDow(d) === dow && !findDay(ATHLETE.id, d)) {
          add.push({ athlete_id: ATHLETE.id, date: d, status: t.status, plan: t.status === 'training' ? currentPlan(ATHLETE.id, d) : null, note: null });
        }
      }
      db.days.push(...add);
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

  async complexes() { return clone(db.complexes); },

  async saveComplexes(list, next) {
    needAdmin();
    if (!Array.isArray(list) || list.length < 1 || list.length > 5) fail('Комплексов — от 1 до 5');
    if (!Number.isInteger(next) || next < 0 || next >= list.length) fail('Нет такого комплекса');
    for (const c of list) {
      if (c.some((x) => !db.exercises.some((e) => e.id === x.id && !e.archived))) fail('В комплексе есть неизвестное упражнение');
      if (c.some((x) => x.sets < 1 || x.sets > 10 || (x.target_reps != null && (x.target_reps < 1 || x.target_reps > 1000)))) {
        fail('Подходов — от 1 до 10, цель — от 1 до 1000');
      }
      if (c.some((x) => x.alt && (!db.exercises.some((e) => e.id === x.alt.id && !e.archived)
        || (x.alt.target_reps != null && (x.alt.target_reps < 1 || x.alt.target_reps > 1000))
        || (x.alt.sets != null && (x.alt.sets < 1 || x.alt.sets > 10))))) fail('Второй вариант: неизвестное упражнение, подходов не от 1 до 10 или цель не от 1 до 1000');
      const ids = c.flatMap((x) => (x.alt ? [x.id, x.alt.id] : [x.id]));
      if (new Set(ids).size !== ids.length) fail('Упражнение повторяется в одном комплексе');
    }
    const t = today();
    const old = JSON.stringify(currentPlan(ATHLETE.id, t));
    db.complexes = list.map((c, i) => ({ id: seq++, position: i,
      items: c.map(({ id, sets, target_reps, alt }) => ({ id, sets, target_reps: target_reps ?? null,
        alt: alt ? { id: alt.id, target_reps: alt.target_reps ?? null, sets: alt.sets ?? sets } : null })) }));
    Object.assign(db.settings, { rotation_from: t, rotation_shift: next });
    markActive();
    replanToday(old);
  },

  // Пробный «Выбор»: друг сам берёт один из двух вариантов (i — номер пункта плана, k — 0 или 1). Один раз, без отмены.
  async chooseExercise(date, i, k) {
    needAthlete();
    if (date !== today()) fail('Выбрать можно только на сегодня');
    const d = findDay(current.id, date);
    const x = d?.plan?.[i];
    if (d?.status !== 'training' || !x?.pick?.[k]) fail('Тут нечего выбирать');
    if (x.chosen != null) fail('Выбор уже подтверждён');
    if (pickLocked(x, db.logs.filter((l) => l.athlete_id === current.id && l.date === date))) fail('Подход уже отмечен — выбор не поменять');
    const o = x.pick[k];
    d.plan[i] = { ...x, id: o.id, name: o.name, unit: o.unit, target_reps: o.target_reps, sets: o.sets ?? x.sets, chosen: k,
      ...(o.eff != null ? { times: o.times, eff: o.eff } : {}) };
    return clone(d);
  },

  async complexSchedule(a, from, to) {
    const out = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, status: dayStatusOf(a, d), complex: complexIndex(a, d) });
    return out;
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
      waitingVideo(row, d.plan);
      return clone(row);
    }
    const changed = prev.claimed !== claimed;
    const was = prev.claimed;
    Object.assign(prev, { claimed, has_video: hasVideo });
    if (changed) {
      Object.assign(prev, { review: 'pending', confirmed: null, auto: false });
      if (prev.points != null || prev.bonus != null || db.theory.some((x) => x.set_id === prev.id)) awardSet(prev);
      if (was == null) waitingVideo(prev, d.plan);
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

  // ── Видео из Telegram ──
  async videoSettings() { return { on: db.settings.video_auto, bot_sees: db.settings.bot_sees }; },
  async setVideoAuto(on) { needAdmin(); db.settings.video_auto = on; },
  // Видео, к которым друг ещё не вписал повторы.
  async waitingVideos(a, date) { return clone(db.videos.filter((v) => v.athlete_id === a && v.date === date)); },
  // Подходы, которые бот подтвердил по видео (сегодня и вчера) — админ может отменить.
  async videoConfirmed() {
    needAdmin();
    // Вчерашние — только до 03:00, потом в блоке остаются сегодняшние.
    const from = clock().grace ? addDays(today(), -1) : today();
    return clone(db.logs.filter((l) => l.auto && l.date >= from)
      .sort((a, b) => b.date.localeCompare(a.date) || a.id - b.id));
  },
  async undoVideo(id) {
    needAdmin();
    const l = db.logs.find((x) => x.id === id && x.auto) ?? fail('Подход не найден');
    Object.assign(l, { review: 'pending', confirmed: null, auto: false });
    awardSet(l);
    settle(l.athlete_id);
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
    const old = JSON.stringify(currentPlan(ATHLETE.id, today()));
    db.rules = db.rules.filter((r) => r.valid_from < row.valid_from).concat(row);
    replanToday(old);
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

  async buyAllin(date) {
    needAthlete();
    const s = streakAt(current.id, today());
    const need = rulesFor(today())?.allin_streak ?? 0;
    if (s < need) fail(`«Всё или ничего» открывается при серии от ${need} дней, сейчас ${s}`);
    return clone(buyAllin(current.id, date));
  },

  async eventDay(date, athleteId) {
    const a = athleteId ?? current.id;
    if (a !== current.id) needAdmin();
    const e = db.events.find((x) => x.athlete_id === a && x.date === date);
    if (!e) return null;
    const bonus = db.ledger.filter((x) => x.athlete_id === a && x.date === date && x.kind === 'event').reduce((n, x) => n + x.rating, 0);
    return clone({ ...e, test: isCal(rulesFor(date)), bonus });
  },

  async setEvent(a, date, game, title) {
    needAdmin();
    if (date < today()) fail('Событие можно поставить только на сегодня или позже');
    const e = db.events.find((x) => x.athlete_id === a && x.date === date);
    if (e && e.score !== null) fail('Атлет уже начал играть, событие не поменять');
    db.events = db.events.filter((x) => x !== e);
    if (!game) return null;
    db.events.push({ athlete_id: a, date, title: title?.trim() || 'Событие дня', game, score: null, done: false });
    return this.eventDay(date, a);
  },

  async playEvent(date, score, done) {
    needAthlete();
    const e = db.events.find((x) => x.athlete_id === current.id && x.date === date);
    if (!e || date !== today()) fail('Сегодня события нет');
    if (e.done) fail('Попытка уже была');
    e.score = Math.max(e.score ?? 0, Math.min(5, Math.round(score ?? 0)));
    e.done = Boolean(done);
    return this.eventDay(date);
  },

  async allinDay(date, athleteId) {
    const a = athleteId ?? current.id;
    if (a !== current.id) needAdmin();
    const s = allinState(a, date);
    if (s && s.test && current.role !== 'admin') Object.assign(s, { points: null, bonus: null });
    return clone(s);
  },

  async cancelPurchase(id) {
    const p = db.purchases.find((x) => x.id === id && (x.athlete_id === current.id || current.role === 'admin'));
    if (!p) fail('Покупка не найдена');
    if (p.status === 'cancelled') fail('Покупка уже отменена');
    if (p.date <= today()) fail('Отменить можно только до начала дня');
    p.status = 'cancelled';
    const d = findDay(p.athlete_id, p.date);
    if (d && d.status === 'bought') d.status = p.prev_status;
    addLedger({ athlete_id: p.athlete_id, date: p.date, kind: 'refund', amount: p.price,
      note: `${p.kind === 'allin' ? 'Отмена «Всё или ничего»' : 'Отмена выходного'} на ${dayLabel(p.date)}` });
    return clone(p);
  },

  async pariPlan(start) {
    needAthlete();
    return clone(pariPlan(current.id, start));
  },

  async buyPari(start, bets) {
    needAthlete();
    return clone(buyPari(current.id, start, bets));
  },

  async cancelPari(id) {
    const p = db.pari.find((x) => x.id === id && (x.athlete_id === current.id || current.role === 'admin'));
    if (!p) fail('Пари не найдено');
    if (p.status === 'cancelled') fail('Пари уже отменено');
    if (p.start <= today()) fail('Отменить можно только до начала первого дня');
    p.status = 'cancelled';
    addLedger({ athlete_id: p.athlete_id, date: p.start, kind: 'refund', amount: p.price, note: `Отмена «За гранью предела» с ${dayLabel(p.start)}` });
    return clone(p);
  },

  async pariList(from, athleteId) {
    const a = athleteId ?? current.id;
    if (a !== current.id) needAdmin();
    return clone(pariList(a, from));
  },

  async pariDay(date, athleteId) {
    const a = athleteId ?? current.id;
    if (a !== current.id) needAdmin();
    return clone(pariState(a, date));
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

  // ── v3.11: замена по просьбе ──

  async swapRequests(a, from) {
    return clone(db.swaps.filter((s) => s.athlete_id === a && s.date >= from).sort((x, y) => y.date.localeCompare(x.date)));
  },

  async pendingSwaps() {
    needAdmin();
    return clone(db.swaps.filter((s) => s.status === 'pending'));
  },

  async requestSwap(ids, note) {
    needAthlete();
    const t = today();
    if (!ids?.length) fail('Отметь, что заменить');
    const d = ensureDay(current.id, t);
    if (!d || d.status !== 'training') fail('Сегодня и так нет тренировки');
    if (swapItems(current.id, t, ids).length < ids.length) fail('Заменить можно только упражнение из плана, где ещё не отмечен ни один подход');
    let s = db.swaps.find((x) => x.athlete_id === current.id && x.date === t);
    if (s && s.status !== 'declined') fail('Запрос на сегодня уже отправлен');
    if (!s) { s = { id: seq++, athlete_id: current.id, date: t }; db.swaps.push(s); }
    Object.assign(s, { exercise_ids: [...ids], note: (note || '').trim().slice(0, 200) || null, status: 'pending', created_at: stamp(), decided_at: null });
    return clone(s);
  },

  async decideSwap(id, approve) {
    needAdmin();
    const s = db.swaps.find((x) => x.id === id) ?? fail('Запрос не найден');
    if (s.status !== 'pending') fail('Запрос уже решён');
    if (approve) {
      if (s.date < today()) fail('День уже закончился');
      const items = swapItems(s.athlete_id, s.date, s.exercise_ids);
      if (!items.length) fail('Менять уже нечего: подходы отмечены');
      const d = findDay(s.athlete_id, s.date);
      d.plan = d.plan.map((x) => {
        const i = items.find((y) => y.from.id === x.id);
        // При цене места замена стоит ¾ того, что стоило упражнение.
        return i ? { ...i.to, from: x, ...(x.price != null ? { price: Math.round(x.price * 0.75), top: Math.round((x.top ?? x.price) * 0.75), times: 0, eff: Math.round((x.eff ?? 100) * 0.75) } : {}) } : x;
      });
    }
    s.status = approve ? 'approved' : 'declined';
    s.decided_at = stamp();
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
    d.plan = full ?? (date === today() ? currentPlan(a, date) : null);
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

  // ── v3.10: взвешивание ──

  async body(a, from, to) {
    return clone(db.body.filter((b) => b.athlete_id === a && (!from || b.date >= from) && (!to || b.date <= to))
      .sort((x, y) => (x.date < y.date ? -1 : 1)));
  },

  async saveBody(weight, fat) {
    if (current.role === 'admin') fail('Вес записывает сам атлет');
    if (weight === null || weight < 25 || weight > 300) fail('Вес — от 25 до 300 кг');
    if (fat !== null && (fat < 2 || fat > 70)) fail('Жир — от 2 до 70 %');
    const date = clock().today;
    let b = db.body.find((x) => x.athlete_id === current.id && x.date === date);
    if (!b) { b = { athlete_id: current.id, date }; db.body.push(b); }
    b.weight = Math.round(weight * 10) / 10;
    b.fat = fat === null ? null : Math.round(fat * 10) / 10;
    return clone(b);
  },

  async deleteBody(a, date) {
    if (current.role !== 'admin' && (a !== current.id || date !== clock().today)) fail('Удалить можно только сегодняшнее взвешивание');
    db.body = db.body.filter((b) => !(b.athlete_id === a && b.date === date));
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
