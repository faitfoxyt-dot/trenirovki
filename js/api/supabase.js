// Настоящий режим: данные в Supabase. Права проверяет база (RLS и функции),
// поэтому здесь только запросы.

import { createClient } from '../../vendor/supabase.js';
import { SUPABASE_URL, SUPABASE_KEY } from '../config.js';
import { general } from '../util.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

function check({ data, error }) {
  if (error) throw new Error(friendly(error.message));
  return data;
}

function friendly(message) {
  if (/Invalid login credentials/i.test(message)) return 'Неверная почта или пароль';
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return 'Нет связи с сервером';
  return general(message);
}

export const api = {
  demo: false,

  async session() {
    const { data } = await sb.auth.getSession();
    return data.session ? { id: data.session.user.id } : null;
  },

  async signIn(email, password) {
    check(await sb.auth.signInWithPassword({ email, password }));
  },

  async signOut() {
    await sb.auth.signOut();
  },

  async me() {
    const { data } = await sb.auth.getUser();
    const id = data.user?.id;
    return check(await sb.from('profiles').select('id, role, name').eq('id', id).single());
  },

  async athletes() {
    return check(await sb.from('profiles').select('id, name').eq('role', 'athlete').order('created_at'));
  },

  async clock() {
    return check(await sb.rpc('app_clock'));
  },

  async settings() {
    return check(await sb.from('settings').select('*').eq('id', 1).single());
  },

  async updateSettings(patch) {
    check(await sb.from('settings').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', 1));
  },

  async weekTemplate() {
    return check(await sb.from('week_template').select('dow, status').order('dow'));
  },

  async setWeekday(dow, status) {
    check(await sb.from('week_template').update({ status }).eq('dow', dow));
  },

  async exercises() {
    return check(await sb.from('exercises').select('*').order('position').order('id'));
  },

  async saveExercise(ex) {
    const row = {
      name: ex.name, unit: ex.unit ?? 'reps', sets: ex.sets, target_reps: ex.target_reps,
      position: ex.position, active: ex.active, archived: ex.archived ?? false,
    };
    if (ex.id) return check(await sb.from('exercises').update(row).eq('id', ex.id).select().single());
    return check(await sb.from('exercises').insert(row).select().single());
  },

  async openDay(date, athleteId) {
    const d = check(await sb.rpc('open_day', { p_date: date, p_athlete: athleteId ?? null }));
    // Функция возвращает пустую строку, если день ещё не наступил.
    return d && d.date ? d : null;
  },

  async days(athleteId, from, to) {
    return check(await sb.from('days').select('*')
      .eq('athlete_id', athleteId).gte('date', from).lte('date', to));
  },

  async logs(athleteId, from, to) {
    return check(await sb.from('set_logs').select('*')
      .eq('athlete_id', athleteId).gte('date', from).lte('date', to));
  },

  async mornings(athleteId, from, to) {
    return check(await sb.from('morning_checks').select('*')
      .eq('athlete_id', athleteId).gte('date', from).lte('date', to));
  },

  async logSet(date, exerciseId, setNo, claimed, hasVideo) {
    return check(await sb.rpc('log_set', {
      p_date: date, p_exercise_id: exerciseId, p_set_no: setNo,
      p_claimed: claimed, p_has_video: hasVideo,
    }));
  },

  async saveMorning({ muscles = null, energy = null, note = null }) {
    return check(await sb.rpc('save_morning', { p_muscles: muscles, p_energy: energy, p_note: note }));
  },

  async pendingLogs() {
    return check(await sb.from('set_logs').select('*')
      .eq('review', 'pending').not('claimed', 'is', null)
      .order('date').order('exercise_id').order('set_no'));
  },

  async reviewSet(id, decision, confirmed, comment) {
    return check(await sb.rpc('review_set', {
      p_id: id, p_decision: decision, p_confirmed: confirmed, p_comment: comment,
    }));
  },

  async setDayStatus(athleteId, date, status) {
    return check(await sb.rpc('set_day_status', { p_athlete: athleteId, p_date: date, p_status: status }));
  },

  // ── v3: очки, магазин, больничный, идеи ──

  async rules() {
    return check(await sb.rpc('rules_now'));
  },

  async saveRules(rules) {
    return check(await sb.rpc('save_rules', { p: rules }));
  },

  async wallet(athleteId) {
    return check(await sb.rpc('wallet', { p_athlete: athleteId ?? null }));
  },

  async ledger(athleteId, limit = 60) {
    return check(await sb.from('ledger').select('*')
      .eq('athlete_id', athleteId).order('id', { ascending: false }).limit(limit));
  },

  async purchases(athleteId, from) {
    return check(await sb.from('purchases').select('*')
      .eq('athlete_id', athleteId).eq('status', 'active').gte('date', from).order('date'));
  },

  async buyRestDay(date) {
    return check(await sb.rpc('buy_rest_day', { p_date: date }));
  },

  async cancelPurchase(id) {
    return check(await sb.rpc('cancel_purchase', { p_id: id }));
  },

  async sickRequests(athleteId, from) {
    return check(await sb.from('sick_requests').select('*')
      .eq('athlete_id', athleteId).gte('date', from).order('date', { ascending: false }));
  },

  async pendingSick() {
    return check(await sb.from('sick_requests').select('*').eq('status', 'pending').order('created_at'));
  },

  async requestSick(note) {
    return check(await sb.rpc('request_sick', { p_note: note ?? null }));
  },

  async decideSick(id, approve) {
    return check(await sb.rpc('decide_sick', { p_id: id, p_approve: approve }));
  },

  async ideas(athleteId) {
    return check(await sb.from('ideas').select('*')
      .eq('athlete_id', athleteId).order('id', { ascending: false }).limit(50));
  },

  async addIdea(text) {
    return check(await sb.rpc('add_idea', { p_text: text }));
  },

  async setIdeaStatus(id, status) {
    return check(await sb.rpc('set_idea_status', { p_id: id, p_status: status }));
  },

  // ── v3.1 ──

  async theory(athleteId, from, to) {
    return check(await sb.from('theory_points').select('*')
      .eq('athlete_id', athleteId).gte('date', from).lte('date', to));
  },

  async setDayPlan(athleteId, date, plan, note) {
    return check(await sb.rpc('set_day_plan', { p_athlete: athleteId, p_date: date, p_plan: plan, p_note: note ?? null }));
  },

  async grantPoints(athleteId, amount, note, rating) {
    return check(await sb.rpc('grant_points', { p_athlete: athleteId, p_amount: amount, p_note: note, p_rating: Boolean(rating) }));
  },

  async buyPhone() {
    return check(await sb.rpc('buy_phone'));
  },

  async deleteIdea(id) {
    return check(await sb.rpc('delete_idea', { p_id: id }));
  },

  async resetAthlete(athleteId) {
    return check(await sb.rpc('reset_athlete', { p_athlete: athleteId }));
  },

  // ── v3.2 ──

  async clearAthlete(athleteId, what, from, to) {
    return check(await sb.rpc('clear_athlete', { p_athlete: athleteId, p_what: what, p_from: from || null, p_to: to || null }));
  },

  async deleteLedger(id) {
    return check(await sb.rpc('delete_ledger', { p_id: id }));
  },
};
