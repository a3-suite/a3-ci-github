import { test, describe, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { repositoryRoot, scriptPath } from "./update-release-aliases.fixtures.mjs";

describe("update-release-aliases", () => {
  test('repository VERSION is a release or development SemVer', () => {
    const version = readFileSync(path.join(repositoryRoot, 'VERSION'), 'utf8').trim();
    expect(version).toMatch(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-dev\.(0|[1-9][0-9]*))?$/);
  });
});


describe("repository-release-alias-update", () => {

  // integration_id: repository-release-alias-update
  test('release workflow delegates alias mutation to the executable repository runtime', () => {
    const workflow = readFileSync(path.join(repositoryRoot, '.github/workflows/release.yml'), 'utf8');
    const marker = '      - name: Update major and minor aliases\n';
    const start = workflow.indexOf(marker);
    expect(start).not.toBe(-1);
    const nextJob = workflow.indexOf('\n\n  ', start);
    const updateStep = workflow.slice(start, nextJob === -1 ? undefined : nextJob);
    expect(updateStep).toMatch(/^          RELEASE_TAG: \$\{\{ inputs\.release-tag \}\}$/m);
    expect(updateStep).toMatch(/^          RELEASE_SHA: \$\{\{ needs\.prepare-distribution\.outputs\.source_sha \}\}$/m);
    expect(updateStep).toMatch(/^        shell: bash$/m);
    expect(updateStep).toMatch(/^        run: runtime\/repository\/update-release-aliases\.sh$/m);
    expect(updateStep).not.toMatch(/^        run: \|/m);
    expect(statSync(scriptPath).mode & 0o111).not.toBe(0);
  });
});
