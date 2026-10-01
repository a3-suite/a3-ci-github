import fs from 'node:fs';
import path from 'node:path';
import { SOURCE_ROOT, add, map, parseYaml, strings } from './ci-preset-assets.ts';
import type { ValueMap } from './ci-preset-assets.ts';
import type { Report } from './validation-report.ts';
import { effectivePermissions, on, permissionRank, uses } from './workflow-validation.ts';

const CI_SCRIPT_CONTRACT_PATH = path.resolve(
  SOURCE_ROOT,
  'skills/ci-github/references/ci-script-contracts.reference.yml',
);

const supplementalAdapterInputs = (
  phaseName: string,
  argumentValues: Record<string, string>,
  report: Report,
): ValueMap | undefined => {
  if (!fs.existsSync(CI_SCRIPT_CONTRACT_PATH)) {
    add(report.missingSettings, {
      path: CI_SCRIPT_CONTRACT_PATH,
      message: 'CI script contract is missing',
    });
    return undefined;
  }
  const definitions = map(parseYaml(
    fs.readFileSync(CI_SCRIPT_CONTRACT_PATH, 'utf8'),
    CI_SCRIPT_CONTRACT_PATH,
    report,
  ));
  const contract = (Array.isArray(definitions.contracts) ? definitions.contracts : [])
    .map(map)
    .find((item) => item.id === 'release-supplemental-asset-build-scripts');
  const phase = map(map(map(contract?.adapterInterface).phases)[phaseName]);
  const subcommand = phase.subcommand;
  const argumentsFromContract = strings(phase.arguments);
  const resolvedArguments = argumentsFromContract.map((argument) => argumentValues[argument]);
  if (typeof subcommand !== 'string' || subcommand === ''
    || argumentsFromContract.length === 0
    || resolvedArguments.some((argument) => argument === undefined)) {
    add(report.mismatches, {
      path: CI_SCRIPT_CONTRACT_PATH,
      message: `supplemental asset adapter phase ${phaseName} is invalid`,
    });
    return undefined;
  }
  const inputMapping: Record<string, string> = {
    'authority-context-path': 'authority-path', 'config-snapshot-path': 'snapshot-path',
    'standard-platform-build-directory': 'standard-build-root', 'standard-platform-build-root': 'standard-build-root',
    'supplemental-platform-build-root': 'supplemental-build-root',
    'supplemental-platform-output-directory': 'output-directory', 'output-directory': 'output-directory',
  };
  if (argumentsFromContract.some((argument) => !inputMapping[argument])) {
    add(report.mismatches, { path: CI_SCRIPT_CONTRACT_PATH, message: 'supplemental adapter arguments have no GitHub Action mapping' });
    return undefined;
  }
  return { operation: subcommand, ...Object.fromEntries(argumentsFromContract.map((argument, index) => [inputMapping[argument], resolvedArguments[index]])) };
};

const supplementalActionMatches = (step: ValueMap | undefined, inputs: ValueMap | undefined): boolean => Boolean(
  step && inputs && typeof step.uses === 'string'
  && step.uses.startsWith('a3-suite/a3-ci-github/actions/ci-release-supplemental-asset@')
  && step.run === undefined && step.shell === undefined
  && (step['continue-on-error'] === undefined || step['continue-on-error'] === false)
  && JSON.stringify(Object.entries(map(step.with)).sort()) === JSON.stringify(Object.entries(inputs).sort()),
);

const workflowCallRequired = (workflow: ValueMap): { inputs: string[]; secrets: string[] } => {
  const call = map(on(workflow).workflow_call);
  const required = (value: unknown): string[] => Object.entries(map(value))
    .filter(([, config]) => map(config).required === true)
    .map(([name]) => name);
  return { inputs: required(call.inputs), secrets: required(call.secrets) };
};

