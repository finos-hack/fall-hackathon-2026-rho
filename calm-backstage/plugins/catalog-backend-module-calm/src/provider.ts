import { promises as fs } from 'fs';
import { resolve } from 'path';
import type {
  LoggerService,
  SchedulerServiceTaskRunner,
} from '@backstage/backend-plugin-api';
import type {
  EntityProvider,
  EntityProviderConnection,
} from '@backstage/plugin-catalog-node';
import {
  CalmHubClient,
  CalmHubError,
  compareVersions,
  latestVersion,
} from '@internal/backstage-plugin-calm-common';
import {
  BundleInfo,
  CalmSnapshot,
  ControlDocument,
  HubDocument,
  RequirementRef,
  buildEntities,
  referencedRequirements,
} from './entities';
import {
  BundleRegistrySettings,
  mergeBundles,
  readRegistryBundles,
} from './bundles';

/**
 * Reads the control requirements the documents reference from the configured Hub, one per control: the highest
 * referenced version the Hub holds. A version the Hub lacks (deleted, or referenced by a URL on another host whose path
 * the local Hub lacks) falls back to the next referenced version; a control with no version in the Hub is skipped with a
 * warning, so one missing control does not stop the whole refresh. Any other Hub failure still throws.
 */
export async function readControls(
  client: Pick<CalmHubClient, 'controlRequirement'>,
  requirements: RequirementRef[],
  logger: Pick<LoggerService, 'warn'>,
): Promise<ControlDocument[]> {
  const byControl = new Map<string, RequirementRef[]>();
  for (const r of requirements) {
    const key = `${r.domain}/${r.control}`;
    const versions = byControl.get(key) ?? [];
    if (!versions.some(v => v.version === r.version)) {
      versions.push(r);
    }
    byControl.set(key, versions);
  }

  const controls: ControlDocument[] = [];
  for (const [key, versions] of byControl) {
    versions.sort((a, b) => compareVersions(b.version, a.version));
    const missing: RequirementRef[] = [];
    for (const r of versions) {
      try {
        const doc = await client.controlRequirement(
          r.domain,
          r.control,
          r.version,
        );
        controls.push({ ...r, doc });
        break;
      } catch (e) {
        if (e instanceof CalmHubError && e.status === 404) {
          missing.push(r);
          continue;
        }
        throw e;
      }
    }
    if (missing.length === versions.length) {
      logger.warn(
        `CALM catalog: control ${key} skipped, no referenced version is in CALM Hub (${missing
          .map(r => `${r.version} as ${r.url}`)
          .join(', ')})`,
      );
    } else if (missing.length) {
      logger.warn(
        `CALM catalog: control ${key} ${missing
          .map(r => r.version)
          .join(', ')} not in CALM Hub; using ${
          versions[missing.length].version
        }`,
      );
    }
  }
  return controls;
}

export interface CalmProviderSettings {
  hubUrl: string;
  namespaces: string[];
  /** Local bundle folders (authoring). */
  bundles: { name: string; version: string; path: string }[];
  /** The OCI registry the bundles are read from. */
  bundleRegistry?: BundleRegistrySettings;
}

/**
 * Emits CALM Hub architectures (Component), patterns, controls and template bundles (Resource), and one Template per
 * pattern. One full mutation per refresh; a failed Hub read keeps the entities of the last good refresh. Bundles come
 * from the OCI bundle registry and from local folders; a registry that is down gives a warning and no registry
 * bundles, not a failed refresh.
 */
export class CalmEntityProvider implements EntityProvider {
  private connection?: EntityProviderConnection;
  private readonly client: CalmHubClient;
  private readonly location: string;
  /** Local bundles already reported as replaced by a registry bundle, so each is logged once. */
  private readonly reportedReplaced = new Set<string>();

  constructor(
    private readonly settings: CalmProviderSettings,
    private readonly taskRunner: SchedulerServiceTaskRunner,
    private readonly logger: LoggerService,
  ) {
    this.client = new CalmHubClient(settings.hubUrl);
    this.location = `calm-hub:${this.client.baseUrl}`;
  }

  getProviderName(): string {
    return 'calm-hub';
  }

