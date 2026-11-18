# CALM Ripples

An experimental CALM Hub diagram lens that shows where an incident might travel through a modeled architecture. Select a starting system to trace directed `connects` relationships, see the shortest hop count, and switch between the ripple and the full architecture. The included digital bank is fictional: 42 systems, 51 connections, and the Rewards and FX examples from the presentation.

**Demo:** [Watch the silent CALM Ripples walkthrough](https://www.youtube.com/watch?v=RbEa7VUfKg4) (35 seconds; screenshots from the running prototype).

## Run the demonstration

Requirements: Docker with Compose, Python 3, OpenSSL, and an internet connection for the first image download. On macOS, Docker Desktop or Colima can provide Docker. This setup starts an isolated, unauthenticated local test Hub bound to `127.0.0.1:8091`, plus the Ripples backend on a container-only network. Use fictional data only.

```sh
cd calm-ripples
./scripts/start.sh
```

Open [CALM Hub](http://localhost:8091/#/namespace/demo), select **Digital Bank — CALM Ripples**, open **View**, and choose the **Ripples** lens. Choose **Rewards Service** or **FX Rates Service** from **Starting system**. Click any component in the graph to make it the starting point and recalculate both the downstream reach and control findings. Gold components are immediate upstream neighbors; click them to move back along the chain. They are navigation context and are not counted as downstream impact. **Ripple** shows nearby reachable nodes (two hops by default); **Hops shown** expands or narrows the diagram, while the impact and control counts cover the full reachable ripple. **Full architecture** shows the context.

Stop the demo using `docker compose -f compose.yml down` (or `docker-compose -f compose.yml down`). Its database is inside the Hub container and is recreated if that container is replaced; the start script adds the fictional architecture again. Generated local signing keys are under `.keys/` and are ignored by Git.

## What it means

The lens traces modeled connection direction. A path is a reason to investigate, not evidence of actual access or compromise; missing or unmodeled relationships can hide impact. Types other than `connects` and invalid endpoints are not traversed and are counted as omissions. The four data classifications in the demo come from explicitly labeled fictional metadata, not a standardized CALM classification. For the fictional bank only, a small demonstration rule set checks exact example.org control requirement references: encryption in transit on reachable connections, and encryption at rest and audit logging on classified stores. These illustrative identifiers are not FINOS controls. A missing reference means unknown, and a reference does not verify runtime enforcement. Other architectures show that no control rules have been configured. External parties, business flows, owners, and live state are not assessed. It supports up to 200 nodes.

The backend is stateless and accepts any caller; it does not verify Hub identity assertions. This demo runs it only on the isolated container network. Production use needs authentication, authorization and a security review. Hub sends the model to the extension service for each request.

Run the analysis checks with `python3 -m unittest discover -s tests -v`. The pinned Hub image supports the experimental `hubData` and diagram lens API used here. This is a local prototype; integration into another Hub version needs verification.
