const digest='a'.repeat(64), sha='a'.repeat(40);
const wf=(job='',step='run: echo safe',header='on: pull_request')=>`name: check\n${header}\njobs:\n  verify:\n    runs-on: ubuntu-24.04\n${job}    steps:\n      - ${step}\n`;
const rules={ moving:'no_moving_runner', selector:'no_untrusted_runner_selector', run:'no_untrusted_run_expression', cancel:'no_privileged_cancel', image:'immutable_image', pin:'external_action_full_sha', name:'name_matches_file', long:'no_long_inline_script', cli:'runtime_no_a3_cli', action:'action_runtime_contract' };
const cases=[
 ['moving-array','moving',wf().replace('runs-on: ubuntu-24.04','runs-on: [ubuntu-latest]'),true],
 ['moving-flow','moving','name: check\non: push\njobs: {verify: {runs-on: ubuntu-latest, steps: [{run: "echo safe"}]}}\n',true],
 ['moving-scalar','moving',wf().replace('runs-on: ubuntu-24.04','runs-on: >-\n      ubuntu-latest'),true],
 ['selector-data','selector',wf("    env:\n      runs-on: \${{ github.head_ref }}\n"),false],
 ['run-comment-marker','run',wf('','run: | # command\n          echo "\${{ github.event.pull_request.title }}"'),true],
 ['run-description-data','run',wf('', 'name: |\n          run: echo "\${{ github.event.pull_request.title }}"\n        run: echo safe'),false],
 ['run-flow','run',`name: check\non: pull_request\njobs: {verify: {runs-on: ubuntu-24.04, steps: [{run: 'echo "\${{ github.event.pull_request.title }}"'}]}}\n`,true],
 ['cancel-comment','cancel',wf('','run: echo safe','on: workflow_dispatch\nconcurrency:\n  group: check\n  cancel-in-progress: true # required'),true],
 ['cancel-data','cancel',wf('',"run: |\n          cat <<'EOF'\n          cancel-in-progress: true\n          EOF",'on: workflow_dispatch\nconcurrency:\n  group: check\n  cancel-in-progress: false'),false],
 ['cancel-quoted-event','cancel',wf('','run: echo safe','on: "workflow_dispatch"\nconcurrency:\n  group: check\n  cancel-in-progress: true'),true],
 ['image-env-block','image',wf('    env:\n      container: node:latest\n'),false],
 ['image-service-env','image',wf(`    services:\n      db: {image: "postgres@sha256:${digest}", env: {image: "example"}}\n`),false],
 ['image-job-flow-map','image',`name: check\non: push\njobs: {verify: {runs-on: ubuntu-24.04, container: {image: "node:latest"}, steps: [{run: "echo safe"}]}}\n`,true],
 ['pin-env-block','pin',wf('    env:\n      uses: actions/checkout@main\n'),false],
 ['pin-with-flow','pin',wf('',`uses: example/action@${sha}\n        with: {uses: "actions/checkout@main"}`),false],
 ['name-quoted-key','name',wf().replace('name: check','"name": check'),false],
 ['long-quoted-key','long',wf('',`"run": |\n${'          true\n'.repeat(11)}`),true],
 ['long-indent-marker','long',wf('',`run: |2\n${'          true\n'.repeat(11)}`),true],
 ['cli-indent-marker','cli',wf('','run: |2\n          a3-lint'),true],
 ['cli-data','cli',wf('',"run: |\n          cat <<'EOF'\n          a3-lint\n          EOF"),false],
 ['cli-js','cli',"import { spawnSync } from 'node:child_process';\nspawnSync('a3-lint', []);\n",true,'.ci/scripts/check.js','javascript'],
 ['cli-mjs','cli',"import { spawnSync } from 'node:child_process';\nspawnSync('a3-lint', []);\n",true,'.ci/scripts/check.mjs','javascript'],
 ['action-quoted-run','action','name: example\ndescription: example\nruns:\n  using: composite\n  steps:\n    - "run": node script.mjs\n      shell: bash\n',true,'actions/example/action.yml'],
 ['action-comment-runs','action','name: example\ndescription: example\nruns: # runtime\n  using: node24\n  main: dist/index.js\n',false,'actions/example/action.yml'],
];

export const yamlRegressions = cases.map(([name, rule, source, expectedDiagnostic, relative = '.github/workflows/check.yml', lang = 'yaml']) => {
  const filename = rule === 'cli' && lang === 'yaml' ? 'ci_github_workflow_no_a3_cli.lua'
    : `ci_github_${['cli', 'action'].includes(rule) ? '' : 'workflow_'}${rules[rule]}.lua`;
  return { name, file: filename, lang, source, relative, expectedDiagnostic };
});
