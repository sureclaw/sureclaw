/**
 * IPC handlers: browser automation (launch, navigate, snapshot, click, type, screenshot, close).
 */
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';

export function createBrowserHandlers(providers: ProviderRegistry) {
  return {
    browser_launch: async (req: any) => {
      return await providers.browser.launch(req.config ?? {});
    },

    browser_navigate: async (req: any, ctx: IPCContext) => {
      await providers.audit.log({ action: 'browser_navigate', sessionId: ctx.sessionId, args: { url: req.url } });
      await providers.browser.navigate(req.session, req.url);
      return { ok: true };
    },

    browser_snapshot: async (req: any) => {
      return await providers.browser.snapshot(req.session);
    },

    browser_click: async (req: any) => {
      await providers.browser.click(req.session, req.ref);
      return { ok: true };
    },

    browser_type: async (req: any) => {
      await providers.browser.type(req.session, req.ref, req.text);
      return { ok: true };
    },

    browser_screenshot: async (req: any) => {
      const buf = await providers.browser.screenshot(req.session);
      return { data: buf.toString('base64') };
    },

    browser_close: async (req: any) => {
      await providers.browser.close(req.session);
      return { ok: true };
    },
  };
}
