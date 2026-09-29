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
      -- Computed expressions may map an input to a reviewed fixed value.  This
      -- raw-view rule only rejects an untrusted source used without such a
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

    local function has_untrusted_expression(line)
      if line:match("^%s*#") ~= nil then
        return false
      end
      for expression in line:gmatch("%${{%s*(.-)%s*}}") do
        if is_untrusted_expression(expression) then
          return true
        end
      end
      return false
    end

    local diagnostics = {}
    local function inspect_line(line, line_number)
      if has_untrusted_expression(line) then
        table.insert(diagnostics, {
          message = "untrusted value must not be interpolated directly in a run script",
          code = "ci_github_workflow_untrusted_run_expression",
          start_line = line_number,
          start_col = 1,
          end_line = line_number,
          end_col = #line + 1,
        })
      end
    end

    local block_indent = nil
    local line_number = 0
    for raw_line in (source() .. "\n"):gmatch("([^\n]*)\n") do
      line_number = line_number + 1
      if block_indent ~= nil then
        local leading = raw_line:match("^(%s*)") or ""
        local trimmed = raw_line:match("^%s*(.-)%s*$") or ""
        if trimmed ~= "" and #leading <= block_indent then
          block_indent = nil
        else
          inspect_line(raw_line, line_number)
        end
      end

      if block_indent == nil then
        local indent, value = raw_line:match("^(%s*)%-%s+run:%s*(.*)$")
        local key_indent = nil
        if indent == nil then
          indent, value = raw_line:match("^(%s*)run:%s*(.*)$")
        else
          key_indent = #indent + 2
        end
        if key_indent == nil and indent ~= nil then
          key_indent = #indent
        end
        if indent ~= nil then
          if value:match("^[|>][+-]?%s*$") ~= nil then
            block_indent = key_indent
          else
            inspect_line(value, line_number)
          end
        end
      end
    end
    return diagnostics
  end,
}
