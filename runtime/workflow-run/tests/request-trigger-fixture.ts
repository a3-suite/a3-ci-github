import fs from 'node:fs';
import path from 'node:path';

// Writes a workflow_run event payload for a successful default-branch dispatch and returns the runner environment for it.
export const requestTriggerEnvironment = (root: string, requestWorkflow: string, run: Record<string, unknown> = {}): Record<string, string> => {
  const eventPath = path.join(root, `${requestWorkflow}-event.json`);
  fs.writeFileSync(eventPath, JSON.stringify({
    repository: { default_branch: 'main' },
    workflow_run: {
      id: 22, conclusion: 'success', name: requestWorkflow, event: 'workflow_dispatch', head_branch: 'main',
      path: `.github/workflows/${requestWorkflow}.yml@main`, head_sha: 'a'.repeat(40), repository: { full_name: 'owner/project' }, ...run,
    },
  }));
  return { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: 'owner/project' };
};

export function* rejectedRequestTriggerEnvironments(root: string, workflow: string) {
  const mismatches: [string, Record<string, unknown>, Record<string, string>?][] = [
    ['event-name', {}, { GITHUB_EVENT_NAME: 'push' }],
    ['conclusion', { conclusion: 'failure' }],
    ['repository', { repository: { full_name: 'other/project' } }],
    ['workflow-name', { name: 'other-request' }],
    ['event', { event: 'push' }],
    ['head-branch', { head_branch: 'feature' }],
    ['workflow-path', { path: '.github/workflows/other.yml' }],
    ['run-id', { id: 0 }],
    ['head-sha', { head_sha: 'A'.repeat(40) }],
  ];
  for (const [field, run, overrides] of mismatches) {
    yield { field, reason: 'request-trigger-mismatch', env: { ...requestTriggerEnvironment(root, workflow, run), ...overrides } };
  }
  const env = requestTriggerEnvironment(root, workflow);
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  fs.writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify({ ...event, repository: {} }));
  yield { field: 'default-branch', reason: 'request-trigger-mismatch', env };

  fs.writeFileSync(env.GITHUB_EVENT_PATH, '{"secret-value"');
  yield { field: 'malformed-event', reason: 'request-trigger-event-unreadable', env };
  yield { field: 'missing-event', reason: 'request-trigger-event-unreadable', env: { ...env, GITHUB_EVENT_PATH: path.join(root, 'missing.json') } };
}
