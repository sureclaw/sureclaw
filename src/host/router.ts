import { randomUUID } from 'node:crypto';
import type { ProviderRegistry, TaintTag } from '../types.js';
import { canonicalize, type InboundMessage } from '../providers/channel/types.js';
import type { ScanResult } from '../providers/scanner/types.js';
import type { MessageQueue } from '../db.js';
import type { TaintBudget } from './taint-budget.js';

export interface RouterResult {
  queued: boolean;
  messageId?: string;
  sessionId: string;
  canaryToken: string;
  scanResult: ScanResult;
}

export interface OutboundResult {
  content: string;
  scanResult: ScanResult;
  canaryLeaked: boolean;
}

export interface Router {
  processInbound(msg: InboundMessage): Promise<RouterResult>;
  processOutbound(
    response: string,
    sessionId: string,
    canaryToken: string,
  ): Promise<OutboundResult>;
}

export interface RouterOptions {
  taintBudget?: TaintBudget;
}

export function createRouter(
  providers: ProviderRegistry,
  db: MessageQueue,
  opts?: RouterOptions,
): Router {

  const taintBudget = opts?.taintBudget;

  function taintTag(source: string): TaintTag {
    return { source, trust: 'external', timestamp: new Date() };
  }

  function wrapExternalContent(content: string, source: string): string {
    return `<external_content trust="external" source="${source}">${content}</external_content>`;
  }

  return {
    async processInbound(msg: InboundMessage): Promise<RouterResult> {
      const sessionId = canonicalize(msg.session);
      const canaryToken = providers.scanner.canaryToken();

      // Taint-tag external content
      const isTainted = msg.session.provider !== 'system';
      const taint = taintTag(msg.session.provider);
      const taggedContent = wrapExternalContent(msg.content, msg.session.provider);

      // Record content in taint budget (SC-SEC-003)
      taintBudget?.recordContent(sessionId, msg.content, isTainted);

      // Scan input
      const scanResult = await providers.scanner.scanInput({
        content: msg.content,
        source: msg.channel,
        taint,
        sessionId,
      });

      await providers.audit.log({
        action: 'router_inbound',
        sessionId,
        args: {
          channel: msg.session.provider,
          sender: msg.sender,
          verdict: scanResult.verdict,
        },
        result: scanResult.verdict === 'BLOCK' ? 'blocked' : 'success',
      });

      if (scanResult.verdict === 'BLOCK') {
        return {
          queued: false,
          sessionId,
          canaryToken,
          scanResult,
        };
      }

      // Inject canary token into the content for the agent
      const contentWithCanary = `${taggedContent}\n<!-- canary:${canaryToken} -->`;

      // Enqueue for processing
      const messageId = db.enqueue({
        sessionId,
        channel: msg.session.provider,
        sender: msg.sender,
        content: contentWithCanary,
      });

      return {
        queued: true,
        messageId,
        sessionId,
        canaryToken,
        scanResult,
      };
    },

    async processOutbound(
      response: string,
      sessionId: string,
      canaryToken: string,
    ): Promise<OutboundResult> {
      // Check for canary leakage (empty token = no canary to check)
      const canaryLeaked = canaryToken.length > 0 && providers.scanner.checkCanary(response, canaryToken);

      if (canaryLeaked) {
        await providers.audit.log({
          action: 'canary_leaked',
          sessionId,
          args: {},
          result: 'blocked',
        });
      }

      // Scan output
      const scanResult = await providers.scanner.scanOutput({
        content: response,
        source: 'agent',
        sessionId,
      });

      await providers.audit.log({
        action: 'router_outbound',
        sessionId,
        args: { verdict: scanResult.verdict, canaryLeaked },
        result: scanResult.verdict === 'BLOCK' ? 'blocked' : 'success',
      });

      // Strip canary from response if present
      const cleanContent = canaryToken.length > 0
        ? response.replaceAll(canaryToken, '[REDACTED]')
        : response;

      return {
        content: canaryLeaked ? '[Response redacted: canary token leaked]' : cleanContent,
        scanResult,
        canaryLeaked,
      };
    },
  };
}
