import fs from 'node:fs';
import path from 'node:path';
import { add } from './validation-report.ts';
import type { RegistryData, ValueMap } from './preset-model.ts';
import type { Report } from './validation-report.ts';

export const validateActionAvailability = (
  root: string,
  presetId: string,
  workflowIds: Set<string>,
  workflows: Map<string, ValueMap>,
  registry: RegistryData,
  report: Report,
): void => {
  for (const target of registry.actionTargets.filter((candidate) => candidate.workflows.some((id) => workflowIds.has(id)))) {
    if (target.status !== 'available') add(report.missingSettings, {
      path: `${presetId}:actions.${target.id}`,
      message: 'Action is not available until its exact release tag and full commit SHA are confirmed',
    });
  }
  const workflowText = JSON.stringify([...workflows.values()]);
  for (const entrypoint of registry.retiredProjectEntrypoints?.[presetId] ?? []) {
    if (!entrypoint.startsWith('.ci/') || entrypoint.includes('\\') || entrypoint.split('/').some((part) => !part || part === '.' || part === '..')) {
      add(report.mismatches, { path: entrypoint, message: 'retired entrypoint registry path is invalid' });
      continue;
    }
    let present = false;
    try { fs.lstatSync(path.join(root, entrypoint)); present = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        add(report.mismatches, { path: entrypoint, message: 'retired entrypoint presence cannot be determined' });
        continue;
      }
    }
    if (present || workflowText.includes(entrypoint)) add(report.mismatches, {
      path: entrypoint,
      message: 'Actionized processing must not retain a registered project-local fallback or invocation',
      settingLocation: entrypoint,
    });
  }
};
