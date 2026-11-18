/** The diagram formats the import Template offers, in the order of its Format field. */
export const IMPORT_FORMATS = ['drawio', 'c4', 'mermaid'] as const;

export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/**
 * The formats as the import form names them. The Template's Format field and the import action's wrong-format hint
 * both use these words; calm-import's FORMAT_LABELS gives its readers' hints the same labels.
 */
export const IMPORT_FORMAT_LABELS: Record<ImportFormat, string> = {
  drawio: 'draw.io',
  c4: 'C4 (Mermaid or PlantUML)',
  mermaid: 'Mermaid flowchart',
};
