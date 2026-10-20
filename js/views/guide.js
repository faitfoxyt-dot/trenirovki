// Справочник: все упражнения каталога с человечком, который показывает движение,
// шагами «как делать» и частыми ошибками. Открывается поверх «Сегодня».

import { html, raw } from '../util.js';
import { goalText, unitOf } from '../logic.js';
import { GROUPS, guideFor } from '../guide-data.js';
import { poseSVG, svg, fitBox, play, gripSVG, underlay } from '../figure.js';

// Упражнения дня по порядку: у «Выбора» — оба варианта.
function planItems(plan) {
  const out = [];
  for (const ex of plan ?? []) {
    const opts = ex.pick ? ex.pick.map((o) => ({ id: o.id, name: o.name, sets: ex.sets, target_reps: o.target_reps })) : [ex];
    for (const o of opts) if (!out.some((x) => x.id === o.id)) out.push(o);
  }
  return out;
}

const thumb = (g) => {
  if (!g) return html`<div class="gd-none" aria-hidden="true">?</div>`;
  const last = g.frames[g.frames.length - 1];
  return raw(svg(poseSVG(last), '', fitBox(g.frames), underlay(g.frames)));
};

export function openGuide(ctx, { catalog, plan, focus = null }) {
  const list = (catalog ?? []).filter((e) => !e.archived);
  const today = planItems(plan);
  const layer = document.createElement('div');
  layer.className = 'gd-overlay';
  layer.innerHTML = '<div class="gd-sheet" role="dialog" aria-modal="true" aria-label="Справочник упражнений"></div>';
  const sheet = layer.firstElementChild;
  document.body.append(layer);
  document.body.classList.add('gd-lock');

  let stop = () => {};
  const remove = () => {
    stop();
    layer.remove();
    document.body.classList.remove('gd-lock');
    window.removeEventListener('popstate', remove);
    document.removeEventListener('keydown', onKey);
  };
  // Кнопка «Назад» на телефоне закрывает справочник, а не уходит со страницы.
  history.pushState({ guide: true }, '');
  window.addEventListener('popstate', remove);
  const close = () => (history.state?.guide ? history.back() : remove());
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  layer.addEventListener('click', (e) => { if (e.target === layer) close(); });

  const tile = (e) => html`<button type="button" class="gd-tile" data-id="${e.id}">
    <span class="gd-thumb">${thumb(guideFor(e.name))}</span>
    <span class="gd-tile-name">${e.name}</span></button>`;

  function showList() {
    stop();
    const groups = GROUPS.map((gr) => ({ ...gr, items: list.filter((e) => guideFor(e.name)?.group === gr.key) }));
    const other = list.filter((e) => !guideFor(e.name));
    sheet.innerHTML = String(html`
      <div class="row"><span class="gd-tag">📖 Справочник</span>
        <button type="button" class="ghost icon gd-close" aria-label="Закрыть">✕</button></div>
      <div class="stack-4">
        <h2 class="gd-title">Как делать упражнения</h2>
        <p class="label">Нажми на упражнение — человечек покажет движение, а ниже будет, как делать правильно.</p>
      </div>
      ${today.length ? html`<section class="stack-8"><h3 class="gd-h3">Сегодня в плане</h3>
        <div class="gd-grid">${today.map((e) => tile(list.find((x) => x.id === e.id) ?? e))}</div></section>` : ''}
      ${groups.filter((g) => g.items.length).map((g) => html`<section class="stack-8"><h3 class="gd-h3">${g.name}</h3>
        <div class="gd-grid">${g.items.map(tile)}</div></section>`)}
      ${other.length ? html`<section class="stack-8"><h3 class="gd-h3">Другие</h3>
        <div class="gd-grid">${other.map(tile)}</div></section>` : ''}`);
    sheet.querySelector('.gd-close').addEventListener('click', close);
    sheet.querySelectorAll('.gd-tile').forEach((b) => b.addEventListener('click', () => showOne(Number(b.dataset.id))));
    sheet.scrollTop = 0;
  }

  function showOne(id) {
    stop();
    const ex = list.find((e) => e.id === id) ?? today.find((e) => e.id === id);
    if (!ex) { showList(); return; }
    const g = guideFor(ex.name);
    const inPlan = today.find((e) => e.id === id);
    const box = g ? fitBox(g.frames) : null;
    sheet.innerHTML = String(html`
      <div class="row">
        <button type="button" class="ghost gd-back">← Все упражнения</button>
        <button type="button" class="ghost icon gd-close" aria-label="Закрыть">✕</button></div>
      ${g ? html`<div class="gd-stage">
          ${raw(svg('', '', box, underlay(g.frames)))}
          ${g.hold ? html`<span class="gd-hold">⏱ Держи</span>` : ''}
          <div class="gd-phase">
            ${g.frames.length > 1 ? html`<span class="gd-dots">${g.frames.map(() => html`<i></i>`)}</span>` : ''}
            <span class="gd-cap"></span></div>
        </div>`
        : html`<div class="gd-stage gd-stage-none"><div class="gd-none">?</div>
          <p class="label center">Картинки для этого упражнения пока нет. Спроси у генерала, как его делать.</p></div>`}
      <div class="stack-8">
        <h2 class="gd-title">${ex.name}</h2>
        <div class="chips">
          ${g ? html`<span class="chip">💪 ${g.muscles}</span>` : ''}
          ${inPlan ? html`<span class="chip chip-on">Сегодня: ${goalText(inPlan, unitOf(inPlan, catalog))}</span>` : ''}
        </div>
        ${g?.grip ? html`<div class="gd-grip">${raw(gripSVG(g.grip))}</div>` : ''}
      </div>
      ${g ? html`<section class="stack-8"><h3 class="gd-h3">Как делать</h3>
        <ol class="gd-steps">${g.steps.map((s, i) => html`<li><span class="news-n">${i + 1}</span><span>${s}</span></li>`)}</ol></section>
        <section class="stack-8"><h3 class="gd-h3">Частые ошибки</h3>
          ${g.bad ? html`<div class="gd-bad">${raw(svg(poseSVG(g.bad), 'fg-bad', fitBox([g.bad]), underlay([g.bad])))}<span>✕ ${g.badText}</span></div>` : ''}
          <ul class="gd-mistakes">${g.mistakes.map((m) => html`<li><span aria-hidden="true">✕</span><span>${m}</span></li>`)}</ul></section>` : ''}
    `);
    sheet.querySelector('.gd-close').addEventListener('click', close);
    sheet.querySelector('.gd-back').addEventListener('click', showList);
    sheet.scrollTop = 0;
    if (!g) return;
    const fig = sheet.querySelector('.gd-stage .fg');
    const cap = sheet.querySelector('.gd-cap');
    const dots = [...sheet.querySelectorAll('.gd-dots i')];
    stop = play(fig, g.frames, (i) => {
      cap.textContent = g.frames[i].cap ?? '';
      dots.forEach((d, k) => d.classList.toggle('on', k === i));
    });
  }

  if (focus !== null && list.concat(today).some((e) => e.id === focus)) showOne(focus);
  else showList();
}
