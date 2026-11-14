/*
 * Names shared by the parts that deploy a service to Kubernetes (the scaffolder actions), record where it went
 * (`catalog-info.yaml`) and read it back (calm-backend, the architecture card).
 */

/** Annotations the Backstage Kubernetes plugin reads on an entity. */
export const KUBERNETES_ANNOTATIONS = {
  /** Value of the `backstage.io/kubernetes-id` label on the entity's Kubernetes objects. */
  id: 'backstage.io/kubernetes-id',
  namespace: 'backstage.io/kubernetes-namespace',
} as const;

/** Label the Backstage Kubernetes plugin selects an entity's objects by. */
export const KUBERNETES_ID_LABEL = 'backstage.io/kubernetes-id';

/** Labels and annotations on the Kubernetes objects of a service created from a CALM pattern. */
export const CALM_KUBERNETES = {
  /** Label on the namespace `calm:deploy:k8s` created: the service name. */
  serviceLabel: 'calm.finos.org/service',
  /** Annotation on a NetworkPolicy: the `unique-id` of the `connects` relationship it was rendered from. */
  relationshipAnnotation: 'calm.finos.org/relationship',
  /** Annotation on a NetworkPolicy: the relationship's protocol. */
  protocolAnnotation: 'calm.finos.org/protocol',
  /**
   * Annotation on a Deployment (k8s-deploy 1.2.2 and later): the `unique-id` of the node it was rendered from, when
   * that id is not a valid Kubernetes name and the Deployment has a converted name.
   */
  uniqueIdAnnotation: 'calm.finos.org/unique-id',
} as const;

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** True for a Kubernetes DNS label: lower-case letters, digits and hyphens, alphanumeric at both ends, at most 63. */
export const isDnsLabel = (s: string) => s.length <= 63 && DNS_LABEL.test(s);

/**
 * The namespace a service is deployed to: `<prefix><name>`. Throws when the name is not a DNS label, when the
 * namespace is longer than 63 characters, and for `default` and `kube-*` (reachable only with an empty or odd prefix).
 */
export function deployNamespace(prefix: string, name: string): string {
  if (!isDnsLabel(name)) {
    throw new Error(
      `Service name ${JSON.stringify(
        name,
      )} cannot name Kubernetes objects: use lower-case letters, digits and hyphens, starting and ending with a letter or digit, at most 63 characters`,
    );
  }
  const namespace = `${prefix}${name}`;
  if (!isDnsLabel(namespace)) {
    throw new Error(
      `Namespace ${JSON.stringify(
        namespace,
      )} is not a valid Kubernetes namespace name (a DNS label of at most 63 characters)`,
    );
  }
  if (namespace === 'default' || namespace.startsWith('kube-')) {
    throw new Error(
      `Refusing to deploy to the namespace ${JSON.stringify(
        namespace,
      )}: default and kube-* are not for services`,
    );
  }
  return namespace;
}