  async connect(connection: EntityProviderConnection): Promise<void> {
    this.connection = connection;
    await this.taskRunner.run({
      id: `${this.getProviderName()}:refresh`,
      fn: async () => {
        try {
          await this.refresh();
        } catch (e) {
          this.logger.warn(
            `CALM catalog refresh failed, keeping the last entities: ${e}`,
          );
        }
      },
    });
  }

  async refresh(): Promise<void> {
    if (!this.connection) {
      return;
    }
    const snapshot = await this.read();
    const { entities, warnings } = buildEntities(snapshot);
    warnings.forEach(w => this.logger.warn(`CALM catalog: ${w}`));
    await this.connection.applyMutation({
      type: 'full',
      entities: entities.map(entity => {
        entity.metadata.annotations = {
          ...entity.metadata.annotations,
          'backstage.io/managed-by-location': this.location,
          'backstage.io/managed-by-origin-location': this.location,
        };
        return { entity, locationKey: this.location };
      }),
    });
    this.logger.info(
      `CALM catalog: ${snapshot.patterns.length} patterns, ${snapshot.architectures.length} architectures, ` +
        `${snapshot.controls.length} controls, ${snapshot.bundles.length} bundles, ${entities.length} entities`,
    );
  }

  /**
   * Reads everything first; any Hub error throws (except a missing control, see `readControls`), so no partial full
   * mutation is applied.
   */
  private async read(): Promise<CalmSnapshot> {
    const patterns: HubDocument[] = [];
    const architectures: HubDocument[] = [];
    for (const namespace of this.settings.namespaces) {
      for (const item of await this.client.patterns(namespace)) {
        const version = latestVersion(
          await this.client.patternVersions(namespace, item.customId),
        );
        if (version) {
          const doc = await this.client.pattern(
            namespace,
            item.customId,
            version,
          );
          patterns.push({ namespace, id: item.customId, version, doc });
        }
      }
      for (const item of await this.client.architectures(namespace)) {
        const version = latestVersion(
          await this.client.architectureVersions(namespace, item.customId),
        );
        if (version) {
          const doc = await this.client.architecture(
            namespace,
            item.customId,
            version,
          );
          architectures.push({ namespace, id: item.customId, version, doc });
        }
      }
    }

    const controls = await readControls(
      this.client,
      referencedRequirements([
        ...patterns.map(p => p.doc),
        ...architectures.map(a => a.doc),
      ]),
      this.logger,
    );

    return {
      hubUrl: this.client.baseUrl,
      patterns,
      architectures,
      controls,
      bundles: await this.readBundles(),
    };
  }

  /** Local folders and registry bundles; a registry bundle wins over a local folder of the same name and version. */
  private async readBundles(): Promise<BundleInfo[]> {
    const local = await this.readLocalBundles();
    const registry = this.settings.bundleRegistry;
    if (!registry) {
      return local;
    }
    let fromRegistry: BundleInfo[] = [];
    try {
      const read = await readRegistryBundles(registry);
      read.warnings.forEach(w => this.logger.warn(`CALM catalog: ${w}`));
      fromRegistry = read.bundles;
    } catch (e) {
      this.logger.warn(
        `CALM catalog: bundle registry ${registry.url} not read, no registry bundles in this refresh: ${e}`,
      );
    }
    const { bundles, replaced } = mergeBundles(local, fromRegistry);
    const fresh = replaced.filter(k => !this.reportedReplaced.has(k));
    if (fresh.length) {
      fresh.forEach(k => this.reportedReplaced.add(k));
      this.logger.info(
        `CALM catalog: the registry bundle is used instead of the local folder in calm.bundles for ${fresh.join(
          ', ',
        )}`,
      );
    }
    return bundles;
  }

  private async readLocalBundles(): Promise<BundleInfo[]> {
    const out: BundleInfo[] = [];
    for (const b of this.settings.bundles) {
      const dir = resolve(b.path);
      try {
        const meta = JSON.parse(
          await fs.readFile(resolve(dir, 'calm-backstage.json'), 'utf-8'),
        );
        out.push({
          name: b.name,
          version: b.version,
          path: dir,
          description: meta.description,
          pattern: meta.pattern,
        });
      } catch (e) {
        this.logger.warn(
          `CALM catalog: bundle ${b.name}@${b.version} at ${dir} skipped: ${e}`,
        );
      }
    }
    return out;
  }
}
