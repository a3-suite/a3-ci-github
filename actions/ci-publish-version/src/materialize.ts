import { DiagnosticError } from '../../../runtime/diagnostics/failure.mjs';
type ExactVersionPlan = {
  strategy: 'exact';
  publishVersion: string;
};

type GeneratedVersionPlan = {
  strategy: 'ciGenerated';
  template: string;
  components: Record<string, string>;
};

type VersionPlan = ExactVersionPlan | GeneratedVersionPlan;

const COMPONENT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const assertKeys = (value: Record<string, unknown>, expected: string[]): void => {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new DiagnosticError('publish-version-plan-fields-invalid', { diagnostics: { stage: 'plan-validation', field: 'plan-fields', expected: allowed, observed: actual.map(key => COMPONENT_NAME.test(key) ? key : 'invalid-or-protected') } });
  }
};

const requireSafeText = (value: unknown, error: string): string => {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) {
    throw new DiagnosticError(error);
  }
  return value;
};

const parseVersionPlan = (value: unknown): VersionPlan => {
  if (!isRecord(value)) throw new DiagnosticError('publish-version-plan-invalid');

  if (value.strategy === 'exact') {
    assertKeys(value, ['publishVersion', 'strategy']);
    return {
      strategy: 'exact',
      publishVersion: requireSafeText(value.publishVersion, 'publish-version-plan-exact-version-invalid'),
    };
  }

  if (value.strategy === 'ciGenerated') {
    assertKeys(value, ['components', 'strategy', 'template']);
    const template = requireSafeText(value.template, 'publish-version-plan-template-invalid');
    if (!isRecord(value.components)) throw new DiagnosticError('publish-version-plan-components-invalid');

    const components: Record<string, string> = {};
    for (const [name, component] of Object.entries(value.components)) {
      if (!COMPONENT_NAME.test(name)) throw new DiagnosticError('publish-version-plan-component-name-invalid');
      components[name] = requireSafeText(component, 'publish-version-plan-component-invalid');
    }
    return { strategy: 'ciGenerated', template, components };
  }

  throw new DiagnosticError('publish-version-plan-strategy-invalid');
};

export const materializePublishVersion = (value: unknown): string => {
  const plan = parseVersionPlan(value);
  if (plan.strategy === 'exact') return plan.publishVersion;

  const referenced = new Set<string>();
  const publishVersion = plan.template.replace(PLACEHOLDER, (_placeholder, name: string) => {
    referenced.add(name);
    const component = plan.components[name];
    if (component === undefined) throw new DiagnosticError('publish-version-plan-component-missing', { diagnostics: { stage: 'template-expansion', strategy: plan.strategy, field: name, expected: 'declared-component', observed: 'missing' } });
    return component;
  });

  if (publishVersion.includes('{') || publishVersion.includes('}')) {
    throw new DiagnosticError('publish-version-plan-placeholder-invalid');
  }
  if (referenced.size === 0) throw new DiagnosticError('publish-version-plan-components-invalid');
  if (Object.keys(plan.components).some((name) => !referenced.has(name))) {
    throw new DiagnosticError('publish-version-plan-component-unused', { diagnostics: { stage: 'template-expansion', strategy: plan.strategy, field: 'components', expected: 'referenced-components-only', observed: Object.keys(plan.components).filter(name => !referenced.has(name)) } });
  }
  return requireSafeText(publishVersion, 'publish-version-invalid');
};
