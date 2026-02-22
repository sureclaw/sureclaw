import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore } from '../src/session-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionAddress } from '../src/providers/channel/types.js';

describe('SessionStore', () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-session-store-test-'));
    store = await SessionStore.create(join(tmpDir, 'sessions.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when no session has been tracked', () => {
    const result = store.getLastChannelSession('agent-1');
    expect(result).toBeUndefined();
  });

  it('stores and retrieves a session', () => {
    const session: SessionAddress = {
      provider: 'slack',
      scope: 'channel',
      identifiers: { channel: 'C123', workspace: 'W456' },
    };
    store.trackSession('agent-1', session);
    const result = store.getLastChannelSession('agent-1');
    expect(result).toEqual({
      provider: 'slack',
      scope: 'channel',
      identifiers: { channel: 'C123', workspace: 'W456' },
    });
  });

  it('upserts — keeps only the latest session for a given agentId', () => {
    const first: SessionAddress = {
      provider: 'slack',
      scope: 'dm',
      identifiers: { peer: 'U111' },
    };
    const second: SessionAddress = {
      provider: 'discord',
      scope: 'channel',
      identifiers: { channel: 'D999', workspace: 'guild-1' },
    };
    store.trackSession('agent-1', first);
    store.trackSession('agent-1', second);

    const result = store.getLastChannelSession('agent-1');
    expect(result).toEqual({
      provider: 'discord',
      scope: 'channel',
      identifiers: { channel: 'D999', workspace: 'guild-1' },
    });
  });

  it('isolates sessions by agentId', () => {
    const sessionA: SessionAddress = {
      provider: 'slack',
      scope: 'dm',
      identifiers: { peer: 'U100' },
    };
    const sessionB: SessionAddress = {
      provider: 'discord',
      scope: 'channel',
      identifiers: { channel: 'C200' },
    };
    store.trackSession('agent-a', sessionA);
    store.trackSession('agent-b', sessionB);

    const resultA = store.getLastChannelSession('agent-a');
    const resultB = store.getLastChannelSession('agent-b');
    expect(resultA).toEqual({
      provider: 'slack',
      scope: 'dm',
      identifiers: { peer: 'U100' },
    });
    expect(resultB).toEqual({
      provider: 'discord',
      scope: 'channel',
      identifiers: { channel: 'C200' },
    });
  });

  it('round-trips all SessionAddress identifier fields through JSON serialization', () => {
    const session: SessionAddress = {
      provider: 'slack',
      scope: 'thread',
      identifiers: {
        workspace: 'T-workspace',
        channel: 'C-channel',
        thread: 'ts-1234567890.000100',
        peer: 'U-peer',
      },
    };
    store.trackSession('agent-full', session);
    const result = store.getLastChannelSession('agent-full');
    expect(result).toBeDefined();
    expect(result!.provider).toBe('slack');
    expect(result!.scope).toBe('thread');
    expect(result!.identifiers).toEqual({
      workspace: 'T-workspace',
      channel: 'C-channel',
      thread: 'ts-1234567890.000100',
      peer: 'U-peer',
    });
  });
});
