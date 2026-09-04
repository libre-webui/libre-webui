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

// Launch flags map onto the environment the backend already reads, so a
// launcher such as `ollama launch libre-webui` and a human typing the
// command line share one contract. Explicit flags win over inherited env.
const valueFlags = new Map([
  ['-p', 'PORT'],
  ['--port', 'PORT'],
  ['-m', 'DEFAULT_MODEL'],
  ['--model', 'DEFAULT_MODEL'],
  ['--ollama-url', 'OLLAMA_BASE_URL'],
]);

const readValue = (args, index, flag) => {
  const inline = flag.indexOf('=');
  if (inline !== -1) return { value: flag.slice(inline + 1), consumed: 0 };
  const next = args[index + 1];
  if (next === undefined || next.startsWith('-')) {
    return { value: undefined, consumed: 0 };
  }
  return { value: next, consumed: 1 };
};

/**
 * Parse launch flags into environment overrides. Unknown flags are left
 * alone; a value flag without a value is reported so the CLI can refuse it.
 */
const parseLaunchArgs = (args = []) => {
  const env = {};
  const errors = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (name === '--no-open') {
      env.OPEN_BROWSER = 'false';
      continue;
    }
    const variable = valueFlags.get(name);
    if (!variable) continue;
    const { value, consumed } = readValue(args, index, arg);
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) {
      errors.push(`${name} requires a value`);
      continue;
    }
    if (variable === 'PORT' && !/^\d{1,5}$/.test(trimmed)) {
      errors.push(`${name} must be a port number, got "${trimmed}"`);
      continue;
    }
    env[variable] = trimmed;
    index += consumed;
  }
  return { env, errors };
};

module.exports = { parseLaunchArgs };
