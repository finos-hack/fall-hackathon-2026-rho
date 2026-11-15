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
| 7 | 4:12 | Upgrade code and deployment rules | The card offers Spring Boot 4.1.2 and `k8s-deploy` 1.2.1; **Upgrade** runs the `calm-upgrade` Template: re-render on a branch, build, pull request merged in Gitea, Flux applies the merge commit. The pull request and its files, the card up to date, and the app now on Spring Boot 4.1.2 under `k8s-deploy@1.2.1`. |
| 8 | 5:07 | Who uses what | The Template Explorer's **Used by**: which services run which deployment rules and starter versions. |

Recorded on 2026-11-14 against this branch: Backstage on 3200/7207 (a second checkout held 3100/7107), CALM Hub, the
bundle registry and Gitea from `hub/docker-compose.yml`, and the minikube profile `calm-backstage` rebuilt with
`yarn k8s:up`. The image caches were warmed first with throwaway services, so the builds in the video are the warm
ones; cold, a Spring Boot service took 135 s and a Red Hat Quarkus one several minutes (FINDINGS, part 3).

Record it again (pick a suffix not used yet; it names `orders-<suffix>`, `billing-<suffix>`, `events-<suffix>`):

```sh
node docs/demo/record-full-demo.cjs <suffix> <out-dir> http://localhost:3100
```

Older recordings, recorded by `record-demo.cjs`: [part 2](https://youtu.be/XhFmQQTT6-k) and
[part 1](https://youtu.be/zQ1cLPv3Fmk) on YouTube.
