import { useEffect, useState } from 'react';
import { useTheme } from '@material-ui/core/styles';
import Box from '@material-ui/core/Box';
import LinearProgress from '@material-ui/core/LinearProgress';
import Alert from '@material-ui/lab/Alert';

type Mermaid = typeof import('mermaid')['default'];

let loaded: Promise<Mermaid> | undefined;
let initialisedTheme: string | undefined;
let renderCount = 0;

/** Loads Mermaid once (its own chunk) and (re)initialises it for the Backstage palette. */
async function mermaidFor(theme: 'default' | 'dark'): Promise<Mermaid> {
  loaded ??= import('mermaid').then(m => m.default);
  const mermaid = await loaded;
  if (initialisedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme,
      flowchart: { htmlLabels: true },
    });
    initialisedTheme = theme;
  }
  return mermaid;
}

/** Renders Mermaid source to an inline SVG with `mermaid.render()`. */
export function MermaidDiagram(props: { source: string; title?: string }) {
  const { source, title } = props;
  const palette = useTheme().palette.type;
  const [state, setState] = useState<{ svg?: string; error?: string }>({});

  useEffect(() => {
    let cancelled = false;
    // A fresh id per render: Mermaid uses it as a CSS selector (no colons, as React's useId would give).
    const id = `calm-mermaid-${++renderCount}`;
    setState({});
    mermaidFor(palette === 'dark' ? 'dark' : 'default')
      .then(mermaid => mermaid.render(id, source))
      .then(
        ({ svg }) => !cancelled && setState({ svg }),
        error => {
          // A failed render can leave Mermaid's scratch element in the body.
          document.getElementById(`d${id}`)?.remove();
          document.getElementById(id)?.remove();
          if (!cancelled) {
            setState({ error: String(error?.message ?? error) });
          }
        },
      );
    return () => {
      cancelled = true;
    };
  }, [source, palette]);

  if (state.error) {
    return (
      <Alert severity="error">The diagram did not render: {state.error}</Alert>
    );
  }
  if (!state.svg) {
    return <LinearProgress aria-label="Rendering the diagram" />;
  }
  return (
    <Box
      role="img"
      aria-label={title ?? 'Architecture diagram'}
      data-testid="calm-mermaid"
      style={{ overflowX: 'auto', textAlign: 'center' }}
      // Mermaid output with securityLevel 'strict' (labels sanitised, no click handlers).
      dangerouslySetInnerHTML={{ __html: state.svg }}
    />
  );
}
