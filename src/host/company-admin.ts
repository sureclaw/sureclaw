/**
 * Company admin helpers — DB-backed (DocumentStore) company admin list.
 *
 * Replaces the filesystem-based admin list which doesn't work in multi-pod k8s.
 * Admins are stored as a JSON array in the 'config' collection under key 'company/admins'.
 */

import type { DocumentStore } from '../providers/storage/types.js';

const COMPANY_ADMINS_KEY = 'company/admins';
const COLLECTION = 'config';

export async function isCompanyAdmin(documents: DocumentStore, userId: string): Promise<boolean> {
  const raw = await documents.get(COLLECTION, COMPANY_ADMINS_KEY);
  if (!raw) return false;
  const admins: string[] = JSON.parse(raw);
  return admins.includes(userId);
}

/** Claim the first company admin slot. Returns false if already claimed. */
export async function claimCompanyAdmin(documents: DocumentStore, userId: string): Promise<boolean> {
  const raw = await documents.get(COLLECTION, COMPANY_ADMINS_KEY);
  if (raw) {
    const admins: string[] = JSON.parse(raw);
    if (admins.length > 0) return false;
  }
  await documents.put(COLLECTION, COMPANY_ADMINS_KEY, JSON.stringify([userId]));
  return true;
}

export async function addCompanyAdmin(documents: DocumentStore, userId: string): Promise<void> {
  const raw = await documents.get(COLLECTION, COMPANY_ADMINS_KEY);
  const admins: string[] = raw ? JSON.parse(raw) : [];
  if (!admins.includes(userId)) {
    admins.push(userId);
    await documents.put(COLLECTION, COMPANY_ADMINS_KEY, JSON.stringify(admins));
  }
}
