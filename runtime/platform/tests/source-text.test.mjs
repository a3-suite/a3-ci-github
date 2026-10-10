import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { sourceTextSha256 } from '../source-text.mjs';

describe('source-text-identity', () => {
  test('normalizes CRLF only and preserves other UTF-8 bytes', () => {
    // Arrange
    const lf = '名前: 値\nsecond: value\n';
    const digest = createHash('sha256').update(lf).digest('hex');
    // Act / Assert
    for (const value of [lf, lf.replaceAll('\n', '\r\n'), lf.replace('\n', '\r\n')]) {
      expect(sourceTextSha256(Buffer.from(value))).toBe(digest);
    }
    for (const value of [`\uFEFF${lf}`, lf.trimEnd(), `${lf} `, lf.replaceAll('\n', '\r'), lf.replace('値', '別')]) {
      expect(sourceTextSha256(Buffer.from(value))).not.toBe(digest);
      expect(sourceTextSha256(Buffer.from(value))).toBe(createHash('sha256').update(value).digest('hex'));
    }
    expect(() => sourceTextSha256(Buffer.from([0xc3, 0x28]))).toThrow('source-text-utf8-invalid');
  });
});
