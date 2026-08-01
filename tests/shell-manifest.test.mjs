// shell-manifest.test.mjs — the offline shell is complete and honest.
//
//   node tests/shell-manifest.test.mjs
//
// No dependencies, by design: this runs in the same install-free lane as the
// settlement fixtures.
//
// Two failure modes, both of which white-screen the app on Ben's phone rather
// than showing an error:
//
//   1. index.html or sw.js references a file that is not in the repo. This is
//      the Backstage dropped-vendor lesson, already written into the README as
//      a manual pre-push check. Manual checks get skipped on the session where
//      it matters.
//   2. A new module gets imported but never added to sw.js's SHELL list. The
//      app works fine online and then breaks the first time he opens it in a
//      dead zone — which is exactly where he uses it, at garage sales.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; return; }
  fails.push(label + (detail ? `\n     ${detail}` : ''));
};

// ---- every local file index.html points at exists -------------------------
const html = read('index.html');
const htmlRefs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((u) => !/^(https?:|data:|#|mailto:)/.test(u));

htmlRefs.forEach((ref) => {
  const rel = ref.replace(/^\.\//, '');
  ok(`index.html references ${ref}, which is missing from the repo`,
    fs.existsSync(path.join(APP, rel)));
});

// ---- every file sw.js precaches exists ------------------------------------
const sw = read('sw.js');
const shellBlock = sw.match(/const SHELL = \[([\s\S]*?)\];/);
ok('sw.js has a SHELL list this test can read', !!shellBlock);

const shell = shellBlock
  ? [...shellBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  : [];

shell.filter((f) => f !== './').forEach((ref) => {
  ok(`sw.js precaches ${ref}, which is missing from the repo`,
    fs.existsSync(path.join(APP, ref.replace(/^\.\//, ''))));
});

// ---- every module actually reachable from ui.js is precached --------------
// Walks the real import graph rather than globbing js/, because a module that
// nothing imports (pricebook.js, retired in v17) SHOULD be absent from SHELL.
const seen = new Set();
(function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const src = read('js/' + file);
  [...src.matchAll(/from\s+'\.\/([^']+)'/g)].forEach((m) => walk(m[1]));
})('ui.js');

const shellSet = new Set(shell);
[...seen].sort().forEach((f) => {
  ok(`js/${f} is imported by the app but NOT in sw.js SHELL — it would break offline`,
    shellSet.has('./js/' + f));
});

// ---- NFR-002: no credentials in a public repo -----------------------------
// The README carries this as a manual pre-push grep. Manual is not a control.
const SECRETS = [/github_pat_[A-Za-z0-9_]{20,}/, /\bghp_[A-Za-z0-9]{30,}/, /\bgithub_pat_\w*\s*=\s*['"][^'"]+['"]/];
// .github is deliberately NOT skipped: a token pasted into a workflow file is
// just as public as one pasted into a module.
const skip = new Set(['.git', 'node_modules']);
const offenders = [];
(function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { scan(full); continue; }
    if (!/\.(js|mjs|json|html|css|md|webmanifest|yml|yaml)$/.test(e.name)) continue;
    const body = fs.readFileSync(full, 'utf8');
    if (SECRETS.some((re) => re.test(body))) offenders.push(path.relative(APP, full));
  }
})(APP);
ok('NFR-002: no GitHub token committed to this PUBLIC repo', offenders.length === 0,
  offenders.join(', '));

// ---- the version badge and the cache version agree ------------------------
// They are bumped by hand in two files. When they drift, the service worker
// serves a stale shell while the badge claims the new version — which is
// precisely the "I don't see the new features" scare from v18.
const appVersion = (read('js/ui.js').match(/APP_VERSION = '([^']+)'/) || [])[1];
const cacheVersion = (sw.match(/flip-scout-shell-(v\d+)/) || [])[1];
ok(`APP_VERSION (${appVersion}) and the sw.js cache version (${cacheVersion}) must match`,
  !!appVersion && appVersion === cacheVersion);

if (fails.length) {
  console.error(`\n${fails.length} FAILED, ${pass} passed\n`);
  fails.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`✓ ${pass} shell-manifest checks passed`);
