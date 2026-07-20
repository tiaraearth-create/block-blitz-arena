// Small DOM helpers: screen router, toasts, modals, top bar.
import { session } from './net.js';

export const $ = sel => document.querySelector(sel);
export const $$ = sel => [...document.querySelectorAll(sel)];

const SCREENS = ['menu', 'game', 'matchmaking', 'leaderboard', 'shop', 'battlepass', 'admin'];

export function showScreen(name) {
  for (const s of SCREENS) {
    const el = $(`#screen-${s}`);
    if (el) el.classList.toggle('hidden', s !== name);
  }
}

export function toast(message, kind = '', ms = 2600) {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 350);
  }, ms);
}

export function showModal(html, { dismissable = true } = {}) {
  closeModal();
  const root = $('#modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal">${html}</div>`;
  if (dismissable) {
    backdrop.addEventListener('pointerdown', e => {
      if (e.target === backdrop) closeModal();
    });
  }
  root.appendChild(backdrop);
  return backdrop.querySelector('.modal');
}

export function closeModal() {
  $('#modal-root').innerHTML = '';
}

export function countdownOverlay(n, onDone, audio) {
  const el = document.createElement('div');
  el.className = 'countdown-overlay';
  document.body.appendChild(el);
  let i = n;
  const step = () => {
    if (i <= 0) {
      el.innerHTML = `<div class="countdown-num" style="color:#5ee86e">GO!</div>`;
      if (audio) audio.countdown(true);
      setTimeout(() => { el.remove(); onDone(); }, 600);
      return;
    }
    el.innerHTML = `<div class="countdown-num">${i}</div>`;
    if (audio) audio.countdown(false);
    i--;
    setTimeout(step, 900);
  };
  step();
}

export function fmt(n) { return Number(n).toLocaleString('ja-JP'); }

export function updateTopbar() {
  const u = session.user;
  $('#userName').textContent = u ? u.username : 'ゲスト';
  $('#userAvatar').textContent = u ? (u.role === 'admin' ? '🛡️' : '😀') : '👤';
  $('#coinsLabel').textContent = fmt(u ? u.coins : 0);
  $('#gemsLabel').textContent = fmt(u ? u.gems : 0);
  const lvl = $('#userLevel');
  if (u) { lvl.classList.remove('hidden'); lvl.textContent = `Lv.${u.level}`; }
  else lvl.classList.add('hidden');
  $('#btnAdmin').classList.toggle('hidden', !u || u.role !== 'admin');
}
