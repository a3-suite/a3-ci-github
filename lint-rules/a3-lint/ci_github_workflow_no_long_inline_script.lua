return {
  rule_id = "ci-github-workflow-no-long-inline-script",
  description = "Flag long YAML block scripts for semantic review",
  hint = "空行を除く10行超は意味レビューの起点です。外部化の便益と追加の保守コストを比較してください。",
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
      for _, step in ipairs(yaml.steps(context)) do
        local node = yaml.field(step, "run")
        local count = 0
        for line in ((yaml.value(node) or "") .. "\n"):gmatch("([^\n]*)\n") do if line:match("%S") then count = count + 1 end end
        if count > 10 then report(node, "long_inline_script", "long inline CI script requires semantic review") end
      end
    end
    return diagnostics
  end,
}
