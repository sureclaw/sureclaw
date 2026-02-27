/**
 * Re-export safePath for provider authors who need filesystem safety.
 *
 * Every file-based provider MUST use safePath() when constructing paths
 * from input. This re-export lets SDK consumers access it without reaching
 * into AX internals.
 */
export { safePath, assertWithinBase } from '../../utils/safe-path.js';
