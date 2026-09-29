return {
  rule_id = "ci-github-runtime-no-a3-cli",
  description = "Forbid known a3 CLI invocations in CI workflows and scripts",
  hint = "CI runtime から a3-* CLI を呼び出さず、project-local の検証資材を使用してください。",
  languages = { "yaml", "javascript", "typescript" },
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
    local function normalize_path(path)
      return (path or ""):gsub("\\", "/")
    end

    local function target_path()
      local project = ctx ~= nil and ctx.project or nil
      local target = type(project) == "table" and project.current_target or nil
      if type(target) == "table" and type(target.path) == "string" then
        return normalize_path(target.path)
      end
      return normalize_path(ctx ~= nil and (ctx.path or ctx.file) or "")
    end

    local function source_text()
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

    local function is_workflow(path)
      return path:match("/%.github/workflows/") ~= nil
        and path:match("%.ya?ml$") ~= nil
    end

    local function is_script(path)
      return (path:match("/%.ci/scripts/") ~= nil
        or path:match("/%.ci/provider/") ~= nil
        or path:match("/%.ci/trusted/") ~= nil)
        and path:match("%.[jt]s$") ~= nil
    end

    local function diagnostic(line, message)
      return {
        message = message,
        code = "ci_github_runtime_a3_cli_forbidden",
        start_line = line,
        start_col = 1,
        end_line = line,
        end_col = #message + 1,
      }
    end

    local function mask_javascript_non_code(source)
      local masked = {}
      local state = "code"
      local index = 1
      while index <= #source do
        local current = source:sub(index, index)
        local next_char = source:sub(index + 1, index + 1)
        if state == "code" then
          if current == "/" and next_char == "/" then
            table.insert(masked, "  ")
            index = index + 2
            state = "line_comment"
          elseif current == "/" and next_char == "*" then
            table.insert(masked, "  ")
            index = index + 2
            state = "block_comment"
          elseif current == "\"" or current == "'" or current == "`" then
            table.insert(masked, current)
            index = index + 1
            state = current
          else
            table.insert(masked, current)
            index = index + 1
          end
        elseif state == "line_comment" then
          if current == "\n" then
            table.insert(masked, "\n")
            state = "code"
          else
            table.insert(masked, " ")
          end
          index = index + 1
        elseif state == "block_comment" then
          if current == "*" and next_char == "/" then
            table.insert(masked, "  ")
            index = index + 2
            state = "code"
          else
            table.insert(masked, current == "\n" and "\n" or " ")
            index = index + 1
          end
        else
          if current == "\\" then
            table.insert(masked, "  ")
            index = index + 2
          elseif current == state then
            table.insert(masked, current)
            index = index + 1
            state = "code"
          else
            table.insert(masked, current == "\n" and "\n" or " ")
            index = index + 1
          end
        end
      end
      return table.concat(masked)
    end

    local function has_a3_cli_call(source, masked, function_name)
      local function is_identifier_byte(value)
        if value == "" then
          return false
        end
        local byte = value:byte()
        return byte >= 128 or value:match("^[%w_$]$") ~= nil
      end

      local offset = 1
      while true do
        local call_pattern = function_name .. "%s*%(%s*"
        local start_pos, end_pos = masked:find(call_pattern, offset)
        if start_pos == nil then
          return nil
        end
        local before = masked:sub(start_pos - 1, start_pos - 1)
        local after = masked:sub(start_pos + #function_name, start_pos + #function_name)
        if not is_identifier_byte(before) and not is_identifier_byte(after) then
          local argument, suffix = source:sub(end_pos + 1):match("^%s*[\"']a3%-([%w%-]+)(.*)")
          local suffix_start = suffix ~= nil and suffix:sub(1, 1) or ""
          local terminated = suffix_start == ""
            or suffix_start == "\""
            or suffix_start == "'"
            or suffix_start:match("[%s,;|&)]") ~= nil
          if terminated and (argument == "lint" or argument == "suite") then
            return start_pos
          end
        end
        offset = end_pos + 1
      end
    end

    local path = target_path()
    local workflow = is_workflow(path)
    local script = is_script(path)
    if not workflow and not script then
      return {}
    end

    local diagnostics = {}
    if script then
      local source = source_text()
      local masked = mask_javascript_non_code(source)
      local call_pos = nil
      for _, function_name in ipairs({ "exec", "execFile", "execFileSync", "execSync", "spawn", "spawnSync" }) do
        call_pos = has_a3_cli_call(source, masked, function_name)
        if call_pos ~= nil then
          break
        end
      end
      if call_pos ~= nil then
        local _, preceding_lines = source:sub(1, call_pos):gsub("\n", "\n")
        table.insert(diagnostics, diagnostic(preceding_lines + 1, "CI script must not invoke a3-* CLI"))
      end
      return diagnostics
    end

    local scalar_indent = nil
    local line_number = 0
    for raw_line in (source_text() .. "\n"):gmatch("([^\n]*)\n") do
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
      if workflow then
        local function invokes_cli(value)
          value = value:gsub("^[\"']", ""):gsub("[\"']$", "")
          return value:match("^%s*a3%-lint[%s;&|]") ~= nil
            or value:match("^%s*a3%-suite[%s;&|]") ~= nil
            or value:match("[;&|]%s*a3%-lint[%s;&|]") ~= nil
            or value:match("[;&|]%s*a3%-suite[%s;&|]") ~= nil
            or value:match("^%s*a3%-lint%s*$") ~= nil
            or value:match("^%s*a3%-suite%s*$") ~= nil
        end

        if in_scalar then
          if invokes_cli(line) then
            table.insert(diagnostics, diagnostic(line_number, "CI runtime must not invoke a3-* CLI"))
          end
        else
          local run_indent, run_value = line:match("^(%s*)%-%s*[%\"']?run[%\"']?:%s*(.-)%s*$")
          if run_indent == nil then
            run_indent, run_value = line:match("^(%s*)[%\"']?run[%\"']?:%s*(.-)%s*$")
          end
          if run_indent ~= nil then
            local scalar = run_value:match("^[|>][+-]?%s*$") ~= nil
            if scalar then
              scalar_indent = #run_indent
            elseif invokes_cli(run_value) then
              table.insert(diagnostics, diagnostic(line_number, "CI runtime must not invoke a3-* CLI"))
            end
          end
        end
      end
    end
    return diagnostics
  end,
}
