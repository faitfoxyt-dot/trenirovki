// Оболочка: выбор режима (демо или Supabase), вход, вкладки и переходы.

import { html, raw } from './util.js';
import * as login from './views/login.js';
import * as today from './views/today.js';
import * as calendar from './views/calendar.js';
import * as review from './views/review.js';
import * as plan from './views/plan.js';
import * as goal from './views/goal.js';
import * as shop from './views/shop.js';
import * as rules from './views/rules.js';
import * as body from './views/body.js';

const DEMO = new URLSearchParams(location.search).has('demo');
const { api } = DEMO ? await import('./api/demo.js') : await import('./api/supabase.js');

const ICONS = {
  today: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 12l3 3 5-6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  review: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
  plan: '<path d="M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1"/>',
  friend: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  goal: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
  body: '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M8 9a5 5 0 0 1 8 0"/><path d="M12 9l1.5-2"/>',
  shop: '<path d="M5 8h14l-1 12H6L5 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  rules: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
};

const TABS = {
  athlete: [
    { route: 'today', label: 'Сегодня', icon: 'today' },
    { route: 'calendar', label: 'Календарь', icon: 'calendar' },
    { route: 'body', label: 'Тело', icon: 'body' },
    { route: 'goal', label: 'Цель', icon: 'goal' },
    { route: 'shop', label: 'Магазин', icon: 'shop' },
  ],
  admin: [
    { route: 'review', label: 'Проверка', icon: 'review' },
    { route: 'plan', label: 'План', icon: 'plan' },
    { route: 'rules', label: 'Правила', icon: 'rules' },
    { route: 'today', label: 'Друг', icon: 'friend' },
  ],
};

// Экраны друга: у атлета это вкладки, у админа — разделы вкладки «Друг».
const FRIEND = TABS.athlete;
const FRIEND_ROUTES = ['today', 'day', 'calendar', 'body', 'goal', 'shop'];

const VIEWS = { today, day: today, calendar, body, goal, shop, review, plan, rules };

const root = document.getElementById('app');
const ctx = { api, demo: DEMO, toast, refresh: () => route(), signOut };

function toast(message) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    document.body.append(t);
  }
  t.textContent = message;
  t.classList.add('toast-on');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('toast-on'), 3200);
}

async function signOut() {
  await api.signOut();
  ctx.me = null;
  location.hash = '';
  start();
}

function shell() {
  const tabs = TABS[ctx.me.role];
  root.innerHTML = String(html`
    ${DEMO ? html`<div class="demo-bar">
      <span>Демо · данные не сохраняются</span>
      <button type="button" class="demo-switch" id="demo-switch">Роль: ${ctx.me.role === 'admin' ? 'Тимур' : 'Друг'} ⇄</button>
    </div>` : ''}
    ${ctx.me.role === 'admin' && ctx.athletes.length > 1 ? html`<div class="athlete-bar">
      <label for="athlete-pick">Атлет</label>
      <select id="athlete-pick" class="input input-sm">
        ${ctx.athletes.map((a) => html`<option value="${a.id}" ${a.id === ctx.athleteId ? html`selected` : ''}>${a.name || 'без имени'}</option>`)}
      </select>
    </div>` : ''}
    <main class="main">
      ${ctx.me.role === 'admin' ? html`<nav class="subnav" id="subnav" aria-label="Экраны друга" hidden>
        ${FRIEND.map((t) => html`<a class="sub-tab" data-route="${t.route}" href="#/${t.route}">${t.label}</a>`)}
      </nav>` : ''}
      <div class="view" id="view"></div>
    </main>
    <nav class="tabbar" aria-label="Вкладки">
      ${tabs.map((t) => html`<a class="tab" data-route="${t.route}" href="#/${t.route}">
        <svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${raw(ICONS[t.icon])}</svg>${t.label}</a>`)}
    </nav>`);

  root.querySelector('#demo-switch')?.addEventListener('click', async () => {
    api.switchRole();
    await boot();
    location.hash = ctx.me.role === 'admin' ? '#/review' : '#/today';
    route();
  });
  root.querySelector('#athlete-pick')?.addEventListener('change', (e) => {
    ctx.athleteId = e.target.value;
    try { localStorage.setItem('athlete', ctx.athleteId); } catch { /* приватный режим */ }
    route();
  });
}

function parseHash() {
  const [name, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: name || '', args: rest };
}

let routeSeq = 0;

async function route() {
  if (!ctx.me) return;
  const { name, args } = parseHash();
  const tabs = TABS[ctx.me.role];
  const view = VIEWS[name];
  const isAdmin = ctx.me.role === 'admin';
  const friend = FRIEND_ROUTES.includes(name);
  // Правила атлет открывает по ссылке из «Цели», если Тимур включил показ (проверяет сам экран).
  const allowed = tabs.some((t) => t.route === name) || name === 'day' || (isAdmin && friend) || name === 'rules';
  if (!view || !allowed) {
    location.replace(`#/${tabs[0].route}`);
    return;
  }
  const sub = name === 'day' ? 'today' : name;
  const active = isAdmin && friend ? 'today' : !isAdmin && name === 'rules' ? 'goal' : sub;
  const mark = (t, on) => {
    t.classList.toggle(t.classList.contains('tab') ? 'tab-on' : 'sub-on', on);
    if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  };
  root.querySelectorAll('.tab').forEach((t) => mark(t, t.dataset.route === active));
  const subnav = root.querySelector('#subnav');
  if (subnav) {
    subnav.hidden = !friend;
    subnav.querySelectorAll('.sub-tab').forEach((t) => mark(t, t.dataset.route === sub));
  }

  const el = root.querySelector('#view');
  const my = ++routeSeq;
  try {
    [ctx.clock, ctx.settings, ctx.rules] = await Promise.all([api.clock(), api.settings(), api.rules()]);
    if (my !== routeSeq) return;
    await view.render(el, ctx, args, () => my === routeSeq);
  } catch (err) {
    if (my !== routeSeq) return;
    el.innerHTML = String(html`<section class="card"><h2 class="h2">Не получилось загрузить</h2>
      <p class="label">${err.message}</p>
      <button type="button" class="ghost" id="retry">Попробовать ещё раз</button></section>`);
    el.querySelector('#retry').addEventListener('click', route);
  }
}

async function boot() {
  ctx.me = await api.me();
  if (ctx.me.role === 'admin') {
    ctx.athletes = await api.athletes();
    let saved = null;
    try { saved = localStorage.getItem('athlete'); } catch { /* приватный режим */ }
    ctx.athleteId = ctx.athletes.find((a) => a.id === saved)?.id ?? ctx.athletes[0]?.id ?? null;
  } else {
    ctx.athletes = [];
    ctx.athleteId = ctx.me.id;
  }
  shell();
}

async function start() {
  root.innerHTML = '<main class="main"><p class="label">Загрузка…</p></main>';
  try {
    const session = await api.session();
    if (!session) {
      login.render(root, ctx, async () => { await boot(); route(); });
      return;
    }
    await boot();
    route();
  } catch (err) {
    root.innerHTML = String(html`<main class="main"><section class="card">
      <h2 class="h2">Не получилось открыть</h2><p class="label">${err.message}</p>
      <button type="button" class="ghost" id="retry">Попробовать ещё раз</button></section></main>`);
    root.querySelector('#retry').addEventListener('click', start);
  }
}

window.addEventListener('hashchange', route);
start();
