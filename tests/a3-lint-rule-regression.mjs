#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { yamlRegressions } from './fixtures/a3-lint-yaml-regressions.mjs';
import { fileURLToPath } from 'node:url';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testRoot, '..');
const temporaryParent = path.join(testRoot, 'tmp');
const binary = process.env.A3_LINT_BIN ?? 'a3-lint';
const sha40 = 'a'.repeat(40);
const digest64 = 'a'.repeat(64);
const readme = `## 固定項目（必須）
### 目的と対象
x
### 採用 preset / flow
x
### project 固有差分
差分種別: なし
標準で成立しない理由: なし
owner: x
正本・検証導線: x
検証証跡: x
更新・撤去条件: x
`;
const nonstandardReadme = `${readme
  .replace('差分種別: なし', '差分種別: trigger extension')
  .replace('標準で成立しない理由: なし', '標準で成立しない理由: 標準 trigger では対象イベントを表現できないため')}
## 自由記述（標準からの差異がある場合のみ）
- 追加条件: x
`;

const rules = [
  ...['js', 'mjs'].map((extension) => ({
    file: 'ci_github_runtime_no_a3_cli.lua', lang: 'javascript', code: 'ci_github_runtime_a3_cli_forbidden',
    invalid: [`.ci/scripts/check.${extension}`, "import { spawnSync } from 'node:child_process';\nspawnSync('a3-lint', []);\n"],
    valid: [`.ci/scripts/check.${extension}`, "spawnSync('node', []);\n"],
    falsePositive: [`.ci/scripts/check.${extension}`, "const example = \"spawnSync('a3-lint', [])\";\n"],
  })),
  {
    file: 'ci_github_action_runtime_contract.lua', lang: 'yaml', code: 'ci_github_action_runtime_unsupported',
    invalid: ['actions/example/action.yml', 'runs:\n  using: node20\n  main: dist/index.js\n'],
    valid: ['actions/example/action.yml', 'runs:\n  using: node24\n  main: dist/index.js\n'],
    falsePositive: ['config/action.yml', 'runs:\n  using: node20\n'],
  },
  {
    file: 'ci_github_action_runtime_contract.lua', lang: 'yaml', code: 'ci_github_action_main_not_dist',
    invalid: ['actions/example/action.yml', 'runs:\n  using: node24\n  main: src/index.ts\n'],
    valid: ['actions/example/action.yml', 'runs:\n  using: "node24"\n  main: "dist/index.js"\n'],
    falsePositive: ['actions/example/action.yml', 'runs:\n  using: composite\n  steps:\n    - run: echo node\n'],
  },
  {
    file: 'ci_github_action_runtime_contract.lua', lang: 'yaml', code: 'ci_github_action_runner_node_review',
    invalid: ['actions/example/action.yml', 'runs:\n  using: composite\n  steps:\n    - run: |\n        node script.mjs\n'],
    valid: ['actions/example/action.yml', 'runs:\n  using: composite\n  steps:\n    - run: bash script.sh\n'],
    falsePositive: ['actions/example/action.yml', 'description: node example\nruns:\n  using: composite\n  steps:\n    - run: |\n        # node example\n        echo "node script.mjs"\n'],
  },
  {
    file: 'ci_github_action_runtime_contract.lua', lang: 'yaml', code: 'ci_github_action_runner_node_review',
    invalid: ['actions/example/action.yml', 'runs:\n  using: composite\n  steps:\n    - run: "node script.mjs"\n'],
    valid: ['actions/example/action.yml', 'runs:\n  using: composite\n  steps:\n    - run: echo safe\n'],
    falsePositive: ['.github/workflows/example.yml', 'runs:\n  using: composite\n  steps:\n    - run: node script.mjs\n'],
  },
  {
    file: 'ci_github_workflow_no_a3_cli.lua',
    lang: 'yaml',
    code: 'ci_github_runtime_a3_cli_forbidden',
    invalid: ['.github/workflows/check.yml', 'run: a3-lint\n'],
    valid: ['.github/workflows/check.yml', 'run: echo safe\n'],
    falsePositive: ['scripts/check.yml', 'run: a3-lint\n'],
  },
  {
    file: 'ci_github_workflow_external_action_full_sha.lua',
    lang: 'yaml',
    code: 'ci_github_workflow_external_action_not_full_sha',
    invalid: ['.github/workflows/check.yml', 'uses: actions/checkout@v4\n'],
    valid: ['.github/workflows/check.yml', `uses: actions/checkout@${sha40}\n`],
    falsePositive: ['.github/workflows/check.yml', 'uses: ./local\n'],
  },
  {
    file: 'ci_github_workflow_external_action_full_sha.lua', lang: 'yaml',
    code: 'ci_github_workflow_external_action_not_full_sha',
    invalid: ['custom/action.yml', 'runs:\n  using: composite\n  steps:\n    - uses: actions/checkout@<commit-sha>\n'],
    valid: ['custom/action.yml', `runs:\n  using: composite\n  steps:\n    - uses: actions/checkout@${sha40}\n`],
    falsePositive: ['custom/action.yml', 'runs:\n  using: composite\n  steps:\n    - run: |\n        uses: actions/checkout@v4\n'],
  },
  {
    file: 'ci_github_workflow_external_action_full_sha.lua', lang: 'yaml',
    code: 'ci_github_workflow_external_action_not_full_sha',
    invalid: ['custom/action.yml', 'runs: {"using": composite, steps: [{uses: actions/checkout@main}]}\n'],
    valid: ['custom/action.yml', `runs: {"using": composite, steps: [{uses: actions/checkout@${sha40}}]}\n`],
    falsePositive: ['custom/action.yml', 'description: |\n  using: composite\n  uses: actions/checkout@main\nruns:\n  using: node24\n  main: dist/index.js\n'],
  },
  {
    file: 'ci_github_workflow_external_action_full_sha.lua', lang: 'yaml',
    code: 'ci_github_workflow_external_action_not_full_sha',
    invalid: ['custom/action.yml', 'runs: {using: composite, steps: [{uses: actions/checkout@main}]}\n'],
    valid: ['custom/action.yml', `runs: {using: composite, steps: [{uses: actions/checkout@${sha40}}]}\n`],
    falsePositive: ['custom/action.yml', `description: 'example {uses: actions/checkout@main}'\nruns: {using: node24, main: dist/index.js}\n`],
  },
  {
    file: 'ci_github_workflow_external_action_full_sha.lua', lang: 'yaml',
    code: 'ci_github_workflow_external_action_not_full_sha',
    invalid: ['custom/action.yml', 'runs:\n  using: composite\n  steps:\n    - name: |\n        Example\n      uses: actions/checkout@main\n'],
    valid: ['custom/action.yml', `runs:\n  using: composite\n  steps:\n    - name: |\n        Example\n      uses: actions/checkout@${sha40}\n`],
    falsePositive: ['custom/action.yml', `runs: {using: composite, steps: [{run: "echo '{uses: actions/checkout@main}'", shell: bash}]}\n`],
  },
  {
    file: 'ci_github_workflow_external_action_full_sha.lua', lang: 'yaml',
    code: 'ci_github_workflow_external_action_not_full_sha',
    invalid: ['custom/action.yml', `runs: {using: composite, steps: [{"uses": 'actions/checkout@main'}]}\n`],
    valid: ['custom/action.yml', `runs: {using: composite, steps: [{"uses": 'actions/checkout@${sha40}'}]}\n`],
    falsePositive: ['custom/action.yml', `runs: {using: composite, steps: [{run: 'echo ''{uses: actions/checkout@main}''', shell: bash}]}\n`],
  },
  {
    file: 'ci_github_workflow_immutable_image.lua',
    lang: 'yaml',
    code: 'ci_github_workflow_immutable_image_required',
    invalid: ['.github/workflows/check.yml', 'container: alpine\n'],
    valid: ['.github/workflows/check.yml', `container: alpine@sha256:${digest64}\n`],
    falsePositive: ['.github/workflows/check.yml', 'image: alpine\n'],
  },
  {
    file: 'ci_github_workflow_name_matches_file.lua',
    lang: 'yaml',
    code: 'ci_github_workflow_name_mismatch',
    invalid: ['.github/workflows/check.yml', 'name: other\n'],
    valid: ['.github/workflows/check.yml', 'name: check\n'],
    falsePositive: ['docs/check.yml', 'name: other\n'],
  },
  {
    file: 'ci_github_workflow_no_long_inline_script.lua',
    lang: 'yaml',
    code: 'ci_github_workflow_long_inline_script',
    invalid: ['.github/workflows/check.yml', `run: |\n${'  true\n'.repeat(11)}`],
    valid: ['.github/workflows/check.yml', `run: |\n${'  true\n'.repeat(10)}`],
    falsePositive: ['docs/check.yml', `run: |\n${'  true\n'.repeat(11)}`],
  },
  {
    file: 'ci_github_workflow_no_moving_runner.lua',
    lang: 'yaml',
    code: 'ci_github_workflow_moving_runner',
    invalid: ['.github/workflows/check.yml', 'runs-on: ubuntu-latest\n'],
    valid: ['.github/workflows/check.yml', 'runs-on: ubuntu-24.04\n'],
    falsePositive: ['.github/workflows/check.yml', '# runs-on: ubuntu-latest\n'],
  },
  {
    file: 'ci_github_workflow_no_privileged_cancel.lua',
    lang: 'yaml',
    code: 'ci_github_workflow_privileged_cancel',
    invalid: ['.github/workflows/check.yml', 'on: workflow_dispatch\ncancel-in-progress: true\n'],
    valid: ['.github/workflows/check.yml', 'on: workflow_dispatch\ncancel-in-progress: false\n'],
    falsePositive: ['.github/workflows/check.yml', 'on: push\ncancel-in-progress: true\n'],
  },
  {
    file: 'ci_github_workflow_no_untrusted_run_expression.lua',
    lang: 'yaml',
    code: 'ci_github_workflow_untrusted_run_expression',
    invalid: ['.github/workflows/check.yml', 'run: echo ${{ inputs.x }}\n'],
    valid: ['.github/workflows/check.yml', 'env:\n  X: ${{ inputs.x }}\nrun: echo "$X"\n'],
    falsePositive: ['docs/check.yml', 'run: echo ${{ inputs.x }}\n'],
  },
  {
    file: 'ci_github_workflow_no_untrusted_runner_selector.lua',
    lang: 'yaml',
    code: 'ci_github_workflow_untrusted_runner_selector',
    invalid: ['.github/workflows/check.yml', 'runs-on: ${{ inputs.runner }}\n'],
    valid: ['.github/workflows/check.yml', 'runs-on: ${{ matrix.runner }}\n'],
    falsePositive: ['docs/check.yml', 'runs-on: ${{ inputs.runner }}\n'],
  },
  {
    file: 'ci_github_ci_readme_contract.lua',
    lang: 'markdown',
    code: 'ci_github_ci_readme_owner_missing',
    invalid: ['.ci/README.md', readme.replace('owner: x\n', '')],
    valid: ['.ci/README.md', readme],
    falsePositive: ['README.md', ''],
  },
  {
    file: 'ci_github_ci_readme_contract.lua',
    lang: 'markdown',
    code: 'ci_github_ci_readme_nonstandard_reason_missing',
    invalid: ['.ci/README.md', nonstandardReadme.replace('標準で成立しない理由: 標準 trigger では対象イベントを表現できないため\n', '')],
    valid: ['.ci/README.md', nonstandardReadme],
    falsePositive: ['README.md', ''],
  },
  {
    file: 'ci_github_ci_readme_contract.lua',
    lang: 'markdown',
    code: 'ci_github_ci_readme_nonstandard_reason_missing',
    invalid: ['.ci/README.md', nonstandardReadme.replace('標準で成立しない理由: 標準 trigger では対象イベントを表現できないため', '標準で成立しない理由: なし')],
    valid: ['.ci/README.md', nonstandardReadme],
    falsePositive: ['README.md', ''],
  },
  {
    file: 'ci_github_ci_readme_contract.lua',
    lang: 'markdown',
    code: 'ci_github_ci_readme_nonstandard_reason_missing',
    invalid: ['.ci/README.md', readme.replace('標準で成立しない理由: なし', '標準で成立しない理由: 標準 trigger では対象イベントを表現できないため')],
    valid: ['.ci/README.md', readme],
    falsePositive: ['README.md', ''],
  },
  {
    file: 'ci_github_ci_readme_contract.lua',
    lang: 'markdown',
    code: 'ci_github_ci_readme_nonstandard_reason_missing',
    invalid: ['.ci/README.md', readme.replace('標準で成立しない理由: なし\n', '')],
    valid: ['.ci/README.md', readme],
    falsePositive: ['README.md', ''],
  },
];

