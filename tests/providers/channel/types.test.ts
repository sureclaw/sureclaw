import { describe, test, expect } from 'vitest';
import { canonicalize, type SessionAddress, type InboundMessage } from '../../../src/providers/channel/types.js';

describe('canonicalize', () => {
  test('serializes DM session', () => {
    const addr: SessionAddress = {
      provider: 'slack',
      scope: 'dm',
      identifiers: { peer: 'U789' },
    };
    expect(canonicalize(addr)).toBe('slack:dm:U789');
  });

  test('serializes channel session', () => {
    const addr: SessionAddress = {
      provider: 'discord',
      scope: 'channel',
      identifiers: { channel: 'C01' },
    };
    expect(canonicalize(addr)).toBe('discord:channel:C01');
  });

  test('serializes thread session with all identifiers', () => {
    const addr: SessionAddress = {
      provider: 'slack',
      scope: 'thread',
      identifiers: { channel: 'C01', thread: '1234.5678' },
    };
    expect(canonicalize(addr)).toBe('slack:thread:C01:1234.5678');
  });

  test('omits empty identifier segments', () => {
    const addr: SessionAddress = {
      provider: 'telegram',
      scope: 'dm',
      identifiers: { peer: 'U999' },
    };
    expect(canonicalize(addr)).toBe('telegram:dm:U999');
  });

  test('serializes scheduler session', () => {
    const addr: SessionAddress = {
      provider: 'scheduler',
      scope: 'dm',
      identifiers: { peer: 'heartbeat' },
    };
    expect(canonicalize(addr)).toBe('scheduler:dm:heartbeat');
  });
});

describe('InboundMessage', () => {
  test('InboundMessage supports isMention field', () => {
    const msg: InboundMessage = {
      id: '1',
      session: { provider: 'test', scope: 'channel', identifiers: {} },
      sender: 'U1',
      content: 'hello',
      attachments: [],
      timestamp: new Date(),
      isMention: true,
    };
    expect(msg.isMention).toBe(true);
  });
});
