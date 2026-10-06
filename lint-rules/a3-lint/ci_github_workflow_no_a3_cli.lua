return {
  rule_id = "ci-github-workflow-no-a3-cli",
  description = "Forbid known a3 CLI invocations in CI workflow run steps",
  hint = "CI runtime から a3-* CLI を呼び出さず、標準 Action / reusable workflow を優先し、project 固有の差分だけを個別実装してください。",
  languages = { "yaml" },
  targets = { "both" },
  frameworks = { "any" },
  category = "semantic",
  default_severity = "warn",
  execution_model = "project",
  relation_mode = "1:1",
  path_scope = "any",
  requires_context = true,
  prefilter_strategy = "none",
  implementation = {
    type = "lua",
    entrypoint = "check",
    lua_reason = "fact:yaml_structure:v1",
    lua_evidence = {
      required_runtime_capability = "fact:yaml_structure:v1",
    },
  },
  governance = {
    rule_family = "structural-pattern",
    required_capability_gaps = { "fact:yaml_structure:v1" },
    dsl_gap_evidence = "required_runtime_capability",
    migration_candidate = "revisit_after_capability_extension",
  },
  check = function(ctx)
    local yaml = require("ci_github_yaml")
    local context = yaml.context(ctx)
    if not yaml.workflow(context) then return {} end
    local diagnostics = {}
    for _, step in ipairs(yaml.steps(context)) do
      local node = yaml.field(step, "run")
      for _, line in ipairs(yaml.command_lines(yaml.value(node) or "")) do
        if line:match("^%s*a3%-lint[%s;&|]") or line:match("^%s*a3%-suite[%s;&|]")
          or line:match("[;&|]%s*a3%-lint[%s;&|]") or line:match("[;&|]%s*a3%-suite[%s;&|]")
          or line:match("^%s*a3%-lint%s*$") or line:match("^%s*a3%-suite%s*$") then
          table.insert(diagnostics, yaml.diagnostic(context, node, "ci_github_runtime_a3_cli_forbidden", "CI runtime must not invoke a3-* CLI"))
          break
        end
      end
    end
    return diagnostics
  end,
}
