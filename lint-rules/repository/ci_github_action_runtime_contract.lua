return {
  rule_id = "ci-github-action-runtime-contract",
  description = "Check repository Action runtime declarations and flag runner Node invocation in Composite Actions",
  hint = "共通処理は node24 と dist/index.js を標準とします。Composite の Node 直起動は docs/maintenance/action-construction.md に照らして方式をレビューしてください。",
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
    lua_evidence = { required_runtime_capability = "fact:yaml_structure:v1" },
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
    if not ("/" .. context.path):match("/actions/[^/]+/action%.ya?ml$") then return {} end
    local diagnostics = {}
    local function report(node, code, message)
      table.insert(diagnostics, yaml.diagnostic(context, node, "ci_github_action_" .. code, message))
    end
    local runs = yaml.field(context.root, "runs")
    if not runs or runs.kind ~= "mapping" then
      report(runs, "runs_unchecked", "Action runs must be a mapping")
      return diagnostics
    end
    local using = yaml.field(runs, "using")
    local main = yaml.field(runs, "main")
    local runtime = yaml.value(using)
    if runtime ~= "node24" and runtime ~= "composite" then report(using, "runtime_unsupported", "repository Action runtime must be node24 or composite")
    elseif runtime == "node24" and yaml.value(main) ~= "dist/index.js" then report(main, "main_not_dist", "Node Action main must be dist/index.js")
    elseif runtime == "composite" then
      for _, step in ipairs(yaml.items(yaml.field(runs, "steps"))) do
        local node = yaml.field(step, "run")
        for _, line in ipairs(yaml.command_lines(yaml.value(node) or "")) do
          if line:match("^%s*node%s") or line:match("^%s*exec%s+node%s") then
            report(node, "runner_node_review", "Composite runner Node invocation requires runtime ownership review"); break
          end
        end
      end
    end
    return diagnostics
  end,
}
