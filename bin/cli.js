#!/usr/bin/env node

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

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { resolveCliRuntimePaths } = require('./runtime-paths');
const { parseLaunchArgs } = require('./cli-args');

const helpFlags = ['-h', '--help'];
const versionFlags = ['-v', '--version'];
const maintenanceCommands = new Map([
  ['recovery-check', 'cli/recoveryInventory.js'],
  ['backup', 'cli/recoveryBackup.js'],
  ['migrate-postgres', 'cli/migrateSqliteToPostgres.js'],
]);

const printHelp = () => {
  console.log(`
Libre WebUI - Local-First AI Workspace

Usage:
  npx libre-webui [options]
  npx libre-webui recovery-check [options]
  npx libre-webui backup <command> [options]
  npx libre-webui migrate-postgres [options]

Options:
  -h, --help      Show this help message
  -v, --version   Show version number
  -p, --port      Set the port (default: 8080)
  -m, --model     Model new accounts start on (for example llama3.2)
  --ollama-url    Ollama API URL (default: http://localhost:11434)
  --no-open       Do not open the browser after startup

Maintenance Commands:
  recovery-check    Collect a read-only recovery-readiness inventory
  backup            Create, verify, inspect, or restore a protected backup
  migrate-postgres  Analyze, apply, resume, or validate a SQLite migration

Environment Variables:
  PORT                    Server port (default: 8080)
  DATA_DIR                Persistent data directory (default: ~/.libre-webui)
  PLUGINS_DIR             Custom plugin directory (default: DATA_DIR/plugins)
  PLATFORM_PREFLIGHT_TMP_DIR
                          Writable database-inspection scratch directory
  OLLAMA_BASE_URL         Ollama API URL (default: http://localhost:11434)
  DEFAULT_MODEL           Model new accounts start on (optional)
  OPEN_BROWSER            Set to false to skip opening the browser
  OPENAI_API_KEY          OpenAI API key (optional)
  ANTHROPIC_API_KEY       Anthropic API key (optional)

Examples:
  npx libre-webui
  npx libre-webui --port 3000
  npx libre-webui --model llama3.2 --ollama-url http://localhost:11434
  ollama launch libre-webui
  npx libre-webui recovery-check --json
  npx libre-webui backup --help
  npx libre-webui migrate-postgres --help
  PORT=3000 npx libre-webui

Documentation: https://docs.librewebui.org
`);
};

const resolveBackendArtifact = relativePath => {
  const roots = [
    path.join(__dirname, '../backend/dist'),
    path.join(__dirname, '../dist/backend'),
  ];
  return roots
    .map(root => path.join(root, relativePath))
    .find(candidate => fs.existsSync(candidate));
};

const runtimeEnvironment = () => {
  // Resolve packaged state before importing a maintenance command. This keeps
  // npx and Homebrew data outside their immutable installation directories;
  // the resolver is intentionally read-only and creates no paths.
  const { dataDirectory, pluginsDirectory, preflightDirectory } =
    resolveCliRuntimePaths(process.env);
  return {
    ...process.env,
    NODE_ENV: 'production',
    DATA_DIR: dataDirectory,
    PLUGINS_DIR: pluginsDirectory,
    PLATFORM_PREFLIGHT_TMP_DIR: preflightDirectory,
  };
};

const launch = (artifactPath, forwardedArgs, env) => {
  const child = spawn(process.execPath, [artifactPath, ...forwardedArgs], {
    stdio: 'inherit',
    env,
  });

  child.on('error', error => {
    console.error('Failed to start Libre WebUI:', error.message);
    process.exit(1);
  });

  child.on('close', code => {
    process.exit(code ?? 1);
  });

  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
};

const requireArtifact = relativePath => {
  const artifact = resolveBackendArtifact(relativePath);
  if (!artifact) {
    console.error('Error: Backend not found. The package may be corrupted.');
    console.error('Please try reinstalling: npm install -g libre-webui');
    process.exit(1);
  }
  return artifact;
};

const main = () => {
  const args = process.argv.slice(2);
  const maintenanceArtifact = maintenanceCommands.get(args[0]);
  if (maintenanceArtifact) {
    launch(
      requireArtifact(maintenanceArtifact),
      args.slice(1),
      runtimeEnvironment()
    );
    return;
  }

  if (args.some(arg => helpFlags.includes(arg))) {
    printHelp();
    return;
  }

  if (args.some(arg => versionFlags.includes(arg))) {
    const packageJson = require('../package.json');
    console.log(`libre-webui v${packageJson.version}`);
    return;
  }

  const launchArgs = parseLaunchArgs(args);
  if (launchArgs.errors.length > 0) {
    for (const error of launchArgs.errors) console.error(`Error: ${error}`);
    console.error('Run `npx libre-webui --help` for usage.');
    process.exit(1);
  }
  Object.assign(process.env, launchArgs.env);

  const backendPath = requireArtifact('main.js');
  const frontendPaths = [
    path.join(__dirname, '../frontend/dist/index.html'),
    path.join(__dirname, '../dist/frontend/index.html'),
  ];
  if (!frontendPaths.some(candidate => fs.existsSync(candidate))) {
    console.error('Error: Frontend not found. The package may be corrupted.');
    console.error('Please try reinstalling: npm install -g libre-webui');
    process.exit(1);
  }

  const env = {
    ...runtimeEnvironment(),
    SERVE_FRONTEND: 'true',
  };
  const port = env.PORT || '8080';

  console.log(`
╭─────────────────────────────────────────────────╮
│                                                 │
│   Libre WebUI                                   │
│   Local-First AI Workspace                      │
│                                                 │
╰─────────────────────────────────────────────────╯

Starting server...
`);

  launch(backendPath, [], env);
};

main();
