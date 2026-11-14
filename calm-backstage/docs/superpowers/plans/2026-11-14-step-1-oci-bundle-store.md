# Part 2, step 1: OCI bundle store

Part 2 plan: bundle store and deployment to local Kubernetes (decisions by Jim, 2026-11-14: bundles live in an OCI
registry). Risk to remove: a plain HTTP client, with no new npm package, can push and pull a bundle as an OCI
artifact that a standard client can read.

## Facts checked (2026-11-14 11:15)

- `hub/docker-compose.yml` (project `calm-backstage`) has `mongodb` and `calmhub` on network `calm-net`. Host port
  5000 is taken; the registry uses **5050**.
- Bundles are read from `calm.bundles` (local folders) in two places:
  - `plugins/catalog-backend-module-calm/src/provider.ts` `readBundles()` → `BundleInfo` (`entities.ts`), used for
    bundle Resources and the Template's bundle choices (`bundlesFor`, `templateEntity`);
  - `plugins/scaffolder-backend-module-calm/src/module.ts` builds `bundles` once at init and passes them to
    `createCalmTemplateAction` (`actions/template.ts`), which calls `renderBundle({ bundleDir })` in `calm-node`.
- `tar` 6 and 7 are in `yarn.lock`. Depend on a range that resolves to an existing entry (`tar: ^7.5.7`), so nothing
  new is fetched. `.yarnrc.yml` must not change (3-day age gate). Node 26 has global `fetch` and `crypto`.
- `oras` and `crane` are not installed. Docker is; `docker run --rm ghcr.io/oras-project/oras:v1.2.0` can serve as
  the standard client for the risk check (pull through `host.docker.internal:5050` with `--plain-http`).
- Backstage is running as a background task of the lead on 3100/7107. **Do not start a second one and do not kill
  it.** Ask the lead (in your report) to restart it; for your own checks use `yarn tsc`, `yarn test`, and the backend
  routes that pick up changes through the dev server's reload.
