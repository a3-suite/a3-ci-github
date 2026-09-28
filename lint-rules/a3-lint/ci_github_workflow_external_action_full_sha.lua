return {
  rule_id = "ci-github-workflow-external-action-full-sha",
  description = "Require external GitHub Actions references to use a full commit SHA",
  hint = "外部 Action は小文字 hex 40 桁の commit SHA へ固定してください。",
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

    local function valid_commit_sha(reference)
      return #reference == 40 and reference:match("^[0-9a-f]+$") ~= nil
    end

    local diagnostics = {}
    local scalar_indent = nil
    local function report(raw_line, line_number, value)
      value = value:gsub("%s+#.*$", ""):gsub("^%s+", ""):gsub("%s+$", "")
      if value:match("^[\"'].*[\"']$") then
        value = value:sub(2, -2)
      end
      if not value:match("^%./") and not value:match("^docker://") then
        local reference = value:match("@([^@]+)$")
        if reference == nil or not valid_commit_sha(reference) then
          table.insert(diagnostics, {
            message = "external Action must use a full lowercase commit SHA",
            code = "ci_github_workflow_external_action_not_full_sha",
            start_line = line_number,
            start_col = 1,
            end_line = line_number,
            end_col = #raw_line + 1,
          })
        end
      end
    end

    local line_number = 0
    for raw_line in (source() .. "\n"):gmatch("([^\n]*)\n") do
      line_number = line_number + 1
      local line = raw_line:gsub("%s+#.*$", "")
      local leading = line:match("^(%s*)") or ""
      local trimmed = line:match("^%s*(.-)%s*$") or ""
      local in_scalar = false
      if scalar_indent ~= nil then
        if trimmed == "" or #leading > scalar_indent then
          in_scalar = true
        else
          scalar_indent = nil
        end
      end
      if not in_scalar then
        local run_line = line:match("^%s*%-%s*[%\"']?run[%\"']?:") ~= nil
          or line:match("^%s*[%\"']?run[%\"']?:") ~= nil
        local run_indent = line:match("^(%s*)%-%s*[%\"']?run[%\"']?:%s*([|>][+-]?)%s*$")
          or line:match("^(%s*)[%\"']?run[%\"']?:%s*([|>][+-]?)%s*$")
        if run_indent ~= nil then
          scalar_indent = #run_indent
        end

        if not run_line then
          local uses = line:match("^%s*%-%s*[%\"']?uses[%\"']?:%s*(.-)%s*$")
            or line:match("^%s*[%\"']?uses[%\"']?:%s*(.-)%s*$")
          if uses ~= nil and not uses:match("^[{]") then
            report(raw_line, line_number, uses)
          end
          for flow_value in line:gmatch("[{,]%s*[%\"']?uses[%\"']?%s*:%s*([^,}]+)") do
            report(raw_line, line_number, flow_value)
          end
        end
      end
    end
    return diagnostics
  end,
}
