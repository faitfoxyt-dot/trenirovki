// Человечек для справочника: рисует позу в SVG и плавно переводит одну позу в другую.
// Вид сбоку, человек смотрит вправо. Поза задаётся точками: таз, наклон корпуса,
// куда тянутся кисти и стопы, — локти и колени находит сама (два звена на сустав).

export const L = { torso: 30, neck: 5, head: 7.5, ua: 16, fa: 15, th: 25, sh: 24, foot: 7 };
const W = { torso: 11, ua: 6.5, fa: 5.5, th: 8.5, sh: 7, foot: 4.5 };
export const FLOOR = 118;
const VIEW = '0 -12 200 140';

const rad = (d) => (d * Math.PI) / 180;
const dir = (deg) => [Math.sin(rad(deg)), -Math.cos(rad(deg))]; // 0° — вверх, 90° — вправо
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k];
const lerp = (a, b, t) => a + (b - a) * t;
const lerpP = (a, b, t) => (a && b ? [lerp(a[0], b[0], t), lerp(a[1], b[1], t)] : a ?? b);
const f1 = (n) => Math.round(n * 10) / 10;

// Два звена от корня к цели. Из двух положений сустава берём то, где сгиб идёт как у человека:
// колено сгибается назад, локоть вперёд. bend — нужный знак поворота от первого звена ко второму.
// Знак не зависит от того, куда тянется кисть или стопа, поэтому в анимации сустав не перескакивает.
function reach(root, target, l1, l2, bend) {
  const dx = target[0] - root[0];
  const dy = target[1] - root[1];
  const d = Math.min(Math.max(Math.hypot(dx, dy), Math.abs(l1 - l2) + 0.01), l1 + l2 - 0.01);
  const base = Math.atan2(dy, dx);
  const a = Math.acos((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d));
  const j1 = [root[0] + l1 * Math.cos(base + a), root[1] + l1 * Math.sin(base + a)];
  const j2 = [root[0] + l1 * Math.cos(base - a), root[1] + l1 * Math.sin(base - a)];
  const turn = (j) => (j[0] - root[0]) * (target[1] - j[1]) - (j[1] - root[1]) * (target[0] - j[0]);
  const joint = turn(j1) * bend >= turn(j2) * bend ? j1 : j2;
  const ang = Math.atan2(target[1] - joint[1], target[0] - joint[0]);
  return [joint, [joint[0] + l2 * Math.cos(ang), joint[1] + l2 * Math.sin(ang)]];
}

// Поза → координаты суставов.
export function solve(p) {
  const hip = p.hip;
  const td = dir(p.t ?? 0);
  const sh = add(hip, td, L.torso);
  const hd = dir((p.t ?? 0) + (p.hd ?? 0));
  const head = add(sh, hd, L.neck + L.head);
  const side = p.back ? -1 : 1; // лёжа на спине лицо смотрит в другую сторону
  const nose = dir((p.t ?? 0) + (p.hd ?? 0) + 90 * side);
  const arm = (h) => { const [el, wr] = reach(sh, h, L.ua, L.fa, -side); return { el, wr }; };
  const leg = (f, ft) => {
    const [kn, an] = reach(hip, f, L.th, L.sh, side);
    return { kn, an, toe: add(an, dir(ft ?? p.ft ?? 90), L.foot) };
  };
  return {
    hip, sh, head, nose,
    arm: arm(p.h), arm2: p.h2 ? arm(p.h2) : null,
    leg: leg(p.f, p.ft), leg2: p.f2 ? leg(p.f2, p.ft2) : null,
  };
}

const line = (a, b, w, cls) => `<line class="${cls}" x1="${f1(a[0])}" y1="${f1(a[1])}" x2="${f1(b[0])}" y2="${f1(b[1])}" stroke-width="${w}"/>`;
// Рабочая мышца светится: под ней широкая полупрозрачная линия (без CSS-фильтров — они тормозят анимацию на телефоне).
const seg = (a, b, w, cls) => (cls === 'fg-hot' ? line(a, b, w + 6, 'fg-glow') : '') + line(a, b, w, cls);

// Предметы: пол, турник, стул, диван, стена, рюкзак.
function props(p, j) {
  let out = '';
  if (p.wall !== undefined) out += `<rect class="fg-prop" x="${p.wall - 6}" y="0" width="6" height="${FLOOR}"/>`;
  if (p.bar) {
    out += `<rect class="fg-prop-2" x="${p.bar[0] - 34}" y="${p.bar[1] - 1.5}" width="68" height="3" rx="1.5" opacity=".35"/>`
      + `<circle class="fg-bar" cx="${p.bar[0]}" cy="${p.bar[1]}" r="3.4"/>`;
  }
  if (p.chair) {
    const [x, y, w] = p.chair;
    out += `<rect class="fg-prop" x="${x}" y="${y}" width="${w}" height="5" rx="2"/>`
      + `<rect class="fg-prop" x="${x + 2}" y="${y}" width="4" height="${FLOOR - y}"/>`
      + `<rect class="fg-prop" x="${x + w - 6}" y="${y}" width="4" height="${FLOOR - y}"/>`
      + `<rect class="fg-prop" x="${x + 2}" y="${y - 30}" width="4" height="30" rx="2"/>`;
  }
  if (p.sofa) {
    const [x, y, w] = p.sofa;
    out += `<rect class="fg-prop" x="${x}" y="${y}" width="${w}" height="${FLOOR - y}" rx="5"/>`
      + `<rect class="fg-prop-2" x="${x}" y="${y - 18}" width="12" height="${FLOOR - y + 18}" rx="5"/>`;
  }
  if (p.floor !== false) out += `<line class="fg-floor" x1="-60" y1="${FLOOR + 1.5}" x2="260" y2="${FLOOR + 1.5}"/>`;
  return out;
}

