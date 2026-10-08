const PLACEHOLDER = /<([A-Za-z][A-Za-z0-9._-]*)>/g;
const WHOLE_PLACEHOLDER = /^<([A-Za-z][A-Za-z0-9._-]*)>$/;
const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const parse = (yaml, text) => {
  const document = yaml.parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new Error('workflow-template-invalid-yaml');
  return document.toJS({ maxAliasCount: 0 });
};

// Product values are read from the installed caller; the template owns its structure.
export const readWorkflowSettings = ({ yaml, template, current, triggerExtensions = {} }) => {
  const values = {};
  const extensions = {};
  const visit = (expected, actual, location = []) => {
    if (typeof expected === 'string' && WHOLE_PLACEHOLDER.test(expected)) {
      const key = expected.match(WHOLE_PLACEHOLDER)[1];
      if (isMap(actual) || actual === undefined || actual === null) throw new Error(`workflow-template-setting-invalid:${key}`);
      if (Object.hasOwn(values, key) && !same(values[key], actual)) throw new Error(`workflow-template-setting-inconsistent:${key}`);
      values[key] = actual;
      return;
    }
    if (typeof expected === 'string' && [...expected.matchAll(PLACEHOLDER)].length) {
      if (typeof actual !== 'string') throw new Error('workflow-template-structure-conflict');
      const parts = expected.split(/(<[A-Za-z][A-Za-z0-9._-]*>)/g);
      const expression = parts.map((part) => WHOLE_PLACEHOLDER.test(part)
        ? '(.+)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
      const match = actual.match(new RegExp(`^${expression}$`));
      if (!match) throw new Error('workflow-template-structure-conflict');
      let index = 1;
      for (const part of parts) {
        if (!WHOLE_PLACEHOLDER.test(part)) continue;
        const key = part.match(WHOLE_PLACEHOLDER)[1];
        if (!key.endsWith('-workflow-sha') && key !== 'commit-sha') {
          if (Object.hasOwn(values, key) && !same(values[key], match[index])) throw new Error(`workflow-template-setting-inconsistent:${key}`);
          values[key] = match[index];
        }
        index += 1;
      }
      return;
    }
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual)) throw new Error('workflow-template-structure-conflict');
      if (expected.length === 1 && typeof expected[0] === 'string' && WHOLE_PLACEHOLDER.test(expected[0])) {
        if (!actual.length || actual.some((item) => typeof item !== 'string' || !item)) throw new Error('workflow-template-list-invalid');
        values[expected[0].match(WHOLE_PLACEHOLDER)[1]] = actual;
        return;
      }
      if (expected.length !== actual.length) throw new Error('workflow-template-structure-conflict');
      expected.forEach((item, index) => visit(item, actual[index], [...location, index]));
      return;
    }
    if (isMap(expected)) {
      if (!isMap(actual)) throw new Error('workflow-template-structure-conflict');
      for (const key of Object.keys(actual).filter((key) => !Object.hasOwn(expected, key))) {
        if (location.length !== 1 || location[0] !== 'on' || !Object.hasOwn(triggerExtensions, key)) {
          throw new Error('workflow-template-structure-conflict');
        }
        const rule = triggerExtensions[key];
        const value = actual[key];
        const valid = rule === 'empty-map' ? value === null || isMap(value) && !Object.keys(value).length
          : rule === 'cron-list' && Array.isArray(value) && value.length > 0
            && value.every((entry) => isMap(entry) && Object.keys(entry).length === 1
              && typeof entry.cron === 'string' && entry.cron.trim() && !/[\r\n]/.test(entry.cron));
        if (!valid) throw new Error('workflow-template-trigger-extension-invalid');
        extensions[key] = value;
      }
      for (const key of Object.keys(expected)) visit(expected[key], actual[key], [...location, key]);
      return;
    }
    if (!same(expected, actual)) throw new Error('workflow-template-structure-conflict');
  };
  visit(parse(yaml, template), parse(yaml, current));
  return { values, extensions };
};

export const renderWorkflowTemplate = ({ yaml, template, values = {}, references = {}, emptyAllowed = [], extensions = {} }) => {
  const used = new Set();
  const empty = new Set(emptyAllowed);
  const visit = (value, location = []) => {
    if (typeof value === 'string') {
      const matches = [...value.matchAll(PLACEHOLDER)];
      if (!matches.length) return value;
      const whole = value.match(WHOLE_PLACEHOLDER);
      const resolve = (key) => {
        if (Object.hasOwn(references, key)) return references[key];
        used.add(key);
        if (!Object.hasOwn(values, key)) {
          if (empty.has(key)) return '';
          throw new Error(`workflow-template-setting-missing:${key}`);
        }
        const setting = values[key];
        if (isMap(setting) || setting === null || setting === undefined
          || Array.isArray(setting) && typeof location.at(-1) !== 'number'
          || Array.isArray(setting) && (!setting.length || setting.some((item) => typeof item !== 'string' || !item))
          || key.endsWith('-enabled') && typeof setting !== 'boolean'
          || !key.endsWith('-enabled') && !Array.isArray(setting) && typeof setting !== 'string'
          || typeof setting === 'string' && WHOLE_PLACEHOLDER.test(setting)) {
          throw new Error(`workflow-template-setting-invalid:${key}`);
        }
        if (setting === '' && !empty.has(key)) throw new Error(`workflow-template-setting-empty:${key}`);
        return setting;
      };
      if (whole) return resolve(whole[1]);
      if (location.at(-1) === 'uses' && value.endsWith('@<commit-sha>')) {
        const action = value.slice(0, -'@<commit-sha>'.length);
        if (!Object.hasOwn(references, action)) throw new Error(`workflow-template-action-pin-missing:${action}`);
        return `${action}@${references[action]}`;
      }
      return value.replace(PLACEHOLDER, (_, key) => {
        const setting = resolve(key);
        if (typeof setting !== 'string') throw new Error(`workflow-template-setting-type:${key}`);
        return setting;
      });
    }
    if (Array.isArray(value)) return value.flatMap((item, index) => visit(item, [...location, index]));
    if (isMap(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, [...location, key])]));
    return value;
  };
  const rendered = visit(parse(yaml, template));
  for (const key of Object.keys(values)) if (!used.has(key)) throw new Error(`workflow-template-setting-unknown:${key}`);
  if (Object.keys(extensions).length) Object.assign(rendered.on, extensions);
  const result = yaml.stringify(rendered);
  if ([...result.matchAll(PLACEHOLDER)].length) throw new Error('workflow-template-unresolved-placeholder');
  return result;
};
