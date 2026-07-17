// ui.js — shell, routing, first-run sign-in, toasts, sync pill (story 1.1).
// UI never awaits the network on a critical path (ADR-006); the only fetch in
// this story is the explicit sign-in verification.

import * as gh from './githubStore.js';
import * as store from './store.js';
import * as outbox from './outbox.js';
import * as investigate from './investigate.js';
import * as pricebook from './pricebook.js';
import * as inventory from './inventory.js';

const $ = (id) => document.getElementById(id);

// ---------- toast ----------
let toastTimer;
export function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
}

// ---------- paste buttons (FLIP-D11: one-tap paste, dictation-safe inputs) ----------
function wirePasteButtons(root) {
  root.querySelectorAll('[data-paste]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          $(btn.dataset.paste).value = text.trim();
          toast('Pasted');
        } else {
          toast('Clipboard is empty');
        }
      } catch (e) {
        toast('Tap the field and use Paste from the keyboard');
      }
    });
  });
}

// ---------- routing ----------
const VIEWS = ['investigate', 'pricebook', 'inventory'];
function show(view) {
  VIEWS.forEach((v) => { $('view-' + v).hidden = v !== view; });
  document.querySelectorAll('.navbtn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  localStorage.setItem('fs.lastView', view);
  window.dispatchEvent(new CustomEvent('view:show', { detail: { view } }));
}

// ---------- sync pill (live queue, story 1.2) ----------
export function setSyncPill(state, label) {
  const p = $('syncPill');
  p.className = 'sync-pill' + (state ? ' ' + state : '');
  p.textContent = label;
}

async function refreshPill() {
  const n = await outbox.pendingCount();
  const err = outbox.getError();
  if (err) setSyncPill('error', 'sync issue');
  else if (!navigator.onLine) setSyncPill('pending', n ? `offline · ${n} queued` : 'offline');
  else if (n > 0) setSyncPill('pending', `${n} to sync`);
  else setSyncPill('', 'synced');
}

// ---------- sign-in flow ----------
function showSignin() {
  $('view-signin').hidden = false;
  $('shell').hidden = true;
  const cfg = gh.getConfig();
  if (cfg.owner) $('inOwner').value = cfg.owner;
  if (cfg.repo) $('inRepo').value = cfg.repo;
}

function showShell() {
  $('view-signin').hidden = true;
  $('shell').hidden = false;
  show(localStorage.getItem('fs.lastView') || 'investigate');
  refreshPill();
  outbox.sync().then(refreshPill).catch(() => {}); // background, never blocks UI

  const days = gh.tokenExpiryDays();
  const warn = $('tokenWarn');
  if (days !== null && days <= 30) {
    warn.hidden = false;
    warn.textContent = days < 0
      ? 'Your GitHub token has expired. Sign out and set up a new one.'
      : `Your GitHub token expires in ${days} day${days === 1 ? '' : 's'}. Renew it on github.com soon.`;
  } else {
    warn.hidden = true;
  }
}

const SIGNIN_ERRORS = {
  offline: 'No connection. Sign-in needs internet once; try again when online.',
  auth: 'GitHub rejected the token. Check it was copied fully and has not been revoked.',
  notfound: 'Could not see that repo. Check the username and repo name, and that the token was granted access to this exact repo.',
  readonly: 'The token can see the repo but cannot write to it. Grant Contents read AND write.',
  other: 'GitHub returned an unexpected error. Try again in a minute.',
};

async function verify() {
  const owner = $('inOwner').value.trim();
  const repo = $('inRepo').value.trim();
  const token = $('inToken').value.trim();
  const expiry = $('inExpiry').value;
  const err = $('signinErr');
  err.hidden = true;
  if (!owner || !repo || !token) {
    err.textContent = 'Username, repo, and token are all needed.';
    err.hidden = false;
    return;
  }
  const btn = $('btnVerify');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  const r = await gh.verifyToken({ owner, repo, token });
  btn.disabled = false;
  btn.textContent = 'Verify & sign in';
  if (!r.ok) {
    err.textContent = SIGNIN_ERRORS[r.kind] || SIGNIN_ERRORS.other;
    err.hidden = false;
    return;
  }
  gh.setCredentials({ owner, repo, token, expiry });
  $('inToken').value = '';
  toast('Signed in');
  showShell();
}

async function signout() {
  if (!confirm('Sign out? This wipes the token and all local data on this device. Your repo data is untouched.')) return;
  const n = await outbox.pendingCount();
  if (n > 0 && !confirm(`${n} capture(s) have not synced yet and will be LOST. Sign out anyway?`)) return;
  gh.clearCredentials();
  localStorage.removeItem('fs.lastView');
  await store.wipe();
  location.reload();
}

// ---------- boot ----------
function boot() {
  window.__fsBooted = true;
  document.querySelectorAll('.navbtn').forEach((b) => {
    b.addEventListener('click', () => show(b.dataset.view));
  });
  $('btnVerify').addEventListener('click', verify);
  $('btnSignout').addEventListener('click', signout);
  $('btnHelp').addEventListener('click', () => { $('shell').hidden = true; $('view-help').hidden = false; });
  $('btnHelpClose').addEventListener('click', () => { $('view-help').hidden = true; $('shell').hidden = false; });
  wirePasteButtons(document);

  window.addEventListener('online', () => { outbox.sync().then(refreshPill).catch(() => {}); refreshPill(); });
  window.addEventListener('offline', refreshPill);
  window.addEventListener('outbox:change', refreshPill);
  window.addEventListener('outbox:error', refreshPill);
  $('syncPill').style.cursor = 'pointer';
  $('syncPill').addEventListener('click', () => {
    toast('Syncing…');
    outbox.sync().then((r) => {
      refreshPill();
      toast(r && r.done ? 'Synced' : 'Sync incomplete, will retry');
    }).catch(() => toast('Sync failed, will retry'));
  });

  investigate.init(show);
  pricebook.init();
  inventory.init();

  if (gh.hasToken()) showShell();
  else showSignin();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

if (typeof document !== 'undefined') boot();
