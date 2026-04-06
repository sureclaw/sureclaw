import { describe, test, expect, vi } from 'vitest';
import {
  buildContentWithAttachments,
  ThreadOwnershipMap,
  resolveAgentForMessage,
  maybeAddResponsePrefix,
  type AgentRoutingResult,
} from '../../src/host/server-channels.js';
import type { Attachment, InboundMessage, SessionAddress } from '../../src/providers/channel/types.js';
import type { ContentBlock } from '../../src/types.js';
import type { AgentRegistry, AgentRegistryEntry } from '../../src/host/agent-registry.js';
import type { AgentProvisioner } from '../../src/host/agent-provisioner.js';

const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => logger } as any;

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'ts-123',
    session: {
      provider: 'slack',
      scope: 'dm',
      identifiers: { peer: 'U001' },
    },
    sender: 'U001',
    content: 'hello',
    attachments: [],
    timestamp: new Date(),
    ...overrides,
  };
}

function makeEntry(overrides: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    status: 'active',
    parentId: null,
    agentType: 'pi-coding-agent',
    capabilities: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: 'test',
    admins: [],
    displayName: 'Test Agent',
    agentKind: 'personal',
    ...overrides,
  };
}

describe('buildContentWithAttachments', () => {
  test('uses downloadFn instead of plain fetch for image attachments', async () => {
    const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
    const downloadFn = vi.fn().mockResolvedValue(imageData);

    const attachments: Attachment[] = [{
      filename: 'photo.png',
      mimeType: 'image/png',
      size: 4,
      url: 'https://files.slack.com/files-pri/T01-F01/photo.png',
    }];

    const result = await buildContentWithAttachments('analyze this', attachments, logger, downloadFn);

    expect(downloadFn).toHaveBeenCalledWith(attachments[0]);
    expect(Array.isArray(result)).toBe(true);
    const blocks = result as ContentBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: 'analyze this' });
    expect(blocks[1]).toEqual({
      type: 'image_data',
      data: imageData.toString('base64'),
      mimeType: 'image/png',
    });
  });

  test('falls back to plain fetch when downloadFn is not provided', async () => {
    const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(imageData.buffer),
    }) as any;

    try {
      const attachments: Attachment[] = [{
        filename: 'photo.png',
        mimeType: 'image/png',
        size: 4,
        url: 'https://example.com/photo.png',
      }];

      const result = await buildContentWithAttachments('check this', attachments, logger);

      expect(globalThis.fetch).toHaveBeenCalledWith('https://example.com/photo.png');
      const blocks = result as ContentBlock[];
      expect(blocks).toHaveLength(2);
      expect(blocks[1].type).toBe('image_data');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('falls back to plain fetch when downloadFn returns undefined', async () => {
    const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const downloadFn = vi.fn().mockResolvedValue(undefined);
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(imageData.buffer),
    }) as any;

    try {
      const attachments: Attachment[] = [{
        filename: 'photo.png',
        mimeType: 'image/png',
        size: 4,
        url: 'https://example.com/photo.png',
      }];

      const result = await buildContentWithAttachments('img', attachments, logger, downloadFn);

      expect(downloadFn).toHaveBeenCalled();
      expect(globalThis.fetch).toHaveBeenCalled();
      const blocks = result as ContentBlock[];
      expect(blocks[1].type).toBe('image_data');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('returns plain text when no image attachments', async () => {
    const attachments: Attachment[] = [{
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      size: 1000,
      url: 'https://example.com/doc.pdf',
    }];

    const result = await buildContentWithAttachments('see the doc', attachments, logger);

    expect(result).toBe('see the doc');
  });

  test('returns plain text when all downloads fail', async () => {
    const downloadFn = vi.fn().mockResolvedValue(undefined);
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 }) as any;

    try {
      const attachments: Attachment[] = [{
        filename: 'photo.png',
        mimeType: 'image/png',
        size: 4,
        url: 'https://example.com/photo.png',
      }];

      const result = await buildContentWithAttachments('img', attachments, logger, downloadFn);

      expect(result).toBe('img');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// =====================================================
// ThreadOwnershipMap
// =====================================================

describe('ThreadOwnershipMap', () => {
  test('set and get thread owner', () => {
    const map = new ThreadOwnershipMap();
    map.set('C001', '1234.5678', 'agent-alice');
    expect(map.get('C001', '1234.5678')).toBe('agent-alice');
  });

  test('get returns undefined for unknown thread', () => {
    const map = new ThreadOwnershipMap();
    expect(map.get('C001', '1234.5678')).toBeUndefined();
  });

  test('overwrites existing owner', () => {
    const map = new ThreadOwnershipMap();
    map.set('C001', '1234.5678', 'agent-alice');
    map.set('C001', '1234.5678', 'agent-bob');
    expect(map.get('C001', '1234.5678')).toBe('agent-bob');
  });
});

// =====================================================
// resolveAgentForMessage
// =====================================================

describe('resolveAgentForMessage', () => {
  test('falls back to fallbackAgentName when no provisioner', async () => {
    const msg = makeMsg();
    const result = await resolveAgentForMessage(msg, { fallbackAgentName: 'main' });
    expect(result.agentId).toBe('main');
    expect(result.agentKind).toBe('personal');
  });

  test('uses provisioner for DM messages', async () => {
    const provisioner = {
      resolveAgent: vi.fn().mockResolvedValue(makeEntry({
        id: 'personal-U001-abc',
        displayName: "U001's Agent",
        agentKind: 'personal',
      })),
    } as unknown as AgentProvisioner;

    const msg = makeMsg();
    const result = await resolveAgentForMessage(msg, {
      provisioner,
      fallbackAgentName: 'main',
    });
    expect(result.agentId).toBe('personal-U001-abc');
    expect(result.displayName).toBe("U001's Agent");
  });

  test('uses thread owner for thread messages', async () => {
    const threadOwners = new ThreadOwnershipMap();
    threadOwners.set('C001', '1234.5678', 'shared-backend');

    const registry = {
      get: vi.fn().mockResolvedValue(makeEntry({
        id: 'shared-backend',
        displayName: 'Backend Bot',
        agentKind: 'shared',
      })),
    } as unknown as AgentRegistry;

    const msg = makeMsg({
      session: {
        provider: 'slack',
        scope: 'thread',
        identifiers: { channel: 'C001', thread: '1234.5678' },
      },
    });

    const result = await resolveAgentForMessage(msg, {
      agentRegistry: registry,
      threadOwners,
      fallbackAgentName: 'main',
    });
    expect(result.agentId).toBe('shared-backend');
    expect(result.agentKind).toBe('shared');
  });

  test('uses boundAgentId for channel-bound messages', async () => {
    const registry = {
      get: vi.fn().mockResolvedValue(makeEntry({
        id: 'shared-devops',
        displayName: 'DevOps Bot',
        agentKind: 'shared',
      })),
    } as unknown as AgentRegistry;

    const msg = makeMsg({
      session: {
        provider: 'slack',
        scope: 'channel',
        identifiers: { channel: 'C001' },
      },
      isMention: true,
    });

    const result = await resolveAgentForMessage(msg, {
      agentRegistry: registry,
      boundAgentId: 'shared-devops',
      fallbackAgentName: 'main',
    });
    expect(result.agentId).toBe('shared-devops');
    expect(result.agentKind).toBe('shared');
  });

  test('thread owner takes priority over boundAgentId', async () => {
    const threadOwners = new ThreadOwnershipMap();
    threadOwners.set('C001', '1234.5678', 'personal-alice');

    const registry = {
      get: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'personal-alice') return makeEntry({ id: 'personal-alice', displayName: 'Alice', agentKind: 'personal' });
        if (id === 'shared-devops') return makeEntry({ id: 'shared-devops', displayName: 'DevOps', agentKind: 'shared' });
        return null;
      }),
    } as unknown as AgentRegistry;

    const msg = makeMsg({
      session: {
        provider: 'slack',
        scope: 'thread',
        identifiers: { channel: 'C001', thread: '1234.5678' },
      },
    });

    const result = await resolveAgentForMessage(msg, {
      agentRegistry: registry,
      threadOwners,
      boundAgentId: 'shared-devops',
      fallbackAgentName: 'main',
    });
    expect(result.agentId).toBe('personal-alice');
  });
});

