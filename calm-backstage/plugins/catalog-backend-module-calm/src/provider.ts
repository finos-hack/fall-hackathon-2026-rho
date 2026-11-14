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
import type { BundleRegistrySettings } from '@internal/backstage-plugin-calm-node';
import { lastGoodRegistryReader, mergeBundles } from './bundles';

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
  /** `calm.gitops` is configured: the Templates push services to Git and deploy them with Flux. */
  gitops?: boolean;
  /** The OCI registry the bundles are read from. */
  bundleRegistry?: BundleRegistrySettings;
}

/**
 * Emits CALM Hub architectures (Component; not those stored for a published service), patterns, controls and template bundles (Resource), and one Template per
 * pattern. One full mutation per refresh; a failed Hub read keeps the entities of the last good refresh. Bundles come
 * from the OCI bundle registry and from local folders; a registry that is down gives a warning and the registry
 * bundles of the last good read, not a failed refresh.
 */
export class CalmEntityProvider implements EntityProvider {
  private connection?: EntityProviderConnection;
  private readonly client: CalmHubClient;
  private readonly location: string;
  /** Registry bundles already reported as replaced by a local folder, so each is logged once. */
  private readonly reportedReplaced = new Set<string>();
  private readonly readRegistry?: ReturnType<typeof lastGoodRegistryReader>;

  constructor(
    private readonly settings: CalmProviderSettings,
    private readonly taskRunner: SchedulerServiceTaskRunner,
    private readonly logger: LoggerService,
  ) {
    this.client = new CalmHubClient(settings.hubUrl);
    this.location = `calm-hub:${this.client.baseUrl}`;
    this.readRegistry =
      settings.bundleRegistry &&
      lastGoodRegistryReader(settings.bundleRegistry);
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
    const { entities, warnings, serviceArchitectures } =
      buildEntities(snapshot);
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
    const left = serviceArchitectures.length
      ? `; ${serviceArchitectures.length} architectures belong to published services and get no entity of their own`
      : '';
    this.logger.info(
      `CALM catalog: ${snapshot.patterns.length} patterns, ${snapshot.architectures.length} architectures, ${snapshot.controls.length} controls, ${snapshot.bundles.length} bundles, ${entities.length} entities${left}`,
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
      gitops: this.settings.gitops,
    };
  }

  /** Local folders and registry bundles; a local folder wins over a registry bundle of the same name and version. */
  private async readBundles(): Promise<BundleInfo[]> {
    const local = await this.readLocalBundles();
    if (!this.readRegistry) {
      return local;
    }
    // Like an unreachable Hub, a registry that cannot be read leaves the bundles of the last good read in place, so
    // the bundle Resources and the Templates' publish steps do not disappear while it restarts.
    const read = await this.readRegistry();
    read.warnings.forEach(w => this.logger.warn(`CALM catalog: ${w}`));
    if (read.failed) {
      this.logger.warn(
        `CALM catalog: bundle registry ${this.settings.bundleRegistry?.url} not read; keeping the ${read.bundles.length} registry bundles from the last read that worked: ${read.failed}`,
      );
    }
    const fromRegistry = read.bundles;
    const { bundles, replaced } = mergeBundles(local, fromRegistry);
    const fresh = replaced.filter(k => !this.reportedReplaced.has(k));
    if (fresh.length) {
      fresh.forEach(k => this.reportedReplaced.add(k));
      this.logger.info(
        `CALM catalog: the local folder in calm.bundles is used instead of the registry bundle for ${fresh.join(
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
          deploy: typeof meta.deploy === 'string' ? meta.deploy : undefined,
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
