import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Serves only the listed release URLs; any other URL answers 404 so that a missing route reads as an unavailable asset.
const preloadSource = `import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
if (process.env.TEST_FAIL_PATH_RENAME === 'true') {
  const rename = fsp.rename;
  fsp.rename = async (source, destination) => {
    if (destination === process.env.GITHUB_PATH) throw new Error('injected PATH promotion failure');
    return rename(source, destination);
  };
  syncBuiltinESMExports();
}
const routes = JSON.parse(fs.readFileSync(process.env.TEST_FETCH_ROUTES, 'utf8'));
globalThis.fetch = async (url) => {
  fs.appendFileSync(process.env.TEST_FETCH_LOG, String(url) + '\\n');
  const body = routes[String(url)];
  return body === undefined ? new Response('', { status: 404 }) : new Response(Buffer.from(body, 'base64'), { status: 200 });
};
`;

export type ProvisionerRun = {
  result: SpawnSyncReturns<string>;
  requested: string[];
};

export const provisionerWorkspace = (parent: string, prefix: string): string => {
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(path.join(parent, prefix));
};

export const runProvisionerEntrypoint = (
  root: string,
  entrypointArgs: string[],
  env: Record<string, string>,
  routes: Record<string, Buffer>,
): ProvisionerRun => {
  const preload = path.join(root, 'mock-fetch.mjs');
  const routesPath = path.join(root, 'fetch-routes.json');
  const logPath = path.join(root, 'fetch-log.txt');
  writeFileSync(preload, preloadSource);
  writeFileSync(routesPath, JSON.stringify(Object.fromEntries(Object.entries(routes).map(([url, body]) => [url, body.toString('base64')]))));
  writeFileSync(logPath, '');
  const result = spawnSync(process.execPath, ['--import', preload, ...entrypointArgs], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_ACTIONS: 'true',
      TEST_FETCH_ROUTES: routesPath,
      TEST_FETCH_LOG: logPath,
      TEST_FAIL_PATH_RENAME: 'false',
      ...env,
    },
  });
  return { result, requested: readFileSync(logPath, 'utf8').split('\n').filter(Boolean) };
};

export const readGithubPath = (githubPath: string): string | undefined =>
  existsSync(githubPath) ? readFileSync(githubPath, 'utf8') : undefined;
