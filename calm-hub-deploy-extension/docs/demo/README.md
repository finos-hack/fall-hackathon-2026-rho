# Demo: plugging a deployment extension into CALM Hub

A narrated walkthrough (12:35, 1920×1080, one take, in the presenter's cloned voice) with a terminal on the local cluster on the left and CALM Hub on
the right. It starts with CALM Hub as it ships, with no extensions, and shows how an integration plugs in: the
manifest, the configuration, the signed calls CALM Hub makes to the extension, and the results the extension writes
back. Then it deploys a pattern decision from CALM Hub, through the firm's own pull request approval and Flux.

The video is not kept in this repository. It is published separately (link to follow), with
`calm-hub-deploy-demo.srt` as its captions. `record-hub-demo.cjs` writes both files.

In this take, `events-stream` (a Nisshi event-streaming service from calm-backstage) runs 1.0.7 with its broker's
topics in SQLite. The take deploys 1.0.9, which moves them back to PostgreSQL, and then tries 1.0.10, which the
pattern forbids.

| | Chapter | What it shows |
|---|---|---|
| 0:00 | CALM Hub on its own | No Extensions tab. The two built-in extensions are views for decorators, with no backend. Decorators already let tools record facts, but CALM Hub can't start anything. |
| 1:02 | An extension is a manifest and a backend | The manifest's routes (method, path, scope), contributions (the Deployment tab and the action) and commands (schemas, which become CLI commands and MCP tools). |
| 2:27 | Plugging it in | The CALM Hub configuration (manifest folder, backend URL, signing key). Starts the backend with manual approval and restarts CALM Hub. Covers the signed assertion on every call, the registry, the JWKS and the MCP tools. |
| 4:01 | CALM Hub hooks in | The Extensions tab appears. The backend's log shows the call CALM Hub made, verified. The tab is blocks that CALM Hub draws. |
| 4:55 | Where the service runs | The cluster's Deployments, and the status command through CALM Hub's proxy. |
| 5:22 | An architect changes a pattern decision | A new version with the broker's storage changed. The tab warns that the cluster runs the old one. |
| 6:02 | Asking CALM Hub to deploy | The confirm dialog: scope check, audit and signing. The deployment record on the Decorators tab goes pending, then validate, render and pull request, then it waits for approval. Ends with the diagram marked in progress and the trail in the backend's log. |
| 7:26 | The firm's change gate | The pull request in Gitea, the files it changes, and the commit message with who asked and CALM Hub's audit id. The approver merges it. |
| 8:38 | Flux applies it | The record says Flux is applying the merge commit, the PostgreSQL Deployment and its network policies come back, and the record and the overlay end completed. |
| 9:19 | The results, back in CALM Hub | The decorator's fields, and the tab saying "deployed" with the history. CALM Hub's audit line has the same id. The integration runs both ways. |
| 10:25 | The controls gate | A forbidden connection fails validation: no pull request is opened and the cluster is unchanged. |
| 11:30 | The same extension, for an agent | The history command as an MCP tool, with the same checks and audit. |
| 11:58 | The integration pattern | Recap. A firm with another deployment platform implements the same profile. |

![CALM Hub before the extension: no Extensions tab](hub-before.png)

![The Deployment tab](deployment-tab.png)

![The diagram's Deployments overlay after the deployment](diagram-overlay.png)

## Re-voice a take

`revoice.cjs` speaks a finished take's lines again, with a different voice or provider. Each line goes back at the
time the take spoke it, over the same footage. It needs no new take, so nothing changes in CALM Hub, Gitea or the
cluster. A line longer than the gap before the next one is sped up to fit, and the script lists it.

```sh
DEMO_TTS=elevenlabs DEMO_VOICE=<voice id> node docs/demo/revoice.cjs <take-dir> [out-dir]
```

## Record it again

**Needs:**
- calm-backstage's stack, with `events-stream` deployed through Flux (the event-streaming Template with the
  `nisshi-stream-app` starter and `k8s-deploy`);
- this extension's Hub (`npm run hub:up`);
- `ttyd`, `ffmpeg` and `jq` on the PATH, and macOS `say`;
- Playwright, which comes from calm-backstage's `node_modules`.

```sh
CALM_KUBECONFIG=/path/to/calm-backstage/.kube/config node docs/demo/record-hub-demo.cjs <out-dir>
node docs/demo/record-hub-demo.cjs <out-dir> --audio-only    # speak and time the narration only
```

**What one take does:**
- **Restarts:** it restarts CALM Hub twice (without the extension, then with it) and runs the backend with manual
  approval. It leaves the backend running on auto approval afterwards.
- **New versions:** it stores two new versions of `events-stream` in CALM Hub, which can't be deleted. One flips
  the broker's storage between PostgreSQL and SQLite, so every take deploys a real change. The other has a
  connection the pattern forbids.
- **Version numbers:** the recorder works out the version numbers and the storage choice from what runs.
- **Kubeconfig:** set `CALM_KUBECONFIG` when this folder isn't next to the calm-backstage checkout that made the
  cluster, for example in a git worktree.

**Narration:** `narration.cjs` holds the voiceover as beats. `voice.cjs` speaks each beat, caches it under
`.work/demo-audio/`, and the recorder shows it as the caption while it plays. Two voices are available:
- macOS `say`, the default: `DEMO_VOICE` (default Daniel) at `DEMO_RATE` (default 170 words a minute);
- ElevenLabs: `DEMO_TTS=elevenlabs` with `ELEVENLABS_API_KEY` and `DEMO_VOICE` set to a voice id, which can be a
  clone of the presenter's voice.

 Each step is held until its beat has been spoken. Typing, holds and waits are 3× the first
take's pace. After the take, the beats are laid under the joined video at the times they were spoken, and the same
times give the `.srt`.

| File | |
|---|---|
| `record-hub-demo.cjs` | Drives a ttyd terminal and CALM Hub in two Playwright pages, joins both recordings with ffmpeg and adds the voiceover |
| `narration.cjs` | The voiceover and the terminal's comments, one beat each |
| `voice.cjs` | Speaks the beats with macOS `say` or ElevenLabs, cached |
| `revoice.cjs` | Re-voices a finished take over the same footage |
| `demo.rc` | bash rc for the terminal: `$HUB`, `$EXT`, `$GITEA`, `$NS`, `k`, and the prompt counter the recorder waits on |
| `start-extension.sh` | (Re)starts the backend in the background with `auto` or `manual` approval |
| `watch-deploy.sh` | Live view of one deployment: its record in CALM Hub, Flux, the Deployments and network policies (`UNTIL=approval` stops at the pull request) |
| `ext-log.sh` | The backend's log: the calls CALM Hub made, and the deployment steps |
| `approve-pr.sh` | Merges the pull request, as the approver would |
| `hub-audit.sh` | CALM Hub's audit line for one call, by its audit id |
| `mcp.sh` | Calls a tool on CALM Hub's MCP server, or lists the tools (`--list`) |
