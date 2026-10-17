const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const count = (value) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null);

const ASSERTION_STATUSES = ['passed', 'failed', 'pending', 'skipped', 'todo'];

export const parseVitestReport = (raw) => {
  try {
    const value = JSON.parse(raw);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

const emptyCounts = () => ({ total: null, passed: null, failed: null, skipped: null, todo: null });

const collectProvidedCounts = (report) => {
  const providedFields = {
    total: { present: 'numTotalTests' in report, value: count(report.numTotalTests) },
    passed: { present: 'numPassedTests' in report, value: count(report.numPassedTests) },
    failed: { present: 'numFailedTests' in report, value: count(report.numFailedTests) },
    pending: { present: 'numPendingTests' in report, value: count(report.numPendingTests) },
    skipped: { present: 'numSkippedTests' in report, value: count(report.numSkippedTests) },
    todo: { present: 'numTodoTests' in report, value: count(report.numTodoTests) },
  };
  const provided = {
    total: providedFields.total.value,
    passed: providedFields.passed.value,
    failed: providedFields.failed.value,
    skipped: providedFields.pending.value ?? providedFields.skipped.value,
    todo: providedFields.todo.value,
  };
  const providedInvalid = Object.values(providedFields)
    .some((field) => field.present && field.value === null);
  return { provided, providedInvalid };
};

const deriveAssertionCounts = (testResults) => {
  const derived = { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 };
  let structureValid = true;
  let derivedAvailable = false;
  if (testResults !== undefined) {
    if (!Array.isArray(testResults)) {
      structureValid = false;
    } else {
      derivedAvailable = true;
      for (const suite of testResults) {
        if (!isRecord(suite) || !Array.isArray(suite.assertionResults)) {
          structureValid = false;
          continue;
        }
        for (const assertion of suite.assertionResults) {
          derived.total += 1;
          if (!isRecord(assertion) || typeof assertion.status !== 'string' || !ASSERTION_STATUSES.includes(assertion.status)) {
            structureValid = false;
            continue;
          }
          if (assertion.status === 'passed') derived.passed += 1;
          else if (assertion.status === 'failed') derived.failed += 1;
          else if (assertion.status === 'todo') derived.todo += 1;
          else derived.skipped += 1;
        }
      }
    }
  }
  return { derived, structureValid, derivedAvailable };
};

export const classifyVitestReport = (report) => {
  if (!isRecord(report)) {
    return {
      status: 'unresolved',
      collection: 'unavailable',
      counts: emptyCounts(),
    };
  }

  const { provided, providedInvalid } = collectProvidedCounts(report);
  const { derived, structureValid, derivedAvailable } = deriveAssertionCounts(report.testResults);

  const source = derivedAvailable ? derived : emptyCounts();
  const counts = {
    total: provided.total ?? source.total,
    passed: provided.passed ?? source.passed,
    failed: provided.failed ?? source.failed,
    skipped: provided.skipped ?? source.skipped,
    todo: provided.todo ?? source.todo,
  };
  const hasAnyCount = Object.values(counts).some((value) => value !== null);
  const hasAllCounts = Object.values(counts).every((value) => value !== null);
  const consistent = hasAllCounts
    && counts.total === counts.passed + counts.failed + counts.skipped + counts.todo;
  const contradictory = derivedAvailable
    && Object.keys(derived).some((key) => provided[key] !== null && provided[key] !== derived[key]);
  const explicitFailure = (counts.failed ?? 0) > 0 || report.success === false;
  const zero = structureValid && !providedInvalid && !contradictory && counts.total === 0;
  const complete = structureValid && !providedInvalid && consistent && !contradictory;
  // An explicit failure wins over malformed or contradictory details; zero tests are never a success.
  const status = explicitFailure ? 'failed' : zero ? 'unresolved' : complete ? 'passed' : 'unresolved';
  const collection = !explicitFailure && zero ? 'unavailable' : complete ? 'complete' : hasAnyCount ? 'partial' : 'unavailable';
  return { status, collection, counts };
};
