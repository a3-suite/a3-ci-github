local M = {}

function M.context(ctx)
  local target = type(ctx.project) == "table" and ctx.project.current_target or nil
  local path = type(target) == "table" and target.path or (ctx.path or ctx.file or "")
  local source = type(target) == "table" and target.text or nil
  if source == nil then source = ctx.source() end
  assert(ctx.yaml and ctx.yaml.status == "ready", "YAML structure observation must be ready")
  return { path = path:gsub("\\", "/"), source = source, root = ctx.yaml.root }
end

function M.field(node, name)
  if node and node.kind == "mapping" then
    for _, entry in ipairs(node.entries) do
      if entry.key.value == name then return entry.value end
    end
  end
end

function M.value(node)
  if node and node.kind == "scalar" then return node.value end
end

function M.items(node)
  return node and node.kind == "sequence" and node.items or {}
end

function M.values(node)
  local values = {}
  if node and node.kind == "mapping" then
    for _, entry in ipairs(node.entries) do table.insert(values, entry.value) end
  end
  return values
end

function M.workflow(context)
  return ("/" .. context.path):match("/%.github/workflows/") ~= nil and context.path:match("%.ya?ml$") ~= nil
end

function M.jobs(context)
  if not M.workflow(context) then return {} end
  return M.values(M.field(context.root, "jobs"))
end

function M.steps(context)
  local steps = {}
  for _, job in ipairs(M.jobs(context)) do
    for _, step in ipairs(M.items(M.field(job, "steps"))) do table.insert(steps, step) end
  end
  if ("/" .. context.path):match("/action%.ya?ml$") then
    local runs = M.field(context.root, "runs")
    if M.value(M.field(runs, "using")) == "composite" then
      for _, step in ipairs(M.items(M.field(runs, "steps"))) do table.insert(steps, step) end
    end
  end
  return steps
end

function M.runner_labels(job)
  local runner = M.field(job, "runs-on")
  if runner and runner.kind == "mapping" then runner = M.field(runner, "labels") end
  if M.value(runner) then return { runner } end
  return M.items(runner)
end

local function position(source, offset)
  local prefix = source:sub(1, offset)
  local _, lines = prefix:gsub("\n", "\n")
  local tail = prefix:match("[^\n]*$") or ""
  return lines + 1, #tail + 1
end

function M.diagnostic(context, node, code, message)
  local span = node and node.span or { start_offset = 0, end_offset = 0 }
  local first_line, first_col = position(context.source, span.start_offset)
  local last_line, last_col = position(context.source, span.end_offset)
  return { code = code, message = message, start_line = first_line, start_col = first_col,
    end_line = last_line, end_col = last_col }
end

-- This keeps literal cat heredoc data out of direct-command checks; it is not a shell parser.
function M.command_lines(value)
  local commands, delimiter, strip_tabs = {}, nil, false
  for line in (value .. "\n"):gmatch("([^\n]*)\n") do
    if delimiter then
      local candidate = strip_tabs and line:gsub("^\t+", "") or line
      if candidate == delimiter then delimiter = nil end
    elseif not line:match("^%s*#") and line:match("%S") then
      table.insert(commands, line)
      local marker, quote, word = line:match("^%s*cat%s+<<(%-?)%s*(['\"]?)([%w_]+)%2%s*$")
      if word then delimiter, strip_tabs = word, marker == "-" end
    end
  end
  return commands
end

return M
