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
  latestVersion,
} from '@internal/backstage-plugin-calm-common';
import {
  BundleInfo,
  CalmSnapshot,
  ControlDocument,
  HubDocument,
  buildEntities,
  referencedRequirements,
} from './entities';

/**
 * Reads the control requirements the documents reference from the configured Hub. A control the Hub does not hold
 * (deleted, or referenced by a URL on another host whose path the local Hub lacks) is skipped with a warning, so one
 * missing control does not stop the whole refresh; any other Hub failure still throws.
 */
export async function readControls(
  client: Pick<CalmHubClient, 'controlRequirement'>,
  requirements: {
    url: string;
    domain: string;
    control: string;
    version: string;
  }[],
  logger: Pick<LoggerService, 'warn'>,
): Promise<ControlDocument[]> {
  const controls: ControlDocument[] = [];
  for (const r of requirements) {
    try {
      const doc = await client.controlRequirement(
        r.domain,
        r.control,
        r.version,
      );
      controls.push({ ...r, doc });
    } catch (e) {
      if (e instanceof CalmHubError && e.status === 404) {
        logger.warn(
          `CALM catalog: control ${r.domain}/${r.control} ${r.version} skipped, not in CALM Hub (referenced as ${r.url})`,
        );
        continue;
      }
      throw e;
    }
  }
  return controls;
}

export interface CalmProviderSettings {
  hubUrl: string;
  namespaces: string[];
  bundles: { name: string; version: string; path: string }[];
}

/**
 * Emits CALM Hub architectures (Component), patterns, controls and template bundles (Resource), and one Template per
 * pattern. One full mutation per refresh; a failed Hub read keeps the entities of the last good refresh.
 */
export class CalmEntityProvider implements EntityProvider {
  private connection?: EntityProviderConnection;
  private readonly client: CalmHubClient;
  private readonly location: string;

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

  private async readBundles(): Promise<BundleInfo[]> {
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
