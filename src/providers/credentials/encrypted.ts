import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataFile } from '../../paths.js';
import type { CredentialProvider } from './types.js';
import type { Config } from '../../types.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 100_000;
const DIGEST = 'sha512';

interface EncryptedFile {
  salt: string;   // hex
  iv: string;     // hex
  tag: string;    // hex
  data: string;   // hex (ciphertext)
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST);
}

function encrypt(plaintext: string, passphrase: string): EncryptedFile {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(passphrase, salt);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
  };
}

function decrypt(file: EncryptedFile, passphrase: string): string {
  const salt = Buffer.from(file.salt, 'hex');
  const key = deriveKey(passphrase, salt);
  const iv = Buffer.from(file.iv, 'hex');
  const tag = Buffer.from(file.tag, 'hex');
  const data = Buffer.from(file.data, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final('utf-8');
}

export async function create(_config: Config): Promise<CredentialProvider> {
  const storePath = process.env.AX_CREDS_STORE_PATH || dataFile('credentials.enc');
  const passphrase = process.env.AX_CREDS_PASSPHRASE;
  if (!passphrase) {
    const { getLogger } = await import('../../logger.js');
    getLogger().warn('creds_no_passphrase', {
      message: 'Encrypted credential store disabled — AX_CREDS_PASSPHRASE not set. Falling back to environment variables.',
      suggestion: 'Set it with: export AX_CREDS_PASSPHRASE=your-secret-passphrase',
    });
    return (await import('./env.js')).create(_config);
  }

  // Cache the derived key in memory for the session
  let cachedStore: Record<string, string> | null = null;

  function loadStore(): Record<string, string> {
    if (cachedStore) return cachedStore;
    try {
      const raw = readFileSync(storePath, 'utf-8');
      const file: EncryptedFile = JSON.parse(raw);
      cachedStore = JSON.parse(decrypt(file, passphrase!));
      return cachedStore!;
    } catch {
      cachedStore = {};
      return cachedStore;
    }
  }

  function saveStore(store: Record<string, string>): void {
    mkdirSync(dirname(storePath), { recursive: true });
    const plaintext = JSON.stringify(store);
    const file = encrypt(plaintext, passphrase!);
    writeFileSync(storePath, JSON.stringify(file));
    cachedStore = store;
  }

  return {
    async get(service: string): Promise<string | null> {
      const store = loadStore();
      return store[service] ?? null;
    },

    async set(service: string, value: string): Promise<void> {
      const store = loadStore();
      store[service] = value;
      saveStore(store);
    },

    async delete(service: string): Promise<void> {
      const store = loadStore();
      delete store[service];
      saveStore(store);
    },

    async list(): Promise<string[]> {
      const store = loadStore();
      return Object.keys(store);
    },
  };
}
