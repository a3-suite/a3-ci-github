return {
  rule_id = "ci-github-ci-readme-contract",
  description = "Require .ci/README.md to follow the CI configuration documentation contract",
  hint = "CI README は固定項目を満たし、標準差分がある場合だけ自由記述を追加してください。",
  languages = { "markdown" },
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
    local function target_path()
      local project = ctx ~= nil and ctx.project or nil
      local target = type(project) == "table" and project.current_target or nil
      if type(target) == "table" and type(target.path) == "string" then
        return target.path:gsub("\\", "/")
      end
      return (ctx ~= nil and (ctx.path or ctx.file) or ""):gsub("\\", "/")
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

    local path = target_path():gsub("^%./", "")
    if path:match("^%.ci/README%.md$") == nil
      and path:match("/%.ci/README%.md$") == nil then
      return {}
    end

    local lines = {}
    for raw_line in (source_text() .. "\n"):gmatch("([^\n]*)\n") do
      local line = raw_line:gsub("\\r$", "")
      table.insert(lines, line)
    end

    local function trimmed(line)
      return (line:match("^%s*(.-)%s*$") or "")
    end

    local function heading(level, title)
      local prefix = string.rep("#", level)
      for index, line in ipairs(lines) do
        if trimmed(line) == prefix .. " " .. title then
          return index
        end
      end
      return nil
    end

    local function section_end(start_line, level)
      if start_line == nil then
        return #lines
      end
      for index = start_line + 1, #lines do
        local hashes = trimmed(lines[index]):match("^(#+)%s")
        if hashes ~= nil and #hashes <= level then
          return index - 1
        end
      end
      return #lines
    end

    local function heading_in_range(level, title, start_line, end_line)
      if start_line == nil then
        return nil
      end
      local prefix = string.rep("#", level)
      for index = start_line, end_line or #lines do
        if trimmed(lines[index]) == prefix .. " " .. title then
          return index
        end
      end
      return nil
    end

    local function nonempty(value)
      value = trimmed(value or "")
      return value ~= ""
        and value ~= "-"
        and value ~= "未記入"
        and value ~= "TODO"
        and value ~= "（記入）"
        and value ~= "(記入)"
    end

    local function substantive(line)
      line = trimmed(line)
      if line == "" or line:match("^<!--") ~= nil or line:match("^#+%s") ~= nil then
        return false
      end
      local field_value = line:match("^[-*]?%s*[^:]+:%s*(.-)%s*$")
      if field_value ~= nil then
        return nonempty(field_value)
      end
      return line ~= "-"
    end

    local diagnostics = {}
    local function report(line_number, code, message)
      table.insert(diagnostics, {
        message = message,
        code = code,
        start_line = line_number or 1,
        start_col = 1,
        end_line = line_number or 1,
        end_col = #(lines[line_number or 1] or "") + 1,
      })
    end

    local fixed_start = heading(2, "固定項目（必須）")
    local fixed_end = section_end(fixed_start, 2)
    if fixed_start == nil then
      report(1, "ci_github_ci_readme_fixed_section_missing", "CI README must include the fixed-items section")
    end

    local required_subsections = {
      { "目的と対象", "ci_github_ci_readme_purpose_missing" },
      { "採用 preset / flow", "ci_github_ci_readme_preset_missing" },
      { "project 固有差分", "ci_github_ci_readme_difference_section_missing" },
    }
    for _, item in ipairs(required_subsections) do
      local subsection_start = heading_in_range(3, item[1], fixed_start, fixed_end)
      if subsection_start == nil then
        report(fixed_start or 1, item[2], "CI README fixed-items section must include '" .. item[1] .. "'")
      else
        local subsection_end = section_end(subsection_start, 3)
        local has_content = false
        for index = subsection_start + 1, subsection_end do
          if substantive(lines[index]) then
            has_content = true
            break
          end
        end
        if not has_content then
          report(subsection_start, item[2] .. "_empty", "CI README fixed subsection '" .. item[1] .. "' must not be empty")
        end
      end
    end

    local difference_start = heading_in_range(3, "project 固有差分", fixed_start, fixed_end)
    local difference_end = section_end(difference_start, 3)
    local field_values = {}
    local field_lines = {}
    local field_names = {
      "差分種別",
      "owner",
      "正本・検証導線",
      "検証証跡",
      "更新・撤去条件",
    }
    local difference_scan_start = difference_start or 1
    local difference_scan_end = difference_start ~= nil and difference_end or 0
    for index = difference_scan_start, difference_scan_end do
      local line = lines[index]
      for _, field in ipairs(field_names) do
        local value = line:match("^%s*[-*]?%s*" .. field .. ":%s*(.-)%s*$")
        if value ~= nil then
          field_values[field] = value
          field_lines[field] = index
        end
      end
    end

    local required_fields = {
      { "差分種別", "ci_github_ci_readme_difference_type_missing" },
      { "owner", "ci_github_ci_readme_owner_missing" },
      { "正本・検証導線", "ci_github_ci_readme_source_link_missing" },
      { "検証証跡", "ci_github_ci_readme_evidence_missing" },
      { "更新・撤去条件", "ci_github_ci_readme_lifecycle_missing" },
    }
    for _, item in ipairs(required_fields) do
      local value = field_values[item[1]]
      if not nonempty(value) then
        report(field_lines[item[1]] or fixed_start or 1, item[2], "CI README fixed item '" .. item[1] .. "' must be non-empty")
      end
    end

    local difference_type = trimmed(field_values["差分種別"] or "")
    local optional_start = heading(2, "オプション項目（該当時のみ）")
    if optional_start ~= nil then
      local optional_end = section_end(optional_start, 2)
      local has_optional_content = false
      for index = optional_start + 1, optional_end do
        if substantive(lines[index]) then
          has_optional_content = true
          break
        end
      end
      if not has_optional_content then
        report(optional_start, "ci_github_ci_readme_optional_section_empty", "Optional CI README section must be omitted when no optional item applies")
      end
    end

    local free_start = heading(2, "自由記述（標準からの差異がある場合のみ）")
    local has_difference = difference_type ~= "" and difference_type ~= "なし"
    if has_difference and free_start == nil then
      report(field_lines["差分種別"] or fixed_start or 1, "ci_github_ci_readme_free_section_missing", "CI README must describe a non-standard difference in the free-text section")
    elseif not has_difference and free_start ~= nil then
      report(free_start, "ci_github_ci_readme_free_section_unnecessary", "CI README free-text section is only allowed for a non-standard difference")
    elseif free_start ~= nil then
      local free_end = section_end(free_start, 2)
      local has_free_content = false
      for index = free_start + 1, free_end do
        if substantive(lines[index]) then
          has_free_content = true
          break
        end
      end
      if not has_free_content then
        report(free_start, "ci_github_ci_readme_free_section_empty", "CI README free-text section must explain the non-standard difference")
      end
    end

    return diagnostics
  end,
}
