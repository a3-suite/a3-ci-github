import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test, describe, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import * as sourceVerification from '../runtime/repository/verify-action-packages.mjs';

import { collectActions } from '../runtime/repository/check-action-dist.mjs';
import {
  collectActionPackages,
  runVerificationPlan,
  sharedRuntimeVerificationPlan,
  verificationPlan,
} from '../runtime/repository/verify-action-packages.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export { root };