const workflow = (job, step = 'run: echo safe') => `name: check\non: push\njobs:\n  verify:\n    ${job}\n    steps:\n      - ${step}\n`;
const quotedCases = [
  ['no_moving_runner', 'moving_runner', workflow("runs-on: 'ubuntu-latest'"), workflow("runs-on: 'ubuntu-24.04'"), workflow('runs-on: ubuntu-24.04', "run: |\n          cat <<'EOF'\n          runs-on: ubuntu-latest\n          EOF")],
  ['no_moving_runner', 'moving_runner', workflow('"runs-on": ubuntu-latest'), workflow('"runs-on": ubuntu-24.04'), workflow('runs-on: ubuntu-24.04-custom')],
  ['no_untrusted_runner_selector', 'untrusted_runner_selector', workflow('"runs-on": ${{ github.head_ref }}'), workflow('"runs-on": ${{ matrix.runner }}'), workflow('"runs-on": ubuntu-24.04')],
  ['no_untrusted_run_expression', 'untrusted_run_expression', workflow('runs-on: ubuntu-24.04', '"run": |\n          echo "${{ github.event.pull_request.title }}"'), workflow('runs-on: ubuntu-24.04', '"run": echo "$TITLE"'), workflow('runs-on: ubuntu-24.04', '"run": echo safe')],
  ['no_untrusted_run_expression', 'untrusted_run_expression', workflow('runs-on: ubuntu-24.04', 'run: |2\n          echo "${{ github.event.pull_request.title }}"'), workflow('runs-on: ubuntu-24.04', 'run: |2-\n          echo "$TITLE"'), workflow('runs-on: ubuntu-24.04', 'run: |+2\n          echo safe')],
  ['no_privileged_cancel', 'privileged_cancel', '"on": workflow_dispatch\nconcurrency:\n  cancel-in-progress: true\n', '"on": workflow_dispatch\nconcurrency:\n  cancel-in-progress: false\n', '"on": push\nconcurrency:\n  cancel-in-progress: true\n'],
  ['no_privileged_cancel', 'privileged_cancel', 'on: workflow_dispatch\nconcurrency:\n  "cancel-in-progress": true\n', 'on: workflow_dispatch\nconcurrency:\n  "cancel-in-progress": false\n', 'on: push\nconcurrency:\n  "cancel-in-progress": true\n'],
  ['immutable_image', 'immutable_image_required', 'name: check\non: push\njobs: {verify: {runs-on: ubuntu-24.04, container: "node:latest", steps: [{run: "echo safe"}]}}\n', `name: check\non: push\njobs: {verify: {runs-on: ubuntu-24.04, container: "node@sha256:${digest64}", steps: [{run: "echo safe"}]}}\n`, workflow('runs-on: ubuntu-24.04', "run: |\n          cat <<'EOF'\n          container: node:latest\n          EOF")],
  ['immutable_image', 'immutable_image_required', 'jobs: {verify: {"container": "node:latest"}}\n', `jobs: {verify: {"container": "node@sha256:${digest64}"}}\n`, 'jobs: {verify: {steps: [{run: "echo {container: node:latest}"}]}}\n'],
  ['immutable_image', 'immutable_image_required', 'jobs: {verify: {container: "node:latest"}}\n', `jobs: {verify: {container: "node@sha256:${digest64}"}}\n`, 'env: {container: "node:latest"}\njobs: {verify: {runs-on: ubuntu-24.04, steps: [{run: "echo safe"}]}}\n'],
  ['immutable_image', 'immutable_image_required', 'jobs: {verify: {container: "node:latest"}}\n', `jobs: {verify: {container: "node@sha256:${digest64}"}}\n`, 'jobs: {verify: {runs-on: ubuntu-24.04, env: {container: "node:latest"}, steps: [{uses: "example/action@'+('a'*40)+'", with: {container: "node:latest"}}]}}\n'],
];
for (const [file, code, invalid, valid, falsePositive] of quotedCases) {
  rules.push({ file: `ci_github_workflow_${file}.lua`, lang: 'yaml', code: `ci_github_workflow_${code}`,
    invalid: ['.github/workflows/check.yml', invalid], valid: ['.github/workflows/check.yml', valid],
    falsePositive: ['.github/workflows/check.yml', falsePositive] });
}

