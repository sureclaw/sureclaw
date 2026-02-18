import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Writable } from 'node:stream';

// We'll test via createLogger which returns our Logger interface

describe('Logger', () => {
  let lines: string[];
  let testStream: Writable;

  beforeEach(() => {
    lines = [];
    testStream = new Writable({
      write(chunk, _enc, cb) {
        // pino writes JSON lines
        const text = chunk.toString().trim();
        if (text) lines.push(text);
        cb();
      },
    });
  });

  it('should log info with message and details', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'debug' });
    logger.info('agent_spawn', { sandbox: 'bwrap' });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe(30); // pino info level
    expect(entry.msg).toBe('agent_spawn');
    expect(entry.sandbox).toBe('bwrap');
  });

  it('should log warn level', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'debug' });
    logger.warn('rate_limited', { status: 429 });

    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe(40); // pino warn level
    expect(entry.msg).toBe('rate_limited');
  });

  it('should log error level', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'debug' });
    logger.error('agent_failed', { exitCode: 1 });

    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe(50);
    expect(entry.msg).toBe('agent_failed');
  });

  it('should log debug level', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'debug' });
    logger.debug('ipc_call', { action: 'llm_call' });

    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe(20);
  });

  it('should filter by log level', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'warn' });
    logger.debug('should_not_appear');
    logger.info('should_not_appear');
    logger.warn('should_appear');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).msg).toBe('should_appear');
  });

  it('should create child logger with bound context', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'debug' });
    const child = logger.child({ reqId: 'abc123', component: 'server' });
    child.info('request_start');

    const entry = JSON.parse(lines[0]);
    expect(entry.reqId).toBe('abc123');
    expect(entry.component).toBe('server');
    expect(entry.msg).toBe('request_start');
  });

  it('should nest child logger context', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'debug' });
    const child1 = logger.child({ reqId: 'abc123' });
    const child2 = child1.child({ step: 'proxy' });
    child2.info('call');

    const entry = JSON.parse(lines[0]);
    expect(entry.reqId).toBe('abc123');
    expect(entry.step).toBe('proxy');
  });

  it('should include pid and timestamp', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'debug' });
    logger.info('test');

    const entry = JSON.parse(lines[0]);
    expect(entry.pid).toBe(process.pid);
    expect(entry.time).toBeDefined();
  });
});
