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

    local workflow_path = path()
    if workflow_path:match("/%.github/workflows/") == nil
      or workflow_path:match("%.ya?ml$") == nil then
      return {}
    end

    local stem = workflow_path:match("/([^/]+)%.ya?ml$")
    local diagnostics = {}
    local name = nil
    local name_line = 1
    local line_number = 0
    for raw_line in (source() .. "\n"):gmatch("([^\n]*)\n") do
      line_number = line_number + 1
      local value = raw_line:gsub("#.*$", ""):match("^name:%s*(.-)%s*$")
      if value ~= nil and name == nil then
        name = value:gsub("^['\"]", ""):gsub("['\"]$", "")
        name_line = line_number
      end
    end

    local valid_stem = stem ~= nil
      and stem:match("^[a-z0-9%-]+$") ~= nil
      and stem:match("^%-") == nil
      and stem:match("%-$") == nil
      and stem:match("%-%-") == nil
    if not valid_stem then
      table.insert(diagnostics, {
        message = "workflow file name must use lower-kebab-case",
        code = "ci_github_workflow_file_name_invalid",
        start_line = 1,
        start_col = 1,
        end_line = 1,
        end_col = 1,
      })
    elseif name == nil or name ~= stem then
      local name_value = name or ""
      table.insert(diagnostics, {
        message = "workflow name must match the file stem",
        code = "ci_github_workflow_name_mismatch",
        start_line = name_line,
        start_col = 1,
        end_line = name_line,
        end_col = #name_value + 1,
      })
    end
    return diagnostics
  end,
}
