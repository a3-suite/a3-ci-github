import { test, describe, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoUntrackedDist,
  assertTrackedReferences,
  buildPlan,
  collectActions,
  runPlan,
  collectScriptBundles,
} from '../runtime/repository/check-action-dist.mjs';
import { safeErrorReason } from '../runtime/diagnostics/failure.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export { root };
