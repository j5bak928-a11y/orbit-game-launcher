'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewReport, parseReport } = require('../scripts/lint-report.cjs');
const warning = {
  severity:'warning', category:'lint/complexity/noImportantStyles',
  location:{ path:'src/ui/styles.css', start:{line:1,column:1}, end:{line:1,column:11} },
};
const review = { warnings:[{ ...warning, source:'reviewed source', reason:'Force reduced motion over inline animation.' }] };
const report = () => ({ command:'lint', summary:{ errors:0, warnings:1, infos:0, changed:0, unchanged:1, diagnosticsNotPrinted:0 }, diagnostics:[warning] });
test('lint gate accepts only the exact reviewed warning and source', () => {
  assert.deepEqual(reviewReport(report(), review, ()=>'reviewed source'), []);
});
test('lint gate rejects a new warning even when an older review exists', () => {
  const data=report();
  data.diagnostics.push({ ...warning, category:'lint/correctness/noUnusedVariables' });
  data.summary.warnings++;
  assert(reviewReport(data, review, ()=>'reviewed source').some(s=>s.includes('Unreviewed warning')));
});
test('lint gate rejects edited or relocated reviewed source', () => {
  assert(reviewReport(report(), review, ()=>'changed source').some(s=>s.includes('source changed')));
  const data=report();
  data.diagnostics=[{ ...warning, location:{ ...warning.location, start:{line:2,column:1} } }];
  assert(reviewReport(data, review, ()=>'reviewed source').some(s=>s.includes('Unreviewed warning')));
});
test('lint gate fails errors, omitted diagnostics and empty checks', () => {
  const data=report();data.summary.errors=1;data.summary.diagnosticsNotPrinted=2;data.summary.unchanged=0;
  const issues=reviewReport(data, review, ()=>'reviewed source');
  assert(issues.some(s=>s.includes('error')));
  assert(issues.some(s=>s.includes('omitted')));
  assert(issues.some(s=>s.includes('No files')));
});
test('lint gate rejects stale review entries instead of keeping unused exemptions', () => {
  const data=report();data.diagnostics=[];data.summary.warnings=0;
  assert(reviewReport(data, review, ()=>'reviewed source').some(s=>s.includes('Stale reviewed warning')));
});
test('lint gate normalizes Windows diagnostic paths for Linux CI reviews', () => {
  const data=report();data.diagnostics=[{ ...warning, location:{ ...warning.location, path:'src\\ui\\styles.css' } }];
  assert.deepEqual(reviewReport(data, review, ()=>'reviewed source'), []);
});
test('lint parser fails missing or truncated tool output', () => {
  assert.throws(()=>parseReport('install failed'), /Expected one/);
  assert.throws(()=>parseReport('{"summary":'), /JSON|position|end/i);
  assert.deepEqual(parseReport('{"summary":{},"command":"lint"}'), {summary:{},command:'lint'});
});
