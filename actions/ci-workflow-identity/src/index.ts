import { appendFileSync } from 'node:fs';
import { verifyWorkflowIdentity } from './identity.js';

const input = (name: string): string => process.env[`INPUT_${name.toUpperCase()}`] ?? '';

export const run = (): void => {
  try {
    const { sha } = verifyWorkflowIdentity({
      repository: input('repository'),
      defaultBranch: input('default-branch'),
      expectedCallerWorkflowPath: input('expected-caller-workflow-path'),
      expectedCalledWorkflowPath: input('expected-called-workflow-path'),
      callerWorkflowRef: input('caller-workflow-ref'),
      callerWorkflowSha: input('caller-workflow-sha'),
      calledWorkflowRepository: input('called-workflow-repository'),
      calledWorkflowFilePath: input('called-workflow-file-path'),
      calledWorkflowRef: input('called-workflow-ref'),
      calledWorkflowSha: input('called-workflow-sha'),
    });
    const outputPath = process.env.GITHUB_OUTPUT ?? '';
    if (!outputPath) throw new Error('ci-workflow-identity-output-missing');
    if (/[\0\r\n]/.test(outputPath)) throw new Error('ci-workflow-identity-output-invalid');
    appendFileSync(outputPath, `sha=${sha}\n`, 'utf8');
    process.stdout.write(`verified workflow snapshot ${sha}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
