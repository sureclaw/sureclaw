import { randomUUID } from 'node:crypto';
import type {
  ProviderRegistry,
  InboundMessage,
  TaintTag,
  ScanResult,
} from './providers/types.js';
import type { MessageQueue } from './db.js';

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

export function createRouter(
  providers: ProviderRegistry,
  db: MessageQueue,
): Router {

  function taintTag(source: string): TaintTag {
    return { source, trust: 'external', timestamp: new Date() };
  }

  function wrapExternalContent(content: string, source: string): string {
    return `<external_content trust="external" source="${source}">${content}</external_content>`;
  }

  return {
    async processInbound(msg: InboundMessage): Promise<RouterResult> {
      const sessionId = msg.id ?? randomUUID();
      const canaryToken = providers.scanner.canaryToken();

      // Taint-tag external content
      const taint = taintTag(msg.channel);
      const taggedContent = wrapExternalContent(msg.content, msg.channel);

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
          channel: msg.channel,
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
        channel: msg.channel,
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
      // Check for canary leakage
      const canaryLeaked = providers.scanner.checkCanary(response, canaryToken);

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
      const cleanContent = response.replaceAll(canaryToken, '[REDACTED]');

      return {
        content: canaryLeaked ? '[Response redacted: canary token leaked]' : cleanContent,
        scanResult,
        canaryLeaked,
      };
    },
  };
}
