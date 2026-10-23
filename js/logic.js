// Правила, общие для настоящего и демо-режима: состояние дня, подписи, тексты.

import { shortDate, isoDow, addDays } from './util.js';

export const DAY_STATUS = {
  training: 'Тренировка',
  rest: 'Выходной',
  bought: 'Купленный выходной',
  sick: 'Больничный',
  busy: 'Занят',
};

export const REVIEW = {
  pending: 'На проверке',
  accepted: 'Принято',
  corrected: 'Исправлено',
  rejected: 'Отклонено',
};

export const MUSCLES = [
  { key: 'pain', label: 'Плохо' },
  { key: 'sore', label: 'Так себе' },
  { key: 'ok', label: 'Готов' },
];

// Состояние дня в календаре — от него зависит цвет клетки.
export const DAY_STATE = {
  before: 'До старта',
  confirmed: 'Подтверждено',
  pending: 'На проверке',
  missed: 'Пропуск',
  sick: 'Больничный',
  rest: 'Выходной',
  bought: 'Купленный',
  busy: 'Занят',
  planned: 'По плану',
  unset: 'Не задано',
};

export function effectiveStatus(date, dayRow, template) {
  if (dayRow) return dayRow.status ?? null;
  const t = template.find((x) => x.dow === isoDow(date));
  return t ? t.status : null;
}

// plan — комплекс дня [{id, sets}]: прошедший день, где отмечен не каждый подход плана, — пропуск.
export function dayState({ date, today, startDate, status, logs, plan }) {
  if (startDate && date < startDate) return 'before';
  if (status === 'sick' || status === 'rest' || status === 'bought' || status === 'busy') return status;
  if (status !== 'training') return 'unset';
  if (date > today) return 'planned';
  const filled = logs.filter((l) => l.claimed !== null && l.claimed !== undefined);
  if (date < today && plan && dayCounts(plan, logs).done < dayCounts(plan, logs).total) return 'missed';
  if (filled.length) return filled.some((l) => l.review === 'pending') ? 'pending' : 'confirmed';
  return date < today ? 'missed' : 'planned';
}

// Подход засчитан, если в нём больше 0 повторов: до проверки — по числу друга,
// после — по числу Тимура (у отклонённого это 0). Как в базе.
export const setDone = (l) => (l.confirmed ?? l.claimed ?? 0) > 0;

// Сколько подходов плана засчитано и сколько всего — как day_counts в базе.
export function dayCounts(plan, logs) {
  const total = plan.reduce((s, e) => s + e.sets, 0);
  const done = logs.filter((l) => setDone(l) && plan.some((e) => e.id === l.exercise_id && l.set_no <= e.sets)).length;
  return { done, total };
}

export function caption(date, exerciseName, setNo) {
  return `${shortDate(date)} · ${exerciseName} · подход ${setNo}`;
}

// Номер подхода за день: подходы всех упражнений плана подряд, 1…N. Его друг пишет в подписи видео.
export function setNumber(plan, exerciseId, setNo) {
  let n = 0;
  for (const ex of plan ?? []) {
    if (ex.id === exerciseId) return setNo <= ex.sets ? n + setNo : null;
    n += ex.sets;
  }
  return null;
}
export const videoCaption = (no, name) => `#${no} ${name}`;

// Единица упражнения: 'reps' — повторы, 'sec' — секунды (планка и т.п.).
// Берём из каталога (там правда), иначе из снимка плана, иначе повторы.
export function unitOf(ex, catalog) {
  const id = ex?.id ?? ex?.exercise_id;
  return catalog?.find((e) => e.id === id)?.unit ?? ex?.unit ?? 'reps';
}
export const isSec = (unit) => unit === 'sec';

// Комплексы идут по кругу: А, Б, В… (не больше пяти).
export const CX_LETTERS = 'АБВГД';
export const cxLetter = (i) => CX_LETTERS[i] ?? '?';

// Число с единицей: «12» для повторов, «45 с» или «1 мин 30 с» для секунд.
export function amount(n, unit) {
  if (n === null || n === undefined) return '—';
  if (!isSec(unit) || n < 60) return isSec(unit) ? `${n} с` : `${n}`;
  const m = Math.floor(n / 60);
  const s = n % 60;
  return s ? `${m} мин ${s} с` : `${m} мин`;
}

// Подписи под единицу.
export const UNIT = {
  reps: { what: 'повторы', many: 'повторов', one: 'повтор', input: 'повторы' },
  sec: { what: 'секунды', many: 'секунд', one: 'секунду', input: 'секунды' },
};
export const unitText = (unit) => UNIT[unit] ?? UNIT.reps;

export function goalText(ex, unit = ex?.unit ?? 'reps') {
  const sets = `${ex.sets} ${plural(ex.sets, 'подход', 'подхода', 'подходов')}`;
  const tag = isSec(unit) ? ' · на время' : '';
  return ex.target_reps ? `${sets} · цель ${amount(ex.target_reps, unit)}${tag}` : `${sets} · без цели${tag}`;
}

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// Что видит атлет у подхода после проверки.
export function reviewNote(log, unit = 'reps') {
  if (!log || log.claimed === null || log.claimed === undefined) return '';
  if (log.review === 'pending') return 'На проверке';
  const pts = setPoints(log);
  const tail = pts === null ? '' : ` · ${signed(pts)}${multTag(log.mult)}`;
  if (log.review === 'accepted' && log.auto) return `Подтверждено по видео: ${amount(log.confirmed, unit)}${tail}`;
  if (log.review === 'accepted') return `Принято: ${amount(log.confirmed, unit)}${tail}`;
  if (log.review === 'corrected') return `Исправлено: ${amount(log.confirmed, unit)}${tail}`;
  return 'Отклонено';
}

