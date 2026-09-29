return {
  rule_id = "ci-github-workflow-no-moving-runner",
  description = "Forbid moving latest runner labels in CI workflows",
  hint = "runner は ubuntu-24.04 などの versioned label を使用してください。",
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

    local diagnostics = {}
    local line_number = 0
    for raw_line in (source() .. "\n"):gmatch("([^\n]*)\n") do
      line_number = line_number + 1
      local line = raw_line:gsub("#.*$", "")
      if line:match("^%s*runs%-on:%s*\"?ubuntu%-latest")
        or line:match("^%s*runs%-on:%s*\"?windows%-latest")
        or line:match("^%s*runs%-on:%s*\"?macos%-latest") then
        table.insert(diagnostics, {
          message = "moving runner label is forbidden",
          code = "ci_github_workflow_moving_runner",
          start_line = line_number,
          start_col = 1,
          end_line = line_number,
          end_col = #raw_line + 1,
        })
      end
    end
    return diagnostics
  end,
}
