return {
  rule_id = "ci-github-workflow-external-action-full-sha",
  description = "Require external GitHub Actions references to use a full commit SHA",
  hint = "外部 Action は小文字 hex 40 桁の commit SHA へ固定してください。",
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
    local diagnostics = {}
    local function report(node, code, message)
      table.insert(diagnostics, yaml.diagnostic(context, node, "ci_github_workflow_" .. code, message))
    end
    local candidates = yaml.steps(context)
    for _, job in ipairs(yaml.jobs(context)) do table.insert(candidates, job) end
    for _, node in ipairs(candidates) do
      local uses = yaml.field(node, "uses")
      local value = yaml.value(uses)
      if value and not value:match("^%./") and not value:match("^docker://") then
        local sha = value:match("@([^@]+)$")
        if not sha or #sha ~= 40 or not sha:match("^[0-9a-f]+$") then report(uses, "external_action_not_full_sha", "external Action must use a full lowercase commit SHA") end
      end
    end
    return diagnostics
  end,
}