// Очки за подход (уже с бонусом сверх цели и множителем серии); null — очки не считались.
export function setPoints(log) {
  if (log?.points === null || log?.points === undefined) return null;
  return log.points;
}

// Множитель серии рядом с очками: « (серия ×1.5)», при ×1 — ничего.
export function multTag(mult) {
  return Number(mult) > 1 ? ` (серия ×${Number(mult)})` : '';
}

export function signed(n) {
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0';
}

// Правила: null или calibration = очки не начисляются.
export function isCalibration(rules) {
  return !rules || rules.calibration !== false;
}

export const POINTS = (n) => `${n} ${plural(n, 'очко', 'очка', 'очков')}`;

// Режим дня для атлета: можно всё, только видео, или только смотреть.
export function dayMode({ date, clock, startDate, status }) {
  if (startDate && date < startDate) return 'closed';
  if (status !== 'training') return 'closed';
  if (date === clock.today) return 'open';
  if (clock.grace && date === addDays(clock.today, -1)) return 'grace';
  return 'closed';
}

// «Всё или ничего» (ALL IN): модификатор дня из магазина.
// Множитель дня = серия + up × сделанные упражнения − down × несделанные, не ниже ×0.1 — как allin_state в базе.
export const ALLIN = 'Всё или ничего';
// Модификаторы открываются серией и работают, пока она держится: пропустил день — снова закрыто.
export const ALLIN_STREAK = 7;
// «За гранью предела» (идея друга, переделанная в пари) — пока только витрина: ставка на 3 тренировки, приз за выигранный день, умножается на серию.
export const PARI = 'За гранью предела';
export const PARI_STREAK = 14;
export const PARI_PRICE = 5000;
export const PARI_PRIZES = [[10, 2500], [25, 3500], [50, 5000]]; // [ставка выше базы на %, приз]
const x2 = (v) => Math.round(Number(v) * 100) / 100;
export const allinMult = (k, up, down, done, miss) => Math.max(0.1, x2(k + up * done - down * miss));

// Пример на трёх упражнениях: всё сделал / одно не добил (без серии).
export function allinExample(r) {
  const up = Number(r?.allin_up ?? 0);
  const down = Number(r?.allin_down ?? 0);
  return { all: allinMult(1, up, down, 3, 0), oneMiss: allinMult(1, up, down, 2, 1), up: x2(up), down: x2(down) };
}

export const ALLIN_STATE = {
  done: { icon: '✅', text: 'сделано' },
  miss: { icon: '❌', text: 'не сделано' },
  wait: { icon: '⏳', text: 'на кону' },
};

// Выбор упражнения (пробный режим): в пункте плана pick — два варианта [{id, name, unit, target_reps}],
// chosen — какой выбран (null — ещё нет, тогда пункт считается первым вариантом).
// Выбор подтверждают кнопкой один раз — потом его не поменять. Не выбрал, но уже отметил подход — тоже закрыто.
export const pickLocked = (ex, logs) => ex.chosen != null || logs.some((l) => l.exercise_id === ex.id && l.claimed != null);
export const choiceIds = (c) => c.items.flatMap((x) => (x.alt ? [x.id, x.alt.id] : [x.id]));

// Замена по просьбе: что станет с упражнениями плана — как swap_items в базе.
// [{from: пункт плана, to: {id, name, unit, sets, target_reps}}]; ids — какие (null — все с заменой).
// Уже заменённые, пункты с выбором и те, где отмечен хоть один подход, не меняются.
export function swapItems(plan, logs, catalog, ids = null) {
  return (plan ?? []).flatMap((ex) => {
    if (ex.from || ex.pick || (ids && !ids.includes(ex.id))) return [];
    const e = catalog.find((x) => x.id === ex.id);
    const to = e?.swap_id && catalog.find((x) => x.id === e.swap_id && !x.archived);
    if (!to || logs.some((l) => l.exercise_id === ex.id && l.claimed != null)) return [];
    return [{ from: ex, to: { id: to.id, name: to.name, unit: to.unit ?? 'reps', sets: ex.sets,
      target_reps: e.swap_target ?? to.target_reps ?? null } }];
  });
}

// Эффективность при «Выборе»: берёт то же самое подряд — каждый раз минус choice_drop % (−10%, −20%, …),
// но не ниже choice_floor %; на неё умножаются очки подхода. Где выбора нет — 100%.
export function choiceEff(r, times = 0) {
  const drop = Number(r?.choice_drop ?? 0);
  const floor = Number(r?.choice_floor ?? 0);
  return Math.max(floor, 100 - drop * times);
}

// Очки за подход по «Правилам» упражнения — как award_set в базе (до множителя серии).
// rep — за каждый повтор до цели, over — за повтор сверх цели, cap — сколько повторов сверх цели
// в подходе считается. У упражнений на время всё в секундах. eff — эффективность при «Выборе», %.
export function ruleSetPoints(pe, target, reps, eff = 100) {
  if (!(reps > 0)) return { base: 0, bonus: 0 };
  const k = eff / 100;
  const base = Math.min(reps, target ?? reps) * (pe?.rep ?? 0) * k;
  const over = target != null && reps > target ? Math.min(reps - target, pe?.cap ?? Infinity) : 0;
  return { base, bonus: Math.round(over * (pe?.over ?? 0) * k) };
}
