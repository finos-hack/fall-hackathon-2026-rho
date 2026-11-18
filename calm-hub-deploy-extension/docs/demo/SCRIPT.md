# Script for review: Platform Connector demo with runtime control evidence

One take, as before: a terminal on the cluster on the left and CALM Hub on the right. Chapters 1–6 are unchanged and
summarised in one line each. New and changed beats are written out in full:
- **Says:** the caption, and later the voice.
- **Shows:** what happens on screen.
- **Types:** the short comment typed in the terminal.

Approved 2026-11-18. Changes made while building it are marked "after review". Spoken counts ("three of
three") became "all of them": the take flips the broker's storage, and with PostgreSQL there are more connections,
so the count isn't known when the narration is written. The screen still shows the real numbers.

Names and timings come from a dry run on the live stack (2026-11-18):
- The sensors turn a connection red about 2–4 s after a policy is deleted.
- It is green again about 3–5 s after asking Flux to reconcile.

## Chapters 1–6 (unchanged)

1. **CALM Hub today:** namespaces, the event-streaming pattern and its open decision, the Permitted Connection
   control, and `events-stream`.
2. **Deployment records are write-only:** the built-in Deployments overlay, its badge and "View all".
3. **A Platform Connector:** the manifest, the backend starts, CALM Hub restarts with it, and the registry and MCP
   list it.
4. **Woven in:** the home card, the Extensions tab, the Platform panel and the connector log. The Deployment tab now
   also shows the new **"Runtime checks holding 3/3"** stat. Chapter 8 explains it, so it isn't narrated here.
5. **Drift: what a record can't know:** `stream-app` is scaled to 0, the panel and the tab show it, and Flux puts it
   back.
6. **A decision changes, and the connector deploys it:** storage is flipped, then the gate, the record, the pull
   request, approval, Flux, completed, and CALM Hub validating the record.

## 7. The controls gate, as a control evaluation (two beats added at the end)

Unchanged: the forbidden version, refused at the gate, the control evaluation on the diagram, the finding, and no pull
request.

- **New beat, `no-pattern`**
  - **Types:** `# A version that names no pattern`
  - **Shows:** `npx tsx scripts/new-version.ts hackathon events-stream --no-pattern` prints "Stored … names no
    pattern".
  - **Says:** "One more. This version names no pattern at all, so there is nothing to validate it against."
- **New beat, `no-pattern-refused`**
  - **Types:** `# Deploy it`
  - **Shows:** the deploy request through CALM Hub's extension API, then `watch-deploy.sh` ending on "Refused at the
    controls gate: … names no pattern in CALM Hub … cannot validate it".
  - **Says:** "Until now, the gate skipped a version like this and deployed it unchecked. Now it fails closed: refused,
    recorded as a control evaluation, and nothing reaches Git."

## 8. Controls at runtime: evidence (new chapter)

1. **`runtime-gap`**
   - **Shows:** the diagram of the running version. The legend reads "Control evaluations · 3 OK".
   - **Says:** "The gate checks a version before it is deployed. But once it runs, nothing checked that its controls
     still held. Someone could delete a network policy, and the architecture would still say the connection is
     permitted."
2. **`sensors`**
   - **Types:** `# The policies Git renders, one per connection`
   - **Shows:** `k -n calm-events-stream get networkpolicies` with a RELATIONSHIP column, which is the
     `calm.finos.org/relationship` annotation.
   - **Says:** "Since it was plugged in, the connector's sensors have checked every five seconds that, for each
     connection the security control covers, the policies Git renders are in the cluster and allow exactly that, and
     that default-deny is in place."
3. **`evaluations-met`**
   - **Shows:** the legend "Control evaluations · 3 OK" is highlighted.
   - **Says:** "Each connection gets a standard control evaluation, the same kind of record the gate writes, so CALM
     Hub's built-in view draws it. All of them are met."
4. **`tab-checks`**
   - **Shows:** the Extensions tab, with the "Runtime checks holding 3/3" stat highlighted.
   - **Says:** "Switch to the Deployment tab. It counts the runtime checks that hold: all of them."
5. **`break-policy`**
   - **Types:** `# Delete a policy behind Git's back`
   - **Shows:** `k -n calm-events-stream delete networkpolicy api-gateway-stream-app-ingress`, then back to the
     Diagram.
   - **Says:** "Now break one. Delete the policy that lets the gateway reach the stream app, as a hurried fix might."
6. **`not-met`**
   - **Shows:** the legend turns to "1 Error · 2 OK", and the gateway-to-stream-app connection gets the red
     "✗ Not met" badge. The diagram zooms in on it.
   - **Says:** "Within seconds the sensors see it. On CALM Hub's own diagram, the connection from the gateway to the
     stream app is not met."
7. **`panel`** (changed after review: CALM Hub shows extension panels for nodes only, never for a connection)
   - **Shows:** the connection is selected. CALM Hub's own relationship sidebar lists the evidence record under "All
     decorators", with `result` (fail) and `observed` ("api-gateway-stream-app-ingress is missing") highlighted.
   - **Says:** "Select the connection. CALM Hub's sidebar lists what the sensors recorded about it: the check failed,
     and why. The ingress policy is missing."
8. **`evidence-record`**
   - **Shows:** the sidebar's "All decorators" lists the `evidence` record. Highlighted: `evidence` (unique-id,
     evidence-paths, control-config-url), `result: fail`, `expected`, `observed`.
   - **Says:** "It is an evidence record, in CALM's own evidence format: the control configuration it proves, the
     paths to the raw evidence in the cluster, and what was expected against what was observed."
