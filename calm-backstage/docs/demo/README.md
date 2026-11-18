# Demo: CALM + Backstage + template bundles

The full demo (5:25) retakes everything so far (parts 1, 2 and 3) in one take. It opens with this table of contents;
each chapter starts with a card showing its number. The video is not committed; it will be linked here once it is on
YouTube.

| # | Starts at | Chapter | What you see |
|---|---|---|---|
| 1 | 0:11 | CALM in the catalog | The catalog from CALM Hub: architectures, the two patterns, an architecture page (pattern, controls, diagram), the web-service pattern and its decisions. |
| 2 | 0:35 | The Template Explorer | The Template Explorer: a starter (Spring Boot) and the files inside its OCI artifact; the deployment rules `k8s-deploy` and what changed from 1.0.0 to 1.2.1; its source folder in Gitea at the commit it was published from. |
| 3 | 1:06 | Create a Spring Boot service | Create `orders-nov14` from the web-service pattern with `spring-boot-service@1.0.0` and `k8s-deploy@1.0.0`: the run pushes it to Git, builds the image and Flux deploys it. The card shows the bundles, the Git repository and the commit Flux applied; **Open the running app** shows Spring Boot 4.0.9 and its database answering. |
| 4 | 2:03 | Red Hat build of Quarkus | `billing-nov14`, made with the same Template and the Red Hat build of Quarkus starter (started through the scaffolder API while chapter 3 ran), opened as a running app: Quarkus 3.33.4 on UBI 9 OpenJDK 21. |
| 5 | 2:21 | Event streaming with Nisshi | Create `events-nov14` from the event-streaming pattern (Nisshi, PostgreSQL storage); its architecture (stream app → broker → PostgreSQL); the running app produces three events and shows them consumed back through Nisshi. |
| 6 | 3:43 | Git, Flux and CALM Hub | The service repository in Gitea (the create commit and the deploy commit), the `calm-services` organisation, and CALM Hub: the stored architecture and its deployment decorator naming the Git commit. |
| 7 | 4:12 | Upgrade code and deployment rules | The card offers Spring Boot 4.1.2 and `k8s-deploy` 1.3.1; **Upgrade** runs the `calm-upgrade` Template: re-render on a branch, build, pull request merged in Gitea, Flux applies the merge commit. The pull request and its files, the card up to date, and the app now on Spring Boot 4.1.2 under `k8s-deploy@1.3.1`. (The take shown was recorded before 1.3.1, on 1.3.0; the script now selects 1.3.1 and the video was not retaken.) |
| 8 | 5:07 | Who uses what | The Template Explorer's **Used by**: which services run which deployment rules and starter versions. |

Recorded on 2026-11-14 against this branch: Backstage on 3200/7207 (a second checkout held 3100/7107), CALM Hub, the
bundle registry and Gitea from `hub/docker-compose.yml`, and the minikube profile `calm-backstage` rebuilt with
`yarn k8s:up`. The image caches were warmed first with throwaway services, so the builds in the video are the warm
ones; cold, a Spring Boot service took 135 s and a Red Hat Quarkus one several minutes (FINDINGS, part 3).

A cluster created before `k8s-deploy` 1.3.x needs `yarn k8s:up` again: the upgrade lands on 1.3.x, which needs
cert-manager.

Record it again (pick a suffix not used yet; it names `orders-<suffix>`, `billing-<suffix>`, `events-<suffix>`):

```sh
node docs/demo/record-full-demo.cjs <suffix> <out-dir> http://localhost:3100
```

## Cluster demo: terminal and Backstage side by side

The cluster demo (3:58) puts the live cluster next to Backstage. A terminal (left) starts on an empty cluster; Backstage
(right) walks through the pattern, the starters, the Template form and its run step by step, while the terminal shows
what each step did: CALM Hub and the bundle registry over their APIs, the pods arriving, the Git source Flux applies,
the app answering, the network policies enforced and Nisshi's storage. Watch it on [YouTube](https://youtu.be/mJNV3iuA6H4).

| # | Starts at | Chapter | Terminal | Backstage, CALM Hub, Gitea |
|---|---|---|---|---|
| 1 | 0:00 | An empty cluster | Namespaces, no Flux Kustomizations. | The catalog: CALM architectures, no services. |
| 2 | 0:09 | The pattern | The patterns, from the CALM Hub API. | The event-streaming pattern in Backstage (its decision, the bundles that fit), then in CALM Hub. |
| 3 | 0:23 | Starters and deployment rules | The bundles in the OCI registry and the Nisshi starter's versions. | Template Explorer: four starters (Spring Boot, Red Hat build of Quarkus, Node.js, Nisshi), a starter file, the `k8s-deploy` network policy template. |
| 4 | 0:44 | Create, step by step | | The web-service Template's starter choice, then the event-streaming Template: name; storage decision, starter and deployment rules; the placeholders `calm generate` leaves; review. |
| 5 | 1:07 | The Template runs | `watch-cluster.sh`: the Kustomization, then four pods ready after 12 s. | The run, then each step highlighted: generate, validate, render code and rules, store in CALM Hub, Git, build, Flux, record in CALM Hub. |
| 6 | 1:45 | The service | Deployments, services, network policies with the CALM node each applies to. | The service page: bundles, Git and Flux, workloads and policies. |
| 7 | 1:59 | In Git | The Flux source and the commit it applied. | The repository in Gitea, and `deploy/k8s/network-policy.yaml`. |
| 8 | 2:11 | In CALM Hub | The architecture's nodes and the deployment decorator, from the CALM Hub API. | The architecture in CALM Hub and its Deployments tab. |
| 9 | 2:34 | The app answers | Port-forward, `curl`: info, two events produced and consumed back. | **Open the running app**: the same events. |
| 10 | 3:05 | Network policies, enforced | A busybox pod times out on `nisshi-broker:9092`; labelled `calm.finos.org/node=stream-app` it connects. | The relationships and their policies. |
| 11 | 3:34 | Topics in PostgreSQL | `psql`: the `orders` topic with 2 events, and the events. | |

