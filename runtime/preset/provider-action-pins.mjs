const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const projectProviderActionPins = (entries, fields) => {
  const result = new Map();
  for (const entry of entries) {
    if (!isMap(entry) || typeof entry.action !== 'string' || !entry.action || result.has(entry.action)) {
      throw new Error('provider-action-pin-entry-invalid');
    }
    result.set(entry.action, Object.fromEntries(fields.map((field) => {
      if (typeof entry[field] !== 'string' || !entry[field]) throw new Error(`provider-action-pin-field-invalid:${entry.action}.${field}`);
      return [field, entry[field]];
    })));
  }
  return Object.fromEntries([...result].sort(([left], [right]) => left.localeCompare(right)));
};

export const providerActionPinRepositories = (workflow) => {
  const result = new Set();
  for (const job of Object.values(isMap(workflow?.jobs) ? workflow.jobs : {})) {
    for (const step of Array.isArray(job?.steps) ? job.steps : []) {
      if (typeof step?.uses !== 'string' || step.uses.startsWith('./')) continue;
      result.add(step.uses.split('@')[0].split('/').slice(0, 2).join('/'));
    }
  }
  return result;
};
