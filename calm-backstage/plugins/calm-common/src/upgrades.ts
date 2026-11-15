/*
 * Which upgrades a service has: a newer version of its starter (the code side) or of its deployment rules (how it
 * runs), among the bundles that still fit its pattern.
 */
import { BundleMeta, newestFitting } from './bundleMeta';
import { compareVersions } from './hubClient';
import { CALM_ANNOTATIONS as ANN } from './annotations';

export interface BundleVersionRef {
  name: string;
  version: string;
}

export interface UpgradeSide {
  name: string;
  from: string;
  /** The newest version that fits the pattern, when it is newer than `from`. */
  to?: string;
}

export interface UpgradeTargets {
  starter?: UpgradeSide;
  deploy?: UpgradeSide;
}

/** The starter and deployment rules of a service, from its catalog annotations (no deployment rules for a full bundle). */
export function serviceBundles(annotations: Record<string, string> = {}): {
  starter?: BundleVersionRef;
  deploy?: BundleVersionRef;
  pattern?: { namespace?: string; patternId: string };
} {
  const starter =
    annotations[ANN.bundle] && annotations[ANN.bundleVersion]
      ? {
          name: annotations[ANN.bundle],
          version: annotations[ANN.bundleVersion],
        }
      : undefined;
  const deploy =
    annotations[ANN.deployBundle] && annotations[ANN.deployBundleVersion]
      ? {
          name: annotations[ANN.deployBundle],
          version: annotations[ANN.deployBundleVersion],
        }
      : undefined;
  const pattern = annotations[ANN.pattern]
    ? {
        namespace: annotations[ANN.namespace],
        patternId: annotations[ANN.pattern],
      }
    : undefined;
  return { starter, deploy, pattern };
}

function side(
  current: BundleVersionRef | undefined,
  available: BundleMeta[],
  pattern: { namespace?: string; patternId: string },
): UpgradeSide | undefined {
  if (!current) {
    return undefined;
  }
  const newest = newestFitting(
    available,
    current.name,
    pattern.namespace,
    pattern.patternId,
  );
  return {
    name: current.name,
    from: current.version,
    ...(newest && compareVersions(newest.version, current.version) > 0
      ? { to: newest.version }
      : {}),
  };
}

/** For each side the service has, its current version and the newest fitting version when that is newer. */
export function upgradeTargets(
  current: { starter?: BundleVersionRef; deploy?: BundleVersionRef },
  available: BundleMeta[],
  pattern: { namespace?: string; patternId: string },
): UpgradeTargets {
  const starter = side(current.starter, available, pattern);
  const deploy = side(current.deploy, available, pattern);
  return { ...(starter ? { starter } : {}), ...(deploy ? { deploy } : {}) };
}

/** The scaffolder path of the upgrade Template with the service filled in. */
export function upgradeTemplatePath(entityRef: string): string {
  return `/create/templates/default/calm-upgrade?formData=${encodeURIComponent(
    JSON.stringify({ service: entityRef }),
  )}`;
}
