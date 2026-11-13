import { InfoCard, LinkButton } from '@backstage/core-components';
import { EntityRefLink, useEntity } from '@backstage/plugin-catalog-react';
import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import Box from '@material-ui/core/Box';
import Chip from '@material-ui/core/Chip';
import LinearProgress from '@material-ui/core/LinearProgress';
import Table from '@material-ui/core/Table';
import TableBody from '@material-ui/core/TableBody';
import TableCell from '@material-ui/core/TableCell';
import TableHead from '@material-ui/core/TableHead';
import TableRow from '@material-ui/core/TableRow';
import Typography from '@material-ui/core/Typography';
import Alert from '@material-ui/lab/Alert';
import { PatternResponse, useCalmBackend } from '../api';

/** The scaffolder page of a Template ref, e.g. `/create/templates/default/create-from-web-service`. */
function templatePath(templateRef: string): string {
  const { namespace, name } = parseEntityRef(templateRef);
  return `/create/templates/${encodeURIComponent(
    namespace,
  )}/${encodeURIComponent(name)}`;
}

/** A CALM pattern: its decisions and their choices, the template bundles that fit, and a link to its Template. */
export function CalmPatternCard() {
  const { entity } = useEntity();
  const entityRef = stringifyEntityRef(entity);
  const { value, loading, error } = useCalmBackend<PatternResponse>(
    `/pattern?entityRef=${encodeURIComponent(entityRef)}`,
  );

  return (
    <InfoCard
      title="CALM pattern"
      subheader={
        value
          ? `${value.pattern.namespace}/${value.pattern.id} ${value.pattern.version}`
          : undefined
      }
    >
      {loading && <LinearProgress aria-label="Loading the pattern" />}
      {error && <Alert severity="error">{error.message}</Alert>}
      {value && (
        <>
          <Typography variant="h6" component="h3">
            Decisions
          </Typography>
          {value.decisions.length ? (
            <Table size="small" aria-label="Pattern decisions">
              <TableHead>
                <TableRow>
                  <TableCell>Decision</TableCell>
                  <TableCell>Kind</TableCell>
                  <TableCell>Choices</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {value.decisions.map(d => (
                  <TableRow key={d.relationshipId}>
                    <TableCell>
                      <Typography variant="body2">
                        {d.prompt ?? d.relationshipId}
                      </Typography>
                      <Typography variant="caption" color="textSecondary">
                        {d.relationshipId}
                      </Typography>
                    </TableCell>
                    <TableCell style={{ whiteSpace: 'nowrap' }}>
                      {d.kind === 'oneOf' ? 'one of' : 'any of'}
                    </TableCell>
                    <TableCell>
                      <Box display="flex" flexWrap="wrap" style={{ gap: 8 }}>
                        {d.choices.map(c => (
                          <Chip
                            key={c.description}
                            size="small"
                            label={c.description}
                          />
                        ))}
                      </Box>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Typography variant="body2">
              This pattern has no decisions.
            </Typography>
          )}

          <Box mt={3}>
            <Typography variant="h6" component="h3">
              Template bundles that fit
            </Typography>
            {value.bundles.length ? (
              <ul style={{ marginTop: 4 }}>
                {value.bundles.map(b => (
                  <li key={b.entityRef}>
                    <EntityRefLink
                      entityRef={b.entityRef}
                      title={`${b.name} ${b.version}`}
                    />
                    {b.description ? ` - ${b.description}` : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <Typography variant="body2">
                No bundle in the catalog names this pattern; a new service gets
                its architecture only.
              </Typography>
            )}
          </Box>

          {value.templateRef && (
            <Box mt={2}>
              <LinkButton
                variant="contained"
                color="primary"
                to={templatePath(value.templateRef)}
              >
                Create from this pattern
              </LinkButton>
            </Box>
          )}
        </>
      )}
    </InfoCard>
  );
}
