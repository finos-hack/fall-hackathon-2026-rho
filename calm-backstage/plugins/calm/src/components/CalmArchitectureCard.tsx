import { useMemo } from 'react';
import { InfoCard, Link } from '@backstage/core-components';
import { EntityRefLink, useEntity } from '@backstage/plugin-catalog-react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import {
  CALM_ANNOTATIONS as ANN,
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

/**
 * The CALM architecture of an entity (a Hub architecture, or a service published from a pattern): pattern and version,
 * the controls it references, node and relationship counts, and a Mermaid diagram.
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
      subheader={
        value?.source.type === 'file'
          ? `From ${annotations[ANN.architectureFile] ?? 'architecture.json'}`
          : 'From CALM Hub'
      }
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
            {value.source.type === 'hub' && (
              <Box>
                <Typography variant="overline" display="block">
                  Source
                </Typography>
                <Link to={value.source.url}>CALM Hub (JSON)</Link>
              </Box>
            )}
          </Box>
          <MermaidDiagram
            source={diagram.source}
            title={`Architecture diagram of ${entity.metadata.name}`}
          />
        </>
      )}
    </InfoCard>
  );
}
