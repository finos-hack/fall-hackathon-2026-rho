# Part 2, step 2: bundle `web-service@3.0.0` (runnable service and Kubernetes manifests)

Part 2 plan: bundle store and deployment to local Kubernetes (decisions by Jim, 2026-11-14: small generated app,
NetworkPolicy from CALM). Risk to remove: a `calm template` bundle can render a service that builds, runs in the
cluster, and gets network rules that match the architecture's `connects` relationships.

## Facts checked (2026-11-14 11:20)

- Bundle 2.0.0 (`bundles/web-service/2.0.0`): `index.json` (four `output-type: single` templates from `document`),
  `web-service-transformer.js` (`getTransformedModel` returns `{ document: {...} }`, `registerTemplateHelpers`),
  Handlebars templates, `calm-backstage.json`, `package.json`.
- A generated architecture (`output/inventory-api/architecture.json`, MongoDB + RabbitMQ + OpenTelemetry) has nodes
  `web-client` (webclient), `api-gateway` (system, interface host + port 443, both user-filled placeholders),
  `web-service` (service, port 8080, metadata `owner`, `service-name`), `mongodb-database` (27017) or
  `postgres-database`, optional `cache`, `message-queue` (5672), `observability` (4317); `connects` relationships
  `web-client-api-gateway`, `api-gateway-web-service`, `web-service-<datastore>`, `web-service-<add-on>`, each with a
  `protocol`; plus two `options` relationships. No `$id`.
- `catalog-info.yaml` is written by `calm:publish:local`, not by the bundle. Step 4 adds the Kubernetes annotations
  there; this step does not.
- CLI findings (FINDINGS.md): `calm template -o` treats a folder name with a dot as a file; `calm template` has no
  `-c`, so control URL look-ups log warnings. Run it as the repo does: see `plugins/calm-node/src/template.ts`.
- Cluster: minikube profile `calm-backstage` (Kubernetes 1.37.0, containerd, Calico) is up. Calico enforces: a
  default-deny policy blocked a test pod **including DNS**. Kubeconfig: `<repo>/.kube/config` (git-ignored).
- A blocked connection times out (it is dropped, not refused). `nginx:alpine` has busybox `nc`.

## Design

The bundle must not depend on Backstage names. It renders a **kustomize base**; step 4's deploy action adds the
namespace, the image name and tag, and the Backstage label through an overlay.

- **Workload model in the transformer:** one entry per in-cluster node: `{ id (the node's unique-id, used as the
  Deployment, Service and DNS name), kind, image, port, env }`. `web-client` is outside the cluster and has no
  workload. The gateway's in-cluster Service port is fixed by the bundle (80 → container 8080); its `host` and
  `port` placeholders are the external address and are only printed in the README.
- **In-cluster addresses come from this model, never from the user-filled placeholders** (a host like
  `inventory.example.com` does not resolve in the cluster).
- **Images:** app `calm-service:dev` (placeholder name the overlay rewrites, `imagePullPolicy: IfNotPresent`, never
  `latest`); `nginxinc/nginx-unprivileged:1.27-alpine` or `nginx:1.27-alpine` for the gateway; `postgres:16-alpine`,
  `mongo:7`, `redis:7-alpine`, `rabbitmq:3-alpine`, `otel/opentelemetry-collector:0.110.0`. Pick what starts with no
  extra config; record any that needs one.
- **Labels:** every pod `calm.finos.org/node: <unique-id>`.

## Tasks

1. Create `bundles/web-service/3.0.0` from 2.0.0. `calm-backstage.json`: version 3.0.0, a description, and
   `"deploy": "kubernetes"`.
2. Templates (all `output-type: single`; iterate the workload list with `{{#each}}` and render multi-document YAML):
   - `src/server.js`: Node `http` + `net`, no dependencies. `GET /` returns JSON (service name, owner, pattern, node
     and relationship counts, the bundle version); `GET /health` → 200; `GET /connections` tries a TCP connection
     (2 s timeout) to each node the architecture says `web-service` connects to and returns
     `[{ node, host, port, protocol, open }]`. Listens on the service's port from the architecture.
   - `Dockerfile`: `node:22-alpine`, non-root user, `COPY src/server.js`, `HEALTHCHECK` on `/health`.
   - `deploy/k8s/workloads.yaml`: Deployment + Service per workload, with readiness probes (HTTP for the app and
     gateway, TCP for the rest), small resource requests.
   - `deploy/k8s/gateway-config.yaml`: ConfigMap with an nginx config that proxies `/` to `web-service:<port>`.
   - `deploy/k8s/network-policy.yaml`: `default-deny` (ingress and egress, all pods); `allow-dns` (egress to
     kube-system on 53 UDP/TCP for all pods); per in-cluster `connects` relationship one policy named after the
     relationship's `unique-id` allowing egress from the source pod and ingress to the destination pod on the
     destination's port, annotated with `calm.finos.org/relationship` and `calm.finos.org/protocol`; for a
     relationship whose source is outside the cluster (`web-client`), ingress to the destination from anywhere.
   - `deploy/k8s/kustomization.yaml`: lists the three files.
   - `README.md`: what was rendered, the nodes and connections as a table, how to build and deploy by hand
     (`minikube -p calm-backstage image build`, `kubectl apply -k`).
   - Keep `config/application.yaml` only if it still means something; otherwise drop it.
