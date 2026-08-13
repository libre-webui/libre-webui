/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import '../env.js';
import recoveryInventoryService from '../services/recoveryInventoryService.js';

interface CliOptions {
  json: boolean;
  dataDir?: string;
  databasePath?: string;
  legacyPluginsDirectories: string[];
}

const usage = `Usage: recovery-inventory [--json] [--data-dir PATH] [--database PATH] [--legacy-plugins-dir PATH]

Collect a read-only recovery-readiness inventory. Exit status is 0 when no
blockers are found, 1 when recovery blockers exist, and 2 for invalid usage or
an unexpected collection failure. Secret values are never included.`;

const parseArgs = (args: string[]): CliOptions => {
  const options: CliOptions = { json: false, legacyPluginsDirectories: [] };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${usage}\n`);
      process.exit(0);
    }
    if (
      argument === '--data-dir' ||
      argument === '--database' ||
      argument === '--legacy-plugins-dir'
    ) {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        throw new Error(`${argument} requires a path.`);
      }
      if (argument === '--data-dir') options.dataDir = value;
      else if (argument === '--database') options.databasePath = value;
      else options.legacyPluginsDirectories.push(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return options;
};

const renderText = (
  inventory: Awaited<ReturnType<typeof recoveryInventoryService.collect>>
): string => {
  const lines = [
    `Libre WebUI recovery inventory v${inventory.version}`,
    `Application: ${inventory.application.version}`,
    `Status: ${inventory.restoreReady ? 'READY' : 'BLOCKED'}`,
    `Database: ${inventory.database.quickCheck}; ${inventory.database.bytes} bytes; schema ${inventory.database.schema.fingerprint || 'unavailable'}`,
    `Encryption key: ${inventory.encryption.status}; source ${inventory.encryption.source}; fingerprint ${inventory.encryption.fingerprint || 'unavailable'}`,
    `Storage: ${inventory.storage.dataDirectory.files} files; ${inventory.storage.dataDirectory.bytes} bytes`,
    `Plugins: ${inventory.storage.customPlugins.definitions} custom definitions`,
    `Work: ${inventory.work.tasks} tasks; ${inventory.work.activeRuns} active runs; ${inventory.work.activePreviews} active previews; ${inventory.work.workspaces.length} external workspaces`,
    `Jobs: ${inventory.jobs.total} media jobs (${inventory.jobs.active} active); ${inventory.jobs.durable.total} durable jobs (${inventory.jobs.durable.running} running)`,
    `Durable events: ${inventory.jobs.durable.events.total} events across ${inventory.jobs.durable.events.streams} streams; cursor ${inventory.jobs.durable.events.lastCursor}`,
  ];
  if (inventory.blockers.length > 0) {
    lines.push('Blockers:', ...inventory.blockers.map(item => `- ${item}`));
  }
  if (inventory.warnings.length > 0) {
    lines.push('Warnings:', ...inventory.warnings.map(item => `- ${item}`));
  }
  lines.push('Exclusions:', ...inventory.exclusions.map(item => `- ${item}`));
  return `${lines.join('\n')}\n`;
};

const main = async (): Promise<void> => {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n\n${usage}\n`
    );
    process.exitCode = 2;
    return;
  }
  try {
    const inventory = await recoveryInventoryService.collect({
      ...(options.dataDir ? { dataDir: options.dataDir } : {}),
      ...(options.databasePath ? { databasePath: options.databasePath } : {}),
      ...(options.legacyPluginsDirectories.length > 0
        ? { legacyPluginsDirectories: options.legacyPluginsDirectories }
        : {}),
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(inventory, null, 2)}\n`
        : renderText(inventory)
    );
    process.exitCode = inventory.restoreReady ? 0 : 1;
  } catch {
    process.stderr.write('Recovery inventory collection failed.\n');
    process.exitCode = 2;
  }
};

void main();