const validateCaller = (
  callerPath: string,
  caller: ValueMap,
  workflows: Map<string, ValueMap>,
  report: Report,
): void => {
  for (const [jobName, jobValue] of Object.entries(map(caller.jobs))) {
    const job = map(jobValue);
    if (typeof job.uses !== 'string' || !job.uses.startsWith('./.github/workflows/')) continue;
    const targetPath = job.uses.slice(2);
    const target = workflows.get(targetPath);
    if (!target) continue;
    const required = workflowCallRequired(target);
    for (const input of required.inputs) {
      if (!(input in map(job.with))) add(report.missingSettings, {
        path: `${callerPath}:jobs.${jobName}.with.${input}`,
        message: `required reusable workflow input ${input} is missing`,
        settingLocation: callerPath,
      });
    }
    for (const secret of required.secrets) {
      if (!(secret in map(job.secrets))) add(report.missingSettings, {
        path: `${callerPath}:jobs.${jobName}.secrets.${secret}`,
        message: `required reusable workflow secret ${secret} is missing`,
        settingLocation: callerPath,
      });
    }
    const callerPermissions = effectivePermissions(caller, job);
    for (const targetJob of Object.values(map(target.jobs)).map(map)) {
      for (const [permission, level] of Object.entries(effectivePermissions(target, targetJob))) {
        if (permissionRank(callerPermissions[permission]) < permissionRank(level)) add(report.mismatches, {
          path: `${callerPath}:jobs.${jobName}.permissions.${permission}`,
          message: `caller permission is below reusable workflow requirement ${String(level)}`,
          settingLocation: callerPath,
        });
      }
    }
  }
};

const workflowRunText = (workflow: ValueMap): string =>
  Object.values(map(workflow.jobs))
    .flatMap((job) => Array.isArray(map(job).steps) ? map(job).steps as unknown[] : [])
    .map((step) => map(step).run)
    .filter((run): run is string => typeof run === 'string')
    .join('\n');

const workflowActionOperations = (workflow: ValueMap, actionPath: string): string[] =>
  Object.values(map(workflow.jobs))
    .flatMap((job) => Array.isArray(map(job).steps) ? map(job).steps as unknown[] : [])
    .map(map)
    .filter((step) => typeof step.uses === 'string' && step.uses.includes(`/${actionPath}@`))
    .map((step) => map(step.with).operation)
    .filter((operation): operation is string => typeof operation === 'string');

const validatePublicationConcurrency = (
  workflows: Map<string, ValueMap>,
  report: Report,
): void => {
  for (const publicationPath of [
    '.github/workflows/release-publication.yml',
    '.github/workflows/package-publication.yml',
  ]) {
    const workflow = workflows.get(publicationPath);
    if (!workflow) continue;
    const concurrency = map(workflow.concurrency);
    if (concurrency['cancel-in-progress'] !== false) add(report.mismatches, {
      path: `${publicationPath}:concurrency.cancel-in-progress`,
      message: 'publication must not cancel a running run',
      settingLocation: publicationPath,
    });
    if (concurrency.queue !== 'max') add(report.mismatches, {
      path: `${publicationPath}:concurrency.queue`,
      message: 'publication must preserve pending runs within the provider queue limit',
      settingLocation: publicationPath,
    });
    const group = String(concurrency.group ?? '');
    const target = publicationPath.endsWith('package-publication.yml');
    const requiredGroupTokens = target
      ? ['github.workflow', 'github.repository', 'inputs.target_identity']
      : ['github.workflow', 'github.repository'];
    const forbiddenGroupTokens = ['github.run_id', 'github.sha'];
    if (requiredGroupTokens.some((token) => !group.includes(token))
      || forbiddenGroupTokens.some((token) => group.includes(token))) add(report.mismatches, {
      path: `${publicationPath}:concurrency.group`,
      message: 'publication concurrency group must bind the logical target without run identity',
      settingLocation: publicationPath,
    });
  }
};

