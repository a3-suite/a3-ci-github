export { projectProviderActionPins, providerActionPinRepositories } from './provider-action-pins.mjs';

interface YamlRuntime {
  parseDocument(source: string, options: { uniqueKeys: boolean }): { errors: readonly unknown[]; toJS(options: { maxAliasCount: number }): unknown };
  stringify(value: unknown): string;
}
export function readWorkflowSettings(options: { yaml: YamlRuntime; template: string; current: string; triggerExtensions?: Record<string, string> }): { values: Record<string, unknown>; extensions: Record<string, unknown> };
export function renderWorkflowTemplate(options: { yaml: YamlRuntime; template: string; values?: Record<string, unknown>; references?: Record<string, string>; emptyAllowed?: string[]; extensions?: Record<string, unknown> }): string;
