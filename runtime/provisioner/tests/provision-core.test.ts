import assert from 'node:assert/strict';
import { test } from 'vitest';
import { selectChecksumDigest } from '../provision-core.js';

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
  assert.deepEqual(selected, [digest, digest]);
});
