return {
  rule_id = "ci-github-workflow-no-privileged-cancel",
  description = "Forbid automatic cancellation in manually or release-triggered CI workflows",
  hint = "publish / deploy / release / manual 系workflowでは自動キャンセルを無効にしてください。",
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
      local trigger = yaml.field(context.root, "on")
      local privileged = yaml.field(trigger, "workflow_dispatch") ~= nil or yaml.field(trigger, "workflow_run") ~= nil
        or yaml.field(yaml.field(trigger, "push"), "tags") ~= nil
      local events = yaml.value(trigger) and { trigger } or yaml.items(trigger)
      for _, event in ipairs(events) do
        local value = yaml.value(event)
        if value == "workflow_dispatch" or value == "workflow_run" then privileged = true end
      end
      if privileged then
        local scopes = { context.root }
        for _, job in ipairs(yaml.jobs(context)) do table.insert(scopes, job) end
        for _, scope in ipairs(scopes) do
          local node = yaml.field(yaml.field(scope, "concurrency"), "cancel-in-progress")
          if yaml.value(node) == "true" then report(node, "privileged_cancel", "privileged or release-triggered workflow must not cancel in progress") end
        end
      end
    end
    return diagnostics
  end,
}
