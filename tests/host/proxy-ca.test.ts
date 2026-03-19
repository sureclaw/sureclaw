import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as tls from 'node:tls';

// We'll import { getOrCreateCA } from '../../src/host/proxy-ca.js';

describe('proxy-ca', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ax-ca-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('creates CA key and cert on first call', async () => {
    const { getOrCreateCA } = await import('../../src/host/proxy-ca.js');
    const ca = await getOrCreateCA(dir);
    expect(ca.key).toBeDefined();
    expect(ca.cert).toBeDefined();
    // Files should be persisted
    expect(existsSync(join(dir, 'ca.key'))).toBe(true);
    expect(existsSync(join(dir, 'ca.crt'))).toBe(true);
  });

  test('returns same CA on second call', async () => {
    const { getOrCreateCA } = await import('../../src/host/proxy-ca.js');
    const ca1 = await getOrCreateCA(dir);
    const ca2 = await getOrCreateCA(dir);
    expect(ca1.cert).toBe(ca2.cert);
  });

  test('generates valid domain cert signed by CA', async () => {
    const { getOrCreateCA, generateDomainCert } = await import('../../src/host/proxy-ca.js');
    const ca = await getOrCreateCA(dir);
    const domainCert = generateDomainCert('api.linear.app', ca);
    expect(domainCert.key).toBeDefined();
    expect(domainCert.cert).toBeDefined();

    // Verify the cert is valid for the domain by creating a TLS context
    // (no error = valid PEM format)
    const ctx = tls.createSecureContext({
      key: domainCert.key,
      cert: domainCert.cert,
      ca: ca.cert,
    });
    expect(ctx).toBeDefined();
  });

  test('caches domain certs', async () => {
    const { getOrCreateCA, generateDomainCert } = await import('../../src/host/proxy-ca.js');
    const ca = await getOrCreateCA(dir);
    const cert1 = generateDomainCert('api.linear.app', ca);
    const cert2 = generateDomainCert('api.linear.app', ca);
    expect(cert1.cert).toBe(cert2.cert);
  });
});
