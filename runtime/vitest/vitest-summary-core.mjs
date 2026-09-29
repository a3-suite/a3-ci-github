const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const count = (value) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null);

export const VITEST_ASSERTION_STATUSES = Object.freeze(['passed', 'failed', 'pending', 'skipped', 'todo']);

export const parseVitestReport = (raw) => {
  try {
    const value = JSON.parse(raw);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

const emptyCounts = () => ({ total: null, passed: null, failed: null, skipped: null, todo: null });

const resolveFailedName = (assertion) =>
  (typeof assertion.fullName === 'string' && assertion.fullName)
  || (typeof assertion.title === 'string' && assertion.title)
  || (typeof assertion.name === 'string' && assertion.name)
  || 'unknown';

const diagnostic = (code, message) => ({ code, message });

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
  const failedNames = [];
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
          if (!isRecord(assertion) || typeof assertion.status !== 'string' || !VITEST_ASSERTION_STATUSES.includes(assertion.status)) {
            structureValid = false;
            continue;
          }
          if (assertion.status === 'passed') derived.passed += 1;
          else if (assertion.status === 'failed') {
            derived.failed += 1;
            failedNames.push(resolveFailedName(assertion));
          } else if (assertion.status === 'todo') derived.todo += 1;
          else derived.skipped += 1;
        }
      }
    }
  }
  return { derived, failedNames, structureValid, derivedAvailable };
};

const classifyOutcome = ({
  explicitFailure,
  zero,
  complete,
  contradictory,
  structureValid,
  consistent,
  hasAnyCount,
  providedInvalid,
}) => {
  const diagnostics = [];
  let status;
  let collection;
  if (explicitFailure) {
    status = 'failed';
    collection = complete ? 'complete' : hasAnyCount ? 'partial' : 'unavailable';
    diagnostics.push(diagnostic('vitest-report-explicit-failure', 'テストレポートが失敗を報告しています'));
    if (contradictory) {
      diagnostics.push(diagnostic('vitest-report-counts-contradictory', '集計値と詳細結果の件数が一致しません'));
    }
  } else if (zero) {
    status = 'unresolved';
    collection = 'unavailable';
    diagnostics.push(diagnostic('vitest-report-empty', 'テストレポートにテストが含まれていません'));
  } else if (complete) {
    status = 'passed';
    collection = 'complete';
  } else {
    status = 'unresolved';
    collection = hasAnyCount ? 'partial' : 'unavailable';
    if (!structureValid) {
      diagnostics.push(diagnostic('vitest-report-structure-invalid', 'テストレポートの結果構造が不正です'));
    }
    if (!consistent) {
      diagnostics.push(diagnostic('vitest-report-counts-inconsistent', 'テスト件数が不足しているか、整合していません'));
    }
    if (contradictory) {
      diagnostics.push(diagnostic('vitest-report-counts-contradictory', '集計値と詳細結果の件数が一致しません'));
    }
  }
  if (providedInvalid) {
    diagnostics.push(diagnostic('vitest-report-counts-invalid', 'テストレポートの集計値が不正です'));
  }
  return { status, collection, diagnostics };
};

export const classifyVitestReport = (report) => {
  if (!isRecord(report)) {
    return {
      status: 'unresolved',
      collection: 'unavailable',
      counts: emptyCounts(),
      failedNames: [],
      diagnostics: [diagnostic('vitest-report-missing', 'テストレポートが見つからないか、形式が不正です')],
    };
  }

  const { provided, providedInvalid } = collectProvidedCounts(report);
  const { derived, failedNames, structureValid, derivedAvailable } =
    deriveAssertionCounts(report.testResults);

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
  const { status, collection, diagnostics } = classifyOutcome({
    explicitFailure,
    zero,
    complete,
    contradictory,
    structureValid,
    consistent,
    hasAnyCount,
    providedInvalid,
  });

  return { status, collection, counts, failedNames, diagnostics };
};