9. **`valid-until`**
   - **Shows:** `observed-at`, `valid-until` and `sensor` are highlighted.
   - **Says:** "It says when it was observed, and how long that holds: ninety seconds. Evidence that nobody refreshes
     turns stale, and stale is never shown as met."
10. **`evaluation-record`** (added after review)
    - **Shows:** the sidebar scrolls to the control evaluation beside it: `status` (not-met), `findings` and
      `report-uri` (a link to the evidence record) highlighted.
    - **Says:** "Beside it, the control evaluation the diagram draws: not met, the finding, and a link to its evidence."
11. **`heal`**
    - **Types:** `# Flux puts back what Git says`
    - **Shows:** `reconcile.sh events-stream`, then the diagram goes back to "3 OK" and the red badge goes away.
    - **Says:** "Flux puts back what Git says, at its next reconcile, or now if we ask. The connection holds again."
12. **`default-deny`**
    - **Types:** `# Delete default-deny`
    - **Shows:** `k -n calm-events-stream delete networkpolicy default-deny`. The legend reads "3 Error" and all three
      connections turn red.
    - **Says:** "Delete default-deny, and every connection fails at once. Nothing else is denied, so traffic is no
      longer limited to the architecture."
13. **`heal-all`**
    - **Shows:** `reconcile.sh events-stream`, then "3 OK".
    - **Says:** "Ask Flux again. It puts default-deny back from Git, and within seconds the sensors see every
      connection hold."

## 9. The same connector, for an agent (one beat added)

The status and history beats are unchanged.

- **New beat, `mcp-verify`**, after history
  - **Types:** `# The verify command: runtime evidence on demand`
  - **Shows:** `mcp.sh ext_platform-connector_verify …` gives holding 3, checked 3, and each check with expected and
    observed.
  - **Says:** "And verify: the agent asks for fresh runtime evidence, and gets the same checks the diagram shows, every
    one of them holding."
- The history beat now says "the refusals" (two versions are refused in chapter 7).

## 10. The pattern (one line changed)

- **`recap-2`** becomes: "A Platform Connector adds what only the platform knows: what really runs, whether it has
  drifted, how to deploy behind the firm's own approval and CALM Hub's controls, and then proof, while it runs, that
  those controls still hold."

## After the first captions-only take (2026-11-18)

Your feedback: CALM Hub was too small to read, and the video needs a table of contents and an introduction.

- **Readable CALM Hub:**
  - The browser pane now renders CALM Hub at its own size. Before, it was drawn 15% larger and scaled down.
  - The diagram uses CALM Hub's own A+ setting at 1.75. At 2, "PostgreSQL" wraps in its node.
