import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, describe, expect } from 'vitest';
import { loadRegistry } from '../preset-registry.ts';
import { validateActionAvailability } from '../action-availability.ts';
import { validateQualityPlatformSelection } from '../quality-validation.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const manifest = `platforms:
  - id: linux-x64
    runner: ubuntu-24.04
    target: x86_64-unknown-linux-gnu
  - id: macos-arm64
    runner: macos-14
    target: aarch64-apple-darwin
`;

export { root, manifest };
