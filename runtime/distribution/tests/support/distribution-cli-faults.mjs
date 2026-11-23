// Preloaded with `node --import` into the public distribution CLI so process tests can reproduce
// filesystem and transport conditions that the CLI arguments cannot express.
// The configuration arrives as JSON in A3_DISTRIBUTION_CLI_FAULTS; absent keys leave Node behavior unchanged.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const config = JSON.parse(process.env.A3_DISTRIBUTION_CLI_FAULTS ?? '{}');
const matches = (rule, target) => typeof target === 'string'
  && (rule.path ? path.resolve(target) === path.resolve(rule.path) : new RegExp(rule.pattern).test(target));
let removeFailed = false;

const originalRemove = fs.rmSync;
fs.rmSync = (target, options) => {
  if ((config.failRemove ?? []).some((rule) => matches(rule, target))) {
    removeFailed = true;
    throw new Error('injected remove failure');
  }
  return originalRemove(target, options);
};

const watchedHandles = new Set();
const originalOpen = fs.openSync;
fs.openSync = (target, ...rest) => {
  const handle = originalOpen(target, ...rest);
  if ((config.failClose ?? []).some((rule) => matches(rule, target))) watchedHandles.add(handle);
  return handle;
};
const originalClose = fs.closeSync;
fs.closeSync = (handle) => {
  originalClose(handle);
  if (watchedHandles.delete(handle)) throw new Error('injected close failure');
};

// A transaction hook runs once, right after the CLI persists the matching transaction state,
// which is the same point at which the CLI is about to write the next destination or start restoring.
const pendingHooks = [...(config.transactionHooks ?? [])];
const runHookAction = (action) => {
  if (action.write) {
    fs.mkdirSync(path.dirname(action.write.path), { recursive: true });
    fs.writeFileSync(action.write.path, action.write.content);
  }
  if (action.replaceDirectoryWithSymlink) {
    originalRemove(action.replaceDirectoryWithSymlink.directory, { recursive: true, force: true });
    fs.symlinkSync(action.replaceDirectoryWithSymlink.target, action.replaceDirectoryWithSymlink.directory);
  }
  if (action.throw) throw new Error('injected write interruption');
};
const hookMatches = (hook, transaction) => {
  if (transaction.status !== hook.status) return false;
  if (hook.status !== 'applying') return true;
  if (transaction.actions.some((entry) => entry.state === 'writing')) return false;
  const next = transaction.actions.findIndex((entry) => entry.state === 'pending');
  if (next < 0) return false;
  return hook.destination ? transaction.actions[next].destination === hook.destination : next === hook.index;
};
const originalRename = fs.renameSync;
fs.renameSync = (source, destination) => {
  if (removeFailed && (config.failRenameAfterRemoveFailure ?? []).some((rule) => matches(rule, destination))) {
    throw new Error('injected record failure');
  }
  originalRename(source, destination);
  if (!/[\\/]transactions[\\/][^\\/]+[\\/]transaction\.json$/.test(String(destination))) return;
  const transaction = JSON.parse(fs.readFileSync(destination, 'utf8'));
  const index = pendingHooks.findIndex((hook) => hookMatches(hook, transaction));
  if (index >= 0) runHookAction(pendingHooks.splice(index, 1)[0]);
};

// Remote transport: raw source paths are served from a local source tree, Release manifest URLs from a local file.
if (config.transport) {
  const transport = config.transport;
  const originalSetTimeout = globalThis.setTimeout;
  // Retry back-off would only slow the test; the retry count itself is unchanged.
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, 0, ...args);
  let calls = 0;
  const response = (status, location, bytes) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'location' ? location ?? null : null) },
    arrayBuffer: async () => bytes,
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    const parsed = new URL(url);
    if (parsed.hostname === 'github.com' && parsed.pathname.includes('/releases/download/')) {
      return response(302, 'https://release-assets.githubusercontent.com/signed-manifest');
    }
    if (parsed.hostname === 'release-assets.githubusercontent.com') {
      return response(200, null, fs.readFileSync(transport.manifestPath));
    }
    calls += 1;
    if (transport.log) fs.appendFileSync(transport.log, `${url}\n`);
    // A probe records whether the fetch lock is held during each transport call and, at the chosen call,
    // runs a peer fetch to completion while this fetch still holds the lock.
    if (transport.probe) {
      const { lockPath, report, peer } = transport.probe;
      const record = { call: calls, lockPresent: fs.existsSync(lockPath) };
      if (peer && calls === peer.call) {
        const result = spawnSync(process.execPath, peer.argv, { encoding: 'utf8', env: { ...process.env, A3_DISTRIBUTION_CLI_FAULTS: JSON.stringify(peer.faults) } });
        record.peer = { status: result.status, stderr: result.stderr };
      }
      fs.appendFileSync(report, `${JSON.stringify(record)}\n`);
    }
    if (transport.failure) throw transport.failure;
    if (transport.status) return response(transport.status, transport.location);
    if (transport.failFromCall && calls >= transport.failFromCall) throw new Error('injected transport failure');
    if (transport.body !== undefined) return response(200, null, Buffer.from(transport.body));
    const relative = url.split(`/${transport.sourceRevision}/`)[1];
    return response(200, null, fs.readFileSync(path.join(transport.sourceRoot, relative)));
  };
}
