import { randomUUID } from 'node:crypto';
import type {
  BrowserProvider, BrowserConfig, BrowserSession, PageSnapshot, Config,
} from '../types.js';

/**
 * Sandboxed Playwright browser provider.
 *
 * Runs Chromium via Playwright with:
 * - Domain allowlist via AX_BROWSER_ALLOWED_DOMAINS (comma-separated)
 * - No raw JS execution exposed to agent — structured commands only
 * - Session management with cleanup
 * - All content is external and should be taint-tagged at the IPC boundary
 *
 * Playwright is an optional dependency — dynamically imported.
 */

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const NAV_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 50_000;
const MAX_REFS = 200;

const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, [role="button"], [role="link"]';

function parseAllowedDomains(): Set<string> | null {
  const raw = process.env.AX_BROWSER_ALLOWED_DOMAINS;
  if (!raw) return null;
  return new Set(
    raw.split(',').map(d => d.trim().toLowerCase()).filter(Boolean),
  );
}

function isDomainAllowed(url: string, allowed: Set<string> | null): boolean {
  if (!allowed) return true;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    for (const domain of allowed) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function validateUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  return parsed;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface SessionState {
  page: any;
  context: any;
}

export async function create(_config: Config): Promise<BrowserProvider> {
  const allowedDomains = parseAllowedDomains();

  let pw: any;
  try {
    pw = await import('playwright');
  } catch {
    throw new Error(
      'Browser provider requires playwright.\n' +
      'Install with: npx playwright install chromium',
    );
  }

  let browser: any = null;
  const sessions = new Map<string, SessionState>();

  async function ensureBrowser(headless: boolean): Promise<any> {
    if (!browser) {
      browser = await pw.chromium.launch({ headless });
    }
    return browser;
  }

  function getSession(id: string): SessionState {
    const s = sessions.get(id);
    if (!s) throw new Error(`Browser session not found: ${id}`);
    return s;
  }

  return {
    async launch(config: BrowserConfig): Promise<BrowserSession> {
      const b = await ensureBrowser(config.headless ?? true);
      const viewport = {
        width: config.viewport?.width ?? DEFAULT_VIEWPORT.width,
        height: config.viewport?.height ?? DEFAULT_VIEWPORT.height,
      };
      const context = await b.newContext({ viewport });
      const page = await context.newPage();
      const id = randomUUID();
      sessions.set(id, { page, context });
      return { id };
    },

    async navigate(sessionId: string, url: string): Promise<void> {
      const parsed = validateUrl(url);
      if (!isDomainAllowed(url, allowedDomains)) {
        throw new Error(`Domain not in allowlist: ${parsed.hostname}`);
      }
      const { page } = getSession(sessionId);
      await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    },

    async snapshot(sessionId: string): Promise<PageSnapshot> {
      const { page } = getSession(sessionId);

      const title: string = await page.title();
      const url: string = page.url();

      // Extract readable text (structured command, not arbitrary JS)
      const text: string = await page.evaluate(
        () => (document.body?.innerText ?? ''),
      );

      // Extract interactive elements
      const refs: PageSnapshot['refs'] = await page.evaluate(
        (sel: string) => {
          const out: { ref: number; tag: string; text: string }[] = [];
          const nodes = document.querySelectorAll(sel);
          nodes.forEach((el, i) => {
            const tag = el.tagName.toLowerCase();
            const t =
              (el as HTMLElement).innerText?.trim().slice(0, 100) ||
              (el as HTMLInputElement).placeholder ||
              el.getAttribute('aria-label') ||
              '';
            if (t || tag === 'input') out.push({ ref: i, tag, text: t });
          });
          return out;
        },
        INTERACTIVE_SELECTOR,
      );

      return {
        title,
        url,
        text: text.slice(0, MAX_TEXT_CHARS),
        refs: refs.slice(0, MAX_REFS),
      };
    },

    async click(sessionId: string, ref: number): Promise<void> {
      const { page } = getSession(sessionId);
      const els = await page.$$(INTERACTIVE_SELECTOR);
      if (ref < 0 || ref >= els.length) {
        throw new Error(`Invalid ref ${ref}: ${els.length} interactive elements`);
      }
      await els[ref].click();
    },

    async type(sessionId: string, ref: number, text: string): Promise<void> {
      const { page } = getSession(sessionId);
      const els = await page.$$(INTERACTIVE_SELECTOR);
      if (ref < 0 || ref >= els.length) {
        throw new Error(`Invalid ref ${ref}: ${els.length} interactive elements`);
      }
      await els[ref].fill(text);
    },

    async screenshot(sessionId: string): Promise<Buffer> {
      const { page } = getSession(sessionId);
      return await page.screenshot({ type: 'png', fullPage: false });
    },

    async close(sessionId: string): Promise<void> {
      const session = sessions.get(sessionId);
      if (!session) return;
      await session.context.close();
      sessions.delete(sessionId);

      if (sessions.size === 0 && browser) {
        await browser.close();
        browser = null;
      }
    },
  };
}
