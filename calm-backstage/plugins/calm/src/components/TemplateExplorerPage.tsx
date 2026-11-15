import { useEffect, useMemo, useState } from 'react';
import {
  Content,
  Header,
  Link,
  LinkButton,
  Page,
} from '@backstage/core-components';
import { useApi } from '@backstage/frontend-plugin-api';
import { catalogApiRef, EntityRefLink } from '@backstage/plugin-catalog-react';
import { Entity, stringifyEntityRef } from '@backstage/catalog-model';
import {
  CALM_ANNOTATIONS as ANN,
  compareVersions,
  patternEntityName,
  upgradeTemplatePath,
} from '@internal/backstage-plugin-calm-common';
import Box from '@material-ui/core/Box';
import Chip from '@material-ui/core/Chip';
import LinearProgress from '@material-ui/core/LinearProgress';
import List from '@material-ui/core/List';
import ListItem from '@material-ui/core/ListItem';
import ListItemText from '@material-ui/core/ListItemText';
import ListSubheader from '@material-ui/core/ListSubheader';
import MenuItem from '@material-ui/core/MenuItem';
import Paper from '@material-ui/core/Paper';
import Select from '@material-ui/core/Select';
import Tab from '@material-ui/core/Tab';
import Table from '@material-ui/core/Table';
import TableBody from '@material-ui/core/TableBody';
import TableCell from '@material-ui/core/TableCell';
import TableHead from '@material-ui/core/TableHead';
import TableRow from '@material-ui/core/TableRow';
import Tabs from '@material-ui/core/Tabs';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import Alert from '@material-ui/lab/Alert';
import {
  BundleDiffResponse,
  BundlesResponse,
  ExplorerBundleVersion,
  useCalmBackend,
} from '../api';

type Bundle = BundlesResponse['bundles'][number];

const KIND_TITLES: Record<Bundle['kind'], string> = {
  starter: 'Starters: the code a service begins with',
  deployment: 'Deployment rules: how any service runs',
  full: 'Full bundles: code and deployment in one',
};

