return {
  rule_id = "ci-github-workflow-no-privileged-cancel",
  description = "Forbid automatic cancellation in manually or release-triggered CI workflows",
  hint = "publish / deploy / release / manual 系workflowでは自動キャンセルを無効にしてください。",
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

    local text = source()
    local function has_inline_privileged_trigger(value)
      local normalized = value:gsub("%s+#.*$", "")
      if normalized:match("tags%s*:") ~= nil then
        return true
      end
      if normalized:match("workflow_dispatch%s*:") ~= nil
        or normalized:match("workflow_run%s*:") ~= nil then
        return true
      end
      local event_list = normalized:match("^%s*%[(.-)%]%s*$")
      if event_list ~= nil then
        for token in event_list:gmatch("[%w_%-]+") do
          if token == "workflow_dispatch" or token == "workflow_run" then
            return true
          end
        end
      end
      if normalized:match("^%s*workflow_dispatch%s*$") ~= nil
        or normalized:match("^%s*workflow_run%s*$") ~= nil then
        return true
      end
      return false
    end

    local privileged_trigger = false
    local in_on = false
    local on_indent = nil
    local in_push = false
    local push_indent = nil
    for raw_line in (text .. "\n"):gmatch("([^\n]*)\n") do
      local content = raw_line:gsub("%s+#.*$", "")
      local leading = content:match("^(%s*)") or ""
      local trimmed = content:match("^%s*(.-)%s*$") or ""
      local top_indent, inline_trigger = content:match("^(%s*)on:%s*(.-)%s*$")
      if top_indent ~= nil and #top_indent == 0 then
        in_on = true
        on_indent = 0
        if has_inline_privileged_trigger(inline_trigger) then
          privileged_trigger = true
          break
        end
      elseif in_on then
        if trimmed ~= "" and #leading <= on_indent then
          in_on = false
          on_indent = nil
          in_push = false
          push_indent = nil
        elseif trimmed ~= "" then
          local key = content:match("^%s*([%w_%-]+)%s*:")
          if key == "workflow_dispatch" or key == "workflow_run" then
            privileged_trigger = true
            break
          elseif key == "push" then
            in_push = true
            push_indent = #leading
            if content:match("tags%s*:") ~= nil then
              privileged_trigger = true
              break
            end
          elseif in_push then
            if push_indent ~= nil and #leading <= push_indent then
              in_push = false
              push_indent = nil
            elseif key == "tags" then
              privileged_trigger = true
              break
            end
          end
        end
      end
    end
    if not privileged_trigger then
      return {}
    end

    local diagnostics = {}
    local line_number = 0
    for raw_line in (text .. "\n"):gmatch("([^\n]*)\n") do
      line_number = line_number + 1
      local value = raw_line:match("^%s*cancel%-in%-progress:%s*(['\"]?)true%1%s*$")
      if value ~= nil then
        table.insert(diagnostics, {
          message = "privileged or release-triggered workflow must not cancel in progress",
          code = "ci_github_workflow_privileged_cancel",
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
