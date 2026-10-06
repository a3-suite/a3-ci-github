return {
  rule_id = "ci-github-workflow-no-moving-runner",
  description = "Forbid moving latest runner labels in CI workflows",
  hint = "runner は ubuntu-24.04 などの versioned label を使用してください。",
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
    for _, job in ipairs(yaml.jobs(context)) do
      for _, node in ipairs(yaml.runner_labels(job)) do
        local value = yaml.value(node)
        if value == "ubuntu-latest" or value == "windows-latest" or value == "macos-latest" then report(node, "moving_runner", "moving runner label is forbidden") end
      end
    end
    return diagnostics
  end,
}
