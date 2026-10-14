// «Проверка» (админ): очередь подходов — принять, исправить, отклонить, комментарий.
// Очки появятся в v3; сейчас решение только фиксирует подтверждённое число.

import { html, dayTitle } from '../util.js';
import { MUSCLES, caption } from '../logic.js';

const DECISIONS = [
  { key: 'accepted', label: 'Принять' },
  { key: 'corrected', label: 'Исправить' },
  { key: 'rejected', label: 'Отклонить' },
];

const SAVED_TEXT = {
  accepted: (l) => `Принято: ${l.confirmed}`,
  corrected: (l) => `Исправлено: ${l.confirmed}`,
  rejected: () => 'Отклонено',
};

export async function render(el, ctx, args, alive) {
  const { api, clock } = ctx;
  const [pending, exercises, mornings] = await Promise.all([
    api.pendingLogs(),
    api.exercises(),
    ctx.athleteId ? api.mornings(ctx.athleteId, clock.today, clock.today) : [],
  ]);
  if (!alive()) return;

  const exName = (id) => exercises.find((e) => e.id === id)?.name ?? 'Упражнение';
  const athleteName = (id) => ctx.athletes.find((a) => a.id === id)?.name ?? '';
  const many = ctx.athletes.length > 1;
  const morning = mornings[0];

  el.innerHTML = String(html`
    <header class="stack-8">
      <p class="sub">Подходы, которые ждут твоего решения</p>
      <h1 class="h1">Проверка</h1>
      <div class="chips"><span class="chip" id="pending-count">Ждут проверки: ${pending.length}</span></div>
    </header>
    ${pending.length ? pending.map((l) => html`<section class="card review-card" data-id="${l.id}">
      <div class="row"><span class="chip">${dayTitle(l.date)}</span>${many ? html`<span class="label">${athleteName(l.athlete_id)}</span>` : ''}</div>
      <h2 class="h2">${exName(l.exercise_id)} · подход ${l.set_no}</h2>
      <p class="label">Заявлено: <b class="em">${l.claimed}</b> · видео ${l.has_video ? 'есть' : html`<span class="bad">нет</span>`}<br>
        Подпись в Telegram: ${caption(l.date, exName(l.exercise_id), l.set_no)}</p>
      <div class="review-form">${formHtml(l)}</div>
    </section>`) : html`<section class="card"><h2 class="h2">Всё проверено</h2>
      <p class="label">Новые подходы появятся здесь, как только друг их отметит.</p></section>`}
    <section class="card">
      <h2 class="h2">Утро друга</h2>
      <p class="label">${morning
        ? html`Мышцы: ${MUSCLES.find((m) => m.key === morning.muscles)?.label ?? '—'} · Энергия: ${morning.energy ?? '—'}${morning.note ? html`<br>«${morning.note}»` : ''}`
        : 'Сегодня ещё не заполнил.'}</p>
      ${morning?.muscles === 'pain' ? html`<p class="label bad">Отметил боль. Больничный можно поставить в «Плане» → «Изменить один день».</p>` : ''}
    </section>
  `);

  let left = pending.length;
  el.querySelectorAll('.review-card').forEach((card) => {
    const log = pending.find((l) => l.id === Number(card.dataset.id));
    wire(card, log, ctx, (delta) => {
      left += delta;
      el.querySelector('#pending-count').textContent = `Ждут проверки: ${left}`;
    });
  });
}

function formHtml(l, decision = null) {
  return html`
    <div class="seg" role="group" aria-label="Решение">
      ${DECISIONS.map((d) => html`<button type="button" class="pill ${decision === d.key ? 'pill-on' : ''}"
        data-decision="${d.key}" aria-pressed="${decision === d.key}">${d.label}</button>`)}
    </div>
    <div class="fix" ${decision === 'corrected' ? '' : html`hidden`}>
      <label class="label" for="fix-${l.id}">Подтверждено, повторов</label>
      <input class="input" id="fix-${l.id}" type="number" inputmode="numeric" pattern="[0-9]*" min="0" max="1000" placeholder="твоё число">
    </div>
    <label class="label" for="cm-${l.id}">Комментарий</label>
    <input class="input" id="cm-${l.id}" type="text" maxlength="300" placeholder="Коротко: что не так или что хорошо">
    <p class="error" role="alert"></p>
    <button type="button" class="btn save" ${decision ? '' : html`disabled`}>Сохранить решение</button>`;
}

function wire(card, log, ctx, onCount) {
  const box = card.querySelector('.review-form');
  let decision = null;

  const bind = () => {
    box.querySelectorAll('[data-decision]').forEach((b) => b.addEventListener('click', () => {
      decision = b.dataset.decision;
      box.querySelectorAll('[data-decision]').forEach((x) => {
        const on = x.dataset.decision === decision;
        x.classList.toggle('pill-on', on);
        x.setAttribute('aria-pressed', String(on));
      });
      box.querySelector('.fix').hidden = decision !== 'corrected';
      box.querySelector('.save').disabled = false;
    }));

    box.querySelector('.save').addEventListener('click', async () => {
      const err = box.querySelector('.error');
      const fixVal = box.querySelector(`#fix-${log.id}`).value;
      const confirmed = decision === 'corrected' ? Number(fixVal) : null;
      if (decision === 'corrected' && (fixVal === '' || !Number.isInteger(confirmed) || confirmed < 0)) {
        err.textContent = 'Впиши подтверждённое число повторов';
        return;
      }
      const comment = box.querySelector(`#cm-${log.id}`).value;
      try {
        const saved = await ctx.api.reviewSet(log.id, decision, confirmed, comment);
        onCount(-1);
        box.innerHTML = String(html`<p class="saved ${saved.review}">${SAVED_TEXT[saved.review](saved)}${saved.comment ? html` · ${saved.comment}` : ''}</p>
          <button type="button" class="ghost again">Изменить решение</button>`);
        box.querySelector('.again').addEventListener('click', () => {
          onCount(1);
          decision = null;
          box.innerHTML = String(formHtml(log));
          bind();
        });
      } catch (e) {
        err.textContent = e.message;
      }
    });
  };
  bind();
}
