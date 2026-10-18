import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, describe, expect } from 'vitest';
import { scriptRoot } from "./rust-release-scripts.fixtures.mjs";

describe("rust-release-scripts", () => {
  describe("rust-release-scripts-regression", () => {
    // integration_id: rust-release-scripts-regression
    test('Windows build uses case-sensitive package and binary version token checks', () => {
      // Arrange
      // Act
      const script = readFileSync(path.join(scriptRoot, 'ci-release-build.ps1'), 'utf8');
      // Assert
      expect(script).toMatch(/\$package\.version -cne \$authority\.version/);
      expect(script).toMatch(/\$token -ceq \$authority\.version -or \$token -ceq "v\$\(\$authority\.version\)" -or \$token -ceq "V\$\(\$authority\.version\)"/);
      expect(script).toMatch(/\$binaryVersionOutput -split '\[\\x20\\x09\\x0A\\x0D\]\+'/);
      expect(script).toContain("throw 'binary-version-mismatch'");
    });

    // integration_id: rust-release-scripts-regression
    test('Windows package verifies staging before publishing the final output directory', () => {
      // Arrange
      // Act
      const script = readFileSync(path.join(scriptRoot, 'package-release.ps1'), 'utf8');
      // Assert
      expect(script).toMatch(/verify-release-asset\.ps1.*\$staging/);
      expect(script).toMatch(/TrimEnd\(\[IO\.Path\]::DirectorySeparatorChar/);
      expect(script).toMatch(/\[IO\.Directory\]::Move\(\$staging, \$outputPath\)/);
      expect(script).toMatch(/\[IO\.Directory\]::Delete\(\$staging, \$true\)/);
    });
  });
});
