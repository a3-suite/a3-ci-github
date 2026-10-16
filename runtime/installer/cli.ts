import { DiagnosticError, FailureContext } from '../diagnostics/failure.mjs';
export { releaseErrorMessage as installerErrorMessage } from '../release-publication/io';
import { runSupplemental } from '../release-publication/supplemental';

const permitted = ['operation', 'source-root', 'authority-path', 'snapshot-path', 'standard-build-root', 'supplemental-build-root', 'output-directory', 'provider-revision'];
export const runInstallerCli = (args: string[], installerRoot: string): void => {
  const diagnostic = new FailureContext('ci-release-supplemental-asset', 'installer-cli');
  try {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, '');
    const value = args[index + 1];
    if (!args[index]?.startsWith('--') || !permitted.includes(key) || key in values || !value || value.startsWith('--')) throw new DiagnosticError('installer-arguments-invalid');
    values[key] = value;
  }
  for (const key of permitted.filter((name) => name !== 'supplemental-build-root')) {
    if (!values[key]) throw new DiagnosticError('installer-arguments-missing');
  }
  diagnostic.confirmed();
  diagnostic.at('standard-installer-execution', { input: 'authority-snapshot-build-and-installer-declarations' });
  runSupplemental({ operation: values.operation, sourceRoot: values['source-root'], authorityPath: values['authority-path'], snapshotPath: values['snapshot-path'], standardBuildRoot: values['standard-build-root'], supplementalBuildRoot: values['supplemental-build-root'], outputDirectory: values['output-directory'], providerRevision: values['provider-revision'], installerRoot });
  } catch (error) {
    diagnostic.report(error);
    throw diagnostic.capture(error);
  }
};
