import { LinkButton } from '@backstage/core-components';
import { EntityRefLink } from '@backstage/plugin-catalog-react';
import { bundleEntityName } from '@internal/backstage-plugin-calm-common';
import Box from '@material-ui/core/Box';
import Chip from '@material-ui/core/Chip';
import Typography from '@material-ui/core/Typography';
import { UpgradesResponse, useCalmBackend } from '../api';

function Side(props: {
  label: string;
  side?: { name: string; from: string; to?: string };
}) {
  const s = props.side;
  if (!s) {
    return null;
  }
  return (
    <Typography variant="body2" component="div">
      {props.label}:{' '}
      <EntityRefLink
        entityRef={`resource:default/${bundleEntityName(s.name, s.from)}`}
        title={`${s.name} ${s.from}`}
      />{' '}
      {s.to ? (
        <Chip size="small" color="secondary" label={`${s.to} available`} />
      ) : (
        <Chip size="small" variant="outlined" label="up to date" />
      )}
    </Typography>
  );
}

/** The service's starter and deployment rules, whether newer versions fit its pattern, and an Upgrade button. */
export function VersionsSection(props: { entityRef: string }) {
  const { value } = useCalmBackend<UpgradesResponse>(
    `/upgrades?entityRef=${encodeURIComponent(props.entityRef)}`,
  );
  if (!value || value.kind === 'none') {
    return null;
  }
  return (
    <Box mb={2} data-testid="calm-versions">
      <Typography variant="overline" display="block">
        Template bundles
      </Typography>
      <Side label="Code (starter)" side={value.starter} />
      <Side label="Deployment rules" side={value.deploy} />
      {value.note && (
        <Typography variant="body2" color="textSecondary">
          {value.note}
        </Typography>
      )}
      {value.upgradePath && (
        <Box mt={1}>
          <LinkButton
            to={value.upgradePath}
            variant="contained"
            color="primary"
            size="small"
          >
            Upgrade
          </LinkButton>
        </Box>
      )}
    </Box>
  );
}
