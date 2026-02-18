/**
 * Legacy entry point — redirects to cli/index.ts
 *
 * This file exists for backward compatibility with `npm start`.
 * All logic has moved to src/server.ts and src/cli/*.ts.
 */

import { main } from './cli/index.js';

main().catch(async (err) => {
  const { diagnoseError, formatDiagnosedError } = await import('./errors.js');
  const diagnosed = diagnoseError(err as Error);
  console.error(formatDiagnosedError(diagnosed));
  process.exit(1);
});
