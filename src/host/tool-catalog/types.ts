/**
 * Backward-compat re-export. The real definitions now live in
 * `src/types/catalog.ts` so the agent can import them without crossing
 * the host→agent boundary (see Task 2.3 of tool-dispatch-unification).
 *
 * New code should import from `src/types/catalog.js` directly. This file
 * exists so Phase 1+2 call sites under `src/host/tool-catalog/` keep
 * working without churn.
 */
export {
  CatalogToolSchema,
  validateCatalogTool,
  type CatalogTool,
} from '../../types/catalog.js';
