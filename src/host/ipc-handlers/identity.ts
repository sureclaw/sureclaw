/**
 * IPC handlers: identity_read, identity_write, and user_write.
 * These have custom taint handling (queues instead of hard-blocking).
 *
 * All identity/user data is stored via DocumentStore (providers.storage.documents).
 */
import type { ProviderRegistry } from '../../types.js';
import type { TaintBudget } from '../taint-budget.js';
import type { IPCContext } from '../ipc-server.js';
import { join } from 'node:path';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { agentDir as agentDirPath, agentIdentityDir, agentIdentityFilesDir } from '../../paths.js';
import { isAdmin } from '../server-admin-helpers.js';

/**
 * Returns true when the admins file exists and contains at least one entry.
 * In k8s, the agent-runtime pod creates an empty admins file at startup but
 * never populates it (admin claims happen on the host pod with a separate
 * filesystem). When no admins are configured locally, the admin gate is
 * meaningless and should be skipped — access control is handled at the host layer.
 */
function hasAnyAdmin(agentDir: string): boolean {
  const adminsPath = join(agentDir, 'admins');
  if (!existsSync(adminsPath)) return false;
  const lines = readFileSync(adminsPath, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
  return lines.length > 0;
}

export interface IdentityHandlerOptions {
  agentName: string;
  profile: string;
  taintBudget?: TaintBudget;
}

export function createIdentityHandlers(providers: ProviderRegistry, opts: IdentityHandlerOptions) {
  const { agentName, profile, taintBudget } = opts;

  const topDir = agentDirPath(agentName);
  const documents = providers.storage.documents;

  return {
    identity_read: async (req: any, _ctx: IPCContext) => {
      const key = `${agentName}/${req.file}`;
      const content = await documents.get('identity', key);
      return { content: content ?? '', file: req.file };
    },

    identity_write: async (req: any, ctx: IPCContext) => {
      // 0a. Admin gate — non-admin users cannot directly modify identity files.
      // Skip when no admins are configured locally (e.g. k8s agent-runtime where
      // admin state lives on the host pod's filesystem, not here).
      if (ctx.userId && !isAdmin(topDir, ctx.userId) && hasAnyAdmin(topDir)) {
        await providers.audit.log({
          action: 'identity_write',
          sessionId: ctx.sessionId,
          args: { file: req.file, reason: req.reason, origin: req.origin, decision: 'rejected_non_admin', userId: ctx.userId },
        });
        return { queued: true, file: req.file, reason: 'Non-admin users cannot directly modify identity files' };
      }

      // 0b. Scan proposed content — blocks injection in identity files
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

      // 3. Auto-apply (balanced + clean, or yolo) — write to DocumentStore
      const key = `${agentName}/${req.file}`;
      await documents.put('identity', key, req.content);

      // Bootstrap completion: delete BOOTSTRAP.md once both SOUL.md and IDENTITY.md exist.
      // Check DocumentStore (authoritative) rather than filesystem — filesystem may not
      // have identity files when using GCS/cloud-backed DocumentStore.
      if (req.file === 'SOUL.md' || req.file === 'IDENTITY.md') {
        const otherFile = req.file === 'SOUL.md' ? 'IDENTITY.md' : 'SOUL.md';
        const otherKey = `${agentName}/${otherFile}`;
        const otherExists = await documents.get('identity', otherKey);
        if (otherExists) {
          // Both SOUL.md and IDENTITY.md exist in DocumentStore — bootstrap is complete
          await documents.delete('identity', `${agentName}/BOOTSTRAP.md`);
          // Also clean up filesystem BOOTSTRAP.md for isAgentBootstrapMode() compat
          const configDir = agentIdentityDir(agentName);
          const idFilesDir = agentIdentityFilesDir(agentName);
          try { unlinkSync(join(configDir, 'BOOTSTRAP.md')); } catch { /* may not exist */ }
          try { unlinkSync(join(idFilesDir, 'BOOTSTRAP.md')); } catch { /* may not exist */ }
          try { unlinkSync(join(topDir, '.bootstrap-admin-claimed')); } catch { /* may not exist */ }
        }
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

      // 0a. Admin gate — non-admins can only write their own user file.
      // Skip when no admins are configured locally (k8s agent-runtime compat).
      if (ctx.userId && ctx.userId !== req.userId && !isAdmin(topDir, ctx.userId) && hasAnyAdmin(topDir)) {
        await providers.audit.log({
          action: 'user_write',
          sessionId: ctx.sessionId,
          args: { userId: req.userId, reason: req.reason, origin: req.origin, decision: 'rejected_non_admin', callerUserId: ctx.userId },
        });
        return { queued: true, reason: 'Non-admin users can only write their own user file' };
      }

      // 0b. Scan proposed content — blocks injection in user files
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

      // 3. Write to DocumentStore under per-user key
      const key = `${agentName}/users/${req.userId}/USER.md`;
      await documents.put('identity', key, req.content);

      await providers.audit.log({
        action: 'user_write',
        sessionId: ctx.sessionId,
        args: { userId: req.userId, reason: req.reason, origin: req.origin, decision: 'applied' },
      });
      return { applied: true, userId: req.userId };
    },
  };
}
