import { describe, test, expect } from 'vitest';
import { downloadVerifiedAsset, provisionWriteState, selectChecksumDigest, sha256Hex } from '../provision-core.js';
import { DiagnosticError } from '../../diagnostics/failure.mjs';

describe('selectChecksumDigest(manifest, asset, failurePrefix)', () => {
  // evidence_role: supplemental
  // test_level: unit
  // target_id: selectChecksumDigest(manifest, asset, failurePrefix)
  // Provisioner contracts cover install, rejection and PATH cleanup; these manifest formats are additional boundaries.
  test('selects checksum entries with binary markers and CRLF line endings', () => {
    // Arrange
    const digest = 'a'.repeat(64);
    const asset = 'tool-linux-amd64';
    const manifests = [
      `${'0'.repeat(64)}  other\n${digest} *${asset}\n`,
      `${'0'.repeat(64)}  other\r\n${digest}  ${asset}\r\n`,
    ];
    // Act
    const selected = manifests.map((manifest) => selectChecksumDigest(manifest, asset, 'provision-failed'));
    // Assert
    expect(selected).toStrictEqual([digest, digest]);
  });
});


describe('downloadVerifiedAsset(request)', () => {
  // evidence_role: supplemental
  // test_level: unit
  // target_id: downloadVerifiedAsset(request)
  test.each(['success', 'checksum-failure', 'asset-failure', 'synchronous-failure'])(
    'starts both reads and settles them before returning: %s', async (scenario) => {
      // Arrange
      const content = Buffer.from('verified tool');
      const manifest = Buffer.from(`${sha256Hex(content)}  tool\n`);
      const started: string[] = [];
      const pending = new Map<string, { resolve: (value: Buffer) => void; reject: (error: Error) => void }>();
      let bothStarted!: () => void;
      const starts = new Promise<void>((resolve) => { bothStarted = resolve; });
      const failure = new Error('download unavailable');
      let completed = false;
      // Act
      const result = downloadVerifiedAsset({
        checksumUrl: 'checksum', assetUrl: 'asset', asset: 'tool', failurePrefix: 'provision-failed',
        fetchAsset: (url) => {
          started.push(url);
          if (started.length === 2) bothStarted();
          if (scenario === 'synchronous-failure' && url === 'checksum') throw failure;
          return new Promise<Buffer>((resolve, reject) => { pending.set(url, { resolve, reject }); });
        },
      }).then((value) => { completed = true; return value; }, (error: unknown) => { completed = true; return error; });
      await starts;
      // Assert
      expect(started).toEqual(['checksum', 'asset']);
      expect(completed).toBe(false);
      if (scenario === 'asset-failure') pending.get('asset')!.reject(failure);
      else if (scenario === 'checksum-failure') pending.get('checksum')!.reject(failure);
      else if (scenario === 'success') pending.get('checksum')!.resolve(manifest);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);
      if (scenario === 'asset-failure') pending.get('checksum')!.resolve(manifest);
      else pending.get('asset')!.resolve(content);
      const outcome = await result;
      if (scenario === 'success') expect(outcome).toEqual(content);
      else {
        expect(outcome).toBeInstanceOf(Error);
        expect((outcome as Error).message).toContain('download failed');
        expect((outcome as Error).cause).toBe(failure);
      }
    },
  );
});

describe('provisionWriteState(error)', () => {
  // evidence_role: supplemental
  // test_level: unit
  // target_id: provisionWriteState(error)
  test('reports a write only for failures after the install directory or PATH file was written', () => {
    // Arrange
    const failures = [
      new DiagnosticError('provision-failed: invalid exact version', { diagnostics: { stage: 'version-validation' } }),
      new Error('download-failed'),
      new DiagnosticError('provision-failed: install failed', { diagnostics: { stage: 'asset-install', rollback: 'removed' } }),
      new DiagnosticError('provision-failed: install failed', { diagnostics: { stage: 'asset-install', rollback: 'cleanup-failed' } }),
      new DiagnosticError('provision-failed: PATH update failed', { diagnostics: { stage: 'path-export', rollback: 'removed' } }),
    ];
    // Act
    const states = failures.map((failure) => provisionWriteState(failure));
    // Assert
    expect(states).toStrictEqual(['not-started', 'not-started', 'rolled-back', 'temporary-install-may-exist', 'github-path-may-be-partial']);
  });
});