3. **Risk gate:** if the transformer cannot hand a list to the templates, or `{{#each}}` output is mangled by the
   CLI (front matter, escaping), stop and report what the CLI does. Alternative to name: one template per fixed
   optional node with `{{#if}}`, as 2.0.0 does.
4. **Verify by rendering** (scratch folder, never `output/`): render 3.0.0 with the CLI for two architectures —
   `output/orders-api/architecture.json` (check which choices it has) and `output/inventory-api/architecture.json`.
   For each: `node --check src/server.js`; `kubectl --kubeconfig <repo>/.kube/config --context calm-backstage apply
   --dry-run=server -k deploy/k8s -n calm-step2-probe` after creating that namespace.
5. **Verify in the cluster** (inventory-api render; this de-risks steps 4 and 6):
   - `KUBECONFIG=<repo>/.kube/config minikube -p calm-backstage image build -t calm-step2-probe:dev <render dir>`;
   - an overlay in the scratch folder (`namespace: calm-step2-probe`, `images: [{ name: calm-service, newName:
     calm-step2-probe, newTag: dev }]`), `kubectl apply -k`, `kubectl rollout status` for every Deployment (allow 5
     minutes: images are pulled inside minikube);
   - from the gateway pod: `wget -qO- http://web-service:8080/connections` (or through the gateway's own port) shows
     every connection `open: true`; `GET /health` 200;
   - **permitted:** web-service → datastore open. **Blocked:** gateway pod → datastore port with `nc -z -w 3` fails
     (timeout); web-service pod → an address the architecture does not name (e.g. the Kubernetes API or the gateway's
     port) fails. Record the exact commands and outputs.
   - `kubectl delete ns calm-step2-probe` at the end, and remove the probe image
     (`minikube -p calm-backstage image rm`).
6. Commit: `feat(bundles): add web-service 3.0.0 with a runnable service and Kubernetes manifests` (with
   `git commit -s`, staging only `bundles/web-service/3.0.0` and this plan file).

## Boundaries

- **Every** `kubectl` call has `--kubeconfig /Users/jpgough/finos/calm-backstage/.kube/config --context
  calm-backstage`; **every** `minikube` call has `-p calm-backstage` and `KUBECONFIG` set to that file. Never run a
  bare `kubectl` or `minikube`: the user's default context is another cluster. Do not run `minikube start`, `stop`,
  `delete` or `profile`. Touch only namespace `calm-step2-probe`.
- Another agent is working on the OCI registry and the catalog/scaffolder plugins at the same time. Do not edit
  `plugins/`, `hub/`, `app-config.yaml`, `package.json` or `yarn.lock`; do not push to the registry on 5050; stage
  only your own paths (`git add bundles/web-service/3.0.0 <this plan>`), and retry if `git` reports an index lock.
- Backstage runs on 3100/7107 (the lead's background task): do not start, stop or restart it.
- No writes outside the repository except the scratch folder. No new npm packages. No `git push`.

## Results

Measured 2026-11-14 (image build started 11:17:05, apply 11:17:19, connection checks 11:18:56). `kc` below stands for
`kubectl --kubeconfig /Users/jpgough/finos/calm-backstage/.kube/config --context calm-backstage`, and `mk` for
`KUBECONFIG=/Users/jpgough/finos/calm-backstage/.kube/config minikube -p calm-backstage`. `<scratch>` is the step's
scratch folder.

### Bundle

`bundles/web-service/3.0.0`: `index.json` (seven `output-type: single` templates from `document`),
`web-service-transformer.js`, `calm-backstage.json` (`"deploy": "kubernetes"`), `package.json`, and the templates
`README.md.hbs`, `Dockerfile.hbs`, `server.js.hbs`, `workloads.yaml.hbs`, `gateway-config.yaml.hbs`,
`network-policy.yaml.hbs`, `kustomization.yaml.hbs`.

### Risk gate (task 3): passed

Checked with a throwaway bundle in the scratch folder before writing 3.0.0:

- The transformer can hand lists to a template: `{{#each}}`, nested `{{#each}}`, `../name` and `@last` all work.
- Multi-document YAML comes out as written, including a `---` on the first line. The CLI added no front matter.
  Block tags on their own line leave no blank line.
- Nested output paths (`src/server.js`, `deploy/k8s/...`) are created.
- `{{value}}` HTML-escapes (`"` becomes `&quot;`), as Handlebars does. The bundle uses a `json` helper from
  `registerTemplateHelpers` with a triple-stash (`{{{json value}}}`) for JSON in `server.js` and for quoted YAML
  strings.

### Render (task 4)

Command, run in the scratch folder, once per architecture:
`node <repo>/node_modules/@finos/calm-cli/dist/index.js template -a <repo>/output/<name>/architecture.json -b
<repo>/bundles/web-service/3.0.0 -o render-<name>`. Exit code 0 for both. Each log has 8 warnings, all the known
control URL look-ups (`Requests to private or internal network addresses are not allowed: localhost`).

- `orders-api` has PostgreSQL, Redis (`cache`) and RabbitMQ. `inventory-api` has MongoDB, RabbitMQ and
  OpenTelemetry.
- Files, the same seven for both: `Dockerfile`, `README.md`, `src/server.js`, `deploy/k8s/gateway-config.yaml`,
  `deploy/k8s/kustomization.yaml`, `deploy/k8s/network-policy.yaml`, `deploy/k8s/workloads.yaml`.
- `node --check src/server.js`: passed for both.
- `kc create namespace calm-step2-probe`, then `kc apply --dry-run=server -k <scratch>/render-<name>/deploy/k8s -n
  calm-step2-probe`: exit 0 for both. Each created (server dry run) 1 ConfigMap, 5 Services, 5 Deployments and 11
  NetworkPolicies (`default-deny`, `allow-dns`, one ingress policy for `web-client-api-gateway`, and an egress and
  an ingress policy for each of the four in-cluster relationships).

### Cluster (task 5, inventory-api render)

The Calico pods (`calico-node`, `calico-kube-controllers`) and CoreDNS were `1/1 Running` before the test.

- Image build: `mk image build -t calm-step2-probe:dev <scratch>/render-inventory-api` took 13.9 s, including the
  pull of `node:22-alpine`. `mk image ls` showed `docker.io/library/calm-step2-probe:dev`.
- Overlay `<scratch>/overlay/kustomization.yaml`: `namespace: calm-step2-probe`, `resources:
  [../render-inventory-api/deploy/k8s]`, `images: [{ name: calm-service, newName: calm-step2-probe, newTag: dev }]`.
  `kc apply -k <scratch>/overlay` created all 22 objects at 11:17:19.
- Rollouts (`kc -n calm-step2-probe rollout status deployment/<name> --timeout=300s`, all exit 0; times are from
  the apply and are approximate to a few seconds, images pulled inside minikube): `web-service` under 10 s (image
  already local); `api-gateway` and `mongodb-database` about 71 s; `message-queue` about 72 s; `observability`
  about 80 s. All five pods `1/1 Running`, 0 restarts.
- Images, all started with no extra config: `nginxinc/nginx-unprivileged:1.27-alpine` (gateway; it has busybox
  `wget` and `nc`), `mongo:7`, `rabbitmq:3-alpine`, `otel/opentelemetry-collector:0.110.0` (its default config
  listens on 4317 on all interfaces: the TCP readiness probe passed and the service reached it). The gateway needs
  its nginx config, which is the rendered ConfigMap. `postgres:16-alpine` gets `POSTGRES_PASSWORD=change-me` in the
  manifest because the image refuses to start without a password; this was not run (see below).

Connection checks. Every command below starts with `kc -n calm-step2-probe exec`.

| Check | Command | Result |
|---|---|---|
| `/connections`, direct | `deploy/api-gateway -- wget -qO- http://web-service:8080/connections` | exit 0; `mongodb-database:27017` (TCP), `message-queue:5672` (AMQP), `observability:4317` (TCP), all `"open": true` |
| `/connections`, through the gateway's nginx | `deploy/api-gateway -- wget -qO- http://127.0.0.1:8080/connections` | exit 0; the same three entries, all `"open": true` |
| `/health` | `deploy/api-gateway -- wget -qSO- http://web-service:8080/health` | `HTTP/1.1 200 OK`, body `{"status": "ok"}` |
| `/` | `deploy/api-gateway -- wget -qO- http://web-service:8080/` | `service: inventory-api`, `owner: team-inventory`, the pattern URL, `nodes: 6`, `relationships: 7`, `bundle: web-service 3.0.0` |
| Permitted: service → data store | `deploy/web-service -- nc -z -w 3 mongodb-database 27017` | exit 0 |
| Blocked: gateway → data store | `deploy/api-gateway -- sh -c 'time nc -z -w 3 mongodb-database 27017'` | exit 1 after `real 0m 3.00s` (timeout) |
| Blocked: gateway → message queue | `deploy/api-gateway -- sh -c 'time nc -z -w 3 message-queue 5672'` | exit 1 after `real 0m 3.00s` |
| Blocked: service → Kubernetes API | `deploy/web-service -- sh -c 'time nc -z -w 3 kubernetes.default.svc.cluster.local 443'` | exit 1 after `real 0m 3.00s` |
| Blocked: service → gateway | `deploy/web-service -- sh -c 'time nc -z -w 3 api-gateway 80'` | exit 1 after `real 0m 3.00s` |

The blocked results are timeouts, not name failures: from the gateway pod `nslookup mongodb-database` gave
`mongodb-database.calm-step2-probe.svc.cluster.local` → `10.108.71.123`, and from the service pod `nslookup
kubernetes.default.svc.cluster.local` gave `10.96.0.1`. (That first `nslookup` exits 1 because busybox also prints
NXDOMAIN for the other search domains.)

Clean-up: `kc delete ns calm-step2-probe` (exit 0, namespace gone from `kc get ns`); `mk image rm
docker.io/library/calm-step2-probe:dev` (exit 0; `mk image ls` no longer lists it). The images pulled for the test
(`node:22-alpine`, nginx, mongo, rabbitmq, the collector) stay in minikube's image store.

### Not verified

- The `orders-api` render ran only as a server dry run: `postgres:16-alpine` and `redis:7-alpine` were not started
  in the cluster.
- The `web-client-api-gateway` policy (ingress to the gateway from anywhere on 8080) was applied but no connection
  from outside the namespace was tried.
- `server.js` and the `Dockerfile` `HEALTHCHECK` were not run outside the cluster (Kubernetes ignores
  `HEALTHCHECK`).
- The README's by-hand path (image built as `calm-service:dev`, base applied with `-n` and no overlay) ran only as
  the server dry run; the cluster test went through the overlay.
- Nothing was run through Backstage: the bundle is not yet in `app-config.yaml` or the registry (other steps).

## Deviations

- **Two NetworkPolicies per in-cluster relationship, not one.** A NetworkPolicy has one `podSelector`, so egress
  from the source's pods and ingress to the destination's pods cannot be one object. The names are
  `<relationship unique-id>-egress` and `<relationship unique-id>-ingress`; a relationship from outside the cluster
  gets only the `-ingress` one. Both carry the `calm.finos.org/relationship` and `calm.finos.org/protocol`
  annotations, so the relationship can still be found from either.
- **Policy ports are pod ports.** Policies are checked after the Service's address translation, so the gateway
  rules name 8080 (the pod), not 80 (the Service) or 443 (the external placeholder).
- **`config/application.yaml` and `deploy/docker-compose.yml` are dropped.** Nothing in 3.0.0 reads the config file
  (the service's values are in `server.js`), and the plan's file list has no compose file.
- **Service port and pod port can differ for backing services.** The Service port is the architecture's port; the
  pod port is the image's own port. They are equal in both test architectures, so a differing port is not tested.
- **Workloads are matched by node `unique-id`** (`web-service`, `api-gateway`, `postgres-database`,
  `mongodb-database`, `cache`, `message-queue`, `observability`). Any other node gets no workload, and a `connects`
  relationship to it is listed in the README as not rendered.
- **Extra settings not in the plan:** `enableServiceLinks: false` on every pod (stops Kubernetes injecting
  `<SERVICE>_PORT` variables that some images misread), and a `/healthz` location in the gateway's nginx config so
  its readiness does not depend on the service.
- **The gateway forwards plain HTTP** although the relationships say HTTPS: no certificates are rendered. The
  protocol is recorded in the policy annotation only.
- **Rollout times are approximate**: the waits ran one after another in a second command, a few seconds after the
  apply.
