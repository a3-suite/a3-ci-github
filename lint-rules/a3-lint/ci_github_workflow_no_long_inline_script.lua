return {
  rule_id = "ci-github-workflow-no-long-inline-script",
  description = "Flag long YAML block scripts for semantic review",
  hint = "空行を除く10行超は意味レビューの起点です。外部化の便益と追加の保守コストを比較してください。",
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

    local lines = {}
    for raw_line in (source() .. "\n"):gmatch("([^\n]*)\n") do
      table.insert(lines, raw_line)
    end
    local diagnostics = {}
    local line_number = 1
    while line_number <= #lines do
      local raw_line = lines[line_number]
      local indent, marker = raw_line:match("^(%s*)%-%s+run:%s*([|>][+-]?)%s*$")
      if indent == nil then
        indent, marker = raw_line:match("^(%s*)run:%s*([|>][+-]?)%s*$")
      end
      if marker ~= nil then
        local body_count = 0
        local body_indent = nil
        local cursor = line_number + 1
        while cursor <= #lines do
          local body = lines[cursor]
          local leading = body:match("^(%s*)") or ""
          local trimmed = body:match("^%s*(.-)%s*$") or ""
          if trimmed == "" then
            cursor = cursor + 1
          elseif #leading > #indent then
            if body_indent == nil then
              body_indent = #leading
              body_count = 1
              cursor = cursor + 1
            elseif #leading >= body_indent then
              body_count = body_count + 1
              cursor = cursor + 1
            else
              break
            end
          else
            break
          end
        end
        if body_count > 10 then
          table.insert(diagnostics, {
            message = "long inline CI script requires semantic review",
            code = "ci_github_workflow_long_inline_script",
            start_line = line_number,
            start_col = 1,
            end_line = line_number,
            end_col = #raw_line + 1,
          })
        end
        line_number = cursor
      else
        line_number = line_number + 1
      end
    end
    return diagnostics
  end,
}
