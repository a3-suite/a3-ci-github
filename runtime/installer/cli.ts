import path from 'node:path';
import { runSupplemental } from '../release-publication/supplemental';

const permitted = ['operation', 'source-root', 'authority-path', 'snapshot-path', 'standard-build-root', 'supplemental-build-root', 'output-directory', 'provider-revision'];
export const runInstallerCli = (args: string[], directory: string): void => {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, '');
    const value = args[index + 1];
    if (!args[index]?.startsWith('--') || !permitted.includes(key) || key in values || !value || value.startsWith('--')) throw new Error('installer-arguments-invalid');
    values[key] = value;
  }
  for (const key of permitted.filter((name) => name !== 'supplemental-build-root')) {
    if (!values[key]) throw new Error('installer-arguments-missing');
  }
  runSupplemental({ operation: values.operation, sourceRoot: values['source-root'], authorityPath: values['authority-path'], snapshotPath: values['snapshot-path'], standardBuildRoot: values['standard-build-root'], supplementalBuildRoot: values['supplemental-build-root'], outputDirectory: values['output-directory'], providerRevision: values['provider-revision'], installerRoot: path.join(directory, 'installer') });
};