- **Introduction and contents (new, before chapter 1):**
  - The terminal pane opens on a title: "A Platform Connector". The browser pane opens on a contents card listing the ten
    chapters, each with a one-line description.
  - Each contents line picks out the chapters it names.

  | Beat | Shows | Says |
  |---|---|---|
  | `intro` | the title and the contents | "This is a demo of a Platform Connector for CALM Hub. It shows what CALM Hub can know, and what it can do, once the platform its architectures run on is plugged in: here, GitOps on Kubernetes." |
  | `intro-screen` | the title fades to the terminal; `# A terminal on the local Kubernetes cluster`, `k get nodes` | "On the left is a terminal on a local Kubernetes cluster. On the right is CALM Hub. Everything you see is live, in one take." |
  | `contents-1` | chapters 1–2 | "There are ten chapters. First, CALM Hub as it ships, and why its deployment records cannot tell what really runs." |
  | `contents-2` | chapters 3–4 | "Then a Platform Connector is plugged in, and woven into CALM Hub’s own screens." |
  | `contents-3` | chapters 5–7 | "With it, CALM Hub sees drift, deploys a changed pattern decision behind the firm’s own approval, and refuses versions at the controls gate." |
  | `contents-4` | chapters 8–10 | "Then evidence, while the service runs, that its controls still hold; the same connector, used by an agent; and the pattern behind it all." |

- **Silences:** the first take had 28 silences over 1.2 s, about 193 s in all. The fixes:
  - **Shorter commands** (typing still at 54 ms per key):
    - names in `demo.rc`: `$MANIFEST`, `$PULLS`, `$DECORATORS`, `$STANDARDS`, `$ARCH_API` and `$ARCH`;
    - simpler `jq`;
    - `new-version.sh`;
    - `deploy.sh`, which does what the button does through CALM Hub's extension API, then follows the job.
  - **The terminal and CALM Hub work at the same time** within a beat.
  - **Slow steps carry on under the next line:** the backend start and CALM Hub restart (under `signed`), the rollout
    (under `in-sync`), the refused watch (under `evaluation`), and Flux finishing (under `completed`).
- **Lines lengthened to say what is happening while it happens** (new words in bold):
  - `commands`: "… a tool that agents can call. **The connector writes neither.**"
  - `registry-after`: "… next to its built-in views. **It came from the manifest, read at start-up: nothing in CALM Hub’s own code
    changed.**"
  - `mcp-tools`: "status, history, deploy **and verify**". This is a correction: the manifest has four commands.
  - `drift-tab`: "… the same drift. **Both read the cluster, not a record.**"
  - `reconcile`: "… and wait **while Kubernetes starts the stream app again**."
  - `pr`: "… own repository, **on a branch, waiting for review like any other**."
  - `commit`: "The commit message says **what was rendered, from which version and with which deployment rules. It says** who
    asked …"
  - `audit`: "… under the same audit id. So the change **in Git traces back to the call in CALM Hub, and to who made it**."
    Only `hub-audit.sh <id>` is typed now; the id is in the record on screen.
  - `deploy-invalid`: "Deploy 1.0.18 the same way: **from its Extensions tab, Deploy this version, and Run**."
  - `unchanged`: "No pull request was opened: **the newest is still the one for 1.0.17**, and the cluster still runs 1.0.17 …"
  - `no-pattern`: "One more. 1.0.19 names no pattern at all. **Its schema is plain CALM, so CALM Hub accepts it, but** there is no
    pattern to validate it against."
  - `no-pattern-refused` now shows the refusal's control evaluation in CALM Hub, in place of the JSON tab (CALM Hub
    shows the `$schema` far down its JSON).
  - `break-policy`: "Now break one, **behind Git’s back**. …"
  - `heal`: "… or now if we ask. **Within seconds the sensors see the policy back, and** the connection holds again."
  - `mcp-history`: "… the deployments and the refusals, **newest first: the two refusals from a moment ago, then the deployment
    before them. All of it is** read back from the same standard records."
  - `mcp-verify`: "… the same checks the diagram shows, **one for each connection**, every one of them holding."

## After the voiced take (2026-11-18, second round)

Your feedback on the voiced take, and what changed.

- **The volume of the voice jumped around.** ElevenLabs returned most lines at about -38 LUFS and seven at about
  -20, 18 dB louder. The recorder now measures every clip's loudness and gives each a fixed gain to -16 LUFS before
  mixing, with a limiter at -1.5 dBFS. `check-take.cjs` measures every line in the finished video and fails the take
  if they are not even.
- **"On the right is CALM Hub" was spoken over the title.** The `intro-screen` line and the title's left/right
  footer are gone.