const validatePackagePublicationFlow = (
  workflows: Map<string, ValueMap>,
  report: Report,
): void => {
  const requestPath = '.github/workflows/package-publication-request.yml';
  const callerPath = '.github/workflows/package-publication-caller.yml';
  const caller = workflows.get(callerPath);
  if (!workflows.get(requestPath) || !caller) return;
  const triggerWorkflows = strings(map(on(caller).workflow_run).workflows);
  if (triggerWorkflows.length !== 1 || triggerWorkflows[0] !== 'package-publication-request') add(report.mismatches, {
    path: `${callerPath}:on.workflow_run.workflows`,
    message: 'package publication caller must only accept package-publication-request',
    settingLocation: callerPath,
  });
  const validateJob = map(map(caller.jobs)['validate-request']);
  if (Object.prototype.hasOwnProperty.call(validateJob, 'if')) add(report.mismatches, {
    path: `${callerPath}:jobs.validate-request.if`,
    message: 'trigger conclusion must be validated as a failure, not skipped at job level',
    settingLocation: callerPath,
  });
  const callerRuns = workflowRunText(caller);
  for (const token of [
    'REQUEST_CONCLUSION',
    '.github/workflows/package-publication-request.yml',
    'REQUEST_WORKFLOW_NAME',
    'REQUEST_WORKFLOW_PATH',
    'test "$REQUEST_HEAD_BRANCH" = "$DEFAULT_BRANCH"',
    'REQUEST_HEAD_SHA',
  ]) {
    if (!callerRuns.includes(token)) add(report.missingSettings, {
      path: `${callerPath}:jobs.validate-request.steps`,
      message: `package publication caller provenance check is missing: ${token}`,
      settingLocation: callerPath,
    });
  }
  if (!workflowActionOperations(caller, 'actions/ci-package-publication-request').includes('verify')) add(report.missingSettings, {
    path: `${callerPath}:jobs.validate-request.steps`,
    message: 'package publication caller is missing Action request verification',
    settingLocation: callerPath,
  });
};

const validateReleaseRequestWorkflow = (
  requestPath: string,
  request: ValueMap,
  report: Report,
): void => {
  const requestInputs = map(map(on(request).workflow_dispatch).inputs);
  if (Object.prototype.hasOwnProperty.call(requestInputs, 'notes_handoff_run_id')) add(report.mismatches, {
    path: `${requestPath}:on.workflow_dispatch.inputs.notes_handoff_run_id`,
    message: 'release notes handoff run ID must not be supplied by the operator',
    settingLocation: requestPath,
  });
  if (!JSON.stringify(request).includes('"name":"release-notes-handoff"')) add(report.missingSettings, {
    path: `${requestPath}:jobs.request.steps`,
    message: 'release publication request must upload release-notes-handoff',
    settingLocation: requestPath,
  });
  if (!workflowActionOperations(request, 'actions/ci-release-publication-control').includes('create-request')) add(report.missingSettings, {
    path: `${requestPath}:jobs.request.steps`,
    message: 'release publication request is missing Action handoff binding: create-request',
    settingLocation: requestPath,
  });
};

const validateSupplementalOwnerContract = (
  callerPath: string,
  publishWith: ValueMap,
  report: Report,
): void => {
  const supplementalAssetEnabled = publishWith.supplemental_release_asset_enabled;
  const supplementalAssetOwnerContract = publishWith.supplemental_release_asset_owner_contract;
  const ownerContractPath = `${callerPath}:jobs.publish.with.supplemental_release_asset_owner_contract`;
  if (supplementalAssetEnabled === true) {
    if (typeof supplementalAssetOwnerContract !== 'string'
      || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/.test(
        supplementalAssetOwnerContract,
      )) {
      add(report.mismatches, {
        path: ownerContractPath,
        message: 'enabled supplemental asset requires one static dot-separated owner contract ID',
        settingLocation: callerPath,
      });
    }
  } else if (supplementalAssetEnabled === false && supplementalAssetOwnerContract !== '__unset__') add(report.mismatches, {
    path: ownerContractPath,
    message: 'disabled supplemental asset must use the __unset__ owner contract sentinel',
    settingLocation: callerPath,
  });
};

