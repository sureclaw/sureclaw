import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WebProvider, FetchRequest, FetchResponse, SearchResult } from '../../src/providers/web/types.js';
import type { GcsBucketLike } from '../../src/providers/workspace/gcs.js';
import { createGcsBackend } from '../../src/providers/workspace/gcs.js';
import { createOrchestrator } from '../../src/providers/workspace/shared.js';
import type { WorkspaceProvider } from '../../src/providers/workspace/types.js';
import type { ScannerProvider } from '../../src/providers/scanner/types.js';
import type { TaintTag } from '../../src/types.js';

// ── Mock Web Provider (replaces Tavily) ──

export interface MockWebOptions {
  fetchResponses?: Map<RegExp, { status: number; body: string }>;
  searchResults?: Map<RegExp, Array<{ title: string; url: string; snippet: string }>>;
}

function taintTag(source: string): TaintTag {
  return { source, trust: 'external', timestamp: new Date() };
}

export function createMockWeb(opts: MockWebOptions = {}): WebProvider {
  return {
    async fetch(req: FetchRequest): Promise<FetchResponse> {
      if (opts.fetchResponses) {
        for (const [pattern, response] of opts.fetchResponses) {
          if (pattern.test(req.url)) {
            return {
              status: response.status,
              headers: { 'content-type': 'text/html' },
              body: response.body,
              taint: taintTag('web_fetch'),
            };
          }
        }
      }
      return {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: `<html><body>Mock page content for ${req.url}</body></html>`,
        taint: taintTag('web_fetch'),
      };
    },

    async search(query: string, maxResults?: number): Promise<SearchResult[]> {
      if (opts.searchResults) {
        for (const [pattern, results] of opts.searchResults) {
          if (pattern.test(query)) {
            return results.slice(0, maxResults ?? 5).map(r => ({
              ...r,
              taint: taintTag('web_search'),
            }));
          }
        }
      }
      return [{
        title: `Mock result for: ${query}`,
        url: 'https://example.com/mock',
        snippet: `Mock search result for "${query}"`,
        taint: taintTag('web_search'),
      }];
    },
  };
}

// ── Mock GCS Bucket (replaces @google-cloud/storage) ──

export function createMockGcsBucket(): GcsBucketLike & {
  files: Map<string, Buffer>;
} {
  const files = new Map<string, Buffer>();

  return {
    files,

    async getFiles(opts: { prefix: string }) {
      const matching = [...files.entries()]
        .filter(([name]) => name.startsWith(opts.prefix))
        .map(([name, content]) => ({
          name,
          async download(): Promise<[Buffer]> {
            return [content];
          },
        }));
      return [matching] as [typeof matching, ...unknown[]];
    },

    file(name: string) {
      return {
        async save(content: Buffer) {
          files.set(name, content);
        },
        async delete() {
          files.delete(name);
        },
      };
    },
  };
}

// ── Mock GCS-backed Workspace Provider ──

/** Pass-through scanner that approves everything (no external deps needed). */
const passThroughScanner: ScannerProvider = {
  async scanInput() { return { verdict: 'PASS' }; },
  async scanOutput() { return { verdict: 'PASS' }; },
  canaryToken() { return ''; },
  checkCanary() { return false; },
};

/**
 * Create a GCS-backed WorkspaceProvider using a mock in-memory bucket.
 * Returns both the provider (for providerOverrides) and the bucket (for assertions).
 */
export function createMockGcsWorkspace(agentId = 'main'): {
  workspace: WorkspaceProvider;
  gcsBucket: GcsBucketLike & { files: Map<string, Buffer> };
} {
  const gcsBucket = createMockGcsBucket();
  const basePath = mkdtempSync(join(tmpdir(), 'ax-gcs-ws-'));
  mkdirSync(basePath, { recursive: true });

  const backend = createGcsBackend(gcsBucket, basePath, '');
  const workspace = createOrchestrator({
    backend,
    scanner: passThroughScanner,
    config: {},
    agentId,
  });

  return { workspace, gcsBucket };
}
