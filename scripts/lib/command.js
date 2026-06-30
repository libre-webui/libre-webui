const { spawnSync } = require('child_process');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');

function run(command, args = [], options = {}) {
  if (!Array.isArray(args)) {
    throw new Error('Command arguments must be an array');
  }

  const result = spawnSync(command, args, {
    cwd: options.cwd || projectRoot,
    encoding: 'utf8',
    stdio: options.silent ? 'pipe' : 'inherit',
    shell: false,
    ...options.spawn,
  });

  if (result.error) {
    if (options.allowFailure) return '';
    throw result.error;
  }

  if (result.status !== 0) {
    if (options.allowFailure) {
      return result.stdout ? result.stdout.trim() : '';
    }

    const stderr = result.stderr ? result.stderr.trim() : '';
    const rendered = [command, ...args].join(' ');
    throw new Error(
      stderr || `${rendered} failed with exit code ${result.status}`
    );
  }

  return result.stdout ? result.stdout.trim() : '';
}

function git(args, options = {}) {
  return run('git', args, options);
}

function npm(args, options = {}) {
  return run('npm', args, options);
}

module.exports = {
  git,
  npm,
  projectRoot,
  run,
};