- The Hub containers are running; `docker compose -f hub/docker-compose.yml up -d` adds the registry without
  recreating them (check with `docker ps` that the Hub container's start time did not change).

## Tasks

1. **Registry.** Add service `registry` (`registry:2`, container `calm-backstage-registry`, `5050:5000`, named volume
   `registry-data`, `calm-net`) to `hub/docker-compose.yml`. Update the header comment.
2. **OCI client** `plugins/calm-node/src/oci.ts` (exported from `index.ts`), over the registry HTTP API v2:
   - `parseRef('localhost:5050/calm-bundles/web-service:2.0.0')` → `{ registry, repository, tag }`; http for
     `localhost`/`127.0.0.1`/explicit `http://`, https otherwise.
   - `pushBundle({ dir, ref })`: tar+gzip the folder (deterministic: sorted entries, fixed mtime, so the same folder
     gives the same digest), upload blobs (monolithic `POST …/blobs/uploads/` then `PUT ?digest=`; skip when `HEAD`
     finds the blob), then `PUT …/manifests/<tag>`. Returns the manifest digest.
   - Manifest: `schemaVersion: 2`, `mediaType: application/vnd.oci.image.manifest.v1+json`,
     `artifactType: application/vnd.finos.calm.template-bundle.v1`, `config` = the bundle's `calm-backstage.json`
     (`application/vnd.finos.calm.template-bundle.config.v1+json`), one layer
     `application/vnd.oci.image.layer.v1.tar+gzip` with annotation `org.opencontainers.image.title: bundle.tar.gz`,
     manifest annotations `org.opencontainers.image.version` and `.description`.
   - `listRepositories(registryUrl, prefix)` (`/v2/_catalog`), `listTags(repo)` (`/tags/list`),
     `readBundleConfig(ref)` → `{ digest, config }` (manifest + config blob, verifying the config digest),
     `pullBundle({ ref, destDir })` → verifies the layer's sha256 before extracting, refuses entries that leave
     `destDir` (absolute paths, `..`, links), returns `{ digest, dir }`.
   - Unit tests (`oci.test.ts`) against an in-process fake registry (`http.createServer`): push then pull round trip
     gives identical files; pushing twice gives the same digest; tags and repositories list; a corrupted layer fails
     with a digest error; a tar entry with `../` is refused.
3. **Push script.** `hub/push-bundles.cjs` (plain Node, runs the client through the workspace; or a `bin` in
   `calm-node` if that is cleaner): with no argument pushes every `bundles/<name>/<version>` to
   `localhost:5050/calm-bundles/<name>:<version>`; with a folder argument pushes that one (name and version from its
   `calm-backstage.json`). Idempotent; prints ref and digest. Root scripts: `bundles:push`; `hub:seed` runs it after
   `seed.sh`. `seed.sh` (or the script) waits for `http://localhost:5050/v2/`.
4. **Config.** `calm.bundleRegistry: { url: http://localhost:5050, repositoryPrefix: calm-bundles }` in
   `app-config.yaml` and both `config.d.ts` files. Keep `calm.bundles` as an authoring fallback, but remove the two
   entries from `app-config.yaml` (leave a commented example), so the demo reads the registry only.
5. **Catalog.** `readBundles()` also lists the registry (`listRepositories` → `listTags` → `readBundleConfig`).
   `BundleInfo` gains `ref` and `digest` (and `path` becomes optional); a registry bundle with the same
   name@version as a local folder wins, with one info log. Bundle Resources get annotations
   `calm.finos.org/bundle-ref` and `calm.finos.org/bundle-digest` (constants in `calm-common/src/annotations.ts`) and
   a description line naming the registry. A registry that is down gives one warning and no registry bundles, not a
   failed refresh.
6. **`calm:template`.** Resolve `<name>@<version>` at run time: local `calm.bundles` first if configured, else
   `pullBundle` from the registry into `<backend tmp>/calm-bundles/<digest without sha256:>/` (skip the pull when the
   folder exists and is complete: write a marker file last). Output `bundleRef` and `bundleDigest`;
   `calm:publish:local` (or the Template's `catalog-info.yaml` step — read how annotations are written today) records
   them on the published service as `calm.finos.org/bundle-ref` / `bundle-digest`.
7. **Verification** (record actual outputs in Results):
   - `yarn tsc`, `yarn test`, `yarn build:backend`, `backstage-cli package lint` in the changed packages.
   - `docker compose -f hub/docker-compose.yml up -d`; `yarn bundles:push` twice (same digests); 
     `curl localhost:5050/v2/_catalog` and `/v2/calm-bundles/web-service/tags/list`.
   - **Risk check:** `docker run --rm -v <scratch>:/w ghcr.io/oras-project/oras:v1.2.0 pull --plain-http
     host.docker.internal:5050/calm-bundles/web-service:2.0.0 -o /w` gives `bundle.tar.gz`, and
     `oras manifest fetch` shows the artifact type. If `oras` cannot read it, stop and report (risk gate).
   - Report to the lead that Backstage needs a restart for the config change; the lead restarts it and checks the
     catalog and a Template run. Do not do the UI check yourself.
8. **Commits** (Conventional Commits, each with `git commit -s`, no AI attribution, no Co-Authored-By):
   `feat(hub): add an OCI registry for template bundles`, `feat(calm-node): add an OCI client for template bundles`,
   `feat(calm): read template bundles from the OCI registry`. Do not commit `docs/plan/*`; the lead does.

## Boundaries

- No writes outside this repository (`~/business/sp`, `~/finos/architecture-as-code` are read only).
- No `kubectl`/`minikube` in this step.
- No new npm packages beyond a `tar` range already resolved in `yarn.lock`; `yarn install` must add workspace lines
  only. Check `git diff yarn.lock`.
- Kill no processes you did not start. No `git push`.

## Results

Done 2026-11-14 on Node 26.13.1. The risk is removed: a client written against the registry HTTP API with the global
`fetch`, and no new npm package, pushes a bundle that `oras` 1.2.0 reads.

### Built

| What | Where |
|---|---|
| Registry service (`registry:2`, container `calm-backstage-registry`, `5050:5000`, volume `registry-data`) | `hub/docker-compose.yml` |
| OCI client: `parseRef`, `bundleRef`, `pushBundle`, `listRepositories`, `listTags`, `readBundleConfig`, `resolveBundleDigest`, `pullBundle`, `pullBundleCached`, `packBundle`, `extractBundle` | `plugins/calm-node/src/oci.ts` (exported from `index.ts`), tests in `oci.test.ts` |
| Push script; root scripts `bundles:push`, and `hub:seed` = `hub/seed.sh && node hub/push-bundles.cjs` | `hub/push-bundles.cjs`, `package.json` |
| `calm.bundleRegistry` config; `calm.bundles` entries removed (commented example left) | `app-config.yaml`, both `config.d.ts` |
| Annotations `calm.finos.org/bundle-ref`, `calm.finos.org/bundle-digest` | `plugins/calm-common/src/annotations.ts` |
| Catalog: registry bundles, registry wins over a local folder | `plugins/catalog-backend-module-calm/src/bundles.ts` (new), `provider.ts`, `entities.ts`, `module.ts`, tests in `bundles.test.ts` |
| `calm:template` resolves at run time and outputs `bundleRef`/`bundleDigest`; `calm:publish:local` records them | `plugins/scaffolder-backend-module-calm/src/actions/template.ts`, `publishLocal.ts`, `module.ts`, tests in `actions/template.test.ts` |

`tar` is declared as `^7.5.7` in `calm-node` and resolves to the existing 7.5.22. `git diff yarn.lock` over the step
is two workspace lines: `tar: "npm:^7.5.7"` under calm-node and `"@internal/backstage-plugin-calm-node": "workspace:^"`
under the catalog module. `.yarnrc.yml` is unchanged.

### Checks

| Check | Result |
|---|---|
| `yarn tsc` | exit 0 |
| `CI=1 yarn test` (root) | exit 0: 8 suites, 52 tests passed |
| `yarn test` per package | calm-common 4 suites / 21 tests; calm-node 1 / 17; catalog-backend-module-calm 1 / 7; scaffolder-backend-module-calm 1 / 6 (the eighth root suite is outside these four packages) |
| `yarn build:backend` | exit 0 |
| `backstage-cli package lint` in calm-common, calm-node, catalog-backend-module-calm, scaffolder-backend-module-calm | exit 0, no output, in all four |
| `yarn backstage-cli config:check` | exit 0 (`Loaded config from app-config.yaml, app-config.local.yaml`) |

The 31 new tests: calm-node 17 (push/pull round trip gives identical files; a second push and a copy of the folder
with other mtimes give the same digest and upload nothing again; repositories under a prefix and tags; config read;
config and layer with a wrong digest fail with "Digest mismatch" and extract nothing; an artifact of another type is
refused; `../`, absolute paths and symlinks in the tar are refused; the cache pulls once per digest), catalog 7,
scaffolder 6.

### Registry

`docker compose -f hub/docker-compose.yml up -d` created only the registry. Start times before and after:
`calm-backstage-hub 2026-11-13T17:11:01.221630837Z`, `calm-backstage-mongodb 2026-11-13T17:10:55.648473418Z`
(unchanged); `calm-backstage-registry 2026-11-14T11:14:23.197952262Z`.

`yarn bundles:push bundles/web-service/1.0.0` and `…/2.0.0`, each run twice (exit 0 every time), gave the same lines
both times:

```
pushed   localhost:5050/calm-bundles/web-service:1.0.0  sha256:28e7726fdd0566f7e685df725ff132d010d0cfeda1784dfe51ceea00b8397591
pushed   localhost:5050/calm-bundles/web-service:2.0.0  sha256:52d1c0cf719adc2842f641fdff17fce4a4de60ebdead29eee9e4b17c82685ff5
```

```
$ curl -s localhost:5050/v2/_catalog
{"repositories":["calm-bundles/web-service"]}
$ curl -s localhost:5050/v2/calm-bundles/web-service/tags/list
{"name":"calm-bundles/web-service","tags":["1.0.0","2.0.0"]}
```

`yarn bundles:push` with no argument was run twice against a throwaway `registry:2` on port 5051 (see Deviations):
both runs pushed 1.0.0, 2.0.0 and 3.0.0 with the same digests (the two above, and
`sha256:138fb648092d32ce978c10507c4650ed6a06cb1f9e6e603f566708f9c396ed24` for 3.0.0 as committed in `234c408`),
`bundles: 3 pushed`, exit 0.

### Risk check: oras 1.2.0

```
$ docker run --rm -v <scratch>/oras:/w ghcr.io/oras-project/oras:v1.2.0 pull --plain-http \
    host.docker.internal:5050/calm-bundles/web-service:2.0.0 -o /w        # exit 0
Downloading 85efd1a673cb bundle.tar.gz
Downloaded  85efd1a673cb bundle.tar.gz
Skipped pulling layers without file name in "org.opencontainers.image.title"
Use 'oras copy host.docker.internal:5050/calm-bundles/web-service:2.0.0 --to-oci-layout <layout-dir>' to pull all layers.
```

The "Skipped" line is about the config blob, which has no file name. With `-v` oras names it:
`Skipped     3c28678d0dbf application/vnd.finos.calm.template-bundle.config.v1+json`. The one layer was written:
`<scratch>/oras/bundle.tar.gz`, 2263 bytes, sha256
`85efd1a673cba622f6434870dbf619fed6ccdc7039f06e6aaf802944ace440e4`, which is the layer digest in the manifest.
`tar tzvf` lists the eight files of `bundles/web-service/2.0.0`, each with owner 0/0 and mtime 1 Jan 2000.

```
$ docker run --rm ghcr.io/oras-project/oras:v1.2.0 manifest fetch --plain-http \
    host.docker.internal:5050/calm-bundles/web-service:2.0.0 --pretty      # exit 0
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.manifest.v1+json",
  "artifactType": "application/vnd.finos.calm.template-bundle.v1",
  "config": {
    "mediaType": "application/vnd.finos.calm.template-bundle.config.v1+json",
    "digest": "sha256:3c28678d0dbfb1e058cd81b798a7dc66826ce550216e992a582b8c3809480c99",
    "size": 429
  },
  "layers": [
    {
      "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
      "digest": "sha256:85efd1a673cba622f6434870dbf619fed6ccdc7039f06e6aaf802944ace440e4",
      "size": 2263,
      "annotations": {
        "org.opencontainers.image.title": "bundle.tar.gz"
      }
    }
  ],
  "annotations": {
    "org.opencontainers.image.version": "2.0.0",
    "org.opencontainers.image.description": "v2 layout: deploy/docker-compose.yml with health checks, a Dockerfile, a component table in the README, and config/application.yaml with a health endpoint."
  }
}
```

### Our own client against the real registry

- `listRepositories` → `listTags` → `readBundleConfig` gave both bundles with the digests above.
- `pullBundleCached` for 2.0.0: first call `cached: false`, second `cached: true`; `diff -r` of the pulled folder and
  `bundles/web-service/2.0.0` shows no difference.
- `calm template -a output/orders-api/architecture.json -b <pulled folder> -o rendered` (the CLI directly, in the
  scratch folder): exit 0, rendered `config/application.yaml`, `deploy/docker-compose.yml`, `Dockerfile`, `README.md`.
- The lead's running backend had already reloaded. `GET /api/catalog/entities/by-query` (guest token) for
  `spec.type=calm-template-bundle` returned `bundle-web-service-1.0.0` and `bundle-web-service-2.0.0`, each with
  `calm.finos.org/bundle-ref` (`localhost:5050/calm-bundles/web-service:<version>`) and the matching
  `calm.finos.org/bundle-digest`.

### Not checked

- A Template run through Backstage (`calm:template` pulling, `calm:publish:local` writing the two annotations into
  `catalog-info.yaml`). Covered only by unit tests of `resolveBundle` and `serviceEntity` and by the CLI render above.
- The catalog in the UI, and the provider with the registry stopped (the registry was not stopped; the client's
  error for an unreachable registry and `readRegistryBundles` throwing are unit-tested, the provider's catch is not).
- `yarn hub:seed` end to end (`seed.sh` was not run; the push it chains was).
- The push script on Node 22 or 24: it loads the TypeScript source through Node's type stripping and ran on Node 26
  only.
- TLS registries and registries with auth: the client has no auth.

### For the lead

- Restart Backstage for a clean start on the new config, then check the catalog and a Template run.
- `web-service` 3.0.0 is committed but **not** in the registry on 5050, and `app-config.yaml` no longer lists local
  bundles, so Backstage does not see it until `yarn bundles:push` is run.

### Commits

- `84a6cb3` feat(hub): add an OCI registry for template bundles
- `854ce3a` feat(calm-node): add an OCI client for template bundles
- `47b4f37` feat(calm): read template bundles from the OCI registry

## Deviations

- **No-argument `yarn bundles:push` was not run against the registry on 5050.** While this step ran, another step
  added `bundles/web-service/3.0.0`; a no-argument push would have put it into the catalog and the Template's choices
  before that step was finished. The two existing bundles were pushed by folder (twice), and the no-argument path was
  run twice against a throwaway `registry:2` container on port 5051 (`step1-scratch-registry`, started and removed by
  this step).
- **Plain Node loads the client's TypeScript source.** `hub/push-bundles.cjs` does
  `require('../plugins/calm-node/src/oci.ts')` (type stripping), not "through the workspace": the package's
  `index.ts` has extension-less relative imports that plain Node cannot resolve. So `oci.ts` imports only Node
  built-ins and `tar`, and has its own small file walk instead of `listFiles`.
- **Signatures differ a little from the plan's sketch.** `pushBundle` returns `{ ref, digest }`; `listTags` takes
  `(registryUrl, repository)`; `parseRef` also returns `baseUrl`; `readBundleConfig` and `pullBundle` also require
  the artifact type to be the bundle type. Added: `bundleRef` (builds the reference from the config values),
  `resolveBundleDigest`, `pullBundleCached`, `packBundle`, `extractBundle`.
- **The cache marker is beside the folder**, `<cache>/<digest>.json`, not in it, so `calm template` never sees it.
  `pullBundle` extracts beside the target and renames, and needs the target absent or empty.
- **Unsafe tar entries fail the whole pull.** The layer is listed first; any absolute path, `..` segment, link or
  other non-file entry refuses the layer before anything is written (node-tar alone would skip such entries
  quietly).
- **`.DS_Store` files are left out of the layer**, so Finder does not change a digest. The gzip bytes depend on the
  zlib in the Node that packs; the same Node gives the same digest.
- **Registry wins in the catalog, local wins in `calm:template`**, both as the plan says. For a name and version in
  both places the catalog Resource shows the registry reference while a run renders the local folder and records no
  reference or digest. The "registry wins" info log is written once per bundle per backend start, the "registry not
  read" warning once per refresh.
- **Registry bundle name and version are the repository and the tag**, not the `name`/`version` in the config blob.
- **The pull cache is `<backend.workingDirectory or os.tmpdir()>/calm-bundles`.**
- **Not in the plan:** `README.md` was updated for the registry; unit tests were added to the catalog and scaffolder
  modules (neither had any); `yarn backstage-cli config:check` was run.
- **`yarn install` ran three times** (to keep each commit's `yarn.lock` line with its package.json change) and
  `yarn build:backend` once while the lead's Backstage was running; 3100 and 7107 answered afterwards.
- Tests and the push script ran with `TMPDIR` set to the scratch folder, so nothing was written outside the
  repository and the scratch folder.
