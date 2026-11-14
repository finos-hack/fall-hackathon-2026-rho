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
    };
  };
}
