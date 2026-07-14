/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

function runNpm(args, stdio = 'ignore') {
  const npmExecPath = process.env.npm_execpath;

  if (npmExecPath) {
    return spawnSync(process.execPath, [npmExecPath, ...args], {
      cwd: projectRoot,
      stdio,
    });
  }

  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: projectRoot,
    shell: process.platform === 'win32',
    stdio,
  });
}

const workspaceRebuild = runNpm([
  'rebuild',
  'better-sqlite3',
  '--workspace=backend',
]);

if (workspaceRebuild.status !== 0) {
  runNpm(['rebuild', 'better-sqlite3']);
}

// Repository hooks are only relevant for a source checkout, not an npm install.
if (fs.existsSync(path.join(projectRoot, '.git'))) {
  runNpm(['run', 'setup-hooks'], 'inherit');
}
