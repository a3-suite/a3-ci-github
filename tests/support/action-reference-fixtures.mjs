import crypto from 'node:crypto';

export const qualityAdapterDescriptor = (boundary = 'read-only') => `schemaVersion: "1"
kind: ci-adapter-bundle
id: node-quality
contract: quality-scripts
languageProfiles: [node]
provider: github
executionBoundary: ${boundary}
sourceCheckout: fixed-source
copyable: true
owner: ci
assets: []
projectSettings:
  requiredFiles: []
  requiredScripts: []
  requiredEnvironmentPaths: []
toolchain:
  versionEnv: CI_TOOLCHAIN_VERSION
  verify:
    command: node
    args: [--version]
preparation:
  - id: prepare
    command: node
    args: [-e, "process.exit(0)"]
commands:
  - id: test
    command: node
    args: [-e, "process.exit(0)"]
`;

export const publicationRequestInputs = (root) => {
  const notes = '# Release\n';
  return { INPUT_OPERATION: 'create-request', 'INPUT_ROOT-DIRECTORY': root,
    'INPUT_RELEASE-REQUEST-RUN-ID': '11', 'INPUT_REQUEST-WORKFLOW-RUN-ID': '22',
    'INPUT_REQUEST-HEAD-SHA': 'a'.repeat(40), 'INPUT_RELEASE-IDENTITY': 'v1.2.3',
    'INPUT_RELEASE-VERSION': '1.2.3', 'INPUT_TARGET-IDENTITY': 'owner/project',
    'INPUT_RELEASE-NOTES': notes, 'INPUT_APPROVAL-ID': 'approval',
    'INPUT_APPROVAL-EXPIRES-AT': '2999-01-01T00:00:00Z',
    'INPUT_APPROVAL-BODY-SHA256': crypto.createHash('sha256').update(notes).digest('hex') };
};
