import { useEffect, useState } from 'react';
import { discoveryApiRef, useApi } from '@backstage/frontend-plugin-api';
import Button from '@material-ui/core/Button';
import OpenInNewIcon from '@material-ui/icons/OpenInNew';

/**
 * Opens the deployed service's own page in a new tab, through calm-backend's proxy to its gateway (no
 * port-forward needed).
 */
export function OpenAppButton(props: { name: string }) {
  const discovery = useApi(discoveryApiRef);
  const [href, setHref] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    discovery
      .getBaseUrl('calm')
      .then(base => !cancelled && setHref(`${base}/app/${encodeURIComponent(props.name)}/`));
    return () => {
      cancelled = true;
    };
  }, [discovery, props.name]);
  if (!href) {
    return null;
  }
  return (
    <Button
      variant="contained"
      color="primary"
      size="small"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      endIcon={<OpenInNewIcon />}
      data-testid="calm-open-app"
    >
      Open the running app
    </Button>
  );
}
