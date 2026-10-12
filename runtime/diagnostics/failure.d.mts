type Details = Record<string, unknown>;
interface DiagnosticOptions extends ErrorOptions {
    diagnostics?: unknown;
    diagnosticCode?: string;
}
interface FailureEvidence {
    classification: {
        subject: string;
        operation: string;
        stage: string;
        reason: string;
        cause: string;
    };
    context: Details;
    comparison: unknown;
    'evidence-location': Details;
    'execution-state': Details;
    'next-check': Details;
}
type InputOptions = {
    required?: boolean;
    trimWhitespace?: boolean;
};
export declare class DiagnosticError extends Error {
    details?: unknown;
    diagnosticCode?: string;
    failureContext?: FailureContext;
    constructor(message?: string, options?: DiagnosticOptions);
}
export declare const safeErrorReason: (error: unknown) => string;
export declare const readActionInput: (reader: (name: string, options?: InputOptions) => string, name: string, options?: InputOptions) => string;
export declare class FailureContext {
    subject: string;
    operation: string;
    stage: string;
    lastConfirmed: string;
    writeState: string;
    outcome: string;
    retainedEvidence?: string;
    details: Details;
    constructor(subject: string, operation: string, writeState?: string);
    at(stage: string, details?: Details): void;
    confirmed(stage?: string): void;
    capture(error: unknown): DiagnosticError;
    evidence(error: unknown, reason?: string): FailureEvidence;
    report(error: unknown, reason?: string): string;
}
export declare const writeFailureOutputs: (writer: (name: string, value: unknown) => void, entries: [string, unknown][], context: FailureContext) => void;
export declare const completeFailure: (message: string, exitCode?: number, writer?: (message: string) => unknown) => void;
export {};
