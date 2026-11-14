# Step 1: Repository and app

Spec: `docs/superpowers/specs/2026-11-13-calm-backstage-design.md`, thin slice step 1. Risk to remove: Node version.

## Facts checked (2026-11-13 15:10)

- Node `v26.13.1` at `/opt/homebrew/bin/node`; `node@22` and `node@26` kegs exist under Homebrew. No `corepack` on Node 26.
  Global `yarn` 1.22.22.
- Docker 29.9.3 running. Ports 3100, 7107, 8090 are free.
- npm: `@backstage/create-app` 0.9.3, `@finos/calm-cli` 1.71.0 (spec facts were read on 1.70.0).
- The spike (`~/business/sp/backstage`, read only) is Backstage 1.56.0 with `engines.node: "22 || 24"`.
- Repo: `.git` (no commits), `docs/superpowers/specs/…design.md`, `docs/plan/calm-backstage-status.html`.

## Tasks

1. Scaffold into a scratch folder, then copy into the repo root (create-app makes a sub-folder and the repo is not
   empty): `npx @backstage/create-app@latest --path <scratch>/app --skip-install`. Copy everything except `.git`
   into `~/finos/calm-backstage`. Keep `docs/` as is.
2. Ports: `app.baseUrl` `http://localhost:3100`; `backend.baseUrl` `http://localhost:7107`, `backend.listen.port`
   7107, `backend.cors.origin` `http://localhost:3100`. Check for any other `3000`/`7007` in config and `package.json`.
3. Node 26: if `engines.node` excludes 26, widen it to include 26 (record the change). `yarn install` on Node 26.
   A native-module build failure (`isolated-vm`, `better-sqlite3`) is the risk: capture the error.
4. `yarn tsc` and `yarn build:backend`.
5. Smoke template: add `examples/smoke-template/` (a `template.yaml` with one `name` parameter, a `fetch:template`
   step over a one-file skeleton that uses `${{ values.name }}`, and a `debug:log` step), registered in
   `app-config.yaml` `catalog.locations`. Start the app (`yarn start`, in the background), get a guest token from
   `GET http://localhost:7107/api/auth/guest/refresh`, then `POST /api/scaffolder/v2/tasks` for the smoke template
   and poll `GET /api/scaffolder/v2/tasks/{id}` until it finishes. `fetch:template` loads `isolated-vm`, so a task
   that completes is the proof. Also `curl -s -o /dev/null -w '%{http_code}' http://localhost:3100`.
6. Stop every process you started; ports 3100 and 7107 must be free again.
7. Add a short "Node" note to `README.md`: the Node version that worked, and any engines change.
8. Commit on `main` with Conventional Commits and no Claude attribution: `chore: scaffold Backstage app on ports 3100 and 7107`
   (include `docs/superpowers/specs`, this plan and `docs/plan/calm-backstage-status.html` in the commit).

## Risk gate

If the Node 26 install, build or template run fails because of a native module, stop. Do not install Node 24 and do
not work around it. Report the exact error. The fallback (approved in the spec) is `brew install node@24`, which the
lead decides on.

## Done when

`yarn install`, `yarn tsc` and `yarn build:backend` pass on Node 26; the smoke task status is `completed`; the
frontend returns 200 on 3100; the ports are free again; one commit exists.
