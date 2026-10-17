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
