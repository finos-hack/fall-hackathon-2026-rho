/*
 * The upgrade status of a service: its starter and deployment rules, and the newest versions that fit its pattern.
 */
import type { Entity } from '@backstage/catalog-model';
import { stringifyEntityRef } from '@backstage/catalog-model';
import {
  BundleMeta,
  CALM_ANNOTATIONS as ANN,
  UpgradeSide,
  serviceBundles,
  upgradeTargets,
  upgradeTemplatePath,
} from '@internal/backstage-plugin-calm-common';

export interface UpgradesResponse {
  /** The service lives in Git and Flux deploys it: only then can it be upgraded. */
  inGit: boolean;
  /** `starter` (code and deployment rules upgrade separately) or `full` (one bundle; no upgrade path). */
  kind: 'starter' | 'full' | 'none';
  starter?: UpgradeSide;
  deploy?: UpgradeSide;
  /** Scaffolder path of the upgrade Template with the service filled in, when there is something to upgrade. */
  upgradePath?: string;
  /** Why the service cannot be upgraded, when it cannot. */
  note?: string;
}

export function upgradesFor(
  entity: Entity,
  available: BundleMeta[],
): UpgradesResponse {
  const a = entity.metadata.annotations ?? {};
  const current = serviceBundles(a);
  const inGit = Boolean(a[ANN.gitops]);
  if (!current.starter || !current.pattern) {
    return {
      inGit,
      kind: 'none',
      note: 'Not made from a CALM pattern with a template bundle.',
    };
  }
  const t = upgradeTargets(current, available, current.pattern);
  if (!current.deploy) {
    return {
      inGit,
      kind: 'full',
      ...(t.starter ? { starter: t.starter } : {}),
      note: `Made with the full bundle ${current.starter.name} ${current.starter.version}, which has no separate deployment rules: create the service again with a starter to upgrade it.`,
    };
  }
  const canUpgrade = Boolean(t.starter?.to || t.deploy?.to);
  return {
    inGit,
    kind: 'starter',
    ...t,
    ...(inGit && canUpgrade
      ? { upgradePath: upgradeTemplatePath(stringifyEntityRef(entity)) }
      : {}),
    ...(!inGit
      ? { note: 'Not in Git, so it cannot be upgraded through a pull request.' }
      : {}),
  };
}
