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

export function goalText(ex) {
  const sets = `${ex.sets} ${plural(ex.sets, 'подход', 'подхода', 'подходов')}`;
  return ex.target_reps ? `${sets} · цель ${ex.target_reps}` : `${sets} · без цели`;
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
export function reviewNote(log) {
  if (!log || log.claimed === null || log.claimed === undefined) return '';
  if (log.review === 'pending') return 'На проверке';
  const pts = setPoints(log);
  const tail = pts === null ? '' : ` · ${signed(pts)}${multTag(log.mult)}`;
  if (log.review === 'accepted') return `Принято: ${log.confirmed}${tail}`;
  if (log.review === 'corrected') return `Исправлено: ${log.confirmed}${tail}`;
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
