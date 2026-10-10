import { createHash } from 'node:crypto';

// Source identity permits checkout CRLF only; retain BOM, whitespace and terminal newlines.
export const sourceTextSha256 = (bytes) => {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('source-text-utf8-invalid'); }
  return createHash('sha256').update(text.replaceAll('\r\n', '\n'), 'utf8').digest('hex');
};
