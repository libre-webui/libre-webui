#!/usr/bin/env node
/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import path from 'node:path';

import {
  createBackupArchive,
  createTeamBackupArchive,
  generateBackupKeys,
  inspectBackupArchive,
  restoreBackupArchive,
  restoreTeamBackupArchive,
  verifyBackupArchive,
  verifyRestoredBackup,
} from '../platform/recovery/index.js';
import { resolveDataDirectory } from '../utils/dataDirectory.js';

type Parsed = {
  command: string;
  values: Map<string, string>;
  flags: Set<string>;
};

const usage = `Usage:
  libre-webui backup keygen --directory PATH
  libre-webui backup create --output FILE --encryption-key FILE --signing-private-key FILE --offline [--data-dir PATH]
  libre-webui backup create-team --output FILE --encryption-key FILE --signing-private-key FILE --offline
  libre-webui backup inspect --archive FILE
  libre-webui backup verify --archive FILE --signing-public-key FILE [--encryption-key FILE]
  libre-webui backup restore-preflight --archive FILE --target PATH --signing-public-key FILE --encryption-key FILE
  libre-webui backup restore-apply --archive FILE --target PATH --signing-public-key FILE --encryption-key FILE
  libre-webui backup restore-team-preflight --archive FILE --signing-public-key FILE --encryption-key FILE
  libre-webui backup restore-team-apply --archive FILE --signing-public-key FILE --encryption-key FILE --configuration-output PATH
  libre-webui backup restore-verify --target PATH

From a source checkout, replace "libre-webui backup" with "npm run recovery:backup --".

All JSON output is metadata-only. Secrets and user content are never printed.`;

