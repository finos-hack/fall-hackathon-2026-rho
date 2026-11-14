export interface Config {
  calm?: {
    /** Base URL of the CALM Hub the catalog provider reads, e.g. http://localhost:8090. */
    hubUrl: string;
    /** Hub namespaces to read architectures and patterns from. Default: [hackathon]. */
    namespaces?: string[];
    /** Seconds between catalog refreshes. Default: 60. */
    refreshSeconds?: number;
    /**
     * Template bundles. `path` is relative to the backend's working directory (packages/backend) and holds the
     * bundle's index.json and calm-backstage.json; the pattern a bundle fits comes from calm-backstage.json.
     */
    bundles?: Array<{
      name: string;
      version: string;
      path: string;
    }>;
  };
}
