import { useMemo } from 'react';
import { InfoCard, Link } from '@backstage/core-components';
import { EntityRefLink, useEntity } from '@backstage/plugin-catalog-react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import {
  CALM_ANNOTATIONS as ANN,
  RecordedDeployment,
  controlEntityName,
  parsePatternUrl,
  parseRequirementUrl,
  patternEntityName,
  requirementUrls,
  toMermaid,
} from '@internal/backstage-plugin-calm-common';
import Box from '@material-ui/core/Box';
import Chip from '@material-ui/core/Chip';
import LinearProgress from '@material-ui/core/LinearProgress';
import Typography from '@material-ui/core/Typography';
import Alert from '@material-ui/lab/Alert';
import { ArchitectureResponse, useCalmBackend } from '../api';
import { MermaidDiagram } from './MermaidDiagram';
import { VersionsSection } from './VersionsSection';
import { OpenAppButton } from './OpenAppButton';

/** The controls a CALM document references, as control Resource refs (one per domain and control). */
function controlsOf(architecture: unknown) {
  const byRef = new Map<string, { ref: string; control: string }>();
  for (const url of requirementUrls(architecture)) {
    const r = parseRequirementUrl(url);
    if (r) {
      const ref = `resource:default/${controlEntityName(r.domain, r.control)}`;
      byRef.set(ref, { ref, control: r.control });
    }
  }
  return [...byRef.values()];
}

type Deployment = NonNullable<ArchitectureResponse['deployment']>;

/** The network policies rendered from `connects` relationships, one entry per relationship, and the rest. */
function policiesByRelationship(deployment: Deployment, architecture: any) {
  const relationships: any[] = Array.isArray(architecture?.relationships)
    ? architecture.relationships
    : [];
  const byRelationship = new Map<
    string,
    { relationship: string; protocol?: string; policies: string[] }
  >();
  const other: string[] = [];
  for (const p of deployment.networkPolicies) {
    if (!p.relationship) {
      other.push(p.name);
      continue;
    }
    const entry = byRelationship.get(p.relationship) ?? {
      relationship: p.relationship,
      protocol: p.protocol,
      policies: [],
    };
    entry.policies.push(p.name);
    byRelationship.set(p.relationship, entry);
  }
  return {
    fromArchitecture: deployment.networkPolicies.length - other.length,
    other,
    relationships: [...byRelationship.values()].map(r => ({
      ...r,
      // The controls the architecture puts on this relationship (e.g. permitted-connection).
      controls: controlsOf(
        relationships.find(x => x?.['unique-id'] === r.relationship)?.controls,
      ),
    })),
  };
}

/** Where a published service runs, and the network policies its architecture's relationships became. */
function DeploymentSection(props: {
  deployment: Deployment;
  architecture: unknown;
}) {
  const { deployment } = props;
  const policies = policiesByRelationship(deployment, props.architecture);
  const ready = deployment.workloads.filter(w => w.ready).length;
  return (
    <Box mb={2} data-testid="calm-deployment">
      <Typography variant="overline" display="block">
        Deployment
      </Typography>
      <Typography variant="body2">
        Deployed to{' '}
        <strong>
          {deployment.cluster} / {deployment.namespace}
        </strong>
        : {ready} of {deployment.workloads.length} workloads ready (
        {deployment.workloads
          .map(w => `${w.name}${w.ready ? '' : ' (not ready)'}`)
          .join(', ')}
        ).
      </Typography>
      <Typography variant="body2">
        Network policies from the architecture: {policies.fromArchitecture} (
        {policies.relationships.length} relationships).
      </Typography>
      <Box component="ul" mt={0.5} mb={0.5} pl={3}>
        {policies.relationships.map(r => (
          <Typography key={r.relationship} component="li" variant="body2">
            <code>{r.relationship}</code>
            {r.protocol ? ` (${r.protocol})` : ''}: {r.policies.join(', ')}
            {r.controls.length ? ' · control ' : ' · no control on it'}
            {r.controls.map((c, i) => (
              <span key={c.ref}>
                {i > 0 && ', '}
                <EntityRefLink entityRef={c.ref} title={c.control} />
              </span>
            ))}
          </Typography>
        ))}
      </Box>
      {policies.other.length > 0 && (
        <Typography variant="body2" color="textSecondary">
          Also in the namespace: {policies.other.join(', ')}.
        </Typography>
      )}
    </Box>
  );
}

/** Where the service's code and manifests live, and what Flux last applied from there. */
function GitopsSection(props: {
  gitops: NonNullable<ArchitectureResponse['gitops']>;
}) {
  const g = props.gitops;
  return (
    <Box mb={2} data-testid="calm-gitops">
      <Typography variant="overline" display="block">
        Git and Flux
      </Typography>
      <Typography variant="body2">
        {g.repoUrl ? (
          <Link to={g.repoUrl}>Git repository</Link>
        ) : (
          'Git repository'
        )}{' '}
        deployed by the Flux Kustomization <code>{g.kustomization}</code>:{' '}
        <Chip
          size="small"
          label={g.ready ? 'Ready' : 'Not ready'}
          color={g.ready ? 'primary' : 'default'}
        />
      </Typography>
      <Typography variant="body2">
        {g.commit ? (
          <>
            Applied commit{' '}
            {g.commitUrl ? (
              <Link to={g.commitUrl}>
                <code>{g.commit.slice(0, 12)}</code>
              </Link>
            ) : (
              <code>{g.commit.slice(0, 12)}</code>
            )}
            {g.ready ? '' : `. ${g.message}`}
          </>
        ) : (
          g.message
        )}
      </Typography>
    </Box>
  );
}

/** How many of the deployments recorded in the Hub the card lists. */
const SHOWN_DEPLOYMENTS = 5;