const validateReleaseCallerWorkflow = (
  callerPath: string,
  caller: ValueMap,
  report: Report,
): ValueMap => {
  const triggerWorkflows = strings(map(on(caller).workflow_run).workflows);
  if (triggerWorkflows.length !== 1 || triggerWorkflows[0] !== 'release-publication-request') add(report.mismatches, {
    path: `${callerPath}:on.workflow_run.workflows`,
    message: 'release publication caller must only accept release-publication-request',
    settingLocation: callerPath,
  });
  const callerJobs = map(caller.jobs);
  const validateJob = map(callerJobs['validate-request']);
  if (Object.prototype.hasOwnProperty.call(validateJob, 'if')) add(report.mismatches, {
    path: `${callerPath}:jobs.validate-request.if`,
    message: 'trigger conclusion must be validated as a failure, not skipped at job level',
    settingLocation: callerPath,
  });
  const callerRuns = workflowRunText(caller);
  for (const token of [
    'REQUEST_CONCLUSION',
    '.github/workflows/release-publication-request.yml',
    'REQUEST_WORKFLOW_PATH',
    'test "$REQUEST_HEAD_BRANCH" = "$DEFAULT_BRANCH"',
    'REQUEST_HEAD_SHA',
  ]) {
    if (!callerRuns.includes(token)) add(report.missingSettings, {
      path: `${callerPath}:jobs.validate-request.steps`,
      message: `release publication caller provenance check is missing: ${token}`,
      settingLocation: callerPath,
    });
  }
  if (!workflowActionOperations(caller, 'actions/ci-release-publication-control').includes('verify-publication-request')) add(report.missingSettings, {
    path: `${callerPath}:jobs.validate-request.steps`,
    message: 'release publication caller is missing Action request verification',
    settingLocation: callerPath,
  });
  const publishWith = map(map(callerJobs.publish).with);
  if (publishWith.publication_request_run_id !== '${{ github.event.workflow_run.id }}') add(report.mismatches, {
    path: `${callerPath}:jobs.publish.with.publication_request_run_id`,
    message: 'publication request run ID must come from the triggering workflow_run',
    settingLocation: callerPath,
  });
  validateSupplementalOwnerContract(callerPath, publishWith, report);
  const summary = map(callerJobs.summary);
  if (summary.if !== 'always()' || !Array.isArray(summary.needs)) add(report.missingSettings, {
    path: `${callerPath}:jobs.summary`,
    message: 'caller must always report validation and publication results',
    settingLocation: callerPath,
  });
  return publishWith;
};

