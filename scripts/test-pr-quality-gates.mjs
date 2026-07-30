import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const workflowPath = '.github/workflows/format.yml';

function readWorkflow() {
  return fs.readFileSync(path.join(repoRoot, workflowPath), 'utf8');
}

function getJob(workflow, jobName) {
  const marker = `  ${jobName}:\n`;
  const start = workflow.indexOf(marker, workflow.indexOf('\njobs:\n'));

  assert.notEqual(start, -1, `${workflowPath} must define ${jobName}`);

  const remainder = workflow.slice(start + marker.length);
  const nextJobOffset = remainder.search(/\n  [a-z0-9-]+:\n/);
  return nextJobOffset === -1
    ? workflow.slice(start)
    : workflow.slice(start, start + marker.length + nextJobOffset);
}

test('quality gates run for pull requests into every target branch', () => {
  const workflow = readWorkflow();
  const triggerStart = workflow.indexOf('\non:\n');
  const jobsStart = workflow.indexOf('\njobs:\n');

  assert.notEqual(triggerStart, -1, `${workflowPath} must define triggers`);
  assert.notEqual(jobsStart, -1, `${workflowPath} must define jobs`);

  const triggers = workflow.slice(triggerStart, jobsStart);
  const pullRequestStart = triggers.indexOf('  pull_request:\n');

  assert.notEqual(
    pullRequestStart,
    -1,
    `${workflowPath} must run for pull requests`
  );

  const pullRequestTrigger = triggers.slice(pullRequestStart);
  assert.match(pullRequestTrigger, /^  pull_request:\s*$/m);
  assert.doesNotMatch(
    pullRequestTrigger,
    /^\s+branches:/m,
    `${workflowPath} must cover pull requests into intermediate branches`
  );
  assert.doesNotMatch(
    workflow,
    /pull_request_target:/,
    `${workflowPath} must run untrusted changes without privileged PR context`
  );
});

test('quality gates cover formatting, linting, types, package tests, and E2E', () => {
  const workflow = readWorkflow();
  const formatAndLint = getJob(workflow, 'format-and-lint');
  const packageTests = getJob(workflow, 'package-tests');
  const browserE2e = getJob(workflow, 'browser-e2e');

  assert.match(formatAndLint, /run: npm run format:check/);
  assert.match(formatAndLint, /run: npm run lint:frontend/);
  assert.match(formatAndLint, /run: npm run lint:backend/);
  assert.match(formatAndLint, /cd frontend && npm run type-check/);
  assert.match(formatAndLint, /cd backend && npm run type-check/);
  assert.match(packageTests, /run: npm run test:package/);
  assert.match(
    browserE2e,
    /cd frontend && npx playwright install --with-deps chromium/
  );
  assert.match(browserE2e, /run: npm run test:e2e/);
  assert.match(browserE2e, /if: failure\(\)/);
  assert.doesNotMatch(formatAndLint, /continue-on-error:\s*true/);
  assert.doesNotMatch(packageTests, /continue-on-error:\s*true/);
  assert.doesNotMatch(browserE2e, /continue-on-error:\s*true/);
});
