export interface Config {
  calm?: {
    /** Base URL of the CALM Hub the catalog provider reads, e.g. http://localhost:8090. */
    hubUrl: string;
    /** Hub namespaces to read architectures and patterns from. Default: [hackathon]. */
    namespaces?: string[];
    /** Seconds between catalog refreshes. Default: 60. */
    refreshSeconds?: number;
    /**
     * The OCI registry that holds the template bundles, as `<repositoryPrefix>/<name>:<version>`. The catalog lists
     * every repository under the prefix; the pattern a bundle fits comes from its calm-backstage.json (the artifact's
     * config).
     */
    bundleRegistry?: {
      /** Base URL of the registry, e.g. http://localhost:5050. */
      url: string;
      /** Repository prefix of the bundles. Default: calm-bundles. */
      repositoryPrefix?: string;
    };
    /**
     * Template bundles in local folders, for authoring a bundle without pushing it. `path` is relative to the
     * backend's working directory (packages/backend) and holds the bundle's index.json and calm-backstage.json. A
     * registry bundle with the same name and version takes the catalog entry.
     */
    bundles?: Array<{
      name: string;
      version: string;
      path: string;
    }>;
  };
}
