// Вход по почте и паролю. Регистрации нет: аккаунты создаёт Тимур в Supabase.

import { html } from '../util.js';

export function render(root, ctx, onDone) {
  root.innerHTML = String(html`<main class="main main-center">
    <header class="stack-8">
      <p class="sub">Трекер тренировок</p>
      <h1 class="h1">Вход</h1>
    </header>
    <form class="card" id="login" novalidate>
      <label class="label" for="email">Почта</label>
      <input class="input" id="email" type="email" autocomplete="username" inputmode="email" autocapitalize="off" required>
      <label class="label" for="password">Пароль</label>
      <input class="input" id="password" type="password" autocomplete="current-password" required>
      <p class="error" id="login-error" role="alert"></p>
      <button class="btn" type="submit">Войти</button>
    </form>
    <p class="label center">Аккаунт выдаёт крутой генерал. Пароль можно сохранить в «Паролях» iPhone.</p>
  </main>`);

  const form = root.querySelector('#login');
  const error = root.querySelector('#login-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!email || !password) {
      error.textContent = 'Введи почту и пароль';
      return;
    }
    const btn = form.querySelector('button');
    btn.disabled = true;
    error.textContent = '';
    try {
      await ctx.api.signIn(email, password);
      await onDone();
    } catch (err) {
      error.textContent = err.message;
      btn.disabled = false;
    }
  });
}
