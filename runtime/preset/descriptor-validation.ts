import fs from 'node:fs';
import path from 'node:path';
import { add, isMap, map, parseYaml, strings } from './ci-preset-assets.ts';
import type { ValueMap } from './ci-preset-assets.ts';
import type { Report } from './validation-report.ts';
import { inside, realPathIsInside } from './workflow-assets.ts';
import { walk } from './workflow-validation.ts';

const descriptorValues = (workflow: unknown): string[] => {
  const result: string[] = [];
  walk(workflow, (key, value) => {
    if (key === 'CI_ADAPTER_DESCRIPTOR' && typeof value === 'string') {
      result.push(value.replace(/^\.ci-base\//, ''));
    }
  });
  return result;
};

const validateDescriptor = (
  root: string,
  descriptorPath: string,
  report: Report,
  workflowEnv: ValueMap,
  providerId: string,
): Set<string> => {
  const destinations = new Set<string>();
  let absolute: string;
  try { absolute = inside(root, descriptorPath); } catch (error) {
    add(report.mismatches, {
      path: descriptorPath,
      message: error instanceof Error ? error.message : 'invalid descriptor path',
      settingLocation: descriptorPath,
    });
    return destinations;
  }
  if (!fs.existsSync(absolute)) {
    add(report.missingSettings, {
      path: descriptorPath,
      message: 'quality adapter descriptor is missing',
      settingLocation: descriptorPath,
    });
    return destinations;
  }
  if (!realPathIsInside(root, absolute)) {
    add(report.mismatches, {
      path: descriptorPath,
      message: 'quality adapter descriptor resolves outside the project root',
      settingLocation: descriptorPath,
    });
    return destinations;
  }
  const descriptor = map(parseYaml(fs.readFileSync(absolute, 'utf8'), descriptorPath, report));
  const exact: Array<[string, unknown, unknown]> = [
    ['schemaVersion', descriptor.schemaVersion, '1'],
    ['kind', descriptor.kind, 'ci-adapter-bundle'],
    ['contract', descriptor.contract, 'quality-scripts'],
    ['executionBoundary', descriptor.executionBoundary, 'read-only'],
    ['sourceCheckout', descriptor.sourceCheckout, 'fixed-source'],
    ['copyable', descriptor.copyable, true],
  ];
  for (const [key, actual, expected] of exact) {
    if (actual !== expected) add(report.mismatches, {
      path: `${descriptorPath}:${key}`,
      message: `${key} must be ${String(expected)}`,
      settingLocation: descriptorPath,
    });
  }
  for (const key of ['id', 'owner', 'provider']) {
    if (typeof descriptor[key] !== 'string' || descriptor[key] === '') add(report.missingSettings, {
      path: `${descriptorPath}:${key}`,
      message: `${key} is missing`,
      settingLocation: descriptorPath,
    });
  }
  if (strings(descriptor.languageProfiles).length === 0) add(report.missingSettings, {
    path: `${descriptorPath}:languageProfiles`,
    message: 'languageProfiles is missing',
    settingLocation: descriptorPath,
  });
  const selectedProfile = workflowEnv.CI_LANGUAGE_PROFILE;
  if (typeof selectedProfile !== 'string'
    || !strings(descriptor.languageProfiles).includes(selectedProfile)) add(report.mismatches, {
    path: `${descriptorPath}:languageProfiles`,
    message: 'quality adapter descriptor does not support the selected language profile',
    settingLocation: descriptorPath,
  });
  if (descriptor.provider !== 'provider-neutral' && descriptor.provider !== providerId) {
    add(report.mismatches, {
      path: `${descriptorPath}:provider`,
      message: 'quality adapter descriptor does not support the selected CI provider',
      settingLocation: descriptorPath,
    });
  }
  const assets = Array.isArray(descriptor.assets) ? descriptor.assets : [];
  assets.forEach((value, index) => {
    const asset = map(value);
    if ('source' in asset) add(report.mismatches, {
      path: `${descriptorPath}:assets[${index}].source`,
      message: 'copied descriptor must not reference a source skill tree',
      settingLocation: descriptorPath,
    });
    const destination = typeof asset.destination === 'string'
      ? path.posix.normalize(asset.destination)
      : '';
    if (!destination.startsWith('.ci/') || destination !== asset.destination) {
      add(report.mismatches, {
        path: `${descriptorPath}:assets[${index}].destination`,
        message: 'asset destination must be project-local under .ci',
        settingLocation: descriptorPath,
      });
      return;
    }
    destinations.add(destination);
    const absoluteDestination = inside(root, destination);
    if (!fs.existsSync(absoluteDestination)) add(report.missingSettings, {
      path: destination,
      message: 'adapter asset is missing',
      settingLocation: descriptorPath,
    });
    else if (!realPathIsInside(root, absoluteDestination)) add(report.mismatches, {
      path: destination,
      message: 'adapter asset resolves outside the project root',
      settingLocation: descriptorPath,
    });
  });
  const projectSettings = map(descriptor.projectSettings);
  if (!Array.isArray(projectSettings.requiredFiles) || !Array.isArray(projectSettings.requiredScripts)) {
    add(report.missingSettings, {
      path: `${descriptorPath}:projectSettings`,
      message: 'projectSettings must declare requiredFiles and requiredScripts',
      settingLocation: descriptorPath,
    });
  }
  for (const name of strings(projectSettings.requiredEnvironmentPaths)) {
    const value = workflowEnv[name];
    if (!/^CI_[A-Z0-9_]+$/.test(name) || typeof value !== 'string'
      || value === '' || path.isAbsolute(value)) {
      add(report.mismatches, {
        path: `${descriptorPath}:projectSettings.requiredEnvironmentPaths.${name}`,
        message: 'required environment path must resolve from a valid workflow setting',
        settingLocation: descriptorPath,
      });
      continue;
    }
    try {
      const absoluteFile = inside(root, value);
      if (!fs.existsSync(absoluteFile) || !fs.statSync(absoluteFile).isFile()) add(report.missingSettings, {
        path: value,
        message: 'required environment path is missing',
        settingLocation: descriptorPath,
      });
      else if (!realPathIsInside(root, absoluteFile)) add(report.mismatches, {
        path: value,
        message: 'required environment path resolves outside the project root',
        settingLocation: descriptorPath,
      });
    } catch (error) {
      add(report.mismatches, {
        path: value,
        message: error instanceof Error ? error.message : 'invalid required environment path',
        settingLocation: descriptorPath,
      });
    }
  }
  for (const file of strings(projectSettings.requiredFiles)) {
    try {
      const absoluteFile = inside(root, file);
      if (!fs.existsSync(absoluteFile)) add(report.missingSettings, {
        path: file,
        message: 'required project file is missing',
        settingLocation: descriptorPath,
      });
      else if (!realPathIsInside(root, absoluteFile)) add(report.mismatches, {
        path: file,
        message: 'required project file resolves outside the project root',
        settingLocation: descriptorPath,
      });
    } catch (error) {
      add(report.mismatches, {
        path: file,
        message: error instanceof Error ? error.message : 'invalid project file path',
        settingLocation: descriptorPath,
      });
    }
  }
  const packagePath = path.join(root, 'package.json');
  let projectScripts: ValueMap = {};
  if (fs.existsSync(packagePath)) {
    try {
      projectScripts = map(map(JSON.parse(fs.readFileSync(packagePath, 'utf8'))).scripts);
    } catch {
      add(report.mismatches, {
        path: 'package.json',
        message: 'invalid project package.json',
        settingLocation: descriptorPath,
      });
    }
  }
  const checkScript = (script: string, visiting = new Set<string>()): void => {
    const command = projectScripts[script];
    if (typeof command !== 'string') {
      add(report.missingSettings, {
        path: `package.json:scripts.${script}`,
        message: 'required project script is missing',
        settingLocation: descriptorPath,
      });
      return;
    }
    if (command.trim() === '') add(report.mismatches, {
      path: `package.json:scripts.${script}`,
      message: 'required project script must not be empty',
      settingLocation: descriptorPath,
    });
    if (/(?:^|[\s'"])(?:\.\/)?skills\//.test(command)) add(report.mismatches, {
      path: `package.json:scripts.${script}`,
      message: 'required project script references the source skills tree',
      settingLocation: descriptorPath,
    });
    if (visiting.has(script)) {
      add(report.mismatches, {
        path: `package.json:scripts.${script}`,
        message: 'project script delegation contains a cycle',
        settingLocation: descriptorPath,
      });
      return;
    }
    visiting.add(script);
    for (const match of command.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([A-Za-z0-9:_-]+)/g)) {
      if (match[1] in projectScripts) checkScript(match[1], visiting);
    }
    visiting.delete(script);
  };
  for (const script of strings(projectSettings.requiredScripts)) checkScript(script);
  const toolchain = map(descriptor.toolchain);
  const verify = map(toolchain.verify);
  if (toolchain.versionEnv !== 'CI_TOOLCHAIN_VERSION' || typeof verify.command !== 'string') {
    add(report.mismatches, {
      path: `${descriptorPath}:toolchain`,
      message: 'toolchain verification must bind CI_TOOLCHAIN_VERSION',
      settingLocation: descriptorPath,
    });
  }
  const commandText = (value: unknown): boolean =>
    typeof value === 'string' && value.length > 0 && !/[\0\r\n]/.test(value);
  const validateCommandSpec = (value: unknown, path: string): void => {
    if (!isMap(value)) {
      add(report.mismatches, {
        path,
        message: 'command must be a mapping',
        settingLocation: descriptorPath,
      });
      return;
    }
    const spec = map(value);
    if (!commandText(spec.command)) add(report.mismatches, {
      path: `${path}.command`,
      message: 'command must be a non-empty string without NUL or line breaks',
      settingLocation: descriptorPath,
    });
    if (spec.args !== undefined
      && (!Array.isArray(spec.args) || spec.args.length === 0 || spec.args.some((argument) => !commandText(argument)))) add(report.mismatches, {
      path: `${path}.args`,
      message: 'command args must be a non-empty string list without NUL or line breaks',
      settingLocation: descriptorPath,
    });
    if (spec.id !== undefined && !commandText(spec.id)) add(report.mismatches, {
      path: `${path}.id`,
      message: 'command id must be a non-empty string without NUL or line breaks',
      settingLocation: descriptorPath,
    });
  };
  if (!Array.isArray(descriptor.preparation) || descriptor.preparation.length === 0) {
    add(report.missingSettings, {
      path: `${descriptorPath}:preparation`,
      message: 'dependency preparation is missing',
      settingLocation: descriptorPath,
    });
  } else {
    descriptor.preparation.forEach((value, index) => validateCommandSpec(value, `${descriptorPath}:preparation[${index}]`));
  }
  if (!Array.isArray(descriptor.commands) || descriptor.commands.length === 0) {
    add(report.missingSettings, {
      path: `${descriptorPath}:commands`,
      message: 'quality commands are missing',
      settingLocation: descriptorPath,
    });
  } else {
    descriptor.commands.forEach((value, index) => validateCommandSpec(value, `${descriptorPath}:commands[${index}]`));
  }
  validateCommandSpec(toolchain.verify, `${descriptorPath}:toolchain.verify`);
  const declaredCommandIds = [
    ...(Array.isArray(descriptor.preparation) ? descriptor.preparation : []),
    ...(Array.isArray(descriptor.commands) ? descriptor.commands : []),
    ...(verify.id === undefined ? [] : [verify]),
  ].map(map).map((spec) => spec.id);
  const providedCommandIds = declaredCommandIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (new Set(providedCommandIds).size !== providedCommandIds.length) add(report.mismatches, {
    path: `${descriptorPath}:commands.id`,
    message: 'command ids must be unique within the descriptor',
    settingLocation: descriptorPath,
  });
  return destinations;
};

export { descriptorValues, validateDescriptor };
