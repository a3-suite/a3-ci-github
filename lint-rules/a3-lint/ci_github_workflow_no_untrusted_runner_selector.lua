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
    lua_reason = "view:raw:v1",
    lua_evidence = {
      required_runtime_capability = "view:raw:v1",
    },
  },
  governance = {
    rule_family = "structural-pattern",
    required_capability_gaps = { "view:raw:v1" },
    dsl_gap_evidence = "required_runtime_capability",
    migration_candidate = "revisit_after_capability_extension",
  },
  check = function(ctx)
    local function path()
      local project = ctx ~= nil and ctx.project or nil
      local target = type(project) == "table" and project.current_target or nil
      if type(target) == "table" and type(target.path) == "string" then
        return target.path:gsub("\\", "/")
      end
      return (ctx ~= nil and (ctx.path or ctx.file) or ""):gsub("\\", "/")
    end

    local function source()
      local project = ctx ~= nil and ctx.project or nil
      local target = type(project) == "table" and project.current_target or nil
      if type(target) == "table" and type(target.text) == "string" then
        return target.text
      end
      if ctx ~= nil and type(ctx.source) == "function" then
        local ok, value = pcall(ctx.source)
        if ok and type(value) == "string" then
          return value
        end
      end
      return ""
    end

    local workflow = path():match("/%.github/workflows/") ~= nil
      and path():match("%.ya?ml$") ~= nil
    if not workflow then
      return {}
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

    local diagnostics = {}
    local line_number = 0
    for raw_line in (source() .. "\n"):gmatch("([^\n]*)\n") do
      line_number = line_number + 1
      local value = raw_line:match("^%s*runs%-on:%s*(.-)%s*$")
      if value ~= nil then
        for expression in value:gmatch("%${{%s*(.-)%s*}}") do
          if is_untrusted_expression(expression) then
            table.insert(diagnostics, {
              message = "untrusted value must not select the runner",
              code = "ci_github_workflow_untrusted_runner_selector",
              start_line = line_number,
              start_col = 1,
              end_line = line_number,
              end_col = #raw_line + 1,
            })
            break
          end
        end
      end
    end
    return diagnostics
  end,
}