const parse = (argv: string[]): Parsed => {
  const [command, ...rest] = argv;
  if (!command || command.startsWith('-')) throw new Error(usage);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith('--'))
      throw new Error(`Unexpected argument: ${item}\n${usage}`);
    if (item === '--offline') {
      flags.add(item);
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${item}.\n${usage}`);
    if (values.has(item)) throw new Error(`Duplicate option: ${item}`);
    values.set(item, value);
    index += 1;
  }
  return { command, values, flags };
};

const required = (parsed: Parsed, name: string): string => {
  const value = parsed.values.get(name)?.trim();
  if (!value) throw new Error(`Missing ${name}.\n${usage}`);
  return path.resolve(value);
};

const assertOnly = (
  parsed: Parsed,
  valueNames: readonly string[],
  flagNames: readonly string[] = []
): void => {
  const allowedValues = new Set(valueNames);
  const allowedFlags = new Set(flagNames);
  for (const name of parsed.values.keys()) {
    if (!allowedValues.has(name)) {
      throw new Error(
        `Unexpected option for ${parsed.command}: ${name}\n${usage}`
      );
    }
  }
  for (const name of parsed.flags) {
    if (!allowedFlags.has(name)) {
      throw new Error(
        `Unexpected flag for ${parsed.command}: ${name}\n${usage}`
      );
    }
  }
};

const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const main = async (): Promise<void> => {
  if (
    process.argv.length === 3 &&
    ['--help', '-h'].includes(process.argv[2]!)
  ) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const parsed = parse(process.argv.slice(2));
  switch (parsed.command) {
    case 'keygen': {
      assertOnly(parsed, ['--directory']);
      print(generateBackupKeys(required(parsed, '--directory')));
      return;
    }
    case 'create': {
      assertOnly(
        parsed,
        ['--output', '--encryption-key', '--signing-private-key', '--data-dir'],
        ['--offline']
      );
      const verification = await createBackupArchive({
        dataDir: parsed.values.has('--data-dir')
          ? required(parsed, '--data-dir')
          : resolveDataDirectory(),
        outputPath: required(parsed, '--output'),
        encryptionKeyPath: required(parsed, '--encryption-key'),
        signingPrivateKeyPath: required(parsed, '--signing-private-key'),
        offline: parsed.flags.has('--offline'),
      });
      print({
        created: true,
        backupId: verification.header.manifest.backupId,
        createdAt: verification.header.manifest.createdAt,
        files: verification.header.manifest.files.length,
        bytes: verification.header.encryption.ciphertextBytes,
        signatureVerified: verification.signatureVerified,
        payloadVerified: verification.payloadVerified,
      });
      return;
    }
    case 'create-team': {
      assertOnly(
        parsed,
        ['--output', '--encryption-key', '--signing-private-key'],
        ['--offline']
      );
      const result = await createTeamBackupArchive({
        outputPath: required(parsed, '--output'),
        encryptionKeyPath: required(parsed, '--encryption-key'),
        signingPrivateKeyPath: required(parsed, '--signing-private-key'),
        offline: parsed.flags.has('--offline'),
      });
      print({
        created: true,
        profile: 'team',
        backupId: result.verification.header.manifest.backupId,
        createdAt: result.verification.header.manifest.createdAt,
        files: result.verification.header.manifest.files.length,
        bytes: result.verification.header.encryption.ciphertextBytes,
        schemaVersion: result.inventory.schemaVersion,
        blobObjects: result.inventory.s3.objects.length,
        vectorRecords: result.inventory.vectors.records,
        signatureVerified: result.verification.signatureVerified,
        payloadVerified: result.verification.payloadVerified,
      });
      return;
    }
    case 'inspect': {
      assertOnly(parsed, ['--archive']);
      const header = inspectBackupArchive(required(parsed, '--archive'));
      print({
        manifest: header.manifest,
        encryption: {
          algorithm: header.encryption.algorithm,
          ciphertextBytes: header.encryption.ciphertextBytes,
          ciphertextSha256: header.encryption.ciphertextSha256,
        },
        signature: {
          algorithm: header.signature.algorithm,
          signerFingerprint: header.signature.signerFingerprint,
        },
      });
      return;
    }
    case 'verify': {
      assertOnly(parsed, [
        '--archive',
        '--signing-public-key',
        '--encryption-key',
      ]);
      const verification = verifyBackupArchive({
        archivePath: required(parsed, '--archive'),
        signingPublicKeyPath: required(parsed, '--signing-public-key'),
        ...(parsed.values.has('--encryption-key')
          ? { encryptionKeyPath: required(parsed, '--encryption-key') }
          : {}),
      });
      print({
        backupId: verification.header.manifest.backupId,
        signatureVerified: verification.signatureVerified,
        ciphertextVerified: verification.ciphertextVerified,
        payloadVerified: verification.payloadVerified,
      });
      return;
    }
    case 'restore-preflight':
    case 'restore-apply': {
      assertOnly(parsed, [
        '--archive',
        '--target',
        '--signing-public-key',
        '--encryption-key',
      ]);
      const result = await restoreBackupArchive({
        archivePath: required(parsed, '--archive'),
        targetDirectory: required(parsed, '--target'),
        signingPublicKeyPath: required(parsed, '--signing-public-key'),
        encryptionKeyPath: required(parsed, '--encryption-key'),
        apply: parsed.command === 'restore-apply',
      });
      print({
        applied: result.applied,
        targetDirectory: result.targetDirectory,
        restoreReady: result.inventory.restoreReady,
        schemaFingerprint: result.inventory.database.schema.fingerprint,
        blockers: result.inventory.blockers,
      });
      return;
    }
    case 'restore-team-preflight':
    case 'restore-team-apply': {
      assertOnly(parsed, [
        '--archive',
        '--signing-public-key',
        '--encryption-key',
        ...(parsed.command === 'restore-team-apply'
          ? ['--configuration-output']
          : []),
      ]);
      const result = await restoreTeamBackupArchive({
        archivePath: required(parsed, '--archive'),
        signingPublicKeyPath: required(parsed, '--signing-public-key'),
        encryptionKeyPath: required(parsed, '--encryption-key'),
        targetEnv: process.env,
        apply: parsed.command === 'restore-team-apply',
        ...(parsed.command === 'restore-team-apply'
          ? {
              configurationOutputDirectory: required(
                parsed,
                '--configuration-output'
              ),
            }
          : {}),
      });
      print({
        applied: result.applied,
        profile: 'team',
        backupId: result.verification.header.manifest.backupId,
        schemaVersion: result.inventory.schemaVersion,
        blobObjects: result.inventory.s3.objects.length,
        vectorRecords: result.inventory.vectors.records,
        signatureVerified: result.verification.signatureVerified,
        payloadVerified: result.verification.payloadVerified,
        ...(result.configurationOutputDirectory
          ? {
              configurationOutputDirectory: result.configurationOutputDirectory,
            }
          : {}),
      });
      return;
    }
    case 'restore-verify': {
      assertOnly(parsed, ['--target']);
      const inventory = await verifyRestoredBackup(
        required(parsed, '--target')
      );
      print({
        verified: true,
        restoreReady: inventory.restoreReady,
        schemaFingerprint: inventory.database.schema.fingerprint,
        blockers: inventory.blockers,
      });
      return;
    }
    default:
      throw new Error(usage);
  }
};

main().catch(error => {
  const message =
    error instanceof Error ? error.message : 'Recovery backup failed.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
});
