/*
 * Finds and fills the placeholders `calm generate` leaves in an architecture.
 *
 * Mirrors `getPropertyValue` in `shared/src/commands/generate/components/property.ts` of
 * https://github.com/finos/architecture-as-code: a property with a `type` but no `const` or `default` becomes
 * - `string`: `"[[ NAME ]]"` (the key upper-cased, `-` to `_`), also `"[[ BOOLEAN_NAME ]]"` for `boolean` and
 *   `"[[ REF_NAME ]]"` for a bare `$ref`, and `["[[ NAME ]]"]` for an `array`;
 * - `integer` / `number`: `-1`.
 * Every `[[ … ]]` string is reported as kind `string` (the `BOOLEAN_` and `REF_` forms included) and every `-1` as kind
 * `number`. No CLI command fills them, so `fillPlaceholders` is ours.
 */

/** One value in a generated architecture that the developer still has to give. */
export interface Placeholder {
  /** JSON Pointer (RFC 6901) to the value, e.g. `/nodes/1/interfaces/0/host`. */
  path: string;
  kind: 'string' | 'number';
  /** The placeholder name (`HOST` for `"[[ HOST ]]"`); for a `-1` number, `<enclosing unique-id>.<key>`. */
  name: string;
  /** Readable location: enclosing `unique-id`s and keys, e.g. `api-gateway › api-gateway-ingress › host`. */
  label: string;
}

/** Values for placeholders, keyed by JSON Pointer. */
export type PlaceholderValues = Record<string, string | number>;

const STRING_PLACEHOLDER = /^\[\[\s*(.+?)\s*\]\]$/;
const NUMBER_PLACEHOLDER = -1;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const escapeSegment = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
const unescapeSegment = (s: string) =>
  s.replace(/~1/g, '/').replace(/~0/g, '~');

/** Builds a JSON Pointer from path segments. */
export function toJsonPointer(segments: (string | number)[]): string {
  return segments.map(s => `/${escapeSegment(String(s))}`).join('');
}

/** Splits a JSON Pointer into its segments. */
export function parseJsonPointer(pointer: string): string[] {
  if (pointer === '') {
    return [];
  }
  if (!pointer.startsWith('/')) {
    throw new Error(`Not a JSON Pointer: ${pointer}`);
  }
  return pointer.slice(1).split('/').map(unescapeSegment);
}

const uniqueId = (v: unknown): string | undefined =>
  isObject(v) && typeof v['unique-id'] === 'string'
    ? (v['unique-id'] as string)
    : undefined;

/** The placeholders in a generated architecture, in document order. */
export function scanPlaceholders(doc: unknown): Placeholder[] {
  const out: Placeholder[] = [];

  const visit = (
    value: unknown,
    segments: (string | number)[],
    labelParts: string[],
    enclosingId: string | undefined,
  ) => {
    if (typeof value === 'string') {
      const m = STRING_PLACEHOLDER.exec(value);
      if (m) {
        out.push({
          path: toJsonPointer(segments),
          kind: 'string',
          name: m[1],
          label: labelParts.join(' › '),
        });
      }
      return;
    }
    if (typeof value === 'number') {
      if (value === NUMBER_PLACEHOLDER) {
        const key = String(segments[segments.length - 1] ?? '');
        out.push({
          path: toJsonPointer(segments),
          kind: 'number',
          name: enclosingId ? `${enclosingId}.${key}` : key,
          label: labelParts.join(' › '),
        });
      }
      return;
    }
    if (Array.isArray(value)) {
      // An array element is named by its unique-id when it has one, else by `<key>[<index>]`.
      const arrayKey = labelParts[labelParts.length - 1] ?? '';
      const parent = labelParts.slice(0, -1);
      value.forEach((item, i) => {
        const id = uniqueId(item);
        visit(
          item,
          [...segments, i],
          [...parent, id ?? `${arrayKey}[${i}]`],
          id ?? enclosingId,
        );
      });
      return;
    }
    if (isObject(value)) {
      const id = uniqueId(value) ?? enclosingId;
      for (const [key, child] of Object.entries(value)) {
        visit(child, [...segments, key], [...labelParts, key], id);
      }
    }
  };

  visit(doc, [], [], undefined);
  return out;
}

/**
 * A copy of `doc` with each JSON Pointer in `values` set. A string value for a number (or a number for a string) is
 * converted to the type that is there. Throws on a path that does not exist or a value that is not a number where one
 * is needed.
 */
export function fillPlaceholders<T>(doc: T, values: PlaceholderValues): T {
  const copy = JSON.parse(JSON.stringify(doc));
  for (const [pointer, raw] of Object.entries(values)) {
    const segments = parseJsonPointer(pointer);
    if (!segments.length) {
      throw new Error('Cannot replace the whole document');
    }
    let parent: any = copy;
    for (const seg of segments.slice(0, -1)) {
      parent = parent?.[Array.isArray(parent) ? Number(seg) : seg];
      if (typeof parent !== 'object' || parent === null) {
        throw new Error(`No value at ${pointer}`);
      }
    }
    const last = segments[segments.length - 1];
    const key = Array.isArray(parent) ? Number(last) : last;
    if (!(key in parent)) {
      throw new Error(`No value at ${pointer}`);
    }
    const current = parent[key];
    let value: string | number = raw;
    if (typeof current === 'number' && typeof raw !== 'number') {
      value = Number(raw);
      if (String(raw).trim() === '' || !Number.isFinite(value)) {
        throw new Error(
          `${pointer} needs a number, got ${JSON.stringify(raw)}`,
        );
      }
    } else if (typeof current === 'string' && typeof raw !== 'string') {
      value = String(raw);
    }
    parent[key] = value;
  }
  return copy;
}