function bag(p, j) {
  if (!p.bag) return '';
  const at = p.bag === 'h' ? j.arm.wr : p.bag;
  const hang = p.bagHang ?? 7; // рюкзак висит под кистью
  const x = at[0] - 7;
  const y = at[1] - 3 + (p.bag === 'h' ? hang - 7 : 0);
  return `<g class="fg-bag"><rect x="${f1(x)}" y="${f1(y)}" width="14" height="15" rx="4"/>`
    + `<rect class="fg-bag-2" x="${f1(x + 3)}" y="${f1(y + 7)}" width="8" height="5" rx="1.5"/></g>`;
}

// Тело рисуется слоями: дальние руки и ноги приглушены, ближние — поверх корпуса.
export function poseSVG(p) {
  const j = solve(p);
  const hot = new Set(p.hot ?? []);
  const c = (part, far) => (far ? 'fg-far' : hot.has(part) ? 'fg-hot' : 'fg-body');
  const limbArm = (a, far) => seg(j.sh, a.el, W.ua, c('ua', far)) + seg(a.el, a.wr, W.fa, c('fa', far))
    + `<circle class="${far ? 'fg-far-f' : 'fg-body-f'}" cx="${f1(a.wr[0])}" cy="${f1(a.wr[1])}" r="3.2"/>`;
  const limbLeg = (l, far) => seg(j.hip, l.kn, W.th, c('th', far)) + seg(l.kn, l.an, W.sh, c('sh', far))
    + seg(l.an, l.toe, W.foot, far ? 'fg-far' : 'fg-body');
  const neck = add(j.sh, dir((p.t ?? 0) + (p.hd ?? 0)), L.neck * 0.6);
  const n1 = add(j.head, j.nose, L.head - 1);
  return props(p, j)
    + (j.leg2 ? limbLeg(j.leg2, true) : '')
    + (j.arm2 ? limbArm(j.arm2, true) : '')
    + (p.bag2 ? bag({ ...p, bag: p.bag2 }, j) : '')
    + seg(j.sh, neck, 6, 'fg-body')
    + seg(j.hip, j.sh, W.torso, c('torso'))
    + (hot.has('hip') ? `<circle class="fg-hot-f" cx="${f1(j.hip[0])}" cy="${f1(j.hip[1])}" r="6.5"/>` : '')
    + `<circle class="fg-body-f" cx="${f1(j.head[0])}" cy="${f1(j.head[1])}" r="${L.head}"/>`
    + `<circle class="fg-eye" cx="${f1(n1[0])}" cy="${f1(n1[1])}" r="1.6"/>`
    + limbLeg(j.leg)
    + limbArm(j.arm)
    + bag(p, j);
}

// Хват сверху (вид спереди): где кисти относительно плеч и куда смотрят ладони.
const GRIPS = {
  wide: { span: 1.5, label: 'шире плеч · ладони от себя' },
  narrow: { span: 0.75, label: 'на ширине плеч · ладони к себе' },
  neutral: { span: 0.9, label: 'ладони смотрят друг на друга' },
  close: { span: 0.6, label: 'ладони близко, под грудью' },
};
export function gripSVG(kind) {
  const g = GRIPS[kind];
  if (!g) return '';
  const half = 18 * g.span;
  const palm = (x) => `<rect class="fg-hot-f" x="${f1(x - 3.5)}" y="11" width="7" height="10" rx="3"/>`;
  return `<svg class="fg-grip" viewBox="0 0 80 40" aria-hidden="true">
    <line class="fg-floor" x1="6" y1="14" x2="74" y2="14"/>
    <circle class="fg-far-f" cx="22" cy="30" r="3"/><circle class="fg-far-f" cx="58" cy="30" r="3"/>
    <line class="fg-far" x1="22" y1="30" x2="58" y2="30" stroke-width="2.5"/>
    ${palm(40 - half)}${palm(40 + half)}
  </svg><span><b>Хват:</b> ${g.label}</span>`;
}

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
// Промежуточная поза. Кисть или стопа, которая стоит на месте (на полу, на турнике), остаётся на месте.
// Остальные идут по дуге вокруг плеча или таза: прямая нога поднимается прямой, а не сгибается по пути.
const shoulderOf = (p) => add(p.hip, dir(p.t ?? 0), L.torso);
function arc(pa, pb, ra, rb, r, t) {
  if (!pa || !pb) return pa ?? pb;
  if (Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) < 0.5) return pa;
  const aa = Math.atan2(pa[1] - ra[1], pa[0] - ra[0]);
  let ab = Math.atan2(pb[1] - rb[1], pb[0] - rb[0]);
  if (ab - aa > Math.PI) ab -= 2 * Math.PI;
  if (aa - ab > Math.PI) ab += 2 * Math.PI;
  const ang = lerp(aa, ab, t);
  const len = lerp(Math.hypot(pa[0] - ra[0], pa[1] - ra[1]), Math.hypot(pb[0] - rb[0], pb[1] - rb[1]), t);
  return [r[0] + len * Math.cos(ang), r[1] + len * Math.sin(ang)];
}
export const mix = (a, b, t) => {
  const out = { ...a };
  out.hip = lerpP(a.hip, b.hip, t);
  for (const k of ['t', 'hd', 'ft', 'ft2']) if (a[k] !== undefined || b[k] !== undefined) out[k] = lerp(a[k] ?? 0, b[k] ?? 0, t);
  const sa = shoulderOf(a);
  const sb = shoulderOf(b);
  const so = shoulderOf(out);
  for (const k of ['h', 'h2']) if (a[k] || b[k]) out[k] = arc(a[k], b[k], sa, sb, so, t);
  for (const k of ['f', 'f2']) if (a[k] || b[k]) out[k] = arc(a[k], b[k], a.hip, b.hip, out.hip, t);
  if (Array.isArray(a.bag) && Array.isArray(b.bag)) out.bag = lerpP(a.bag, b.bag, t);
  return out;
};

