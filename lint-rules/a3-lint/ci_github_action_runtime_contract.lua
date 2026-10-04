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
    lua_reason = "view:raw:v1",
    lua_evidence = { required_runtime_capability = "view:raw:v1" },
  },
  governance = {
    rule_family = "structural-pattern",
    required_capability_gaps = { "view:raw:v1" },
    dsl_gap_evidence = "required_runtime_capability",
    migration_candidate = "revisit_after_capability_extension",
  },
  check = function(ctx)
    local target = type(ctx.project) == "table" and ctx.project.current_target or nil
    local filename = type(target) == "table" and target.path or (ctx.path or ctx.file or "")
    filename = filename:gsub("\\", "/")
    local diagnostics = {}
    if not filename:match("/actions/[^/]+/action%.ya?ml$") then return diagnostics end
    local content = type(target) == "table" and target.text or ""
    if content == "" and type(ctx.source) == "function" then content = ctx.source() end
    local lines = {}
    for line in (content .. "\n"):gmatch("([^\n]*)\n") do table.insert(lines, line) end
    local function scalar(value)
      return value:gsub("%s+#.*$", ""):gsub("^%s+", ""):gsub("%s+$", ""):gsub("^[\"']", ""):gsub("[\"']$", "")
    end
    local function report(line, code, message)
      table.insert(diagnostics, { code = code, message = message, start_line = line, start_col = 1, end_line = line, end_col = #lines[line] + 1 })
    end
    local runtime, entrypoint, runtime_line, main_line = nil, nil, nil, nil
    local runs_line, runs_end = nil, #lines
    for index, line in ipairs(lines) do
      if line:match("^[\"']?runs[\"']?:%s*$") then runs_line = index end
      if runs_line ~= nil and index > runs_line and line:match("^%S") and not line:match("^#") then runs_end = index - 1; break end
    end
    if runs_line == nil then
      report(1, "ci_github_action_runs_unchecked", "Action runs must use the repository block mapping form for runtime checks")
      return diagnostics
    end
    for index = runs_line + 1, runs_end do
      local value = lines[index]:match("^  [\"']?using[\"']?:%s*(.-)%s*$")
      if value ~= nil then runtime, runtime_line = scalar(value), index end
      value = lines[index]:match("^  [\"']?main[\"']?:%s*(.-)%s*$")
      if value ~= nil then entrypoint, main_line = scalar(value), index end
    end
    if runtime ~= "node24" and runtime ~= "composite" then
      report(runtime_line or runs_line, "ci_github_action_runtime_unsupported", "repository Action runtime must be node24 or composite")
    elseif runtime == "node24" and entrypoint ~= "dist/index.js" then
      report(main_line or runs_line, "ci_github_action_main_not_dist", "Node Action main must be dist/index.js")
    elseif runtime == "composite" then
      local run_indent = nil
      for index = runs_line + 1, runs_end do
        local line = lines[index]
        local indent, command = line:match("^(%s*)run:%s*(.-)%s*$")
        if indent == nil then indent, command = line:match("^(%s*)%-%s+run:%s*(.-)%s*$") end
        local candidate = nil
        if command ~= nil then
          if command:match("^[|>][+-]?%s*$") then run_indent = #indent else candidate = scalar(command); run_indent = nil end
        elseif run_indent ~= nil then
          local leading = line:match("^(%s*)") or ""
          if line:match("^%s*$") then
            candidate = nil
          elseif #leading > run_indent then candidate = line:match("^%s*(.-)%s*$")
          else run_indent = nil end
        end
        if candidate ~= nil and (candidate:match("^node%s") or candidate:match("^exec%s+node%s")) then
          report(index, "ci_github_action_runner_node_review", "Composite runner Node invocation requires runtime ownership review")
        end
      end
    end
    return diagnostics
  end,
}
