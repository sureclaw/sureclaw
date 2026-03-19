/**
 * MITM proxy CA certificate management.
 *
 * Generates a self-signed root CA for the web proxy's TLS inspection mode.
 * Domain certificates are generated on-the-fly and cached in memory.
 * The CA key + cert are persisted to disk so containers can trust the CA
 * across restarts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as forge from 'node-forge';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'proxy-ca' });

export interface CAKeyPair {
  key: string;   // PEM-encoded private key
  cert: string;  // PEM-encoded certificate
}

export interface DomainCert {
  key: string;   // PEM-encoded private key
  cert: string;  // PEM-encoded certificate
}

/** In-memory cache of generated domain certs. */
const domainCertCache = new Map<string, DomainCert>();

/**
 * Load or generate the root CA. Persists to `dir/ca.key` and `dir/ca.crt`.
 */
export async function getOrCreateCA(dir: string): Promise<CAKeyPair> {
  const keyPath = join(dir, 'ca.key');
  const certPath = join(dir, 'ca.crt');

  if (existsSync(keyPath) && existsSync(certPath)) {
    return {
      key: readFileSync(keyPath, 'utf-8'),
      cert: readFileSync(certPath, 'utf-8'),
    };
  }

  logger.info('generating_ca', { dir });

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: 'commonName', value: 'AX MITM Proxy CA' },
    { name: 'organizationName', value: 'AX' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const pemKey = forge.pki.privateKeyToPem(keys.privateKey);
  const pemCert = forge.pki.certificateToPem(cert);

  mkdirSync(dir, { recursive: true });
  writeFileSync(keyPath, pemKey, { mode: 0o600 });
  writeFileSync(certPath, pemCert);

  return { key: pemKey, cert: pemCert };
}

/**
 * Generate a TLS certificate for a specific domain, signed by the CA.
 * Results are cached in memory — one cert per domain for the process lifetime.
 */
export function generateDomainCert(domain: string, ca: CAKeyPair): DomainCert {
  const cached = domainCertCache.get(domain);
  if (cached) return cached;

  const caKey = forge.pki.privateKeyFromPem(ca.key);
  const caCert = forge.pki.certificateFromPem(ca.cert);

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = Date.now().toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  cert.setSubject([{ name: 'commonName', value: domain }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'subjectAltName', altNames: [{ type: 2, value: domain }] },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
  ]);
  cert.sign(caKey, forge.md.sha256.create());

  const result: DomainCert = {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
  domainCertCache.set(domain, result);
  return result;
}
