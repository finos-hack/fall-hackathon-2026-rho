/*
 * Catalog entity names for CALM documents, shared by the catalog provider (which emits the pattern, control and
 * bundle Resources and the Templates), the scaffolder actions (which point a new service's `dependsOn` at them) and
 * the entity cards (which link to them).
 */

/** Backstage entity names: `[A-Za-z0-9._-]`, at most 63 characters, alphanumeric at both ends. */
export function entityName(s: string): string {
  return s
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
    .slice(0, 63)
    .replace(/[^A-Za-z0-9]+$/, '');
}

/** Resource name of a CALM pattern, e.g. `pattern-web-service`. */
export const patternEntityName = (id: string) => entityName(`pattern-${id}`);

/** Resource name of a template bundle version, e.g. `bundle-web-service-2.0.0`. */
export const bundleEntityName = (name: string, version: string) =>
  entityName(`bundle-${name}-${version}`);

/** Resource name of a CALM control requirement, e.g. `control-hackathon-security-encryption-at-rest`. */
export const controlEntityName = (domain: string, control: string) =>
  entityName(`control-${domain}-${control}`);

/** Template name for a CALM pattern, e.g. `create-from-web-service`. */
export const templateEntityName = (patternId: string) =>
  entityName(`create-from-${patternId}`);

/** A bundle as the Template's `bundle` parameter gives it: `<name>@<version>`, e.g. `web-service@2.0.0`. */
export function parseBundleValue(
  value: string,
): { name: string; version: string } | undefined {
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) {
    return undefined;
  }
  return { name: value.slice(0, at), version: value.slice(at + 1) };
}
