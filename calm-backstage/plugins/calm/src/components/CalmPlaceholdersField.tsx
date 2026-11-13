import { useEffect, useRef, useState } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/frontend-plugin-api';
import type {
  CustomFieldValidator,
  FieldExtensionComponentProps,
} from '@backstage/plugin-scaffolder-react';
import { createFormField } from '@backstage/plugin-scaffolder-react/alpha';
import type {
  Placeholder,
  PlaceholderValues,
  TemplateDecisionParameter,
} from '@internal/backstage-plugin-calm-common';
import Box from '@material-ui/core/Box';
import LinearProgress from '@material-ui/core/LinearProgress';
import TextField from '@material-ui/core/TextField';
import Typography from '@material-ui/core/Typography';
import Alert from '@material-ui/lab/Alert';

/** `ui:options` the CALM catalog provider writes on the Template's `placeholders` parameter. */
export interface CalmPlaceholdersUiOptions {
  /** Pattern URL in CALM Hub (the pattern `$id`), as in the `calm:generate` step. */
  patternUrl?: string;
  /** Form parameter -> pattern decision map (the `calm.finos.org/decisions` annotation). */
  decisions?: TemplateDecisionParameter[];
}

/** Response of calm-backend `POST /placeholders`. */
interface PlaceholdersResponse {
  placeholders: Placeholder[];
  nodeCount: number;
  relationshipCount: number;
}

type Props = FieldExtensionComponentProps<
  PlaceholderValues,
  CalmPlaceholdersUiOptions
>;

/*
 * The list the field shows, shared with the validator. The Stepper calls a field validator with the value only, and
 * RJSF fills an empty object for this parameter, so the validator checks the value against this list (and blocks
 * the step while the list is loading or failed to load).
 */
let shown: {
  status: 'loading' | 'error' | 'ready';
  placeholders: Placeholder[];
  message?: string;
} = { status: 'loading', placeholders: [] };

/** The `calm:generate` choices (decision id -> answer) from the values of the earlier form steps. */
function choicesFrom(
  decisions: TemplateDecisionParameter[],
  formData: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of decisions) {
    if (formData[d.parameter] !== undefined) {
      out[d.relationshipId] = formData[d.parameter];
    }
  }
  return out;
}

/** The count line under the node and relationship counts: it drops as values are entered. */
function summaryOfValues(total: number, remaining: number): string {
  if (!total) {
    return 'no values are needed.';
  }
  if (!remaining) {
    return `all ${total} values are given.`;
  }
  return `${remaining} of ${total} values ${
    remaining === 1 ? 'is' : 'are'
  } still needed.`;
}

