import { DiagnosticError } from '../diagnostics/failure.mjs';
import fs from 'node:fs';

type Environment = Record<string, string | undefined>;

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const mismatch = (field: string, expected: string, observed: string): never => {
  throw new DiagnosticError('request-trigger-mismatch', { diagnostics: { field, expected, observed } });
};

// A publication caller runs only for a successful dispatch of its own request workflow on the default branch.
// The check runs before any artifact of the triggering run is downloaded.
export const verifyRequestTrigger = (requestWorkflow: string, env: Environment = process.env): { runId: string; headSha: string } => {
  if (env.GITHUB_EVENT_NAME !== 'workflow_run') mismatch('event-name', 'workflow_run', text(env.GITHUB_EVENT_NAME) || 'unset');
  let event: Record<string, unknown>;
  try {
    event = record(JSON.parse(fs.readFileSync(text(env.GITHUB_EVENT_PATH), 'utf8')));
  } catch (cause) {
    throw new DiagnosticError('request-trigger-event-unreadable', { cause });
  }
  const run = record(event.workflow_run);
  const defaultBranch = text(record(event.repository).default_branch);
  const runId = typeof run.id === 'number' || typeof run.id === 'string' ? String(run.id) : '';
  const headSha = text(run.head_sha);
  if (run.conclusion !== 'success') mismatch('conclusion', 'success', text(run.conclusion) || 'unset');
  if (!env.GITHUB_REPOSITORY || record(run.repository).full_name !== env.GITHUB_REPOSITORY) mismatch('repository', 'current-repository', 'other');
  if (run.name !== requestWorkflow) mismatch('workflow-name', requestWorkflow, text(run.name) || 'unset');
  if (run.event !== 'workflow_dispatch') mismatch('event', 'workflow_dispatch', text(run.event) || 'unset');
  if (!defaultBranch) mismatch('default-branch', 'present', 'unset');
  if (run.head_branch !== defaultBranch) mismatch('head-branch', 'default-branch', 'other');
  const workflowPath = `.github/workflows/${requestWorkflow}.yml`;
  if (run.path !== workflowPath && run.path !== `${workflowPath}@${defaultBranch}`) mismatch('workflow-path', workflowPath, 'other');
  if (!/^[1-9][0-9]*$/.test(runId)) mismatch('run-id', 'positive-integer', 'invalid');
  if (!/^[a-f0-9]{40}$/.test(headSha)) mismatch('head-sha', '40-hex', 'invalid');
  return { runId, headSha };
};
