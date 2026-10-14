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
  { key: 'ok', label: 'Норма' },
  { key: 'sore', label: 'Крепатура' },
  { key: 'pain', label: 'Боль' },
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

export function dayState({ date, today, startDate, status, logs }) {
  if (startDate && date < startDate) return 'before';
  if (status === 'sick' || status === 'rest' || status === 'bought' || status === 'busy') return status;
  if (status !== 'training') return 'unset';
  if (date > today) return 'planned';
  const filled = logs.filter((l) => l.claimed !== null && l.claimed !== undefined);
  if (filled.length) return filled.some((l) => l.review === 'pending') ? 'pending' : 'confirmed';
  return date < today ? 'missed' : 'planned';
}

export function caption(date, exerciseName, setNo) {
  return `${shortDate(date)} · ${exerciseName} · подход ${setNo}`;
}

export function goalText(ex) {
  const sets = `${ex.sets} ${plural(ex.sets, 'подход', 'подхода', 'подходов')}`;
  return ex.target_reps ? `${sets} · цель ${ex.target_reps}` : `${sets} · цель после калибровки`;
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
  const tail = pts === null ? '' : ` · ${signed(pts)}`;
  if (log.review === 'accepted') return `Принято: ${log.confirmed}${tail}`;
  if (log.review === 'corrected') return `Исправлено: ${log.confirmed}${tail}`;
  return 'Отклонено';
}

// Очки за подход вместе с бонусом сверх цели; null — очки не считались (калибровка, не проверен).
export function setPoints(log) {
  if (log?.points === null || log?.points === undefined) return null;
  return log.points + (log.bonus ?? 0);
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