export const CalmPlaceholdersField = (props: Props) => {
  const { formData, onChange, uiSchema, formContext, schema, rawErrors } =
    props;
  const options = uiSchema?.['ui:options'] ?? {};
  const patternUrl = options.patternUrl;
  const choices = choicesFrom(
    options.decisions ?? [],
    (formContext?.formData ?? {}) as Record<string, unknown>,
  );
  // Only the pattern and the choices decide the list; this field's own value is not part of the key.
  const requestKey = JSON.stringify({ patternUrl, choices });

  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const [state, setState] = useState<{
    loading: boolean;
    error?: Error;
    data?: PlaceholdersResponse;
  }>({ loading: true });

  const valueRef = useRef(formData);
  valueRef.current = formData;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let cancelled = false;
    setState(s => ({ ...s, loading: true, error: undefined }));
    shown = { status: 'loading', placeholders: [] };
    (async () => {
      if (!patternUrl) {
        throw new Error('The Template gives no ui:options.patternUrl');
      }
      const base = await discovery.getBaseUrl('calm');
      const res = await fetch(`${base}/placeholders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestKey,
      });
      const body = await res.json().catch(() => undefined);
      if (!res.ok) {
        throw new Error(
          body?.error?.message ?? `calm-backend answered HTTP ${res.status}`,
        );
      }
      return body as PlaceholdersResponse;
    })().then(
      data => {
        if (cancelled) {
          return;
        }
        shown = { status: 'ready', placeholders: data.placeholders };
        setState({ loading: false, data });
        // The value holds every path of this list, keeping answers given before.
        const prev = valueRef.current ?? {};
        onChangeRef.current(
          Object.fromEntries(
            data.placeholders.map(p => [p.path, prev[p.path] ?? '']),
          ),
        );
      },
      error => {
        if (!cancelled) {
          shown = {
            status: 'error',
            placeholders: [],
            message: String(error?.message ?? error),
          };
          setState({ loading: false, error });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [requestKey, patternUrl, discovery, fetch]);

  const value = formData ?? {};
  const isEmpty = (v: unknown) =>
    v === undefined || v === null || String(v).trim() === '';
  const remaining = (state.data?.placeholders ?? []).filter(p =>
    isEmpty(value[p.path]),
  ).length;
  const set = (p: Placeholder, raw: string) => {
    let v: string | number = raw;
    if (p.kind === 'number' && raw.trim() !== '') {
      v = Number(raw);
    }
    onChange({ ...value, [p.path]: v });
  };

  return (
    <Box mb={2}>
      {schema.title && <Typography variant="h6">{schema.title}</Typography>}
      {schema.description && (
        <Typography variant="body2" color="textSecondary">
          {schema.description}
        </Typography>
      )}
      {state.loading && (
        <Box my={2}>
          <Typography variant="body2">
            Running calm generate for these choices…
          </Typography>
          <LinearProgress />
        </Box>
      )}
      {state.error && (
        <Box my={2}>
          <Alert severity="error" style={{ whiteSpace: 'pre-wrap' }}>
            {state.error.message}
          </Alert>
        </Box>
      )}
      {state.data && !state.loading && (
        <Box my={1}>
          <Typography variant="body2" data-testid="calm-placeholders-summary">
            The architecture for these choices has {state.data.nodeCount} nodes
            and {state.data.relationshipCount} relationships;{' '}
            {summaryOfValues(state.data.placeholders.length, remaining)}
          </Typography>
        </Box>
      )}
      {state.data &&
        state.data.placeholders.map(p => {
          const v = value[p.path];
          const empty = isEmpty(v);
          return (
            <TextField
              key={p.path}
              id={`calm-placeholder-${p.path}`}
              label={p.label}
              helperText={`${p.kind === 'number' ? 'Number' : p.name} · ${
                p.path
              }`}
              type={p.kind === 'number' ? 'number' : 'text'}
              value={v ?? ''}
              onChange={e => set(p, e.target.value)}
              // Asterisk only: the field validator checks the values, not the browser.
              InputLabelProps={{ required: true }}
              error={Boolean(rawErrors?.length) && empty}
              fullWidth
              margin="normal"
              variant="outlined"
              disabled={state.loading}
            />
          );
        })}
    </Box>
  );
};

/** Every placeholder of the shown list needs a value; numbers must be numbers. */
export const calmPlaceholdersValidation: CustomFieldValidator<
  PlaceholderValues,
  CalmPlaceholdersUiOptions
> = (data, field) => {
  if (shown.status === 'loading') {
    field.addError('The placeholder list is still loading');
    return;
  }
  if (shown.status === 'error') {
    field.addError(`The placeholder list did not load: ${shown.message}`);
    return;
  }
  for (const p of shown.placeholders) {
    const v = data?.[p.path];
    if (v === undefined || v === null || String(v).trim() === '') {
      field.addError(`Give a value for ${p.label}`);
    } else if (p.kind === 'number' && !Number.isFinite(Number(v))) {
      field.addError(`${p.label} must be a number`);
    }
  }
};

export const CalmPlaceholdersFormField = createFormField({
  name: 'CalmPlaceholders',
  component: CalmPlaceholdersField,
  validation: calmPlaceholdersValidation,
});