const useStyles = makeStyles(theme => ({
  layout: {
    display: 'grid',
    gridTemplateColumns: 'minmax(240px, 300px) minmax(0, 1fr)',
    gap: theme.spacing(3),
    [theme.breakpoints.down('sm')]: { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  code: {
    margin: 0,
    padding: theme.spacing(2),
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12.5,
    lineHeight: 1.5,
    overflow: 'auto',
    maxHeight: 520,
    background: theme.palette.type === 'dark' ? '#14181f' : '#f6f8fa',
    borderRadius: 6,
  },
  add: {
    color: theme.palette.type === 'dark' ? '#7ddca1' : '#11663a',
    display: 'block',
  },
  del: {
    color: theme.palette.type === 'dark' ? '#ff9a94' : '#a3201c',
    display: 'block',
  },
  hunk: { color: theme.palette.text.secondary, display: 'block' },
  files: {
    display: 'grid',
    gridTemplateColumns: 'minmax(200px, 280px) minmax(0, 1fr)',
    gap: theme.spacing(2),
    [theme.breakpoints.down('sm')]: { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  meta: {
    '& td': {
      borderBottom: 'none',
      padding: '4px 12px 4px 0',
      verticalAlign: 'top',
    },
  },
  mono: {
    fontFamily: 'ui-monospace, Menlo, monospace',
    fontSize: 12.5,
    overflowWrap: 'anywhere',
  },
}));

const shortSha = (s?: string) =>
  s ? s.replace(/^sha256:/, '').slice(0, 12) : '';
const kb = (n?: number) =>
  n === undefined ? '-' : `${(n / 1024).toFixed(1)} KiB`;

function FileViewer(props: { name: string; version: string; file?: string }) {
  const classes = useStyles();
  const { value, loading, error } = useCalmBackend<string>(
    props.file
      ? `/bundles/${encodeURIComponent(props.name)}/${encodeURIComponent(
          props.version,
        )}/file?path=${encodeURIComponent(props.file)}`
      : undefined,
    { text: true },
  );
  if (!props.file) {
    return <Typography color="textSecondary">Choose a file.</Typography>;
  }
  return (
    <Box minWidth={0}>
      <Typography variant="subtitle2" className={classes.mono} gutterBottom>
        {props.file}
      </Typography>
      {loading && <LinearProgress />}
      {error && <Alert severity="error">{error.message}</Alert>}
      {value !== undefined && (
        <pre className={classes.code} data-testid="calm-explorer-file">
          {value}
        </pre>
      )}
    </Box>
  );
}

function FilesTab(props: { name: string; version: string }) {
  const classes = useStyles();
  const { value, loading, error } = useCalmBackend<{
    files: { path: string; size: number }[];
  }>(
    `/bundles/${encodeURIComponent(props.name)}/${encodeURIComponent(
      props.version,
    )}/files`,
  );
  const [file, setFile] = useState<string>();
  useEffect(() => {
    const files = value?.files ?? [];
    const first =
      files.find(f => f.path === 'calm-backstage.json') ??
      files.find(f => f.path.endsWith('.hbs'));
    setFile(first?.path);
  }, [value]);
  if (loading) {
    return <LinearProgress />;
  }
  if (error) {
    return <Alert severity="error">{error.message}</Alert>;
  }
  return (
    <Box className={classes.files}>
      <List dense data-testid="calm-explorer-files">
        {(value?.files ?? []).map(f => (
          <ListItem
            key={f.path}
            button
            selected={f.path === file}
            onClick={() => setFile(f.path)}
          >
            <ListItemText
              primary={<span className={classes.mono}>{f.path}</span>}
              secondary={`${f.size} bytes`}
            />
          </ListItem>
        ))}
      </List>
      <FileViewer name={props.name} version={props.version} file={file} />
    </Box>
  );
}

/** The class of a unified-diff line: added, removed, hunk header, or none. */
function lineClass(
  l: string,
  classes: ReturnType<typeof useStyles>,
): string | undefined {
  if (l.startsWith('+') && !l.startsWith('+++')) {
    return classes.add;
  }
  if (l.startsWith('-') && !l.startsWith('---')) {
    return classes.del;
  }
  return l.startsWith('@@') ? classes.hunk : undefined;
}

const STATUS_COLOR: Record<string, 'primary' | 'secondary' | 'default'> = {
  added: 'primary',
  removed: 'secondary',
};

function Patch(props: { patch: string }) {
  const classes = useStyles();
  const lines = props.patch.split('\n').slice(2); // drop the ===/--- header the file name already says
  return (
    <pre className={classes.code}>
      {lines.map((l, i) => (
        <span
          key={i}
          className={lineClass(l, classes)}
          style={
            l.startsWith('+') || l.startsWith('-') || l.startsWith('@@')
              ? undefined
              : { display: 'block' }
          }
        >
          {l || ' '}
        </span>
      ))}
    </pre>
  );
}

function ChangesTab(props: { bundle: Bundle; version: string }) {
  const classes = useStyles();
  const versions = props.bundle.versions.map(v => v.version);
  const older = versions.filter(v => compareVersions(v, props.version) < 0);
  const [from, setFrom] = useState<string | undefined>(older[0]);
  useEffect(() => setFrom(older[0]), [props.version, props.bundle.name]); // eslint-disable-line react-hooks/exhaustive-deps
  const { value, loading, error } = useCalmBackend<BundleDiffResponse>(
    from
      ? `/bundles/${encodeURIComponent(
          props.bundle.name,
        )}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(
          props.version,
        )}`
      : undefined,
  );
  if (!older.length) {
    return (
      <Typography color="textSecondary">
        {props.version} is the first version of {props.bundle.name}.
      </Typography>
    );
  }
  return (
    <Box data-testid="calm-explorer-diff">
      <Box display="flex" alignItems="center" style={{ gap: 8 }} mb={2}>
        <Typography>What changed from</Typography>
        <Select
          value={from ?? ''}
          onChange={e => setFrom(String(e.target.value))}
        >
          {older.map(v => (
            <MenuItem key={v} value={v}>
              {v}
            </MenuItem>
          ))}
        </Select>
        <Typography>to {props.version}</Typography>
      </Box>
      {loading && <LinearProgress />}
      {error && <Alert severity="error">{error.message}</Alert>}
      {value && value.files.length === 0 && (
        <Typography>No file changed.</Typography>
      )}
      {value?.files.map(f => (
        <Box key={f.path} mb={2}>
          <Typography variant="subtitle2" className={classes.mono}>
            {f.path}{' '}
            <Chip
              size="small"
              label={f.status}
              color={STATUS_COLOR[f.status] ?? 'default'}
            />
          </Typography>
          <Patch patch={f.patch} />
        </Box>
      ))}
    </Box>
  );
}

function useServices(): Entity[] | undefined {
  const catalog = useApi(catalogApiRef);
  const [services, setServices] = useState<Entity[]>();
  useEffect(() => {
    let cancelled = false;
    catalog
      .getEntities({
        filter: { kind: 'Component', 'metadata.tags': 'calm-service' },
      })
      .then(r => !cancelled && setServices(r.items))
      .catch(() => !cancelled && setServices([]));
    return () => {
      cancelled = true;
    };
  }, [catalog]);
  return services;
}

/** Which version of `bundle` a service uses, as its starter (or full bundle) or as its deployment rules. */
function usedVersion(e: Entity, bundle: Bundle): string | undefined {
  const a = e.metadata.annotations ?? {};
  if (bundle.kind === 'deployment') {
    return a[ANN.deployBundle] === bundle.name
      ? a[ANN.deployBundleVersion]
      : undefined;
  }
  return a[ANN.bundle] === bundle.name ? a[ANN.bundleVersion] : undefined;
}

function UsedByTab(props: { bundle: Bundle; services?: Entity[] }) {
  if (!props.services) {
    return <LinearProgress />;
  }
  const latest = props.bundle.versions[0]?.version;
  const users = props.services
    .map(e => ({ e, version: usedVersion(e, props.bundle) }))
    .filter((u): u is { e: Entity; version: string } => Boolean(u.version))
    .sort((a, b) => compareVersions(a.version, b.version));
  if (!users.length) {
    return (
      <Typography color="textSecondary">
        No service uses {props.bundle.name} yet.
      </Typography>
    );
  }
  return (
    <Table size="small" data-testid="calm-explorer-used-by">
      <TableHead>
        <TableRow>
          <TableCell>Service</TableCell>
          <TableCell>Version</TableCell>
          <TableCell>Status</TableCell>
          <TableCell />
        </TableRow>
      </TableHead>
      <TableBody>
        {users.map(({ e, version }) => {
          const behind = latest && compareVersions(version, latest) < 0;
          const ref = stringifyEntityRef(e);
          const inGit = Boolean(e.metadata.annotations?.[ANN.gitops]);
          const full = props.bundle.kind === 'full';
          return (
            <TableRow key={ref}>
              <TableCell>
                <EntityRefLink entityRef={ref} />
              </TableCell>
              <TableCell>{version}</TableCell>
              <TableCell>
                {behind ? (
                  <Chip
                    size="small"
                    color="secondary"
                    label={`${latest} available`}
                  />
                ) : (
                  <Chip size="small" variant="outlined" label="up to date" />
                )}
              </TableCell>
              <TableCell>
                {behind && inGit && !full ? (
                  <LinkButton
                    to={upgradeTemplatePath(ref)}
                    size="small"
                    variant="outlined"
                    color="primary"
                  >
                    Upgrade
                  </LinkButton>
                ) : null}
                {behind && !(inGit && !full) && (
                  <Typography variant="caption" color="textSecondary">
                    {full
                      ? 'full bundle: create again with a starter'
                      : 'not in Git'}
                  </Typography>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function BundleDetail(props: { bundle: Bundle; services?: Entity[] }) {
  const classes = useStyles();
  const { bundle } = props;
  const [version, setVersion] = useState(bundle.versions[0].version);
  const [tab, setTab] = useState(0);
  useEffect(() => setVersion(bundle.versions[0].version), [bundle.name]); // eslint-disable-line react-hooks/exhaustive-deps
  const v: ExplorerBundleVersion =
    bundle.versions.find(x => x.version === version) ?? bundle.versions[0];
  return (
    <Paper variant="outlined" style={{ padding: 20, minWidth: 0 }}>
      <Box
        display="flex"
        alignItems="center"
        flexWrap="wrap"
        style={{ gap: 12 }}
        mb={1}
      >
        <Typography variant="h5">{bundle.name}</Typography>
        <Chip
          size="small"
          label={
            bundle.kind === 'deployment' ? 'deployment rules' : bundle.kind
          }
        />
        <Box
          display="flex"
          style={{ gap: 6 }}
          data-testid="calm-explorer-versions"
        >
          {bundle.versions.map(x => (
            <Chip
              key={x.version}
              size="small"
              clickable
              color={x.version === version ? 'primary' : 'default'}
              variant={x.version === version ? 'default' : 'outlined'}
              label={x.version}
              onClick={() => setVersion(x.version)}
            />
          ))}
        </Box>
      </Box>
      {v.description && (
        <Typography variant="body2" color="textSecondary" paragraph>
          {v.description}
        </Typography>
      )}
      <Table size="small" className={classes.meta}>
        <TableBody>
          {v.runtime && (
            <TableRow>
              <TableCell>Runs on</TableCell>
              <TableCell>{v.runtime}</TableCell>
            </TableRow>
          )}
          <TableRow>
            <TableCell>OCI artifact</TableCell>
            <TableCell className={classes.mono}>
              {v.ref} · sha256:{shortSha(v.digest)} · {kb(v.size)}
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell>Source in Git</TableCell>
            <TableCell>
              {v.source ? (
                <Link to={v.source}>
                  calm-templates/bundles at{' '}
                  {v.revision?.slice(0, 12) ?? 'its commit'}
                </Link>
              ) : (
                <Typography variant="body2" color="textSecondary">
                  Not recorded: published before bundles were published from
                  Git.
                </Typography>
              )}
            </TableCell>
          </TableRow>
          {v.created && (
            <TableRow>
              <TableCell>Published</TableCell>
              <TableCell>{new Date(v.created).toLocaleString()}</TableCell>
            </TableRow>
          )}
          <TableRow>
            <TableCell>Fits</TableCell>
            <TableCell>
              {v.patterns.map(p => (
                <Box component="span" mr={1} key={p.patternId}>
                  <EntityRefLink
                    entityRef={`resource:default/${patternEntityName(
                      p.patternId,
                    )}`}
                    title={`${p.namespace ? `${p.namespace}/` : ''}${
                      p.patternId
                    }`}
                  />
                </Box>
              ))}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <Tabs
        value={tab}
        onChange={(_e, t) => setTab(t)}
        indicatorColor="primary"
        style={{ marginTop: 12 }}
      >
        <Tab label="Files" />
        <Tab label="Changes" />
        <Tab label="Used by" />
      </Tabs>
      <Box pt={2}>
        {tab === 0 && <FilesTab name={bundle.name} version={v.version} />}
        {tab === 1 && <ChangesTab bundle={bundle} version={v.version} />}
        {tab === 2 && <UsedByTab bundle={bundle} services={props.services} />}
      </Box>
    </Paper>
  );
}

/**
 * The Template Explorer: every template bundle in the OCI registry (starters, deployment rules, full bundles), what is
 * inside each version, where its source is in Git, what changed between versions, and which services use it.
 */
export function TemplateExplorerPage() {
  const classes = useStyles();
  const { value, loading, error } = useCalmBackend<BundlesResponse>('/bundles');
  const services = useServices();
  const [selected, setSelected] = useState<string>();
  const bundles = useMemo(() => value?.bundles ?? [], [value]);
  useEffect(() => {
    if (!selected && bundles.length) {
      setSelected(bundles[0].name);
    }
  }, [bundles, selected]);
  const bundle = bundles.find(b => b.name === selected);
  const users = (b: Bundle) =>
    (services ?? []).filter(e => usedVersion(e, b)).length;

  return (
    <Page themeId="tool">
      <Header
        title="Template Explorer"
        subtitle="The template bundles Backstage creates and upgrades services with: what is inside each one, its source in Git, and who uses it"
      />
      <Content>
        {loading && <LinearProgress />}
        {error && <Alert severity="error">{error.message}</Alert>}
        {value && (
          <Box className={classes.layout}>
            <Paper variant="outlined">
              <List dense data-testid="calm-explorer-bundles">
                {(['starter', 'deployment', 'full'] as const).map(kind => {
                  const group = bundles.filter(b => b.kind === kind);
                  return group.length ? (
                    <Box key={kind}>
                      <ListSubheader
                        disableSticky
                        style={{
                          lineHeight: 1.4,
                          paddingTop: 14,
                          paddingBottom: 6,
                        }}
                      >
                        {KIND_TITLES[kind]}
                      </ListSubheader>
                      {group.map(b => (
                        <ListItem
                          key={b.name}
                          button
                          selected={b.name === selected}
                          onClick={() => setSelected(b.name)}
                        >
                          <ListItemText
                            primary={`${b.name} ${b.versions[0].version}`}
                            secondary={`${
                              b.versions[0].runtime ??
                              `${b.versions.length} version${
                                b.versions.length > 1 ? 's' : ''
                              }`
                            } · ${users(b)} service${
                              users(b) === 1 ? '' : 's'
                            }`}
                          />
                        </ListItem>
                      ))}
                    </Box>
                  ) : null;
                })}
              </List>
            </Paper>
            {bundle && <BundleDetail bundle={bundle} services={services} />}
          </Box>
        )}
      </Content>
    </Page>
  );
}