// Legacy unit snippets belong at job/step positions; root-level data is not executable configuration.
const placeWorkflowSnippet = (relative, content) => {
  if (!relative.startsWith('.github/workflows/')) return content;
  const document = yaml.parseDocument(content);
  assert.deepEqual(document.errors, []);
  if (!yaml.isMap(document.contents) || document.has('jobs')) return content;
  if (document.has('cancel-in-progress')) {
    const cancel = document.get('cancel-in-progress', true);
    document.delete('cancel-in-progress');
    document.set('concurrency', new yaml.YAMLMap());
    document.get('concurrency', true).set('cancel-in-progress', cancel);
    return document.toString();
  }
  const indent = (text, width) => text.split('\n').filter((line, index, lines) => index !== lines.length - 1 || line).map((line) => ' '.repeat(width) + line).join('\n');
  if (document.has('run') || document.has('uses')) {
    const lines = content.trimEnd().split('\n');
    return `jobs:\n  verify:\n    steps:\n      - ${lines[0]}\n${indent(lines.slice(1).join('\n'), 8)}\n`;
  }
  if (document.has('runs-on') || document.has('container') || document.has('image')) return `jobs:\n  verify:\n${indent(content, 4)}\n`;
  return content;
};

const runCase = (root, ruleRoot, rule, [relative, content], relativeInput = false) => {
  if (rule.lang === 'yaml') content = placeWorkflowSnippet(relative, content);
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  const result = spawnSync(binary, [
    'lint', relativeInput ? relative : target,
    '--project-root', root,
    '--no-config',
    '--no-cache',
    '--add-rule-set-root', ruleRoot,
    '--add-rule-set-lib', path.join(repositoryRoot, 'lint-rules/a3-lint/shared'),
    '--lang', rule.lang,
    '--framework', 'any',
    '--format', 'json',
    '--fail-on', 'none',
  ], { encoding: 'utf8', cwd: root });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.runtime_errors, []);
  assert.equal(report.checked_targets, 1);
  assert.equal(report.trace.execution.filter((entry) => entry.kind === 'rule_executed').length, 1);
  const lines = content.split('\n');
  for (const entry of rule.file !== 'ci_github_ci_readme_contract.lua' ? report.diagnostics : []) {
    assert.ok(entry.end_col <= Buffer.byteLength(lines[entry.end_line - 1], 'utf8') + 1, `${rule.file}: diagnostic span exceeds source line`);
  }
  return report.diagnostics.map((entry) => entry.code).sort();
};

