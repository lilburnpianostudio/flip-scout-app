# Flip Scout (app)

Static, zero-build PWA. Code only: all data lives in a separate PRIVATE repo
(`flip-scout`) that the app reads/writes through the GitHub API after you sign in.

**Never put in this repo:** tokens, inventory data, personal info, ZIP codes,
platform config with personal defaults. This repo is public so GitHub Pages can
host it free.

## Pre-push checklist (NFR-002)
```
grep -rn "github_pat_\|ghp_" . --exclude-dir=.git
```
Must return nothing. Also confirm every file referenced by index.html/sw.js exists
in the repo (the Backstage dropped-vendor lesson).

## Tests

Two lanes, on purpose.

**The money — no install, no framework, run it always:**
```
node tests/settlement.test.mjs
```
Pure functions from `js/settlement.js`. This is the everyday check and it must
stay dependency-free, so a clean checkout can prove the arithmetic with nothing
but node.

**The screen — costs one `npm i`, run it after touching the UI:**
```
cd tests/ui && npm i && npm test
```
Boots the real `index.html` under jsdom and drives the real `inventory.js`.
It exists because **FLIP-0001 sold for $140 and sat unrecorded for days while
every money fixture stayed green** — the math was perfect, the "Sold…" button
just was not on screen for an `acquired` item. Pure fixtures cannot catch that
class of bug by construction.

`tests/ui/buttons.test.mjs` is the regression suite for exactly that: which
buttons appear on an item in each status. If the "ACQUIRED item offers Sold…"
assertion ever goes red, someone has re-broken FLIP-0001 — fix the code, not
the test.

Dependencies are pinned and dev-only. Nothing that ships to the phone has a
build step or a runtime dependency.

## Local preview
ES modules need a server (file:// won't work):
```
python -m http.server 8765
```
Then open http://localhost:8765

## Setup (one time)
1. Create the PRIVATE data repo `flip-scout` on your GitHub account (or push the
   planning repo that already exists locally).
2. github.com → Settings → Developer settings → Fine-grained tokens → Generate:
   only that repo, Contents: Read and write, ~1 year expiry.
3. Open the app, enter username + repo + token, Verify & sign in.

## Deploy
Push to `main`; enable GitHub Pages (Settings → Pages → Deploy from branch →
main, /root). Service worker (offline shell) activates on the https Pages URL.
