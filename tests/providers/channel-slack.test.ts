import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import type { Config } from '../../src/providers/types.js';

const config = {} as Config;

describe('channel-slack', () => {
  const originalBotToken = process.env.SLACK_BOT_TOKEN;
  const originalAppToken = process.env.SLACK_APP_TOKEN;

  afterEach(() => {
    if (originalBotToken !== undefined) {
      process.env.SLACK_BOT_TOKEN = originalBotToken;
    } else {
      delete process.env.SLACK_BOT_TOKEN;
    }
    if (originalAppToken !== undefined) {
      process.env.SLACK_APP_TOKEN = originalAppToken;
    } else {
      delete process.env.SLACK_APP_TOKEN;
    }
  });

  test('throws without SLACK_BOT_TOKEN', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    const { create } = await import('../../src/providers/channel/slack.js');
    await expect(create(config)).rejects.toThrow('SLACK_BOT_TOKEN');
  });

  test('throws without SLACK_APP_TOKEN', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    delete process.env.SLACK_APP_TOKEN;
    const { create } = await import('../../src/providers/channel/slack.js');
    await expect(create(config)).rejects.toThrow('SLACK_APP_TOKEN');
  });

  test('throws with both tokens missing', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    const { create } = await import('../../src/providers/channel/slack.js');
    await expect(create(config)).rejects.toThrow('SLACK_BOT_TOKEN');
  });
});
