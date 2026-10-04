import fs from 'node:fs';
import path from 'node:path';

export type ResolutionInput = {
  inputHandoffDirectory: string;
  outputDirectory: string;
};
export type ResolutionResult = {
  status: 'success';
  releaseNotesPath: string;
  approvalPath: string;
};

const safePath = (value: string, error: string): string => {
  if (!value || /[\0\r\n]/.test(value)) throw new Error(error);
  return path.resolve(value);
};

const requireFile = (filePath: string, error: string): void => {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile() || fs.statSync(filePath).size === 0) throw new Error(error);
};

export const resolveReleaseNotesInput = (input: ResolutionInput): ResolutionResult => {
  const inputDirectory = safePath(input.inputHandoffDirectory, 'input-handoff-directory-required');
  const outputDirectory = safePath(input.outputDirectory, 'output-directory-required');
  const releaseNotesPath = path.join(outputDirectory, 'release-notes.json');
  const approvalPath = path.join(outputDirectory, 'release-notes-approval.json');
  if ([releaseNotesPath, approvalPath].some((file) => fs.lstatSync(file, { throwIfNoEntry: false }))) throw new Error('release-notes-input-already-present');
  const sourceNotes = path.join(inputDirectory, 'release-notes.json');
  const sourceApproval = path.join(inputDirectory, 'release-notes-approval.json');
  requireFile(sourceNotes, 'release-notes-handoff-missing');
  requireFile(sourceApproval, 'release-notes-approval-handoff-missing');
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.copyFileSync(sourceNotes, releaseNotesPath, fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(sourceApproval, approvalPath, fs.constants.COPYFILE_EXCL);
  requireFile(releaseNotesPath, 'release-notes-missing');
  requireFile(approvalPath, 'release-notes-approval-missing');
  return { status: 'success', releaseNotesPath, approvalPath };
};
