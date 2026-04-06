/**
 * Company Catalog Store — shared skill/connector catalog backed by DocumentStore.
 *
 * Stores entries as JSON in the 'catalog' collection. Filtering is client-side
 * (fine for <100 entries). Scale to a dedicated DB table if catalog grows large.
 */

import type { DocumentStore } from '../providers/storage/types.js';

export interface CatalogEntry {
  slug: string;
  type: 'skill' | 'connector';
  name: string;
  description: string;
  author: string;
  tags: string[];
  version: string;
  content: string;
  required: boolean;
  publishedAt: string;
  updatedAt: string;
}

export interface CatalogPublishInput {
  slug: string;
  type: 'skill' | 'connector';
  name: string;
  description: string;
  author: string;
  tags: string[];
  version: string;
  content: string;
}

const COLLECTION = 'catalog';

export class CatalogStore {
  constructor(private readonly documents: DocumentStore) {}

  async publish(input: CatalogPublishInput): Promise<CatalogEntry> {
    const now = new Date().toISOString();
    const existing = await this.get(input.slug);
    const entry: CatalogEntry = {
      ...input,
      required: existing?.required ?? false,
      publishedAt: existing?.publishedAt ?? now,
      updatedAt: now,
    };
    await this.documents.put(COLLECTION, input.slug, JSON.stringify(entry));
    return entry;
  }

  async get(slug: string): Promise<CatalogEntry | null> {
    const raw = await this.documents.get(COLLECTION, slug);
    if (!raw) return null;
    try { return JSON.parse(raw) as CatalogEntry; } catch { return null; }
  }

  async list(opts?: { tags?: string[]; type?: string; query?: string }): Promise<CatalogEntry[]> {
    const keys = await this.documents.list(COLLECTION);
    const entries: CatalogEntry[] = [];
    for (const key of keys) {
      const raw = await this.documents.get(COLLECTION, key);
      if (!raw) continue;
      try { entries.push(JSON.parse(raw) as CatalogEntry); } catch { /* skip */ }
    }
    return entries.filter(e => {
      if (opts?.type && e.type !== opts.type) return false;
      if (opts?.tags?.length && !opts.tags.some(t => e.tags.includes(t))) return false;
      if (opts?.query) {
        const q = opts.query.toLowerCase();
        if (!e.name.toLowerCase().includes(q) && !e.description.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }

  async unpublish(slug: string, requestingUserId: string): Promise<boolean> {
    const entry = await this.get(slug);
    if (!entry) return false;
    if (entry.required) throw new Error('Cannot unpublish required catalog entry');
    if (entry.author !== requestingUserId) throw new Error('Only the author can unpublish');
    return this.documents.delete(COLLECTION, slug);
  }

  async setRequired(slug: string, required: boolean): Promise<void> {
    const entry = await this.get(slug);
    if (!entry) throw new Error(`Catalog entry "${slug}" not found`);
    entry.required = required;
    entry.updatedAt = new Date().toISOString();
    await this.documents.put(COLLECTION, slug, JSON.stringify(entry));
  }

  async listRequired(): Promise<CatalogEntry[]> {
    const all = await this.list();
    return all.filter(e => e.required);
  }
}