const dateTime = (iso?: string) =>
  iso && !Number.isNaN(Date.parse(iso))
    ? new Date(iso).toLocaleString()
    : undefined;

/** `32 s`, or `2 min 5 s`, between two ISO times. */
function duration(start?: string, end?: string): string | undefined {
  const ms = start && end ? Date.parse(end) - Date.parse(start) : NaN;
  if (Number.isNaN(ms) || ms < 0) {
    return undefined;
  }
  const seconds = Math.round(ms / 1000);
  return seconds < 60
    ? `${seconds} s`
    : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** The deployments CALM Hub holds for this architecture version (deployment decorators), newest first. */
function RecordedDeploymentsSection(props: {
  deployments: RecordedDeployment[];
}) {
  const shown = props.deployments.slice(0, SHOWN_DEPLOYMENTS);
  return (
    <Box mb={2} data-testid="calm-recorded-deployments">
      <Typography variant="overline" display="block">
        Deployments recorded in CALM Hub
      </Typography>
      <Box component="ul" mt={0.5} mb={0.5} pl={3}>
        {shown.map(d => {
          const took = duration(d.startTime, d.endTime);
          return (
            <Typography key={d.id} component="li" variant="body2">
              <strong>{d.status}</strong>
              {dateTime(d.startTime) ? `, ${dateTime(d.startTime)}` : ''}
              {took ? ` (${took})` : ''}
              {d.appliesTo.length ? `: ${d.appliesTo.join(', ')}` : ''}
              {d.notes ? ` · ${d.notes}` : ''}
              {d.details && (
                <>
                  {' · '}
                  <Link to={d.details}>details</Link>
                </>
              )}
              {` · decorator ${d.id}`}
            </Typography>
          );
        })}
      </Box>
      {props.deployments.length > shown.length && (
        <Typography variant="body2" color="textSecondary">
          The {shown.length} newest of {props.deployments.length}.
        </Typography>
      )}
    </Box>
  );
}

/**
 * The CALM architecture of an entity (a Hub architecture, or a service published from a pattern), read from CALM Hub: pattern and version,
 * the controls it references, node and relationship counts, a Mermaid diagram and, for a service deployed to the
 * local cluster, where it runs, its network policies and the deployments recorded in CALM Hub.
 */
export function CalmArchitectureCard() {
  const { entity } = useEntity();
  const entityRef = stringifyEntityRef(entity);
  const { value, loading, error } = useCalmBackend<ArchitectureResponse>(
    `/architecture?entityRef=${encodeURIComponent(entityRef)}`,
  );

  const annotations = entity.metadata.annotations ?? {};
  const fromSchema = parsePatternUrl(value?.architecture?.$schema);
  const patternId = annotations[ANN.pattern] ?? fromSchema?.id;
  const patternVersion = annotations[ANN.patternVersion] ?? fromSchema?.version;

  const diagram = useMemo(
    () => (value ? toMermaid(value.architecture) : undefined),
    [value],
  );
  const controls = useMemo(
    () => (value ? controlsOf(value.architecture) : []),
    [value],
  );
  const relationshipCount = Array.isArray(value?.architecture?.relationships)
    ? value!.architecture.relationships.length
    : 0;

  return (
    <InfoCard
      title="CALM architecture"
      subheader={`From CALM Hub${
        value?.source.version ? `, version ${value.source.version}` : ''
      }`}
    >
      {loading && <LinearProgress aria-label="Loading the architecture" />}
      {error && <Alert severity="error">{error.message}</Alert>}
      {value && diagram && (
        <>
          <Box display="flex" flexWrap="wrap" style={{ gap: 24 }} mb={2}>
            <Box>
              <Typography variant="overline" display="block">
                Pattern
              </Typography>
              {patternId ? (
                <EntityRefLink
                  entityRef={`resource:default/${patternEntityName(patternId)}`}
                  title={`${patternId}${
                    patternVersion ? ` ${patternVersion}` : ''
                  }`}
                />
              ) : (
                <Typography variant="body2">none</Typography>
              )}
            </Box>
            <Box>
              <Typography variant="overline" display="block">
                Size
              </Typography>
              <Typography variant="body2">
                {diagram.nodeCount} nodes, {relationshipCount} relationships
              </Typography>
            </Box>
            <Box>
              <Typography variant="overline" display="block">
                Controls
              </Typography>
              {controls.length ? (
                <Box display="flex" flexWrap="wrap" style={{ gap: 8 }}>
                  {controls.map(c => (
                    <Chip
                      key={c.ref}
                      size="small"
                      variant="outlined"
                      label={
                        <EntityRefLink entityRef={c.ref} title={c.control} />
                      }
                    />
                  ))}
                </Box>
              ) : (
                <Typography variant="body2">none</Typography>
              )}
            </Box>
            <Box>
              <Typography variant="overline" display="block">
                Source
              </Typography>
              <Link to={value.source.url}>CALM Hub (JSON)</Link>
            </Box>
          </Box>
          {value.deployment && (
            <Box mb={2}>
              <OpenAppButton name={entity.metadata.name} />
            </Box>
          )}
          {annotations[ANN.bundle] && <VersionsSection entityRef={entityRef} />}
          {value.gitops && <GitopsSection gitops={value.gitops} />}
          {value.deployment && (
            <DeploymentSection
              deployment={value.deployment}
              architecture={value.architecture}
            />
          )}
          {value.deployments && value.deployments.length > 0 && (
            <RecordedDeploymentsSection deployments={value.deployments} />
          )}
          <MermaidDiagram
            source={diagram.source}
            title={`Architecture diagram of ${entity.metadata.name}`}
          />
        </>
      )}
    </InfoCard>
  );
}