const resolveAuthoritySnapshotValues = (
  publicationPath: string,
  callerPath: string,
  snapshotSources: ValueMap,
  publishWith: ValueMap,
  publicationEnv: ValueMap,
  report: Report,
): void => {
  for (const [source, values] of Object.entries(snapshotSources)) {
    for (const [key, value] of Object.entries(map(values))) {
      let resolved = value;
      let path = `${publicationPath}:jobs.authority.steps.config.with.sources-json.${source}.${key}`;
      let settingLocation = publicationPath;
      const envMatch = typeof value === 'string'
        ? /^\$\{\{\s*env\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}$/.exec(value)
        : undefined;
      const inputMatch = typeof value === 'string'
        ? /^\$\{\{\s*inputs\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}$/.exec(value)
        : undefined;
      if (envMatch) {
        resolved = publicationEnv[envMatch[1]];
        path = `${publicationPath}:env.${envMatch[1]}`;
      } else if (inputMatch) {
        resolved = publishWith[inputMatch[1]];
        path = `${callerPath}:jobs.publish.with.${inputMatch[1]}`;
        settingLocation = callerPath;
      }
      const runtimeValue = typeof resolved === 'string'
        ? resolved
        : typeof resolved === 'boolean' || typeof resolved === 'number' ? String(resolved) : undefined;
      if (runtimeValue !== undefined
        && runtimeValue.length > 0
        && !/[\0\r\n]/.test(runtimeValue)
        && !runtimeValue.includes('${{')) continue;
      add(report.mismatches, {
        path,
        message: 'ci-config-snapshot values must resolve from static non-empty strings without NUL or line breaks',
        settingLocation,
      });
    }
  }
};

const validatePublicationControlSurface = (
  publicationPath: string,
  publication: ValueMap,
  callerPath: string,
  publishWith: ValueMap,
  report: Report,
): void => {
  const requiredInputs = workflowCallRequired(publication).inputs.sort();
  const expectedInputs = [
    'publication_request_run_id',
    'request_run_id',
    'supplemental_release_asset_enabled',
    'supplemental_release_asset_owner_contract',
  ];
  if (JSON.stringify(requiredInputs) !== JSON.stringify(expectedInputs)) add(report.mismatches, {
    path: `${publicationPath}:on.workflow_call.inputs`,
    message: 'trusted publication requires request run IDs and the supplemental asset selection',
    settingLocation: publicationPath,
  });
  const publicationRuns = workflowRunText(publication);
  if (!JSON.stringify(publication).includes('"name":"release-notes-handoff"')) add(report.missingSettings, {
    path: `${publicationPath}:jobs.authority.steps`,
    message: 'trusted publication must download release-notes-handoff',
    settingLocation: publicationPath,
  });
  for (const token of [
    'run-metadata/publication-request.json',
    'authority/publication-request.json',
  ]) {
    if (!publicationRuns.includes(token)) add(report.missingSettings, {
      path: `${publicationPath}:jobs.authority.steps`,
      message: `trusted publication provenance check is missing: ${token}`,
      settingLocation: publicationPath,
    });
  }
  const publicationControlOperations = workflowActionOperations(publication, 'actions/ci-release-publication-control');
  for (const operation of ['verify-provenance', 'verify-approval']) {
    if (!publicationControlOperations.includes(operation)) add(report.missingSettings, {
      path: `${publicationPath}:jobs`,
      message: `trusted publication is missing Action control operation: ${operation}`,
      settingLocation: publicationPath,
    });
  }
  const publicationJobs = map(publication.jobs);
  const authorityJob = map(publicationJobs.authority);
  const authoritySteps = Array.isArray(authorityJob.steps) ? authorityJob.steps.map(map) : [];
  const configSnapshotStep = authoritySteps.find((step) => step.id === 'config');
  const sourcesJson = map(configSnapshotStep?.with)['sources-json'];
  let snapshotSources: ValueMap = {};
  let workflowSnapshot: ValueMap = {};
  if (typeof sourcesJson === 'string') {
    try {
      snapshotSources = map(JSON.parse(sourcesJson));
      workflowSnapshot = map(snapshotSources.workflow);
    } catch {
      workflowSnapshot = {};
    }
  }
  resolveAuthoritySnapshotValues(
    publicationPath,
    callerPath,
    snapshotSources,
    publishWith,
    map(publication.env),
    report,
  );
  const expectedSupplementalAssetSnapshot: Record<string, string> = {
    CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED: '${{ inputs.supplemental_release_asset_enabled }}',
    CI_SUPPLEMENTAL_RELEASE_ASSET_CONTRACT:
      'ci.release-asset-publication-contract#supplementalAsset',
    CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT:
      '${{ inputs.supplemental_release_asset_owner_contract }}',
    CI_SUPPLEMENTAL_RELEASE_ASSET_ADAPTER: '.ci/scripts/ci-release-supplemental-asset.sh',
  };
  for (const [key, value] of Object.entries(expectedSupplementalAssetSnapshot)) {
    if (workflowSnapshot[key] !== value) add(report.mismatches, {
      path: `${publicationPath}:jobs.authority.steps.config.with.sources-json.workflow.${key}`,
      message: `supplemental asset selection must be recorded in the authority snapshot: ${key}`,
      settingLocation: publicationPath,
    });
  }
};

const validateSupplementalBuildStep = (
  publicationPath: string,
  buildJob: ValueMap,
  report: Report,
): void => {
  const buildSteps = Array.isArray(buildJob.steps) ? buildJob.steps.map(map) : [];
  const supplementalPlatformVerification = buildSteps.find(
    (step) => step.name === 'Build and verify supplemental Release asset platform',
  );
  const supplementalPlatformInputs = supplementalAdapterInputs('buildPlatform', {
    'authority-context-path': 'authority/authority.json',
    'config-snapshot-path': 'authority/config-snapshot.json',
    'standard-platform-build-directory': 'build/${{ matrix.id }}',
    'supplemental-platform-output-directory': 'supplemental-build/${{ matrix.id }}',
  }, report);
  if (supplementalPlatformVerification?.if !== 'inputs.supplemental_release_asset_enabled'
    || !supplementalActionMatches(supplementalPlatformVerification, supplementalPlatformInputs)) add(report.mismatches, {
    path: `${publicationPath}:jobs.build.steps.Build and verify supplemental Release asset platform`,
    message: 'supplemental asset platform build must use the current adapter interface',
    settingLocation: publicationPath,
  });
};

const validateSupplementalAssemblyStep = (
  publicationPath: string,
  supplementalAssetJob: ValueMap,
  report: Report,
): void => {
  const supplementalAssetSteps = Array.isArray(supplementalAssetJob.steps)
    ? supplementalAssetJob.steps.map(map) : [];
  const supplementalAssembly = supplementalAssetSteps.find(
    (step) => step.name === 'Build and verify supplemental Release asset',
  );
  const supplementalAssemblyInputs = supplementalAdapterInputs('assemble', {
    'authority-context-path': 'authority/authority.json',
    'config-snapshot-path': 'authority/config-snapshot.json',
    'standard-platform-build-root': 'build',
    'supplemental-platform-build-root': 'supplemental-build',
    'output-directory': 'supplemental-asset',
  }, report);
  if (supplementalAssetJob.if !== 'inputs.supplemental_release_asset_enabled'
    || supplementalAssembly?.if !== undefined
    || !supplementalActionMatches(supplementalAssembly, supplementalAssemblyInputs)) add(report.mismatches, {
    path: `${publicationPath}:jobs.supplemental-asset.steps.Build and verify supplemental Release asset`,
    message: 'supplemental asset assembly must use the current adapter interface',
    settingLocation: publicationPath,
  });
};

const validateReleaseJobGraph = (
  publicationPath: string,
  publication: ValueMap,
  report: Report,
): void => {
  const publicationJobs = map(publication.jobs);
  const qualityJob = map(publicationJobs.quality);
  const assembleJob = map(publicationJobs.assemble);
  const summaryJob = map(publicationJobs.summary);
  if (Object.keys(qualityJob).length === 0) add(report.missingSettings, {
    path: `${publicationPath}:jobs.quality`,
    message: 'release publication quality job is missing',
    settingLocation: publicationPath,
  });
  if (!JSON.stringify(qualityJob).includes('/actions/ci-quality-adapter@')) add(report.missingSettings, {
    path: `${publicationPath}:jobs.quality.steps`,
    message: 'release publication quality adapter invocation is missing',
    settingLocation: publicationPath,
  });
  validateSupplementalBuildStep(publicationPath, map(publicationJobs.build), report);
  validateSupplementalAssemblyStep(publicationPath, map(publicationJobs['supplemental-asset']), report);
  const assembleCondition = typeof assembleJob.if === 'string' ? assembleJob.if : '';
  for (const token of [
    '!cancelled()',
    "needs.authority.result == 'success'",
    "needs.build.result == 'success'",
    "needs.supplemental-asset.result == 'success'",
    "needs.supplemental-asset.result == 'skipped'",
  ]) {
    if (!assembleCondition.includes(token)) add(report.mismatches, {
      path: `${publicationPath}:jobs.assemble.if`,
      message: `release assembly condition is missing: ${token}`,
      settingLocation: publicationPath,
    });
  }
  if (!strings(assembleJob.needs).includes('supplemental-asset')) add(report.mismatches, {
    path: `${publicationPath}:jobs.assemble.needs`,
    message: 'release assembly must wait for the supplemental asset selection result',
    settingLocation: publicationPath,
  });
  if (!strings(summaryJob.needs).includes('quality')
    || !strings(summaryJob.needs).includes('supplemental-asset')
    || summaryJob.if !== 'always()') add(report.mismatches, {
    path: `${publicationPath}:jobs.summary`,
    message: 'release summary must always collect quality and supplemental asset results',
    settingLocation: publicationPath,
  });
};

const validateReleasePublicationFlow = (
  workflows: Map<string, ValueMap>,
  report: Report,
): void => {
  const requestPath = '.github/workflows/release-publication-request.yml';
  const callerPath = '.github/workflows/release-publication-caller.yml';
  const publicationPath = '.github/workflows/release-publication.yml';
  const request = workflows.get(requestPath);
  const caller = workflows.get(callerPath);
  const publication = workflows.get(publicationPath);
  if (!request || !caller || !publication) return;

  validateReleaseRequestWorkflow(requestPath, request, report);

  const publishWith = validateReleaseCallerWorkflow(callerPath, caller, report);

  validatePublicationControlSurface(publicationPath, publication, callerPath, publishWith, report);
  validateReleaseJobGraph(publicationPath, publication, report);
};

const validatePublicationRequest = (
  displayPath: string,
  workflow: ValueMap,
  requiredInputs: string[],
  report: Report,
): void => {
  const releaseRequest = displayPath.endsWith('release-publication-request.yml');
  validateDispatchInputs(
    displayPath,
    workflow,
    requiredInputs,
    report,
  );
  if (!releaseRequest && uses(workflow).some((value) => value.startsWith('actions/checkout@'))) add(report.mismatches, {
    path: `${displayPath}:uses.actions/checkout`,
    message: 'request workflow must not check out source',
    settingLocation: displayPath,
  });
  if (releaseRequest) {
    for (const [permission, level] of Object.entries(map(workflow.permissions))) {
      if (level === 'write') add(report.mismatches, {
        path: `${displayPath}:permissions.${permission}`,
        message: 'request workflow must not declare write permission',
        settingLocation: displayPath,
      });
    }
  }
  for (const [jobName, jobValue] of Object.entries(map(workflow.jobs))) {
    const job = map(jobValue);
    const permissions = effectivePermissions(workflow, job);
    const entries = releaseRequest
      ? Object.entries(map(job.permissions))
      : ['contents', 'packages'].map((permission) => [permission, permissions[permission]]);
    for (const [permission, level] of entries) {
      if (level === 'write') add(report.mismatches, {
        path: `${displayPath}:jobs.${jobName}.permissions.${permission}`,
        message: releaseRequest
          ? 'request workflow must not have write permission'
          : 'request workflow must not have publication permission',
        settingLocation: displayPath,
      });
    }
  }
};

const validateDispatchInputs = (
  displayPath: string,
  workflow: ValueMap,
  names: string[],
  report: Report,
): void => {
  const inputs = map(map(on(workflow).workflow_dispatch).inputs);
  for (const name of names) {
    if (map(inputs[name]).required !== true) add(report.missingSettings, {
      path: `${displayPath}:on.workflow_dispatch.inputs.${name}`,
      message: `required request input ${name} is missing`,
      settingLocation: displayPath,
    });
  }
};

export { validateCaller, validatePackagePublicationFlow, validatePublicationConcurrency, validatePublicationRequest, validateReleasePublicationFlow };
