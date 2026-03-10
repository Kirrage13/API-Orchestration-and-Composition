/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const DETERMINISTIC_TESTS = [
  { idx: 1, title: 'Services start and health checks pass', points: 2 },
  { idx: 2, title: 'Happy path full sequence and completed result', points: 4 },
  { idx: 3, title: 'Payment fail short-circuits downstream calls', points: 3 },
  { idx: 4, title: 'Inventory fail triggers payment refund compensation', points: 4 },
  { idx: 5, title: 'Shipping timeout within limit triggers compensation', points: 4 },
  { idx: 6, title: 'Compensation failure mapped to 422 + compensation_failed', points: 2 },
  { idx: 7, title: 'Idempotency replay same key same payload', points: 3 },
  { idx: 8, title: 'Idempotency mismatch same key different payload => 409', points: 2 },
  { idx: 9, title: 'Trace contract strict fields and order', points: 2 }
];

const BONUS_TEST = { idx: 10, title: 'Bonus probabilistic stress checks', points: 2 };

function loadResults(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function flattenAssertions(testResults) {
  return testResults.flatMap((suite) => suite.assertionResults || []);
}

function findAssertion(assertions, idx) {
  return assertions.find(
    (a) =>
      a.title?.startsWith(`${idx})`) ||
      a.fullName?.startsWith(`${idx})`) ||
      a.fullName?.includes(` ${idx})`)
  );
}

function compactFailure(msg) {
  return (msg || 'Unknown failure')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function rowFromAssertion(testCase, assertion) {
  if (!assertion) {
    return {
      ...testCase,
      awarded: 0,
      status: 'FAIL: Test not found'
    };
  }
  if (assertion.status === 'passed') {
    return {
      ...testCase,
      awarded: testCase.points,
      status: 'PASS'
    };
  }
  return {
    ...testCase,
    awarded: 0,
    status: `FAIL: ${compactFailure((assertion.failureMessages || [])[0])}`
  };
}

function scoreFromResults(results) {
  const assertions = flattenAssertions(results.testResults || []);
  const rows = DETERMINISTIC_TESTS.map((testCase) => rowFromAssertion(testCase, findAssertion(assertions, testCase.idx)));
  const deterministic = rows.reduce((sum, row) => sum + row.awarded, 0);

  const bonusAssertion = findAssertion(assertions, BONUS_TEST.idx);
  const bonus = bonusAssertion?.status === 'passed' ? BONUS_TEST.points : 0;

  return {
    rows,
    deterministic,
    bonus
  };
}

function nowUtc() {
  return new Date().toISOString().replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC');
}

function formatReport({ commit, timestamp, rows, deterministic, bonus }) {
  const lines = [];
  lines.push('# Grade Report: Practice 3 — API Orchestration & Service Composition');
  lines.push('');
  lines.push(`**Submission:** ${timestamp}`);
  lines.push(`**Commit:** ${commit}`);
  lines.push('');
  lines.push('## Deterministic Automated Results (26 points)');
  lines.push('');
  lines.push('| # | Test | Points | Status |');
  lines.push('|---|---|---|---|');
  for (const row of rows) {
    lines.push(`| ${row.idx} | ${row.title} | ${row.awarded}/${row.points} | ${row.status} |`);
  }
  lines.push('');
  lines.push('## Bonus Stress (2 points, cannot reduce score)');
  lines.push('');
  lines.push(`| ${BONUS_TEST.idx} | ${BONUS_TEST.title} | ${bonus}/${BONUS_TEST.points} | ${bonus > 0 ? 'PASS' : 'ADVISORY'} |`);
  lines.push('');
  lines.push('## Manual Review (2 points)');
  lines.push('');
  lines.push('| Item | Points | Status |');
  lines.push('|---|---|---|');
  lines.push('| README quality + architecture rationale | -/2 | MANUAL REVIEW |');
  lines.push('');
  lines.push(`**Deterministic Automated Score: ${deterministic}/26**`);
  lines.push(`**Bonus Score: ${bonus}/2**`);
  lines.push(`**Total with Bonus (without manual): ${deterministic + bonus}/28**`);
  lines.push('**Manual Review Remaining: 2 points**');
  return lines.join('\n');
}

async function main() {
  const inputArg = process.argv[2] || path.join('practice-03-api_orchestration_and_composition', 'test', 'results.json');
  const inputPath = path.resolve(process.cwd(), inputArg);
  const outputPath = path.resolve(process.cwd(), 'grade-report.md');

  const commit = process.env.GITHUB_SHA ? process.env.GITHUB_SHA.slice(0, 7) : 'local';
  const timestamp = nowUtc();

  const parsed = loadResults(inputPath);
  let report;

  if (!parsed) {
    report = formatReport({
      commit,
      timestamp,
      rows: DETERMINISTIC_TESTS.map((t) => ({ ...t, awarded: 0, status: 'FAIL: results.json not found' })),
      deterministic: 0,
      bonus: 0
    });
  } else {
    const scored = scoreFromResults(parsed);
    report = formatReport({
      commit,
      timestamp,
      rows: scored.rows,
      deterministic: scored.deterministic,
      bonus: scored.bonus
    });
  }

  fs.writeFileSync(outputPath, report, 'utf8');
  console.log(`Grade report generated at ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

