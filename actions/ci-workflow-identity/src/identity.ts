// 呼出元 workflow と reusable workflow が、同じ default branch の同じ commit の snapshot であることを検証する。
export type WorkflowIdentityInput = {
  repository: string;
  defaultBranch: string;
  expectedCallerWorkflowPath: string;
  expectedCalledWorkflowPath: string;
  callerWorkflowRef: string;
  callerWorkflowSha: string;
  calledWorkflowRepository: string;
  calledWorkflowFilePath: string;
  calledWorkflowRef: string;
  calledWorkflowSha: string;
};

const SHA_PATTERN = /^[0-9a-f]{40}$/;

const requireValue = (value: string, code: string): string => {
  if (value.length === 0) throw new Error(code);
  return value;
};

export const verifyWorkflowIdentity = (input: WorkflowIdentityInput): { sha: string } => {
  const repository = requireValue(input.repository, 'ci-workflow-identity-repository-missing');
  const defaultBranch = requireValue(input.defaultBranch, 'ci-workflow-identity-default-branch-missing');
  const expectedCaller = `${repository}/${requireValue(input.expectedCallerWorkflowPath, 'ci-workflow-identity-caller-path-missing')}@refs/heads/${defaultBranch}`;
  const expectedCalled = `${repository}/${requireValue(input.expectedCalledWorkflowPath, 'ci-workflow-identity-called-path-missing')}@refs/heads/${defaultBranch}`;

  if (input.callerWorkflowRef !== expectedCaller) throw new Error('ci-workflow-identity-caller-ref-mismatch');
  if (input.calledWorkflowRepository !== repository) throw new Error('ci-workflow-identity-called-repository-mismatch');
  if (input.calledWorkflowFilePath !== input.expectedCalledWorkflowPath) throw new Error('ci-workflow-identity-called-path-mismatch');
  if (input.calledWorkflowRef !== expectedCalled) throw new Error('ci-workflow-identity-called-ref-mismatch');
  if (!SHA_PATTERN.test(input.callerWorkflowSha) || !SHA_PATTERN.test(input.calledWorkflowSha)) {
    throw new Error('ci-workflow-identity-sha-invalid');
  }
  if (input.callerWorkflowSha !== input.calledWorkflowSha) throw new Error('ci-workflow-identity-sha-mismatch');

  return { sha: input.calledWorkflowSha };
};
