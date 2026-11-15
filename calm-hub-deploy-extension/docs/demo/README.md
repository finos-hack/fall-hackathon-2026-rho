# Demo: deploying from CALM Hub

`calm-hub-deploy-demo.mp4`: a terminal on the local cluster (left) and CALM Hub (right), side by side, live, in one
take (1920×1080).

2:10. The service is `events-stream` (a Nisshi event-streaming service from calm-backstage); the take deploys
1.0.5, which moves the broker's storage from PostgreSQL to SQLite, then tries 1.0.6, which the pattern forbids.

| | Chapter |
|---|---|
| 0:00 | CALM Hub with a deployment extension |
| 0:13 | Where the service runs |
| 0:28 | An architect changes a pattern decision |
| 0:50 | Deploy this version, from CALM Hub |
| 1:06 | Deployed: Git, Flux and the record in CALM Hub |
| 1:24 | The controls gate |
| 1:58 | The same extension, for an agent (MCP) |

![The Deployment tab](deployment-tab.png)

![The diagram's Deployments overlay](diagram-overlay.png)

## Record it again

Needs calm-backstage's stack with `events-stream` deployed through Flux (the event-streaming Template with the
`nisshi-stream-app` starter and `k8s-deploy`), this extension's Hub and backend running (`npm run hub:up`,
`npm start`), and `ttyd`, `ffmpeg` and `jq` on the PATH. Playwright comes from calm-backstage's `node_modules`.

```sh
node docs/demo/record-hub-demo.cjs <out-dir>
```

Each take stores two new versions of `events-stream` in CALM Hub (versions cannot be deleted): one that flips the
broker's storage between PostgreSQL and SQLite, so every take deploys a real change, and one with a connection the
pattern forbids. The recorder works out the version numbers and the storage choice from what runs.

| File | |
|---|---|
| `record-hub-demo.cjs` | Drives a ttyd terminal and CALM Hub in two Playwright pages, then joins both recordings with ffmpeg |
| `demo.rc` | bash rc for the terminal: `$HUB`, `$EXT`, `$NS`, `k`, and the prompt counter the recorder waits on |
| `watch-deploy.sh` | Live view of one deployment: its record in CALM Hub, Flux, the Deployments and network policies |
| `mcp.sh` | Calls one tool on CALM Hub's MCP server, as an agent would |
