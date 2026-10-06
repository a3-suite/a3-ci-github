return {
  rule_id = "ci-github-workflow-no-untrusted-run-expression",
  description = "Forbid direct interpolation of untrusted GitHub Actions values in run scripts",
  hint = "未信頼値は env または with input 経由でデータとして渡してください。",
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
    local function is_untrusted_expression(expression)
      -- Computed expressions may map an input to a reviewed fixed value.  This
      -- rule only rejects an untrusted source used without such a
      -- mapping; trust of step/job outputs requires a higher-level review.
      return expression:match("^github%.event%.pull_request%.title$") ~= nil
        or expression:match("^github%.event%.pull_request%.body$") ~= nil
        or expression:match("^github%.event%.pull_request%.head%.ref$") ~= nil
        or expression:match("^github%.event%.pull_request%.base%.ref$") ~= nil
        or expression:match("^github%.event%.issue%.title$") ~= nil
        or expression:match("^github%.event%.issue%.body$") ~= nil
        or expression:match("^github%.event%.comment%.body$") ~= nil
        or expression:match("^github%.event%.inputs%.[%w_%-]+$") ~= nil
        or expression:match("^github%.head_ref$") ~= nil
        or expression:match("^github%.base_ref$") ~= nil
        or expression:match("^github%.ref_name$") ~= nil
        or expression:match("^inputs%.[%w_%-]+$") ~= nil
    end
    if yaml.workflow(context) then
      for _, step in ipairs(yaml.steps(context)) do
        local node = yaml.field(step, "run")
        for expression in (yaml.value(node) or ""):gmatch("%${{%s*(.-)%s*}}") do
          if is_untrusted_expression(expression) then report(node, "untrusted_run_expression", "untrusted value must not be interpolated directly in a run script"); break end
        end
      end
    end
    return diagnostics
  end,
}
