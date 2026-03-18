/**
 * First-run setup server.
 *
 * When no ax.yaml exists, we start a minimal HTTP server that serves
 * the dashboard setup wizard at /admin/setup. Once the user completes
 * the wizard and a config file is written, this server shuts down and
 * the full AX server takes over.
 *
 * Think of it as the BIOS setup screen — runs once, then gets out of the way.
 */

import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readBody } from '../host/server-http.js';
import { getLogger } from '../logger.js';
import { axHome } from '../paths.js';

const logger = getLogger().child({ component: 'setup-server' });

interface SetupServerOptions {
  port: number;
  configPath: string;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function resolveAdminUIDir(): string {
  const devDir = resolve(import.meta.dirname, '../admin-ui');
  if (existsSync(devDir)) return devDir;
  const distDir = resolve(import.meta.dirname, '../../src/admin-ui');
  if (existsSync(distDir)) return distDir;
  return devDir;
}

function sendJSON(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  const body = JSON.stringify({ error: { message } });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export async function runSetupServer(opts: SetupServerOptions): Promise<void> {
  const { port, configPath } = opts;
  const adminDir = resolveAdminUIDir();

  return new Promise<void>((resolvePromise) => {
    const httpServer: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = req.url ?? '/';
      const pathname = url.split('?')[0];

      // Setup API: status check
      if (pathname === '/admin/api/setup/status' && req.method === 'GET') {
        sendJSON(res, { configured: false });
        return;
      }

      // Setup API: submit configuration
      if (pathname === '/admin/api/setup/configure' && req.method === 'POST') {
        let body: string;
        try {
          body = await readBody(req, 64 * 1024);
        } catch {
          sendError(res, 413, 'Payload too large');
          return;
        }

        let answers: Record<string, unknown>;
        try {
          answers = JSON.parse(body);
        } catch {
          sendError(res, 400, 'Invalid JSON');
          return;
        }

        try {
          // Generate admin token
          const adminToken = randomBytes(32).toString('hex');

          // Build config YAML from wizard answers
          const profile = (answers.profile as string) ?? 'balanced';
          const agentType = (answers.agentType as string) ?? 'pi-coding-agent';
          const apiKey = answers.apiKey as string | undefined;

          const configYaml = buildConfigYaml(profile, agentType, adminToken);

          // Ensure directory exists and write config
          mkdirSync(dirname(configPath), { recursive: true });
          writeFileSync(configPath, configYaml, 'utf-8');

          // Write API key to .env if provided
          if (apiKey) {
            const envPath = join(axHome(), '.env');
            const envContent = `ANTHROPIC_API_KEY=${apiKey}\n`;
            writeFileSync(envPath, envContent, 'utf-8');
          }

          logger.info('setup_config_written', { configPath });

          sendJSON(res, {
            ok: true,
            token: adminToken,
            message: 'Configuration saved. AX is starting up.',
          });

          // Shut down setup server after a brief delay
          setTimeout(() => {
            httpServer.close(() => {
              resolvePromise();
            });
          }, 500);
        } catch (err) {
          logger.error('setup_config_failed', { error: (err as Error).message });
          sendError(res, 500, 'Failed to write configuration');
        }
        return;
      }

      // Static files: serve the dashboard SPA
      if (pathname.startsWith('/admin')) {
        let filePath = pathname.replace(/^\/admin\/?/, '') || 'index.html';
        if (filePath.includes('..')) {
          sendError(res, 400, 'Invalid path');
          return;
        }

        const fullPath = join(adminDir, filePath);
        const resolvedPath = existsSync(fullPath) ? fullPath : join(adminDir, 'index.html');

        if (!existsSync(resolvedPath)) {
          sendError(res, 404, 'Dashboard not built. Run: npm run build:dashboard');
          return;
        }

        const ext = extname(resolvedPath);
        const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
        const content = readFileSync(resolvedPath);

        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': content.length,
        });
        res.end(content);
        return;
      }

      // Redirect root to /admin/setup
      if (pathname === '/' || pathname === '') {
        res.writeHead(302, { Location: '/admin' });
        res.end();
        return;
      }

      sendError(res, 404, 'Not found');
    });

    httpServer.listen(port, '127.0.0.1', () => {
      const setupUrl = `http://127.0.0.1:${port}/admin`;
      logger.info('setup_server_started', { url: setupUrl });
      console.log(`\n  Setup wizard: ${setupUrl}\n`);
      console.log('  Complete the setup wizard in your browser to configure AX.\n');

      // Try to open browser
      openBrowser(setupUrl);
    });
  });
}

function buildConfigYaml(profile: string, agentType: string, adminToken: string): string {
  return `# AX Configuration — generated by setup wizard
profile: ${profile}
agent: ${agentType}

providers:
  memory: cortex
  scanner: patterns
  channels: []
  web: none
  browser: none
  credentials: keychain
  audit: database
  sandbox: subprocess
  scheduler: none

sandbox:
  timeout_sec: 120
  memory_mb: 512

scheduler:
  active_hours:
    start: "07:00"
    end: "23:00"
    timezone: "UTC"
  max_token_budget: 50000
  heartbeat_interval_min: 30

admin:
  enabled: true
  token: "${adminToken}"
  port: 8080
`;
}

function openBrowser(url: string): void {
  const { platform } = process;
  try {
    const { execSync } = require('node:child_process');
    if (platform === 'darwin') {
      execSync(`open "${url}"`);
    } else if (platform === 'linux') {
      execSync(`xdg-open "${url}" 2>/dev/null || true`);
    } else if (platform === 'win32') {
      execSync(`start "" "${url}"`);
    }
  } catch {
    // Not fatal — the URL is printed to the console
  }
}
