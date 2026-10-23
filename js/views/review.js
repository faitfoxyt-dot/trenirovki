// «Проверка» (админ): запросы на больничный и очередь подходов — принять, исправить,
// отклонить, комментарий. Очки за подход база считает в момент решения.

import { html, dayTitle } from '../util.js';
import { MUSCLES, caption, setPoints, signed, multTag, amount, unitOf, unitText, ALLIN, PARI, swapItems, setNumber } from '../logic.js';

const DECISIONS = [
  { key: 'accepted', label: 'Принять' },
  { key: 'corrected', label: 'Исправить' },
  { key: 'rejected', label: 'Отклонить' },
];

const SAVED_TEXT = {
  accepted: (l, unit) => `Принято: ${amount(l.confirmed, unit)}${pointsTail(l)}`,
  corrected: (l, unit) => `Исправлено: ${amount(l.confirmed, unit)}${pointsTail(l)}`,
  rejected: (l) => `Отклонено${pointsTail(l)}`,
};

function pointsTail(l) {
  const p = setPoints(l);
  return p === null ? '' : ` · ${signed(p)}${multTag(l.mult)}`;
}

export async function render(el, ctx, args, alive) {
  const { api, clock } = ctx;
  const [pending, exercises, mornings, sick, ideas, swaps, byVideo] = await Promise.all([
    api.pendingLogs(),
    api.exercises(),
    ctx.athleteId ? api.mornings(ctx.athleteId, clock.today, clock.today) : [],
    api.pendingSick(),
    ctx.athleteId ? api.ideas(ctx.athleteId) : [],
    api.pendingSwaps(),
    api.videoConfirmed ? api.videoConfirmed() : [],
  ]);
  if (!alive()) return;
  // Номер подхода за день (#1…) — по плану дня, как его видел друг.
  const plans = new Map();
  await Promise.all([...new Set([...byVideo, ...pending].map((l) => `${l.athlete_id}|${l.date}`))].map(async (k) => {
    const [a, d] = k.split('|');
    plans.set(k, (await api.days(a, d, d))[0]?.plan);
  }));
  [...byVideo, ...pending].forEach((l) => { l.no = setNumber(plans.get(`${l.athlete_id}|${l.date}`), l.exercise_id, l.set_no); });
  // Что заменится по каждому запросу — по плану дня, как в базе.
  await Promise.all(swaps.map(async (s) => {
    const [days, logs] = await Promise.all([api.days(s.athlete_id, s.date, s.date), api.logs(s.athlete_id, s.date, s.date)]);
    s.items = swapItems(days[0]?.plan, logs, exercises, s.exercise_ids);
  }));
  if (!alive()) return;

  const exName = (id) => exercises.find((e) => e.id === id)?.name ?? 'Упражнение';
  const exUnit = (id) => unitOf({ id }, exercises);
  const athleteName = (id) => ctx.athletes.find((a) => a.id === id)?.name ?? '';
  const many = ctx.athletes.length > 1;
  const morning = mornings[0];
  const newIdeas = ideas.filter((i) => i.status === 'new').length;

  // Подходы одного дня одного атлета — вместе, с кнопкой «Принять всё за день».
  const groups = [];
  pending.forEach((l) => {
    const key = `${l.athlete_id}|${l.date}`;
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push(g = { key, date: l.date, athlete: l.athlete_id, logs: [] });
    g.logs.push(l);
  });

  // Дни с «Всё или ничего»: там каждое упражнение должно быть до конца и с видео.
  const allinDays = new Set();
  const from = groups.map((g) => g.date).sort()[0];
  if (from) {
    const lists = await Promise.all([...new Set(groups.map((g) => g.athlete))].map((a) => api.purchases(a, from)));
    lists.flat().filter((p) => p.kind === 'allin').forEach((p) => allinDays.add(`${p.athlete_id}|${p.date}`));
    if (!alive()) return;
  }
  // Ставки «За гранью предела» на эти дни: подход на ставку бот не принимает — решает генерал.
  const bets = new Map();
  if (api.pariDay) {
    const list = await Promise.all(groups.map((g) => api.pariDay(g.date, g.athlete)));
    if (!alive()) return;
    groups.forEach((g, i) => { if (list[i]) bets.set(g.key, list[i]); });
  }

  el.innerHTML = String(html`
    <header class="stack-8">
      <p class="sub">Подходы, которые ждут твоего решения</p>
      <h1 class="h1">Проверка</h1>
      <div class="chips"><span class="chip" id="pending-count">Ждут проверки: ${pending.length}</span>
        <a class="chip chip-link" href="#/goal">Очки вручную →</a></div>
    </header>
    ${sick.map((s) => html`<section class="card sick-card" data-sick="${s.id}">
      <div class="row"><span class="chip chip-bad">Больничный</span>${many ? html`<span class="label">${athleteName(s.athlete_id)}</span>` : ''}</div>
      <h2 class="h2">Просит больничный на ${dayTitle(s.date)}</h2>
      ${s.note ? html`<p class="label">«${s.note}»</p>` : ''}
      <p class="label">Одобришь — день станет «больничный»: очки не тратятся, серия не рвётся, штраф за пропуск снимется.</p>
      <div class="seg">
        <button type="button" class="pill" data-approve="1">Одобрить</button>
        <button type="button" class="pill" data-approve="0">Отказать</button>
      </div>
    </section>`)}
    ${swaps.map((s) => html`<section class="card swap-card" data-swap="${s.id}">
      <div class="row"><span class="chip chip-warn">🔁 Замена</span>${many ? html`<span class="label">${athleteName(s.athlete_id)}</span>` : ''}</div>
      <h2 class="h2">Просит замену на ${dayTitle(s.date)}</h2>
      ${s.note ? html`<p class="label">«${s.note}»</p>` : ''}
      ${s.items.length ? html`<ul class="swap-list">${s.items.map((r) => html`<li>
        <span class="swap-old">${r.from.name} · ${r.from.sets}×${amount(r.from.target_reps, r.from.unit)}</span>
        <span class="em">→ ${r.to.name} · ${r.to.sets}×${amount(r.to.target_reps, r.to.unit)}</span></li>`)}</ul>
      <p class="label">Одобришь — в плане дня будут замены. Очки — по их строкам в «Правилах», серия, пропуск и «Всё или ничего» считаются по новому плану.</p>`
      : html`<p class="label bad">Менять уже нечего: друг отметил эти упражнения. Можно только отказать.</p>`}
      <div class="seg">
        <button type="button" class="pill" data-approve="1">Одобрить</button>
        <button type="button" class="pill" data-approve="0">Отказать</button>
      </div>
    </section>`)}
    ${newIdeas ? html`<a class="notice" href="#/shop">Новые идеи для магазина: ${newIdeas} →</a>` : ''}
    ${pending.length ? groups.map((g) => html`<div class="row day-head">
      <h2 class="h2">${dayTitle(g.date)}${many ? html` · <span class="label">${athleteName(g.athlete)}</span>` : ''}</h2>
      ${allinDays.has(g.key) ? html`<span class="chip chip-allin" title="Каждый подход — до цели и с видео">🎲 ${ALLIN}</span>` : ''}
      ${bets.has(g.key) ? html`<span class="chip chip-pari">🔥 ${PARI}</span>` : ''}
      ${g.logs.length > 1 ? html`<button type="button" class="ghost" data-accept-day="${g.key}">Принять всё за день</button>` : ''}
    </div>
    ${g.logs.map((l) => html`<section class="card review-card" data-id="${l.id}" data-group="${g.key}" data-unit="${exUnit(l.exercise_id)}">
      <h2 class="h2">${exName(l.exercise_id)} · подход ${l.set_no}</h2>
      ${bets.get(g.key)?.exercise_id === l.exercise_id ? html`<p class="pari-note">🔥 Ставка «${PARI}»: ${amount(bets.get(g.key).reps, exUnit(l.exercise_id))}
        за подход. Засчитаешь столько или больше — друг выигрывает приз ${bets.get(g.key).prize} ×${bets.get(g.key).mult}.</p>` : ''}
      <p class="label">Заявлено: <b class="em">${amount(l.claimed, exUnit(l.exercise_id))}</b> · видео ${l.video_url
        ? html`<a href="${l.video_url}" target="_blank" rel="noopener">▶ смотреть</a>` : l.has_video ? 'есть' : html`<span class="bad">нет</span>`}<br>
        Подпись в Telegram: ${l.no ? `#${l.no}` : caption(l.date, exName(l.exercise_id), l.set_no)}</p>
      <div class="review-form">${formHtml(l, null, exUnit(l.exercise_id))}</div>
    </section>`)}`) : html`<section class="card"><h2 class="h2">Всё проверено</h2>
      <p class="label">Новые подходы появятся здесь, как только друг их отметит.</p></section>`}
    ${byVideo.length ? html`<div class="row day-head">
      <h2 class="h2">🫡 Подтверждено по видео</h2><span class="chip chip-on">${byVideo.length}</span></div>
      <p class="label vid-help">Бот засчитал сам: номер в подписи совпал с подходом. Не согласен — «Отменить»:
        подход вернётся на проверку, очки снимутся.</p>
      ${byVideo.map((l) => html`<section class="card video-card" data-vid="${l.id}" data-unit="${exUnit(l.exercise_id)}">
        <div class="row"><h2 class="h2">${exName(l.exercise_id)} · подход ${l.set_no}</h2><span class="vid-no">#${l.no ?? '?'}</span></div>
        <p class="label">${l.date === clock.today ? 'Сегодня' : dayTitle(l.date)}${many ? ` · ${athleteName(l.athlete_id)}` : ''}<br>
          Засчитано: <b class="em">${amount(l.confirmed, exUnit(l.exercise_id))}</b>${pointsTail(l)}</p>
        <div class="row-gap">
          ${l.video_url ? html`<a class="ghost link vid-link" href="${l.video_url}" target="_blank" rel="noopener">▶ Видео</a>` : ''}
          <button type="button" class="ghost ghost-bad vid-undo">Отменить</button>
        </div>
      </section>`)}` : ''}
    <section class="card">
      <h2 class="h2">Утро друга</h2>
      <p class="label">${morning
        ? html`Самочувствие: ${MUSCLES.find((m) => m.key === morning.muscles)?.label ?? '—'} · Энергия: ${morning.energy ?? '—'}${morning.note ? html`<br>«${morning.note}»` : ''}`
        : 'Сегодня ещё не заполнил.'}</p>
      ${morning?.muscles === 'pain' ? html`<p class="label bad">Друг отметил «плохо». Если друг попросит больничный, запрос появится здесь.</p>` : ''}
    </section>
  `);

  el.querySelectorAll('.sick-card').forEach((card) => {
    card.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
      const approve = b.dataset.approve === '1';
      try {
        await api.decideSick(Number(card.dataset.sick), approve);
        card.innerHTML = String(html`<p class="saved ${approve ? 'accepted' : 'rejected'}">
          ${approve ? 'Больничный одобрен' : 'В больничном отказано'}</p>`);
      } catch (e) { ctx.toast(e.message); }
    }));
  });

  el.querySelectorAll('.swap-card').forEach((card) => {
    card.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
      const approve = b.dataset.approve === '1';
      try {
        await api.decideSwap(Number(card.dataset.swap), approve);
        card.innerHTML = String(html`<p class="saved ${approve ? 'accepted' : 'rejected'}">
          ${approve ? 'Замена одобрена: план дня обновлён' : 'В замене отказано'}</p>`);
      } catch (e) { ctx.toast(e.message); }
    }));
  });

  let left = pending.length;
  const cards = [...el.querySelectorAll('.review-card')].map((card) => {
    const log = pending.find((l) => l.id === Number(card.dataset.id));
    return { group: card.dataset.group, ...wire(card, log, ctx, (delta) => {
      left += delta;
      el.querySelector('#pending-count').textContent = `Ждут проверки: ${left}`;
    }) };
  });

  // Отмена подтверждения по видео: подход снова ждёт решения — та же форма, что у обычной проверки.
  el.querySelectorAll('.video-card').forEach((card) => {
    card.querySelector('.vid-undo').addEventListener('click', async () => {
      try {
        const log = await api.undoVideo(Number(card.dataset.vid));
        left += 1;
        el.querySelector('#pending-count').textContent = `Ждут проверки: ${left}`;
        card.classList.replace('video-card', 'review-card');
        card.innerHTML = String(html`<h2 class="h2">${exName(log.exercise_id)} · подход ${log.set_no}</h2>
          <p class="label"><span class="warn">Подтверждение по видео отменено.</span> Заявлено: <b class="em">${amount(log.claimed, card.dataset.unit)}</b>
            ${log.video_url ? html` · <a href="${log.video_url}" target="_blank" rel="noopener">▶ видео</a>` : ''}</p>
          <div class="review-form">${formHtml(log, null, card.dataset.unit)}</div>`);
        wire(card, log, ctx, (delta) => {
          left += delta;
          el.querySelector('#pending-count').textContent = `Ждут проверки: ${left}`;
        });
      } catch (e) { ctx.toast(e.message); }
    });
  });

  el.querySelectorAll('[data-accept-day]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    const open = cards.filter((c) => c.group === b.dataset.acceptDay && !c.done());
    try {
      for (const c of open) await c.accept();
      ctx.toast(`Принято подходов: ${open.length}`);
    } catch (e) { ctx.toast(e.message); }
    b.disabled = false;
  }));
}

function formHtml(l, decision = null, unit = 'reps') {
  return html`
    <div class="seg" role="group" aria-label="Решение">
      ${DECISIONS.map((d) => html`<button type="button" class="pill ${decision === d.key ? 'pill-on' : ''}"
        data-decision="${d.key}" aria-pressed="${decision === d.key}">${d.label}</button>`)}
    </div>
    <div class="fix" ${decision === 'corrected' ? '' : html`hidden`}>
      <label class="label" for="fix-${l.id}">Подтверждено, ${unitText(unit).many}</label>
      <input class="input" id="fix-${l.id}" type="number" inputmode="numeric" pattern="[0-9]*" min="0" max="1000" placeholder="твоё число">
    </div>
    <label class="label" for="cm-${l.id}">Комментарий</label>
    <input class="input" id="cm-${l.id}" type="text" maxlength="300" placeholder="Что не так или что хорошо">
    <p class="error" role="alert"></p>
    <button type="button" class="btn save" ${decision ? '' : html`disabled`}>Сохранить решение</button>`;
}

function wire(card, log, ctx, onCount) {
  const box = card.querySelector('.review-form');
  let decision = null;
  let done = false;

  const submit = async (dec, confirmed, comment) => {
    const saved = await ctx.api.reviewSet(log.id, dec, confirmed, comment);
    done = true;
    onCount(-1);
    // В тестовый период очки не начисляются, но админ видит, сколько было бы.
    let theory = '';
    if (saved.points === null && saved.review !== 'rejected') {
      const t = (await ctx.api.theory(log.athlete_id, log.date, log.date)).find((x) => x.set_id === log.id);
      if (t) theory = ` · в теории ${signed(t.points)}${multTag(t.mult)}`;
    }
    box.innerHTML = String(html`<p class="saved ${saved.review}">${SAVED_TEXT[saved.review](saved, card.dataset.unit)}${theory}${saved.comment ? html` · ${saved.comment}` : ''}</p>
      <button type="button" class="ghost again">Изменить решение</button>`);
    box.querySelector('.again').addEventListener('click', () => {
      onCount(1);
      done = false;
      decision = null;
      box.innerHTML = String(formHtml(log, null, card.dataset.unit));
      bind();
    });
  };

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
        err.textContent = 'Впиши подтверждённое число';
        return;
      }
      const comment = box.querySelector(`#cm-${log.id}`).value;
      try {
        await submit(decision, confirmed, comment);
      } catch (e) {
        err.textContent = e.message;
      }
    });
  };
  bind();
  return { done: () => done, accept: () => submit('accepted', null, box.querySelector(`#cm-${log.id}`)?.value ?? '') };
}
