import fs from 'node:fs';
import path from 'node:path';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test, vi, describe, expect } from 'vitest';
import { fixture, releaseSkillsFixture, selectedReleaseSkillsFixture } from './fixtures.mjs';
import { sha256, canonicalJson } from '../io.ts';
import { validateEvidence } from '../schema.ts';
import { loadAssembly } from '../observation.ts';
import skillPolicy from '../skill-package-policy.json';
// Synchronous child processes block the worker, so Vitest's testTimeout cannot interrupt them; bound each call.
// Measured max 0.03s per call for the Python call; the PowerShell calls were not measurable here, so the 10s limit is an estimate to revisit once they are measured. A timeout means the call regressed:
// investigate its performance or split it before raising the limit.
const spawnTimeoutMs = 10000;

const pwshProbe = spawnSync('pwsh', ['--version'], { encoding: 'utf8', timeout: spawnTimeoutMs });
// A missing pwsh disables the PowerShell tests; a start-up failure or timeout must fail the run instead of skipping them.
if (pwshProbe.error && pwshProbe.error.code !== 'ENOENT') throw pwshProbe.error;
const hasPwsh = pwshProbe.status === 0;

export { spawnTimeoutMs, pwshProbe, hasPwsh };
