/** The diagram formats the import Template offers, in the order of its Format field. */
export const IMPORT_FORMATS = ['drawio', 'c4', 'mermaid'] as const;

export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/**
 * The formats as the import form names them, for the Template's Format field. calm-import's FORMAT_LABELS gives the
 * import action's and the readers' hints the same words; the scaffolder module's importFormats.test.ts keeps the two
 * equal (the catalog module does not depend on calm-import).
 */
export const IMPORT_FORMAT_LABELS: Record<ImportFormat, string> = {
  drawio: 'draw.io',
  c4: 'C4 (Mermaid or PlantUML)',
  mermaid: 'Mermaid flowchart',
};
