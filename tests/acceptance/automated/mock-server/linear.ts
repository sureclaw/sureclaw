import type { IncomingMessage, ServerResponse } from 'node:http';

/** Tracks the last Authorization header received — used by tests to verify credential injection. */
let lastAuthHeader: string | null = null;

export function getLastLinearAuth(): string | null {
  return lastAuthHeader;
}

export function resetLinear(): void {
  lastAuthHeader = null;
}

export function handleLinear(req: IncomingMessage, res: ServerResponse): void {
  // POST /graphql — validate Authorization header and return canned response
  if (req.url?.startsWith('/graphql') && req.method === 'POST') {
    lastAuthHeader = req.headers.authorization ?? null;

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      // Check for valid API key format
      if (!lastAuthHeader || !lastAuthHeader.startsWith('Bearer lin_api_')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errors: [{ message: 'Authentication required' }] }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: {
          issues: {
            nodes: [
              { id: 'ISS-1', title: 'Test Issue', state: { name: 'In Progress' } },
              { id: 'ISS-2', title: 'Another Issue', state: { name: 'Done' } },
            ],
          },
        },
      }));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}
