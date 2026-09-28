import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const isDirectExecution = (moduleUrl: string, argv: string[] = process.argv): boolean => {
  const entrypoint = argv[1];
  return Boolean(entrypoint) && moduleUrl === pathToFileURL(path.resolve(entrypoint)).href;
};

export const writeLine = (line: string, outputPath?: string): void => {
  if (outputPath) {
    fs.appendFileSync(outputPath, `${line}\n`);
  } else {
    console.log(line);
  }
};

export const resolveOutputPath = (value?: string): string | undefined => {
  if (value === undefined) return undefined;
  if (value.length === 0 || /[\0\r\n]/.test(value)) {
    throw new Error('output-path-invalid');
  }
  return value;
};
