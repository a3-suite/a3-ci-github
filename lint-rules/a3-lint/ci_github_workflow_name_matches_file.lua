return {
  rule_id = "ci-github-workflow-name-matches-file",
  description = "Require workflow file names and top-level names to match",
  hint = "workflow file とトップレベル name は同じ lower-kebab の名前にしてください。",
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
    if yaml.workflow(context) then
      local stem = context.path:match("([^/]+)%.ya?ml$")
      local name = yaml.field(context.root, "name")
      if not stem or not stem:match("^[a-z0-9%-]+$") or stem:match("^%-") or stem:match("%-$") or stem:match("%-%-") then
        report(nil, "file_name_invalid", "workflow file name must use lower-kebab-case")
      elseif yaml.value(name) ~= stem then report(name, "name_mismatch", "workflow name must match the file stem") end
    end
    return diagnostics
  end,
}
