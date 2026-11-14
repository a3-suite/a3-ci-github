return {
  rule_id = "ci-github-runtime-no-a3-cli",
  description = "Forbid known a3 CLI invocations in CI JavaScript and TypeScript scripts",
  hint = "CI runtime から a3-* CLI を呼び出さず、標準 Action / reusable workflow を優先し、project 固有の差分だけを個別実装してください。",
  languages = { "javascript", "typescript" },
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
    lua_reason = "fact:call_expressions:v1",
    lua_evidence = {
      required_runtime_capability = "fact:call_expressions:v1",
    },
  },
  governance = {
    rule_family = "structural-pattern",
    required_capability_gaps = { "fact:call_expressions:v1" },
    dsl_gap_evidence = "required_runtime_capability",
    migration_candidate = "revisit_after_capability_extension",
  },
  check = function(ctx)
    local process_calls = {
      exec = true, execFile = true, execFileSync = true, execSync = true, spawn = true, spawnSync = true,
    }
    local project = ctx ~= nil and ctx.project or nil
    local target = type(project) == "table" and project.current_target or nil

    local function target_path()
      local value = type(target) == "table" and type(target.path) == "string" and target.path
        or (ctx ~= nil and (ctx.path or ctx.file)) or ""
      return (value:gsub("\\", "/"))
    end

    local function source_text()
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

    local function is_script(path)
      return (("/" .. path):match("/%.ci/scripts/") ~= nil
        or ("/" .. path):match("/%.ci/provider/") ~= nil
        or ("/" .. path):match("/%.ci/trusted/") ~= nil)
        and (path:match("%.[jt]s$") ~= nil or path:match("%.mjs$") ~= nil)
    end

    -- The command may carry arguments in the same string, as exec does, but a longer name such as a3-lint-x is another CLI.
    local function is_a3_cli(command)
      local name, rest = command:match("^a3%-([%w%-]+)(.*)$")
      return (name == "lint" or name == "suite") and (rest == "" or rest:match("^[%s,;|&)]") ~= nil)
    end

    if not is_script(target_path()) then
      return {}
    end
    local facts = ctx.facts
    -- An unavailable or failed observation must not read as a script without calls.
    assert(type(facts) == "table" and facts.call_expressions_status == "ready", "call expression observation must be ready")

    local first_offset = nil
    for _, call in ipairs(facts.call_expressions) do
      local command = call.first_argument_literal
      if process_calls[call.callee_name] and type(command) == "string" and is_a3_cli(command)
        and (first_offset == nil or call.callee_name_start_offset < first_offset) then
        first_offset = call.callee_name_start_offset
      end
    end
    if first_offset == nil then
      return {}
    end

    local source = source_text()
    local _, preceding_lines = source:sub(1, first_offset):gsub("\n", "\n")
    local line = preceding_lines + 1
    local text = ""
    local index = 0
    for raw_line in (source .. "\n"):gmatch("([^\n]*)\n") do
      index = index + 1
      if index == line then
        text = raw_line
        break
      end
    end
    return {
      {
        message = "CI script must not invoke a3-* CLI",
        code = "ci_github_runtime_a3_cli_forbidden",
        start_line = line,
        start_col = 1,
        end_line = line,
        end_col = #text + 1,
      },
    }
  end,
}