Recorded on 2026-11-15 on top of #8, before #15 moved the CALM Hub step after the Git push (Backstage on 3200/7207,
warm image caches; the run page shows the home folder as `~`). Needs `ttyd` and `ffmpeg` (`brew install vhs` brings both) and, for the empty opening shot, no other
`calm-*` service in the cluster (`docs/demo/cleanup.sh`). Use a suffix CALM Hub has no `events-<suffix>` architecture
for yet: the terminal reads version 1.0.0. Record it again:

```sh
node docs/demo/record-cluster-demo.cjs <suffix> <out-dir> http://localhost:3200
```

It drives two Playwright pages, a ttyd terminal (bash with `cluster-demo.rc`) and Backstage, records both and joins
them with ffmpeg into `<out-dir>/calm-backstage-cluster-demo.mp4`.

## Import demo: a diagram into CALM

The import demo (3:16, narrated) turns one trading platform, drawn in draw.io, written as Mermaid C4 and as a Mermaid
flowchart, into CALM architectures with the **Import a diagram** Template. Watch it on
[YouTube](https://youtu.be/PNV_NTW0gHQ); the video is not committed. Screenshots of the same steps are in
[`calm-import/`](calm-import).

| # | Starts at | Chapter | What you see |
|---|---|---|---|
| 1 | 0:00 | Diagrams already exist | A title card. |
| 2 | 0:14 | The diagram | The trading platform in draw.io (`calm-import/examples/trading.drawio`), with a queue, a cluster, a legend and a TODO note. |
| 3 | 0:36 | The Template | **Import a diagram** on the Create page, and its Format list: draw.io, C4 (Mermaid or PlantUML), Mermaid flowchart. |
| 4 | 0:51 | Import the draw.io file | The form, the run (convert, validate against the CALM schema, store in CALM Hub), 7 nodes and 7 relationships, and the 2 guesses. |
| 5 | 1:22 | The same platform in C4 | `trading.c4.md`, imported the same way: 7 and 7, and 5 guesses. |
| 6 | 2:09 | In CALM Hub | The draw.io import on CALM Hub's own Diagram tab. |
| 7 | 2:26 | Mermaid flowcharts | `trading.mmd`, imported with the draw.io rules. |
| 8 | 2:38 | In the catalog | The draw.io and C4 Components, each with the CALM architecture card drawn from CALM Hub. It comes after CALM Hub and Mermaid so that the catalog, which reads CALM Hub once a minute, already has both. |
| 9 | 2:52 | The wrong file | A draw.io file with C4 chosen: refused before anything is stored, with a hint naming draw.io. |
| 10 | 3:01 | Recap | |

It needs the stack (`yarn hub:up`, Backstage with `yarn start`), `ffmpeg` on the PATH, and calm-import built. The
imports stay in CALM Hub, so each take needs a new suffix.

Record it again (pick a suffix not used yet; it names `<suffix>-drawio`, `<suffix>-c4`, `<suffix>-mmd`, and tries
`<suffix>-wrong`, which is refused):

```sh
node docs/demo/record-import-demo.cjs <suffix> <out-dir> http://localhost:3100
node docs/demo/record-import-demo.cjs <suffix> <out-dir> --audio-only    # speak and time the narration only
```

It writes `calm-import-demo.mp4`, its captions `calm-import-demo.srt`, and `chapters.json`. Before it records, it
checks that the narration and the recorder name the same beats, that the samples still give 7 nodes and 7
relationships, and that no name is taken in CALM Hub. It records the page at its own size and scales it to 1920×1080,
and covers the blank white frame the browser shows between two pages with the frame before it.

**The voice** (`DEMO_TTS`):
- `say` (the default): macOS `say`, voice Daniel.
- `elevenlabs`: ElevenLabs, with `ELEVENLABS_API_KEY` and `DEMO_VOICE` (see `voice.cjs`).
- `local`: the presenter's own voice, cloned on the recording machine from a short sample with
  [Chatterbox](https://github.com/resemble-ai/chatterbox) (MIT). Nothing leaves the machine. It needs a Python with
  `pip install chatterbox-tts 'setuptools<81'` (`DEMO_PYTHON`, default `python3`) and `DEMO_VOICE_SAMPLE`, a WAV of the
  presenter reading for a minute or two, kept outside the repository. `DEMO_CFG`, `DEMO_EXAGGERATION` and
  `DEMO_SEED` tune it (see `clone-voice.py`). A line that came out well can be kept as `docs/demo/.voice/<beat id>.wav`
  (git-ignored), and is used instead of generating that line again.

| File | |
|---|---|
| `record-import-demo.cjs` | Drives Backstage and CALM Hub in one Playwright page and lays the voiceover under the video |
| `import-narration.cjs` | The voiceover, one beat per step; the guess counts come from the converter |
| `pronunciation.cjs` | How the voice should say words it gets wrong (voice only; captions keep the spelling) |
| `voice.cjs` | Speaks the beats (`say`, ElevenLabs or `local`), cached. From calm-hub-deploy-extension (#53), with `local` added |
| `clone-voice.py` | The `local` voice: speaks lines in a voice cloned from a sample, with Chatterbox |
| `revoice.cjs` | Re-voices a finished take over the same footage. From calm-hub-deploy-extension (#53) |

## Older recordings

Recorded by `record-demo.cjs`: [part 2](https://youtu.be/XhFmQQTT6-k) and
[part 1](https://youtu.be/zQ1cLPv3Fmk) on YouTube.