- **The opening showed the terminal for no reason.** The title and the contents now fill the screen, on their own
  recorded page laid over both panes. The split screen first appears at chapter 1's first line.
- **A card for each chapter**, in the title's style: "CHAPTER N OF 10", the title, its one-line description, and a
  strip of all ten with this one picked out. Its line says what is about to be shown:
  1. Chapter one: CALM Hub today. Before anything is plugged in, a short tour of what CALM Hub holds: namespaces, a
     pattern with a decision left open, a control, and an architecture made from that pattern.
  2. Chapter two: deployment records. CALM Hub can show records of what was deployed. We'll see how it draws them,
     and what a record on its own can't tell you.
  3. Chapter three: a Platform Connector. We plug one into CALM Hub: a manifest that describes it, and a backend that
     talks to the platform. Then CALM Hub restarts and loads it.
  4. Chapter four: woven in. We'll see what the connector adds to CALM Hub's own screens: a card on the home page, a
     tab on the architecture, and a panel for each node.
  5. Chapter five: drift. We change the cluster without going through Git, and watch CALM Hub notice, which a
     deployment record alone never could.
  6. Chapter six: a decision changes. An architect changes the pattern's open decision, and the connector deploys the
     new version: past the controls, through a pull request and the firm's approval, onto the cluster.
  7. Chapter seven: the controls gate. Two versions that should never reach the cluster: one the pattern forbids, and
     one that names no pattern. Both are refused, and each refusal is recorded.
  8. Chapter eight: controls at runtime. Passing the gate once is not enough. Sensors check that the controls still
     hold while the service runs; we'll break one and watch it turn red.
  9. Chapter nine: for an agent. The same connector, used by an AI agent through CALM Hub's MCP server: status,
     history, and fresh runtime evidence.
  10. Chapter ten: the pattern. To finish, what a Platform Connector adds to CALM Hub, and why the same approach works
      for any platform.
- Under each card, off camera: the terminal is cleared, CALM Hub reloads its extensions (chapter 4), and the
  sensors are waited for (chapter 8).
- **New checks before you see a take** (`check-take.cjs`): the loudness of every line, and a frame from the middle of
  every line on labelled contact sheets, each looked at against its words.
- Your pronunciation picks from the last round still apply: SQLite "sequel-lite", JSON "Jay-son", past-tense read
  "red".

## Pacing for this take (your feedback on the last one)

- **Captions-only take:** each caption shows for as long as the line takes to speak. Its actions happen while it
  shows, and the next caption follows after the same short gap (about 0.5 s) everywhere.
- **Voiced take:** recorded fresh and timed to your ElevenLabs voice, not re-voiced over old footage. That re-voicing
  is what made the silences uneven.
- **No lingering:** nothing stays on screen after a line ends.
  - Waits are covered by the narration, or shortened.
  - During the take, Flux's own once-a-minute reconcile is slowed off camera, and every heal is requested with
    `reconcile.sh`. That removes the drift chapter's Flux-timing pause and keeps Flux from healing a broken policy
    before it is shown. Flux's interval is restored afterwards.
- **Typing stays at 3×** (54 ms per key).
- **Silence check:** the recorder reports any silence longer than 1.2 s, and I fix those before you see it.

## Off camera, before the take

- The runtime evidence records from earlier runs are deleted, so chapters 1–2 ("CALM Hub as it ships") show none.
  Fresh ones appear once the connector is plugged in during chapter 3.

## Decisions for you

- **No TLS check on screen.** `events-stream` runs `k8s-deploy@1.2.1`, which renders no Certificates, and the cluster
  has no cert-manager. So the video shows the network-policy check only and does not mention TLS.
- **A small bug I'd fix before recording.** The sensors try to read Certificates whenever a relationship is HTTPS,
  even when Git renders none. On this cluster that adds "Cannot read the certificate objects…" to `problems` in every
  `verify` reply, which would show in chapter 9, and logs an error every 5 s. The fix is to read Certificates only
  when Git renders one (`src/sensors.ts`, plus a test).
- **Length:** the last take was 13:22. This adds about 3½ minutes of narration, and tighter gaps take some time back,
  so I expect about 16–17 minutes. That is roughly 3× the original 2:10 take, as your pacing rule asks.
