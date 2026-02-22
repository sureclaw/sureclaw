/**
 * IPC handlers: identity_write and user_write.
 * These have custom taint handling (queues instead of hard-blocking).
 */
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderRegistry } from '../../types.js';
import type { TaintBudget } from '../taint-budget.js';
import type { IPCContext } from '../ipc-server.js';
import { agentUserDir } from '../../paths.js';

export interface IdentityHandlerOptions {
  agentDir?: string;
  agentName: string;
  profile: string;
  taintBudget?: TaintBudget;
}

export function createIdentityHandlers(providers: ProviderRegistry, opts: IdentityHandlerOptions) {
  const { agentDir, agentName, profile, taintBudget } = opts;

  return {
    identity_write: async (req: any, ctx: IPCContext) => {
      // 0. Scan proposed content — blocks injection in identity files
      const scanResult = await providers.scanner.scanInput({
        content: req.content,
        source: 'identity_mutation',
        sessionId: ctx.sessionId,
      });
      if (scanResult.verdict === 'BLOCK') {
        await providers.audit.log({
          action: 'identity_write',
          sessionId: ctx.sessionId,
          args: { file: req.file, reason: req.reason, origin: req.origin, decision: 'scanner_blocked', verdict: scanResult.verdict },
        });
        return { ok: false, error: `Identity content blocked by scanner: ${scanResult.reason ?? 'policy violation'}` };
      }

      // 1. Check taint — if tainted, queue for approval (except yolo)
      if (profile !== 'yolo' && taintBudget) {
        const check = taintBudget.checkAction(ctx.sessionId, 'identity_write');
        if (!check.allowed) {
          await providers.audit.log({
            action: 'identity_write',
            sessionId: ctx.sessionId,
            args: { file: req.file, reason: req.reason, origin: req.origin, decision: 'queued_tainted', taintRatio: check.taintRatio },
          });
          return { queued: true, file: req.file, reason: `Taint ${((check.taintRatio ?? 0) * 100).toFixed(0)}% exceeds threshold` };
        }
      }

      // 2. Check profile — paranoid always queues
      if (profile === 'paranoid') {
        await providers.audit.log({
          action: 'identity_write',
          sessionId: ctx.sessionId,
          args: { file: req.file, reason: req.reason, origin: req.origin, decision: 'queued_paranoid' },
        });
        return { queued: true, file: req.file, reason: req.reason };
      }

      // 3. Auto-apply (balanced + clean, or yolo)
      if (!agentDir) {
        return { ok: false, error: 'agentDir not configured' };
      }
      mkdirSync(agentDir, { recursive: true });
      const filePath = join(agentDir, req.file);
      writeFileSync(filePath, req.content, 'utf-8');

      // Bootstrap completion: delete BOOTSTRAP.md from agentDir when SOUL.md is written
      if (req.file === 'SOUL.md') {
        const bootstrapPath = join(agentDir, 'BOOTSTRAP.md');
        try { unlinkSync(bootstrapPath); } catch { /* may not exist */ }
      }

      await providers.audit.log({
        action: 'identity_write',
        sessionId: ctx.sessionId,
        args: { file: req.file, reason: req.reason, origin: req.origin, decision: 'applied' },
      });
      return { applied: true, file: req.file };
    },

    user_write: async (req: any, ctx: IPCContext) => {
      if (!req.userId) {
        return { ok: false, error: 'user_write requires userId in payload' };
      }

      // 0. Scan proposed content — blocks injection in user files
      const scanResult = await providers.scanner.scanInput({
        content: req.content,
        source: 'user_mutation',
        sessionId: ctx.sessionId,
      });
      if (scanResult.verdict === 'BLOCK') {
        await providers.audit.log({
          action: 'user_write',
          sessionId: ctx.sessionId,
          args: { userId: req.userId, reason: req.reason, origin: req.origin, decision: 'scanner_blocked' },
        });
        return { ok: false, error: `User content blocked by scanner: ${scanResult.reason ?? 'policy violation'}` };
      }

      // 1. Taint check
      if (profile !== 'yolo' && taintBudget) {
        const check = taintBudget.checkAction(ctx.sessionId, 'user_write');
        if (!check.allowed) {
          await providers.audit.log({
            action: 'user_write',
            sessionId: ctx.sessionId,
            args: { userId: req.userId, reason: req.reason, origin: req.origin, decision: 'queued_tainted' },
          });
          return { queued: true, reason: `Taint ${((check.taintRatio ?? 0) * 100).toFixed(0)}% exceeds threshold` };
        }
      }

      // 2. Paranoid gate
      if (profile === 'paranoid') {
        await providers.audit.log({
          action: 'user_write',
          sessionId: ctx.sessionId,
          args: { userId: req.userId, reason: req.reason, origin: req.origin, decision: 'queued_paranoid' },
        });
        return { queued: true, reason: req.reason };
      }

      // 3. Write to per-user dir
      const userDir = agentUserDir(agentName, req.userId);
      mkdirSync(userDir, { recursive: true });
      writeFileSync(join(userDir, 'USER.md'), req.content, 'utf-8');

      await providers.audit.log({
        action: 'user_write',
        sessionId: ctx.sessionId,
        args: { userId: req.userId, reason: req.reason, origin: req.origin, decision: 'applied' },
      });
      return { applied: true, userId: req.userId };
    },
  };
}
