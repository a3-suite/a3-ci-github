type Details = Record<string, unknown>;
type SafeValue = null | boolean | number | string | SafeValue[] | { [key: string]: SafeValue };
interface DiagnosticOptions extends ErrorOptions { diagnostics?: unknown; diagnosticCode?: string }
interface FailureEvidence {
  classification: { subject: string; operation: string; stage: string; reason: string; cause: string };
  context: Details;
  comparison: unknown;
  'evidence-location': Details;
  'execution-state': Details;
  'next-check': Details;
}
type InputOptions = { required?: boolean; trimWhitespace?: boolean };

// Only owner-created errors may carry a public reason. Platform and child messages are private.
export class DiagnosticError extends Error {
  details?: unknown;
  diagnosticCode?: string;
  failureContext?: FailureContext;
  constructor(message = '', options?: DiagnosticOptions) {
    super(message, options);
    this.name = 'DiagnosticError';
    this.details = options?.diagnostics;
    this.diagnosticCode = options?.diagnosticCode;
    this.failureContext = undefined;
  }
}

const identifier = (value: unknown): string => typeof value === 'string' && /^[a-zA-Z0-9_.\[\]-]{1,200}$/.test(value) ? value : 'unavailable';
// The workflow declares the commit it checked out. Pull request events report a merge-ref SHA that differs from a checked-out head, so their event SHA is never presented as the source.
const sourceRevision = (): string => {
  const commit = /^[a-f0-9]{40}$/;
  const declared = process.env.CI_SOURCE_REVISION;
  if (declared) return commit.test(declared) ? declared : 'unavailable';
  const event = process.env.GITHUB_SHA ?? '';
  return !(process.env.GITHUB_EVENT_NAME ?? '').startsWith('pull_request') && commit.test(event) ? event : 'unavailable';
};
const filesystemCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOSPC', 'EROFS', 'EMFILE', 'EIO']);
const safeValue = (value: unknown, depth = 0): SafeValue => {
  if (depth > 4) return 'omitted';
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string') return value.length <= 500 && !/[\0\r\n]/.test(value) ? value : 'omitted';
  if (Array.isArray(value)) return value.length <= 256 ? value.map((item) => safeValue(item, depth + 1)) : { count: value.length, contents: 'omitted' };
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => [identifier(key), safeValue(item, depth + 1)]));
  return 'unavailable';
};
export const safeErrorReason = (error: unknown): string => {
  try {
    if (error instanceof DiagnosticError) {
      const reason = error.diagnosticCode ?? error.message.split(':', 1)[0];
      if (/^[a-z][a-zA-Z0-9-]+$/.test(reason)) return reason;
    }
    if (error && (typeof error === 'object' || typeof error === 'function') && 'code' in error && typeof error.code === 'string' && filesystemCodes.has(error.code)) return `filesystem-${error.code.toLowerCase()}`;
  } catch { /* Untrusted exception accessors have no public reason. */ }
  return 'unknown-failure';
};

export const readActionInput = (reader: (name: string, options?: InputOptions) => string, name: string, options: InputOptions = {}): string => {
  const value = reader(name, { ...options, required: false });
  if (options.required && !value) throw new DiagnosticError('input-missing', { diagnostics: { field: name, expected: 'required-value', observed: 'missing' } });
  return value;
};

export class FailureContext {
  subject: string;
  operation: string;
  stage: string;
  lastConfirmed: string;
  writeState: string;
  outcome: string;
  retainedEvidence?: string;
  details: Details;
  constructor(subject: string, operation: string, writeState = 'not-started') {
    this.subject = identifier(subject);
    this.operation = identifier(operation);
    this.stage = 'input-validation';
    this.lastConfirmed = 'not-started';
    this.writeState = writeState;
    this.outcome = 'failure';
    this.retainedEvidence = undefined;
    this.details = {};
  }
  at(stage: string, details: Details = {}): void {
    this.stage = identifier(stage);
    this.details = { ...this.details, ...details };
  }
  confirmed(stage = this.stage): void { this.lastConfirmed = identifier(stage); }
  capture(error: unknown): DiagnosticError {
    const captured = error instanceof DiagnosticError ? error : new DiagnosticError(safeErrorReason(error), { cause: error });
    captured.failureContext ??= this;
    return captured;
  }
  evidence(error: unknown, reason = safeErrorReason(error)): FailureEvidence {
    if (error instanceof DiagnosticError && error.failureContext && error.failureContext !== this) return error.failureContext.evidence(error, reason);
    const rawDetails = error instanceof DiagnosticError ? error.details : undefined;
    const details = rawDetails && typeof rawDetails === 'object' ? rawDetails as Details : undefined;
    const stage = details && typeof details === 'object' && typeof details.stage === 'string' ? identifier(details.stage) : this.stage;
    return {
      classification: { subject: this.subject, operation: this.operation, stage, reason, cause: reason === 'unknown-failure' ? 'unknown' : 'known' },
      context: { run: identifier(process.env.GITHUB_RUN_ID), job: identifier(process.env.GITHUB_JOB), source: sourceRevision(), platform: identifier(process.env.RUNNER_OS), arch: identifier(process.env.RUNNER_ARCH), inputs: safeValue(this.details) },
      comparison: rawDetails ? safeValue(rawDetails) : { field: this.stage, expected: 'contract-satisfied', observed: reason, values: 'unavailable-or-protected' },
      'evidence-location': { log: process.env.GITHUB_ACTIONS === 'true' ? 'workflow-run-job-step-log' : 'stderr', artifact: 'not-generated', file: this.retainedEvidence ?? 'not-generated' },
      'execution-state': { outcome: this.outcome, lastConfirmed: this.lastConfirmed, write: this.writeState, rollback: details && typeof details === 'object' && details.rollback ? safeValue(details.rollback) : 'unavailable', retention: this.retainedEvidence ? 'log-and-file' : 'log-only' },
      'next-check': { stage, rule: reason, input: safeValue(this.details), unknownCause: reason === 'unknown-failure' },
    };
  }
  report(error: unknown, reason?: string): string {
    let retainedReason = 'unknown-failure';
    try {
      retainedReason = reason ?? safeErrorReason(error);
      process.stderr.write(`ci-failure-diagnostic:${JSON.stringify(this.evidence(error, retainedReason))}\n`);
    } catch { /* Diagnostic construction and sink errors cannot replace the original failure. */ }
    return retainedReason;
  }
}

export const writeFailureOutputs = (writer: (name: string, value: unknown) => void, entries: [string, unknown][], context: FailureContext): void => {
  try {
    for (const [name, value] of entries) writer(name, value);
  } catch (error) {
    const output = new FailureContext(context.subject, context.operation, 'failure-output-may-be-partial');
    output.at('failure-output-write', { input: 'GITHUB_OUTPUT', primaryFailureRetained: true });
    output.report(error);
  }
};

export const completeFailure = (message: string, exitCode = 1, writer: (message: string) => unknown = (value) => process.stderr.write(`${value}\n`)): void => {
  process.exitCode = exitCode;
  try { writer(message); } catch { /* Retain the primary result when its final message cannot be written. */ }
};
