import {
  IMPORT_FORMAT_LABELS,
  IMPORT_FORMATS,
} from '@internal/backstage-plugin-calm-common';
import { FORMAT_LABELS } from '@internal/calm-import';

// The form's Format field (calm-common, for the catalog module) and the converter's hints (calm-import) name the
// formats alike. The catalog module does not depend on calm-import, so the two lists are kept equal here (#71).
describe('import format labels', () => {
  it('are the same in calm-common and calm-import, in the same order', () => {
    expect(IMPORT_FORMAT_LABELS).toEqual(FORMAT_LABELS);
    expect(Object.keys(FORMAT_LABELS)).toEqual([...IMPORT_FORMATS]);
  });
});
