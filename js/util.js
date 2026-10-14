// Мелкие помощники: безопасная вставка текста в HTML и работа с датами.
// Даты везде — строки 'YYYY-MM-DD' по Таллину, без часовых поясов.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

// Шаблон, который экранирует всё, кроме уже собранных кусков html``.
class Html {
  constructor(text) { this.text = text; }
  toString() { return this.text; }
}

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    out += piece(v) + strings[i + 1];
  });
  return new Html(out);
}

function piece(v) {
  if (v instanceof Html) return v.text;
  if (Array.isArray(v)) return v.map(piece).join('');
  if (v === false || v === null || v === undefined) return '';
  return esc(v);
}

export const raw = (text) => new Html(text);

// ── Даты ──

const WD_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
export const WEEKDAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
export { WD_SHORT };

function parts(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

function toUtc(iso) {
  const { y, m, d } = parts(iso);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(iso, n) {
  return fromUtc(toUtc(iso) + n * 86400000);
}

// 1 = понедельник … 7 = воскресенье.
export function isoDow(iso) {
  const wd = new Date(toUtc(iso)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function dayTitle(iso) {
  const { m, d } = parts(iso);
  return `${WD_SHORT[isoDow(iso) - 1]}, ${d} ${MONTHS_GEN[m - 1]}`;
}

export function shortDate(iso) {
  const { m, d } = parts(iso);
  return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}`;
}

export function monthKey(iso) {
  return iso.slice(0, 7);
}

export function shiftMonth(key, n) {
  const [y, m] = key.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export function monthTitle(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function monthDays(key) {
  const [y, m] = key.split('-').map(Number);
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${key}-${String(i + 1).padStart(2, '0')}`);
}

// Сейчас по Таллину — для демо-режима. В настоящем режиме время даёт база.
export function tallinnNow() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Tallinn', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { today: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, hour: Number(p.hour) };
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
