#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
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
    file: 'ci_github_runtime_no_a3_cli.lua',
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

const runCase = (root, ruleRoot, rule, [relative, content]) => {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  const result = spawnSync(binary, [
    'lint', target,
    '--project-root', root,
    '--no-config',
    '--add-rule-set-root', ruleRoot,
    '--lang', rule.lang,
    '--framework', 'any',
    '--format', 'json',
    '--fail-on', 'none',
  ], { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.runtime_errors, []);
  assert.equal(report.checked_targets, 1);
  assert.equal(report.selected_rules.length, 1);
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
        path.join(repositoryRoot, 'lint-rules/a3-lint', rule.file),
        path.join(ruleRoot, rule.file),
      );
      const actual = runCase(caseRoot, ruleRoot, rule, fixture);
      assert.deepEqual(actual, expected, `${rule.file}:${kind}`);
    }
  }
  process.stdout.write(`ok: ${rules.length} a3-lint rules passed valid, invalid, and false-positive regressions\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
  assert.equal(existsSync(temporaryRoot), false);
}
