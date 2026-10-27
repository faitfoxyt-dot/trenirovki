// «Русская рулетка»: что может выпасть на колесе дня.
// Названия, значки и цвета — здесь. Прибавки и шансы — в settings.roulette, их меняет генерал в «Правилах».
// Выпавшее число прибавляется к множителю очков за подходы (серия или «Всё или ничего») — как roulette_* в базе.

export const ROULETTE = 'Русская рулетка';

// Сектора по кругу, по часовой стрелке от стрелки: плюс и минус вперемешку, Пуля — рядом с Джекпотом.
// special — особый сектор: revolver (курок или отказ), respin (крутится ещё раз), star (событие дня).
export const OUTCOMES = [
  { key: 'jackpot', name: 'Джекпот', icon: '💰', color: '#FFD54A', ink: '#2A1F00', say: 'Очки за подходы сегодня почти вдвое!' },
  { key: 'miss', name: 'Мимо', icon: '🙈', color: '#C9892B', say: 'Совсем чуть-чуть в минус.' },
  { key: 'double', name: 'Дуплет', icon: '💥', color: '#6DBE45', say: 'Два попадания подряд — хороший плюс.' },
  { key: 'respin', name: 'Ещё раз', icon: '🔄', color: '#3F5EFB', special: true, say: 'Колесо крутится снова.' },
  { key: 'misfire', name: 'Осечка', icon: '😬', color: '#F06A2A', say: 'Сегодня очков поменьше, но день не потерян.' },
  { key: 'hit', name: 'Попадание', icon: '🎯', color: '#22A699', say: 'Небольшой, но плюс.' },
  { key: 'wound', name: 'Ранение', icon: '🩹', color: '#E23B4A', say: 'Неприятно. Но пропуск обошёлся бы дороже.' },
  { key: 'volley', name: 'Залп', icon: '🎆', color: '#C6F432', ink: '#11140A', say: 'Отличный день, чтобы выложиться.' },
  { key: 'revolver', name: 'Револьвер', icon: '🔫', color: '#7B2CBF', special: true, say: 'В барабане один патрон. Рискнёшь?' },
  { key: 'blank', name: 'Холостой', icon: '💨', color: '#59606C', say: 'Ни плюса, ни минуса.' },
  { key: 'star', name: 'Звезда', icon: '⭐', color: '#2B2D7C', special: true, say: 'Сегодня событие дня. Звезда висит наверху справа — потяни, когда будешь готов: мини-игра до ×1.5.' },
  { key: 'bullet', name: 'Пуля', icon: '💀', color: '#A4161A', say: 'Самый неудачный сектор. Сделай всё — серия важнее.' },
];

export const outcome = (key) => OUTCOMES.find((o) => o.key === key) ?? OUTCOMES.find((o) => o.key === 'blank');

// Стартовые числа: в среднем около +0.1 к множителю (×1.1). add — прибавка, chance — шанс в %.
// gun — револьвер: курок пустой (5 из 6) даёт win, патрон — lose. floor — множитель дня не ниже (null — можно в минус).
// lock — подходы закрыты, пока друг не крутанул колесо (и не решил с револьвером).
export const DEFAULT_ROULETTE = {
  on: false, lock: true, floor: 0.1,
  items: {
    jackpot: { add: 1, chance: 10 }, volley: { add: 0.5, chance: 8 }, double: { add: 0.3, chance: 12 },
    hit: { add: 0.1, chance: 16 }, blank: { add: 0, chance: 12 }, miss: { add: -0.1, chance: 12 },
    misfire: { add: -0.3, chance: 10 }, wound: { add: -0.5, chance: 6 }, bullet: { add: -0.7, chance: 4 },
    revolver: { chance: 4 }, respin: { chance: 4 }, star: { chance: 2 },
  },
  gun: { win: 0.5, lose: -1, chambers: 6 },
};

// Настройки из базы поверх стартовых: чего нет — берём по умолчанию.
export function rouletteCfg(raw) {
  const r = raw ?? {};
  const items = {};
  OUTCOMES.forEach((o) => { items[o.key] = { ...DEFAULT_ROULETTE.items[o.key], ...(r.items?.[o.key] ?? {}) }; });
  return { ...DEFAULT_ROULETTE, ...r, items, gun: { ...DEFAULT_ROULETTE.gun, ...(r.gun ?? {}) } };
}

const round2 = (v) => Math.round(v * 100) / 100;

