// githubStore.js — the ONLY network module (ADR-001/002/003).
// All GitHub API traffic and token custody live here. Token never leaves
// localStorage; never appears in URLs, logs, or exports.

const LS = {
  token: 'fs.token',
  owner: 'fs.owner',
  repo: 'fs.repo',
  expiry: 'fs.tokenExpiry',
};
const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

export function getConfig() {
  return {
    owner: localStorage.getItem(LS.owner) || '',
    repo: localStorage.getItem(LS.repo) || 'flip-scout',
    expiry: localStorage.getItem(LS.expiry) || '',
  };
}

export function hasToken() {
  return !!localStorage.getItem(LS.token);
}

export function setCredentials({ owner, repo, token, expiry }) {
  localStorage.setItem(LS.owner, owner);
  localStorage.setItem(LS.repo, repo);
  localStorage.setItem(LS.token, token);
  if (expiry) localStorage.setItem(LS.expiry, expiry);
  else localStorage.removeItem(LS.expiry);
}

export function clearCredentials() {
  Object.values(LS).forEach((k) => localStorage.removeItem(k));
}

// Days until token expiry, or null if unknown.
export function tokenExpiryDays() {
  const e = localStorage.getItem(LS.expiry);
  if (!e) return null;
  return Math.floor((new Date(e) - Date.now()) / 86400000);
}

// Every call resolves to {ok:true, data, status} or
// {ok:false, kind:'auth'|'conflict'|'offline'|'notfound'|'other', status}.
async function api(method, path, body) {
  const token = localStorage.getItem(LS.token);
  if (!navigator.onLine) return { ok: false, kind: 'offline', status: 0 };
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { ok: false, kind: 'offline', status: 0 };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, kind: 'auth', status: res.status };
  if (res.status === 404) return { ok: false, kind: 'notfound', status: 404 };
  if (res.status === 409 || res.status === 422) return { ok: false, kind: 'conflict', status: res.status };
  if (!res.ok) return { ok: false, kind: 'other', status: res.status };
  const data = res.status === 204 ? null : await res.json();
  return { ok: true, data, status: res.status };
}

function repoPath(rest) {
  const { owner, repo } = getConfig();
  return `/repos/${owner}/${repo}${rest}`;
}

// Distinguishes failure modes so sign-in can say WHICH check failed (AC #2).
export async function verifyToken({ owner, repo, token }) {
  if (!navigator.onLine) return { ok: false, kind: 'offline' };
  let res;
  try {
    res = await fetch(`${API}/repos/${owner}/${repo}`, {
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
      },
    });
  } catch (e) {
    return { ok: false, kind: 'offline' };
  }
  if (res.status === 401) return { ok: false, kind: 'auth' };
  if (res.status === 403) return { ok: false, kind: 'auth' };
  if (res.status === 404) return { ok: false, kind: 'notfound' }; // bad owner/repo OR token lacks access
  if (!res.ok) return { ok: false, kind: 'other', status: res.status };
  const data = await res.json();
  if (!data.permissions || !data.permissions.push) return { ok: false, kind: 'readonly' };
  return { ok: true };
}

export async function readFile(path) {
  const r = await api('GET', repoPath(`/contents/${path}`));
  if (!r.ok) return r;
  const text = decodeURIComponent(escape(atob(r.data.content.replace(/\n/g, ''))));
  return { ok: true, json: JSON.parse(text), sha: r.data.sha };
}

export async function writeFile(path, obj, sha) {
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(obj, null, 2))));
  const body = { message: `flip-scout: put ${path}`, content };
  if (sha) body.sha = sha;
  return api('PUT', repoPath(`/contents/${path}`), body);
}

export async function listTree(prefix) {
  const r = await api('GET', repoPath('/git/trees/main?recursive=1'));
  if (!r.ok) return r;
  const files = r.data.tree.filter((t) => t.type === 'blob' && t.path.startsWith(prefix));
  return { ok: true, files };
}
