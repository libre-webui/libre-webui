import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

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
    /cd frontend && npx playwright install --with-deps \$\{\{ matrix\.browser \}\}/
  );
  assert.match(
    browserE2e,
    /run: npm run test:e2e -- --project=\$\{\{ matrix\.browser \}\}/
  );
  assert.match(browserE2e, /if: failure\(\)/);
  assert.doesNotMatch(formatAndLint, /continue-on-error:\s*true/);
  assert.doesNotMatch(packageTests, /continue-on-error:\s*true/);
  assert.doesNotMatch(browserE2e, /continue-on-error:\s*true/);
});

test('native installation gates use the tested tarball on each supported OS and LTS line', () => {
  const { jobs } = yaml.load(readWorkflow());
  const native = jobs['native-package-install'];
  assert.deepEqual(native.strategy.matrix.os, [
    'ubuntu-latest',
    'macos-latest',
    'windows-latest',
  ]);
  assert.deepEqual(native.strategy.matrix.node, ['22.22', '24']);
  assert.equal(native.needs, 'package-tests');
  assert.equal(native.strategy['fail-fast'], false);
  assert.equal(native.if, undefined);
  assert.notEqual(native['continue-on-error'], true);
  const upload = jobs['package-tests'].steps.find(
    step => step.with?.name === 'native-package'
  );
  assert.equal(upload.with.path, 'native-package/*.tgz');
  assert.equal(upload.with['if-no-files-found'], 'error');
  const download = native.steps.find(
    step => step.with?.name === 'native-package'
  );
  assert.equal(download.with.path, 'native-package');
  assert.ok(
    native.steps.some(
      step => step.run === 'npm run test:package-install -- native-package'
    )
  );
  const scripts = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
  ).scripts;
  assert.match(scripts['test:package'], /npm run test:package-install/);
  assert.match(
    scripts['test:e2e'],
    /--workspace=frontend --$/,
    'the root command must forward project selection to Playwright'
  );
});

test('critical browser coverage and provisioned Work GUI checks cannot silently disappear', () => {
  const { jobs } = yaml.load(readWorkflow());
  const browser = jobs['browser-e2e'];
  assert.deepEqual(browser.strategy.matrix.browser, [
    'chromium',
    'webkit',
    'firefox',
  ]);
  assert.equal(browser.strategy['fail-fast'], false);
  assert.equal(browser.if, undefined);
  const results = browser.steps.find(
    step => step.with?.path === 'frontend/test-results/'
  );
  assert.match(results.with.name, /matrix\.browser/);
  const gui = jobs['work-computer-live'];
  assert.equal(gui.if, undefined);
  assert.notEqual(gui['continue-on-error'], true);
  const build = gui.steps.find(step =>
    step.run?.includes('WORK_RUNTIME_DEFAULTS')
  );
  assert.match(build.run, /WORK_BASE_IMAGE=\$\{WORK_RUNTIME_DEFAULTS\.image\}/);
  assert.match(build.run, /deploy\/work-computer/);
  assert.match(build.run, /result\.status \?\? 1/);
  const live = gui.steps.find(
    step => step.run === 'npm run test:work-computer'
  );
  assert.equal(live.env.TEST_WORK_COMPUTER, '1');
  assert.equal(live.env.WORK_COMPUTER_TEST_IMAGE, 'libre-work-computer:ci');
});

test('a required live Work Computer fixture fails instead of becoming a skipped check', () => {
  // The child is a separate test run, not a worker of this parent runner.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_'))
  );
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=tap',
      path.join(repoRoot, 'scripts/test-work-computer-live.mjs'),
    ],
    {
      cwd: repoRoot,
      env: {
        ...env,
        PATH: '',
        TEST_WORK_COMPUTER: '1',
        WORK_COMPUTER_TEST_IMAGE: 'libre-work-computer:fixture-is-required',
      },
      encoding: 'utf8',
      timeout: 15_000,
    }
  );
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /Docker|fixture|required/);
  assert.doesNotMatch(result.stdout, /# skipped 1/);
});
