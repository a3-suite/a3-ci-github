return {
  rule_id = "ci-github-workflow-no-untrusted-runner-selector",
  description = "Forbid untrusted GitHub Actions values from selecting the runner",
  hint = "runs-on は固定値またはレビュー済み matrix / allowlist へ写像してください。",
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
      -- A computed expression may map an input to an allowlisted runner.  Only
      -- a direct source reference is a high-confidence violation here.
      return expression:match("^inputs%.[%w_%-]+$") ~= nil
        or expression:match("^github%.event%.pull_request%.head%.ref$") ~= nil
        or expression:match("^github%.event%.pull_request%.base%.ref$") ~= nil
        or expression:match("^github%.event%.issue%.title$") ~= nil
        or expression:match("^github%.event%.issue%.body$") ~= nil
        or expression:match("^github%.event%.comment%.title$") ~= nil
        or expression:match("^github%.event%.comment%.body$") ~= nil
        or expression:match("^github%.event%.inputs%.[%w_%-]+$") ~= nil
        or expression:match("^github%.head_ref$") ~= nil
        or expression:match("^github%.base_ref$") ~= nil
        or expression:match("^github%.ref_name$") ~= nil
    end
    for _, job in ipairs(yaml.jobs(context)) do
      for _, node in ipairs(yaml.runner_labels(job)) do
        for expression in (yaml.value(node) or ""):gmatch("%${{%s*(.-)%s*}}") do
          if is_untrusted_expression(expression) then report(node, "untrusted_runner_selector", "untrusted value must not select the runner"); break end
        end
      end
    end
    return diagnostics
  end,
}
