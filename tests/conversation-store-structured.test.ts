import { describe, test, expect } from 'vitest';
import {
  serializeContent,
  deserializeContent,
} from '../src/conversation-store.js';
import type { ContentBlock } from '../src/types.js';

describe('conversation store structured content', () => {
  describe('serializeContent', () => {
    test('returns plain string as-is', () => {
      expect(serializeContent('Hello world')).toBe('Hello world');
    });

    test('serializes ContentBlock[] to JSON', () => {
      const blocks: ContentBlock[] = [
        { type: 'text', text: 'Hello' },
        { type: 'image', fileId: 'files/abc.png', mimeType: 'image/png' },
      ];
      const result = serializeContent(blocks);
      expect(result).toBe(JSON.stringify(blocks));
    });

    test('serializes text-only ContentBlock[] to JSON', () => {
      const blocks: ContentBlock[] = [{ type: 'text', text: 'Hello' }];
      const result = serializeContent(blocks);
      expect(result).toBe(JSON.stringify(blocks));
    });

    test('strips image_data blocks before serializing', () => {
      const blocks: ContentBlock[] = [
        { type: 'text', text: 'Here is the chart:' },
        { type: 'image_data', data: 'iVBORw0KGgoAAAA==', mimeType: 'image/png' },
        { type: 'image', fileId: 'files/abc.png', mimeType: 'image/png' },
      ];
      const result = serializeContent(blocks);
      const parsed = JSON.parse(result);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toEqual({ type: 'text', text: 'Here is the chart:' });
      expect(parsed[1]).toEqual({ type: 'image', fileId: 'files/abc.png', mimeType: 'image/png' });
    });

    test('strips all image_data blocks when array is entirely image_data', () => {
      const blocks: ContentBlock[] = [
        { type: 'image_data', data: 'AAAA', mimeType: 'image/jpeg' },
      ];
      const result = serializeContent(blocks);
      expect(result).toBe('[]');
    });
  });

  describe('deserializeContent', () => {
    test('returns plain string as-is', () => {
      expect(deserializeContent('Hello world')).toBe('Hello world');
    });

    test('returns string that starts with [ but is not valid JSON', () => {
      expect(deserializeContent('[invalid json')).toBe('[invalid json');
    });

    test('returns string that starts with [ but is not ContentBlock array', () => {
      expect(deserializeContent('[1, 2, 3]')).toBe('[1, 2, 3]');
    });

    test('deserializes ContentBlock[] from JSON', () => {
      const blocks: ContentBlock[] = [
        { type: 'text', text: 'Hello' },
        { type: 'image', fileId: 'files/abc.png', mimeType: 'image/png' },
      ];
      const serialized = JSON.stringify(blocks);
      const result = deserializeContent(serialized);
      expect(result).toEqual(blocks);
    });

    test('round-trips text content', () => {
      const content = 'Just a string';
      expect(deserializeContent(serializeContent(content))).toBe(content);
    });

    test('round-trips ContentBlock[]', () => {
      const blocks: ContentBlock[] = [
        { type: 'text', text: 'Describe this image' },
        { type: 'image', fileId: 'files/photo.jpg', mimeType: 'image/jpeg' },
      ];
      const result = deserializeContent(serializeContent(blocks));
      expect(result).toEqual(blocks);
    });
  });
});