// Сколько в среднем прибавляет один день: обычные сектора по шансу, «ещё раз» — как обычная прокрутка,
// револьвер — если жать на курок. Звезда ничего не прибавляет к множителю (у неё своя награда).
export function rouletteEV(cfg) {
  const c = rouletteCfg(cfg);
  const g = c.gun;
  const gunEV = ((g.chambers - 1) * g.win + g.lose) / g.chambers;
  const val = (o) => (o.key === 'revolver' ? gunEV : o.special ? 0 : Number(c.items[o.key].add ?? 0));
  const w = (o) => Number(c.items[o.key].chance ?? 0);
  const plain = OUTCOMES.filter((o) => o.key !== 'respin');
  const plainW = plain.reduce((s, o) => s + w(o), 0);
  const plainEV = plainW ? plain.reduce((s, o) => s + w(o) * val(o), 0) / plainW : 0;
  const total = OUTCOMES.reduce((s, o) => s + w(o), 0);
  return total ? round2((plainW * plainEV + w({ key: 'respin' }) * plainEV) / total) : 0;
}

export const chanceSum = (cfg) => OUTCOMES.reduce((s, o) => s + Number(rouletteCfg(cfg).items[o.key].chance ?? 0), 0);

// Случайный сектор по шансам. exclude — каких не может быть (например, звезды, когда событие уже есть).
export function pickKey(cfg, exclude = [], rnd = Math.random) {
  const c = rouletteCfg(cfg);
  const list = OUTCOMES.filter((o) => !exclude.includes(o.key) && Number(c.items[o.key].chance) > 0);
  const total = list.reduce((s, o) => s + Number(c.items[o.key].chance), 0);
  let x = rnd() * total;
  for (const o of list) {
    x -= Number(c.items[o.key].chance);
    if (x < 0) return o.key;
  }
  return list[list.length - 1]?.key ?? 'blank';
}

// «+0.3», «−0.7», «0».
export const addText = (v) => {
  const n = round2(Number(v ?? 0));
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0';
};

// Настроение сектора: от него цвет карточки и эффекты.
export function toneOf(key, add) {
  if (key === 'jackpot') return 'gold';
  if (key === 'star' || key === 'respin' || (key === 'revolver' && add == null)) return 'special';
  const v = Number(add ?? 0);
  if (v >= 0.5) return 'great';
  if (v > 0) return 'good';
  if (v === 0) return 'zero';
  return v <= -0.5 ? 'awful' : 'bad';
}

// Множитель дня после рулетки: база (серия или «Всё или ничего») + прибавка, но не ниже пола.
export const dayMult = (m, add, floor) => {
  const v = round2(Number(m) + Number(add ?? 0));
  return floor == null ? v : Math.max(Number(floor), v);
};

// Что не так с настройками — как проверка в save_roulette. Пусто — можно сохранять.
export function rouletteProblems(raw) {
  const c = rouletteCfg(raw);
  const bad = [];
  const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  OUTCOMES.forEach((o) => {
    const it = c.items[o.key];
    if (!Number.isInteger(it.chance) || it.chance < 0 || it.chance > 100) bad.push(`${o.name}: шанс — целое от 0 до 100`);
    if (!o.special && !num(it.add, -2, 2)) bad.push(`${o.name}: прибавка от −2 до 2`);
  });
  const sum = chanceSum(c);
  if (sum !== 100) bad.push(`сумма шансов ${sum}%, а нужно 100%`);
  const g = c.gun;
  if (!Number.isInteger(g.chambers) || g.chambers < 2 || g.chambers > 12) bad.push('револьвер: гнёзд от 2 до 12');
  if (!num(g.win, -2, 2) || !num(g.lose, -2, 2)) bad.push('револьвер: прибавки от −2 до 2');
  if (c.floor != null && !num(c.floor, 0, 1)) bad.push('множитель дня не ниже: от 0 до 1');
  return bad;
}

// Худший и лучший исход дня: [прибавка, название].
export function rouletteRange(raw) {
  const c = rouletteCfg(raw);
  const list = OUTCOMES.filter((o) => !o.special && c.items[o.key].chance > 0).map((o) => [Number(c.items[o.key].add), o.name]);
  if (c.items.revolver.chance > 0) list.push([c.gun.lose, 'Выстрел'], [c.gun.win, 'Пусто в револьвере']);
  if (!list.length) return null;
  const sorted = list.sort((a, b) => a[0] - b[0]);
  return { low: sorted[0], high: sorted[sorted.length - 1] };
}
