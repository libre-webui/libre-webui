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

// Parse command line arguments
const args = process.argv.slice(2);
const helpFlags = ['-h', '--help'];
const versionFlags = ['-v', '--version'];

if (args.some(arg => helpFlags.includes(arg))) {
  console.log(`
Libre WebUI - Privacy-First AI Chat Interface

Usage: npx libre-webui [options]

Options:
  -h, --help      Show this help message
  -v, --version   Show version number
  -p, --port      Set the port (default: 8080)

Environment Variables:
  PORT                    Server port (default: 8080)
  OLLAMA_BASE_URL         Ollama API URL (default: http://localhost:11434)
  OPENAI_API_KEY          OpenAI API key (optional)
  ANTHROPIC_API_KEY       Anthropic API key (optional)

Examples:
  npx libre-webui
  npx libre-webui --port 3000
  PORT=3000 npx libre-webui

Documentation: https://docs.librewebui.org
`);
  process.exit(0);
}

if (args.some(arg => versionFlags.includes(arg))) {
  const packageJson = require('../package.json');
  console.log(`libre-webui v${packageJson.version}`);
  process.exit(0);
}

// Handle --port argument
const portArgIndex = args.findIndex(arg => arg === '-p' || arg === '--port');
if (portArgIndex !== -1 && args[portArgIndex + 1]) {
  process.env.PORT = args[portArgIndex + 1];
}

// Find the backend entry point
const possibleBackendPaths = [
  path.join(__dirname, '../backend/dist/index.js'),
  path.join(__dirname, '../dist/backend/index.js'),
];

let backendPath = '';
for (const p of possibleBackendPaths) {
  if (fs.existsSync(p)) {
    backendPath = p;
    break;
  }
}

if (!backendPath) {
  console.error('Error: Backend not found. The package may be corrupted.');
  console.error('Please try reinstalling: npm install -g libre-webui');
  process.exit(1);
}

// Check if frontend exists
const possibleFrontendPaths = [
  path.join(__dirname, '../frontend/dist/index.html'),
  path.join(__dirname, '../dist/frontend/index.html'),
];

let frontendExists = false;
for (const p of possibleFrontendPaths) {
  if (fs.existsSync(p)) {
    frontendExists = true;
    break;
  }
}

if (!frontendExists) {
  console.error('Error: Frontend not found. The package may be corrupted.');
  console.error('Please try reinstalling: npm install -g libre-webui');
  process.exit(1);
}

// Set production environment
const env = {
  ...process.env,
  NODE_ENV: 'production',
  SERVE_FRONTEND: 'true',
};

const port = env.PORT || '8080';

console.log(`
╭─────────────────────────────────────────────────╮
│                                                 │
│   Libre WebUI                                   │
│   Privacy-First AI Chat Interface               │
│                                                 │
╰─────────────────────────────────────────────────╯

Starting server...
`);

// Start the backend server
const server = spawn('node', [backendPath], {
  stdio: 'inherit',
  env,
});

server.on('error', err => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});

server.on('close', code => {
  process.exit(code || 0);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  server.kill('SIGINT');
});

process.on('SIGTERM', () => {
  server.kill('SIGTERM');
});
