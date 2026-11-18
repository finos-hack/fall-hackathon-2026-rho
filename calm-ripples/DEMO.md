# CALM Ripples: demo guide

## One-sentence pitch

CALM Ripples is a CALM Hub lens that traces modeled connections from a selected component and highlights security control declarations to investigate.

## Before presenting

Start the local demo with `./scripts/start.sh` as described in the README. Open the fictional **Digital Bank — CALM Ripples** architecture and choose the **Ripples** lens. Set the starting system to **Rewards Service** and choose **Ripple** with **2 hops**. Collapse Hub's Explore sidebar or timeline if they take too much space. Prepare a screenshot or recording as a fallback if the live demo cannot connect.

## Walkthrough

1. **The problem:** “When an incident affects one component, it can be difficult to trace which other systems may be within reach.”
2. **The model:** “This fictional bank has 42 modeled components and 51 connections. CALM Hub holds the architecture; Ripples is an extension lens.”
3. **The impact:** Select Rewards Service. The summary shows 12 reachable components in the model. The diagram starts with the first two hops; use **Hops shown** to expand the diagram without changing the total.
4. **Explore:** Click Event Bus. Its ripple and findings recalculate. Gold nodes are immediate upstream context; click one to move back. The starting-system menu jumps to any node, and **Full architecture** shows the whole graph.
5. **Investigate controls:** Scroll to **Controls to investigate**. The fictional demo identifies missing references for illustrative transport-encryption, storage-encryption, and audit-logging controls. It explains why a team may want to investigate them.
6. **Compare:** Select FX Rates Service: the fictional model shows one reachable component, with no gaps found by the limited demo rules.

## What the result means

These are modeled `connects` paths, not evidence of access, incident spread, or real-world control effectiveness. Counts and control findings cover the full reachable graph even when the diagram is limited to a few hops. Upstream neighbors are navigation context, not downstream impact. Data classifications and the control identifiers in this example are fictional. A missing reference is unknown, not proof of an absent control. The local demo is unauthenticated and only for fictional data.

The prototype has been tested with one pinned CALM Hub image, the fictional bank, and three repository architecture examples. It does not traverse other CALM relationship types, assess arbitrary real-world control catalogs, or support more than 200 nodes. It is not a live security scanner.