// Рамка вокруг всех кадров упражнения: человечек крупнее, пол всегда внизу, пропорции 10:7.
export function fitBox(frames) {
  const xs = [];
  const ys = [];
  const put = (pt, r = 0) => { xs.push(pt[0] - r, pt[0] + r); ys.push(pt[1] - r, pt[1] + r); };
  for (const p of frames) {
    const j = solve(p);
    put(j.head, L.head + 1); put(j.hip, 6); put(j.sh, 6);
    for (const a of [j.arm, j.arm2]) if (a) { put(a.el, 4); put(a.wr, 4); }
    for (const l of [j.leg, j.leg2]) if (l) { put(l.kn, 5); put(l.an, 4); put(l.toe, 3); }
    if (p.bag) { const b = p.bag === 'h' ? j.arm.wr : p.bag; const up = (p.bagHang ?? 7) < 0; put([b[0], b[1] + (up ? -16 : 16)], 8); }
    if (p.bar) put(p.bar, 6);
    if (p.chair) { put([p.chair[0], p.chair[1] - 32]); put([p.chair[0] + p.chair[2], FLOOR]); }
    if (p.sofa) { put([p.sofa[0], p.sofa[1] - 20]); put([p.sofa[0] + p.sofa[2], FLOOR]); }
    if (p.wall !== undefined) put([p.wall - 8, 20]);
  }
  const floor = frames.some((p) => p.floor !== false);
  let x0 = Math.min(...xs) - 10;
  let x1 = Math.max(...xs) + 10;
  let y0 = Math.min(...ys) - 8;
  let y1 = floor ? FLOOR + 6 : Math.max(...ys) + 8;
  let w = Math.max(x1 - x0, 120);
  let h = y1 - y0;
  if (w / h < 10 / 7) w = (h * 10) / 7; else h = (w * 7) / 10;
  const cx = (x0 + x1) / 2;
  x0 = cx - w / 2;
  if (floor) y0 = y1 - h; else { const cy = (y0 + y1) / 2; y0 = cy - h / 2; }
  return [x0, y0, w, h].map(f1).join(' ');
}

export const svg = (inner, cls = '', box = VIEW) => `<svg class="fg ${cls}" viewBox="${box}" aria-hidden="true"><g>${inner}</g></svg>`;

// Петля по кадрам: держим позу, плавно переходим в следующую, после последней — к первой.
// onPhase(i) зовётся, когда начинается кадр i (для подписи под картинкой).
export function play(el, frames, onPhase = () => {}) {
  const g = el.querySelector('g');
  if (frames.length < 2 || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    g.innerHTML = poseSVG(frames[frames.length - 1]);
    onPhase(frames.length - 1);
    return () => {};
  }
  const HOLD = 650;
  let i = 0;
  let t0 = performance.now();
  let raf = 0;
  let last = '';
  onPhase(0);
  const tick = (now) => {
    if (!el.isConnected) return;
    const a = frames[i];
    const b = frames[(i + 1) % frames.length];
    const hold = a.hold ?? HOLD;
    const move = b.move ?? 900;
    const dt = now - t0;
    let next;
    if (dt < hold) next = poseSVG(a);
    else if (dt < hold + move) next = poseSVG(mix(a, b, ease((dt - hold) / move)));
    else {
      i = (i + 1) % frames.length;
      t0 = now;
      onPhase(i);
      next = poseSVG(frames[i]);
    }
    if (next !== last) { g.innerHTML = next; last = next; } // пока поза стоит, ничего не перерисовываем
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
