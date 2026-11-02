'use strict';
const fs = require('node:fs');
const path = require('node:path');

function signature(diagnostic) {
  const location = diagnostic.location;
  return JSON.stringify([
    String(location?.path || '').replace(/\\/g, '/'), diagnostic.category,
    location?.start?.line, location?.start?.column, location?.end?.line, location?.end?.column,
  ]);
}
function reviewReport(report, review, readSource) {
  const issues = [];
  if (report?.command !== 'lint' || !report.summary || !Array.isArray(report.diagnostics) ||
      !Array.isArray(review?.warnings)) return ['Invalid or incomplete Biome report/review.'];
  if (report.summary.errors !== 0) issues.push(`Biome reported ${report.summary.errors} error(s).`);
  if (report.summary.diagnosticsNotPrinted !== 0) issues.push('Some diagnostics were omitted.');
  if (!(report.summary.unchanged + report.summary.changed > 0)) issues.push('No files were checked.');
  const warnings = report.diagnostics.filter(d => d.severity === 'warning');
  if (warnings.length !== report.summary.warnings) issues.push('Warning totals do not match the diagnostics.');
  const pending = new Map(review.warnings.map(entry => [signature(entry), entry]));
  if (pending.size !== review.warnings.length) issues.push('Duplicate reviewed warning entries.');
  for (const warning of warnings) {
    const key = signature(warning), entry = pending.get(key);
    if (!entry?.reason?.trim()) {
      issues.push(`Unreviewed warning: ${warning.location?.path} (${warning.category}).`);
      continue;
    }
    pending.delete(key);
    try {
      const lines = readSource(String(warning.location.path).replace(/\\/g, '/')).split(/\r?\n/);
      const source = lines.slice(warning.location.start.line - 1, warning.location.end.line).join('\n');
      if (source !== entry.source) issues.push(`Reviewed source changed: ${warning.location.path}.`);
    } catch (error) {
      issues.push(`Cannot verify reviewed warning: ${error.message}`);
    }
  }
  for (const entry of pending.values()) issues.push(`Stale reviewed warning: ${entry.location.path} (${entry.category}).`);
  return issues;
}
function parseReport(input) {
  const lines = input.split(/\r?\n/).filter(line => line.trim().startsWith('{"summary"'));
  if (lines.length !== 1) throw Error('Expected one complete Biome JSON report.');
  return JSON.parse(lines[0]);
}
module.exports = { reviewReport, parseReport };
if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '..');
    const review = JSON.parse(fs.readFileSync(path.join(__dirname, 'lint-review.json'), 'utf8'));
    const report = parseReport(fs.readFileSync(0, 'utf8'));
    const sourceCache = new Map();
    const issues = reviewReport(report, review, relative => {
      const file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep)) throw Error('Source path is outside this repository.');
      if (!sourceCache.has(file)) sourceCache.set(file, fs.readFileSync(file, 'utf8'));
      return sourceCache.get(file);
    });
    const command = require('../package.json').scripts.lint;
    if (!command.includes(`@biomejs/biome@${review.biomeVersion}`)) issues.push('Biome version does not match the reviewed version.');
    if (issues.length) throw Error(issues.join('\n'));
    console.log(`Biome ${review.biomeVersion}: 0 errors, ${report.summary.warnings} reviewed warnings, 0 new warnings; ${report.summary.infos} informational diagnostics.`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const rows = review.warnings.map(entry => `- ${entry.location.path}:${entry.location.start.line} - ${entry.reason}`).join('\n');
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Lint passed: 0 errors and 0 unreviewed warnings.\n\nReviewed cases:\n${rows}\n`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
