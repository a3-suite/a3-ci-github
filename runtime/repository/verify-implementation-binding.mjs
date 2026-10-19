import { DiagnosticError } from '../diagnostics/failure.mjs';
import { execFileSync } from 'node:child_process';

// The branch strategy owns how the tagged source reaches main, so a squash may leave the implementation outside the tag's ancestry.
// Consumers still fetch the pinned SHA, so it must stay reachable from a provider branch or tag; checkout's PR merge refs are temporary.
export function assertImplementationReachable(git, implementationSha) {
  let type;
  try { type = git('cat-file', '-t', implementationSha); } catch { type = 'missing'; }
  if (type !== 'commit') throw new DiagnosticError('implementation-binding-commit-required', { diagnostics: { field: 'implementation-binding', expected: 'commit-objects', observed: 'missing-or-not-commit' } });
  if (!git('for-each-ref', '--count=1', '--contains', implementationSha, '--format=%(refname)', 'refs/heads', 'refs/remotes/origin', 'refs/tags')) throw new DiagnosticError('implementation-source-unreachable', { diagnostics: { field: 'implementation-revision', expected: 'reachable-from-branch-or-tag', observed: 'unreachable' } });
}

// Git tree identities include bytes and modes, without checkout line-ending transformations.
export function verifyImplementationBinding(root, binding, actionPaths, { sourceRevision, sourceTree = sourceRevision } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  if (!/^[0-9a-f]{40}$/.test(binding.exactRef) || !/^[0-9a-f]{40}$/.test(sourceRevision)
      || !/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(binding.releaseTag)) throw new DiagnosticError('implementation-binding-identity-invalid', { diagnostics: { field: 'implementation-binding', expected: 'full-sha-and-semver-tag', observed: 'invalid' } });
  assertImplementationReachable(git, binding.exactRef);
  if (git('cat-file', '-t', sourceRevision) !== 'commit') throw new DiagnosticError('implementation-binding-commit-required', { diagnostics: { field: 'implementation-binding', expected: 'commit-objects', observed: 'missing-or-not-commit' } });
  const version = git('show', `${sourceTree}:VERSION`);
  if (binding.releaseTag !== `v${version}` || git('show', `${binding.exactRef}:VERSION`) !== version) throw new DiagnosticError('implementation-binding-version-mismatch', { diagnostics: { field: 'VERSION', expected: 'release-tag-version', observed: 'differs' } });
  // Keep the closure conservative: whole referenced Action directories and the shared runtime tree.
  const paths = [...new Set([...actionPaths, 'runtime'])].sort();
  const checkedObjects = paths.map((relative) => {
    if (relative !== 'runtime' && !/^actions\/[a-z0-9-]+$/.test(relative)) throw new DiagnosticError('implementation-binding-path-invalid', { diagnostics: { field: 'execution-closure-path', expected: 'actions-or-runtime', observed: 'invalid' } });
    const implementationObject = git('rev-parse', `${binding.exactRef}:${relative}`);
    const sourceObject = git('rev-parse', `${sourceTree}:${relative}`);
    if (git('cat-file', '-t', implementationObject) !== 'tree' || implementationObject !== sourceObject) throw new DiagnosticError(`implementation-execution-closure-mismatch: ${relative}`, { diagnostics: { field: 'execution-closure', expected: implementationObject, observed: sourceObject, path: relative } });
    return { path: relative, implementationObject, sourceObject };
  });
  return { implementationSourceRevision: binding.exactRef, sourceRevision, sourceTree,
    releaseTag: binding.releaseTag, implementationBindingStatus: 'verified', checkedObjects };
}
