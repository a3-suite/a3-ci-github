return {
  rule_id = "ci-github-workflow-immutable-image",
  description = "Require workflow container and service images to use immutable digests",
  hint = "container、service、docker:// Action の image は @sha256:<64桁hex> へ固定してください。",
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
    local function inspect(node)
      local value = yaml.value(node)
      if value then
        local digest = value:match("@sha256:([0-9a-fA-F]+)$")
        if not digest or #digest ~= 64 then report(node, "immutable_image_required", "container or service image must use an immutable sha256 digest") end
      end
    end
    for _, job in ipairs(yaml.jobs(context)) do
      local container = yaml.field(job, "container")
      inspect(yaml.value(container) and container or yaml.field(container, "image"))
      for _, service in ipairs(yaml.values(yaml.field(job, "services"))) do inspect(yaml.field(service, "image")) end
    end
    if yaml.workflow(context) then
      for _, step in ipairs(yaml.steps(context)) do
        local uses = yaml.field(step, "uses")
        if (yaml.value(uses) or ""):match("^docker://") then inspect(uses) end
      end
    end
    return diagnostics
  end,
}
