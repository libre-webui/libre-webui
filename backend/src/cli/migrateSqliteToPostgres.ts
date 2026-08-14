/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import path from 'node:path';
import { resolvePostgresRuntimeConfig } from '../persistence/postgresConfig.js';
import {
  migrateSQLiteToPostgres,
  SQLiteToPostgresMigrationError,
  type SQLiteToPostgresMigrationMode,
} from '../persistence/sqliteToPostgresMigration.js';
import { createSQLiteToTeamStorageMigrationPhase } from '../platform/storage/sqliteToTeamStorageMigration.js';
import {
  createStorageKeyringFromEnvironment,
  resolveLegacyEncryptionKeyForMigration,
} from '../platform/storage/storageFactory.js';

interface CliOptions {
  sourcePath: string;
  sourcePluginsPath?: string;
  mode: SQLiteToPostgresMigrationMode;
  resume: boolean;
}

const usage = (): string =>
  [
    'Usage: libre-webui migrate-postgres --source <data.sqlite> [--plugins <directory>] --mode <dry-run|apply|validate> [--resume]',
    'Source checkout: npm run migrate:postgres -- --source <data.sqlite> [--plugins <directory>] --mode <dry-run|apply|validate> [--resume]',
    '',
    'DATABASE_URL and PostgreSQL TLS/pool settings are read from the normal Libre environment.',
    'Stop every Libre app and worker before apply. Credentials and local paths are never printed.',
  ].join('\n');

const parse = (argv: readonly string[]): CliOptions => {
  let sourcePath = '';
  let sourcePluginsPath: string | undefined;
  let mode: SQLiteToPostgresMigrationMode = 'dry-run';
  let resume = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--source') {
      sourcePath = argv[++index] ?? '';
    } else if (argument === '--plugins') {
      sourcePluginsPath = argv[++index] ?? '';
      if (!sourcePluginsPath) throw new Error('--plugins requires a directory');
    } else if (argument === '--mode') {
      const value = argv[++index];
      if (value !== 'dry-run' && value !== 'apply' && value !== 'validate') {
        throw new Error('Invalid migration mode');
      }
      mode = value;
    } else if (argument === '--resume') {
      resume = true;
    } else if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      throw new Error('Unknown migration argument');
    }
  }
  if (!sourcePath) throw new Error('--source is required');
  if (resume && mode !== 'apply') {
    throw new Error('--resume is valid only with --mode apply');
  }
  return { sourcePath, sourcePluginsPath, mode, resume };
};

const main = async (): Promise<void> => {
  try {
    const options = parse(process.argv.slice(2));
    const postgres = resolvePostgresRuntimeConfig(process.env);
    const sourceEnv = {
      ...process.env,
      DATA_DIR: path.dirname(path.resolve(options.sourcePath)),
    };
    const legacyKey = resolveLegacyEncryptionKeyForMigration(sourceEnv);
    const keyedSourceEnv = { ...sourceEnv, ENCRYPTION_KEY: legacyKey };
    const keyring = createStorageKeyringFromEnvironment(keyedSourceEnv);
    const previousEncryptionKey = process.env.ENCRYPTION_KEY;
    let cipher: typeof import('../services/encryptionService.js').encryptionService;
    try {
      // The encryption singleton is intentionally loaded only after selecting
      // the source key. This prevents the maintenance command from generating
      // or persisting a replacement key in another data directory.
      process.env.ENCRYPTION_KEY = legacyKey;
      ({ encryptionService: cipher } =
        await import('../services/encryptionService.js'));
    } finally {
      if (previousEncryptionKey === undefined) {
        delete process.env.ENCRYPTION_KEY;
      } else {
        process.env.ENCRYPTION_KEY = previousEncryptionKey;
      }
    }
    const storagePhase = createSQLiteToTeamStorageMigrationPhase({
      env: keyedSourceEnv,
      keyring,
      cipher,
    });
    const report = await migrateSQLiteToPostgres({
      sourcePath: options.sourcePath,
      sourcePluginsPath: options.sourcePluginsPath,
      postgres,
      mode: options.mode,
      resume: options.resume,
      storagePhase,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.compatible || report.blockers.length > 0) process.exitCode = 2;
  } catch (error) {
    if (error instanceof SQLiteToPostgresMigrationError && error.report) {
      process.stdout.write(`${JSON.stringify(error.report, null, 2)}\n`);
    }
    process.stderr.write(
      `${error instanceof Error ? error.message : 'SQLite-to-PostgreSQL migration failed'}\n`
    );
    process.exitCode = 1;
  }
};

void main();