mkdirSync(temporaryParent, { recursive: true });
const temporaryRoot = mkdtempSync(path.join(temporaryParent, 'a3-lint-rules-'));
try {
  for (const rule of rules) {
    for (const [kind, fixture, expected] of [
      ['valid', rule.valid, []],
      ['invalid', rule.invalid, [rule.code]],
      ['false-positive', rule.falsePositive, []],
    ]) {
      const caseRoot = path.join(temporaryRoot, `${rule.file}-${kind}`);
      const ruleRoot = path.join(caseRoot, 'rules');
      mkdirSync(ruleRoot, { recursive: true });
      copyFileSync(
        path.join(repositoryRoot, rule.file === 'ci_github_action_runtime_contract.lua' ? 'lint-rules/repository' : 'lint-rules/a3-lint', rule.file),
        path.join(ruleRoot, rule.file),
      );
      const actual = runCase(caseRoot, ruleRoot, rule, fixture);
      assert.deepEqual(actual, expected, `${rule.file}:${kind}`);
      assert.deepEqual(runCase(caseRoot, ruleRoot, rule, fixture, true), expected, `${rule.file}:${kind}:relative`);
    }
  }
  for (const fixture of yamlRegressions) {
    const caseRoot = path.join(temporaryRoot, `structure-${fixture.name}`);
    const ruleRoot = path.join(caseRoot, 'rules');
    mkdirSync(ruleRoot, { recursive: true });
    const owner = fixture.file === 'ci_github_action_runtime_contract.lua' ? 'repository' : 'a3-lint';
    copyFileSync(path.join(repositoryRoot, 'lint-rules', owner, fixture.file), path.join(ruleRoot, fixture.file));
    for (const relativeInput of [false, true]) {
      const codes = runCase(caseRoot, ruleRoot, fixture, [fixture.relative, fixture.source], relativeInput);
      assert.equal(codes.length > 0, fixture.expectedDiagnostic, fixture.name);
    }
  }
  const failedRoot = path.join(temporaryRoot, 'required-observation');
  const failedRules = path.join(failedRoot, 'rules');
  mkdirSync(path.join(failedRoot, '.github/workflows'), { recursive: true });
  mkdirSync(failedRules);
  copyFileSync(path.join(repositoryRoot, 'lint-rules/a3-lint/ci_github_workflow_no_a3_cli.lua'), path.join(failedRules, 'rule.lua'));
  const failedTarget = path.join(failedRoot, '.github/workflows/check.yml');
  for (const [content, reason] of [['jobs: [', 'invalid-syntax'], ['jobs: {}\njobs: {}\n', 'duplicate-key'], ['jobs: &jobs {}\n', 'anchor']]) {
    writeFileSync(failedTarget, content);
    const result = spawnSync(binary, ['lint', failedTarget, '--no-config', '--project-root', failedRoot,
      '--add-rule-set-root', failedRules, '--add-rule-set-lib', path.join(repositoryRoot, 'lint-rules/a3-lint/shared'),
      '--lang', 'yaml', '--framework', 'any', '--format', 'json', '--fail-on', 'none', '--rule-level', 'ci-github-workflow-no-a3-cli=off'], { encoding: 'utf8' });
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, 2);
    assert.equal(report.command_outcome.kind, 'phase_error');
    assert.equal(report.command_outcome.classification, 'runtime-precondition-failure');
    assert.ok(report.phase_error.message.includes(reason));
  }
  const guideRoot = path.join(temporaryRoot, 'public-guide');
  mkdirSync(path.join(guideRoot, '.github/workflows'), { recursive: true });
  mkdirSync(path.join(guideRoot, '.ci'), { recursive: true });
  writeFileSync(path.join(guideRoot, '.github/workflows/check.yml'), 'name: check\non: push\njobs:\n  check:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo safe\n');
  writeFileSync(path.join(guideRoot, '.ci/README.md'), readme);
  const guide = readFileSync(path.join(repositoryRoot, 'skills/ci-github/references/validate-ci-preset.guide.md'), 'utf8');
  const commands = [...guide.matchAll(/^a3-lint lint .*?(?=\n\n|\n```)/gms)];
  assert.equal(commands.length, 2, 'public guide lint commands');
  for (const [index, [command]] of commands.entries()) {
    const tokens = command.replace(/\\\n/g, ' ').match(/"[^"]*"|'[^']*'|\S+/g);
    const args = tokens.slice(1).map((token) => token.replace(/^["']|["']$/g, '')
      .replaceAll('{project-root}', guideRoot).replaceAll('{ci-github-source-root}', repositoryRoot));
    const result = spawnSync(binary, args, { encoding: 'utf8', cwd: guideRoot });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.checked_targets, 1);
    assert.deepEqual(report.runtime_errors, []);
    assert.deepEqual(report.diagnostics, []);
    assert.equal(report.trace.execution.filter((entry) => entry.kind === 'rule_executed').length, index === 0 ? 9 : 1);
  }
  process.stdout.write(`ok: ${rules.length} a3-lint fixture groups passed valid, invalid, and false-positive regressions; ${yamlRegressions.length} structure cases passed absolute/relative checks\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
  assert.equal(existsSync(temporaryRoot), false);
}
