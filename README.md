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