// =====================================================
// maybeAddResponsePrefix
// =====================================================

describe('maybeAddResponsePrefix', () => {
  test('adds prefix for personal agent in channel', () => {
    const routing: AgentRoutingResult = {
      agentId: 'personal-alice',
      displayName: "Alice's Agent",
      agentKind: 'personal',
    };
    const result = maybeAddResponsePrefix('Hello world', routing, 'channel');
    expect(result).toBe("[Alice's Agent] Hello world");
  });

  test('adds prefix for personal agent in thread', () => {
    const routing: AgentRoutingResult = {
      agentId: 'personal-alice',
      displayName: "Alice's Agent",
      agentKind: 'personal',
    };
    const result = maybeAddResponsePrefix('Hello world', routing, 'thread');
    expect(result).toBe("[Alice's Agent] Hello world");
  });

  test('no prefix for personal agent in DM', () => {
    const routing: AgentRoutingResult = {
      agentId: 'personal-alice',
      displayName: "Alice's Agent",
      agentKind: 'personal',
    };
    const result = maybeAddResponsePrefix('Hello world', routing, 'dm');
    expect(result).toBe('Hello world');
  });

  test('no prefix for shared agent in channel', () => {
    const routing: AgentRoutingResult = {
      agentId: 'shared-backend',
      displayName: 'Backend Bot',
      agentKind: 'shared',
    };
    const result = maybeAddResponsePrefix('Hello world', routing, 'channel');
    expect(result).toBe('Hello world');
  });

  test('no prefix for shared agent in thread', () => {
    const routing: AgentRoutingResult = {
      agentId: 'shared-backend',
      displayName: 'Backend Bot',
      agentKind: 'shared',
    };
    const result = maybeAddResponsePrefix('Hello world', routing, 'thread');
    expect(result).toBe('Hello world');
  });
});
