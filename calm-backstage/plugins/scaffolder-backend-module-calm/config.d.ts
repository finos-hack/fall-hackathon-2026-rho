export interface Config {
  calm?: {
    /**
     * The OCI registry calm:template pulls a template bundle from (`<repositoryPrefix>/<name>:<version>`) when no
     * local folder in calm.bundles has that name and version.
     */
    bundleRegistry?: {
      /** Base URL of the registry, e.g. http://localhost:5050. */
      url: string;
      /** Repository prefix of the bundles. Default: calm-bundles. */
      repositoryPrefix?: string;
    };
    /** Template bundles in local folders (authoring); calm:template uses one of these before the registry. */
    bundles?: Array<{
      name: string;
      version: string;
      path: string;
    }>;
    publish?: {
      /**
       * Folder calm:publish:local writes new services to (`<localDir>/<name>`), relative to the backend's working
       * directory (packages/backend). Default ../../output (the repository's git-ignored output folder).
       */
      localDir?: string;
      /**
       * CALM Hub namespace calm:register:hub stores the architectures of new services in, and
       * calm:decorate:deployment their deployment decorators. Default hackathon.
       */
      hubNamespace?: string;
    };
    deploy?: {
      /**
       * The one Kubernetes cluster calm:image:build and calm:deploy:k8s work on (the local minikube profile started
       * by `yarn k8s:up`), also read by calm-backend for the architecture card. Without `kubeconfig` and `context`
       * both actions refuse to run: the user's default kubeconfig and current context are never used.
       */
      kubernetes?: {
        /** Kubeconfig file, relative to the backend's working directory (packages/backend), e.g. ../../.kube/config. */
        kubeconfig?: string;
        /** Context in that file; passed to every kubectl call. */
        context?: string;
        /** minikube profile whose image store calm:image:build builds into. Default: the context. */
        minikubeProfile?: string;
        /** A service <name> is deployed to the namespace <namespacePrefix><name>. Default: calm-. */
        namespacePrefix?: string;
      };
    };
  };
}
