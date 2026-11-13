export interface Config {
  calm?: {
    publish?: {
      /**
       * Folder calm:publish:local writes new services to (`<localDir>/<name>`), relative to the backend's working
       * directory (packages/backend). Default ../../output (the repository's git-ignored output folder).
       */
      localDir?: string;
    };
  };
}
