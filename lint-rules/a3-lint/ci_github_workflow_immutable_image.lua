return {
  rule_id = "ci-github-workflow-immutable-image",
  description = "Require workflow container and service images to use immutable digests",
  hint = "container、service、docker:// Action の image は @sha256:<64桁hex> へ固定してください。",
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

    local function unquote(value)
      value = value:gsub("%s+#.*$", ""):gsub("^%s+", ""):gsub("%s+$", "")
      if value:match("^\".*\"$") or value:match("^'.*'$") then
        return value:sub(2, -2)
      end
      return value
    end

    local function immutable(value)
      local digest = unquote(value):match("@sha256:([0-9a-fA-F]+)$")
      return digest ~= nil and #digest == 64
    end

    local diagnostics = {}
    local function report(line_number, raw_line)
      table.insert(diagnostics, {
        message = "container or service image must use an immutable sha256 digest",
        code = "ci_github_workflow_immutable_image_required",
        start_line = line_number,
        start_col = 1,
        end_line = line_number,
        end_col = #raw_line + 1,
      })
    end

    local function scan_flow_images(text, line_number, raw_line)
      for flow_image in text:gmatch("image:%s*([^,%}%s]+)") do
        if not immutable(flow_image) then
          report(line_number, raw_line)
        end
      end
      for flow_image in text:gmatch("['\"]image['\"]:%s*([^,%}%s]+)") do
        if not immutable(flow_image) then
          report(line_number, raw_line)
        end
      end
    end

    local function flow_delta(text)
      local _, opens = text:gsub("{", "")
      local _, closes = text:gsub("}", "")
      return opens - closes
    end

    local services_indent = nil
    local services_flow_depth = nil
    local container_indent = nil
    local container_flow_depth = nil
    local line_number = 0
    for raw_line in (source() .. "\n"):gmatch("([^\n]*)\n") do
      line_number = line_number + 1
      local content = raw_line:gsub("%s+#.*$", "")
      local leading = content:match("^(%s*)") or ""
      local trimmed = content:match("^%s*(.-)%s*$") or ""
      if services_flow_depth ~= nil then
        scan_flow_images(content, line_number, raw_line)
        services_flow_depth = services_flow_depth + flow_delta(content)
        if services_flow_depth <= 0 then
          services_flow_depth = nil
        end
      end
      if container_flow_depth ~= nil then
        scan_flow_images(content, line_number, raw_line)
        container_flow_depth = container_flow_depth + flow_delta(content)
        if container_flow_depth <= 0 then
          container_flow_depth = nil
        end
      end
      if trimmed ~= "" then
        if services_indent ~= nil and #leading <= services_indent then
          services_indent = nil
        end
        if container_indent ~= nil and #leading <= container_indent then
          container_indent = nil
        end
      end

      local indent, key, value = content:match("^(%s*)%-%s*['\"]([%w_%-]+)['\"]:%s*(.-)%s*$")
      if key == nil then
        indent, key, value = content:match("^(%s*)%-%s*([%w_%-]+):%s*(.-)%s*$")
      end
      if key == nil then
        indent, key, value = content:match("^(%s*)['\"]([%w_%-]+)['\"]:%s*(.-)%s*$")
      end
      if key == nil then
        indent, key, value = content:match("^(%s*)([%w_%-]+):%s*(.-)%s*$")
      end
      if key ~= nil then
        local normalized = unquote(value)
        if key == "uses" and normalized:match("^docker://") ~= nil then
          if not immutable(normalized) then report(line_number, raw_line) end
        elseif key == "services" then
          services_indent = #indent
          scan_flow_images(value, line_number, raw_line)
          if flow_delta(value) > 0 then
            services_flow_depth = flow_delta(value)
          end
        elseif services_indent ~= nil
          and services_flow_depth == nil
          and key ~= "image"
          and #indent > services_indent then
          scan_flow_images(value, line_number, raw_line)
          if flow_delta(value) > 0 then
            services_flow_depth = flow_delta(value)
          end
        elseif key == "container" then
          local flow_image = value:match("image:%s*([^,%}%s]+)")
          if flow_image == nil then
            flow_image = value:match("['\"]image['\"]:%s*([^,%}%s]+)")
          end
          if flow_image ~= nil then
            if not immutable(flow_image) then
              report(line_number, raw_line)
            end
          elseif value == "" or value == "{}" then
            container_indent = #indent
          elseif flow_delta(value) > 0 then
            container_flow_depth = flow_delta(value)
          elseif not immutable(normalized) then
            report(line_number, raw_line)
          end
        elseif key == "image"
          and services_flow_depth == nil
          and container_flow_depth == nil
          and ((services_indent ~= nil and #indent > services_indent)
            or (container_indent ~= nil and #indent > container_indent))
          and not immutable(normalized) then
          report(line_number, raw_line)
        end
      end
    end
    return diagnostics
  end,
}
