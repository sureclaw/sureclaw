/**
 * Backward-compat shim. The real implementation lives in
 * `src/types/catalog-render.ts` so the agent can import it without crossing
 * the host\u2192agent boundary (see Task 2.4 of tool-dispatch-unification).
 *
 * Host callers still pass a `ToolCatalog` instance; we just unwrap it and
 * forward to the array-taking implementation.
 */
import { ToolCatalog } from './registry.js';
import { renderCatalogOneLinersFromArray } from '../../types/catalog-render.js';

export function renderCatalogOneLiners(catalog: ToolCatalog): string {
  return renderCatalogOneLinersFromArray(catalog.list());
}
