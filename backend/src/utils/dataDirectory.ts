/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the default from the backend module location, not process.cwd().
// Root scripts, workspace scripts, Docker, tests, and maintenance CLIs can
// launch from different directories but must always address the same state.
export const BACKEND_DIRECTORY = fileURLToPath(
  new URL('../../', import.meta.url)
);
export const PROJECT_DIRECTORY = path.dirname(BACKEND_DIRECTORY);
export const DEFAULT_DATA_DIRECTORY = path.join(BACKEND_DIRECTORY, 'data');
export const DEFAULT_PREFLIGHT_DIRECTORY = path.join(
  BACKEND_DIRECTORY,
  'temp',
  'preflight'
);
export const LEGACY_NESTED_DATA_DIRECTORY = path.join(
  BACKEND_DIRECTORY,
  'backend',
  'data'
);
export const LEGACY_PLUGINS_DIRECTORY = path.join(BACKEND_DIRECTORY, 'plugins');

export const resolveDataDirectory = (
  env: NodeJS.ProcessEnv = process.env
): string => {
  const configured = env.DATA_DIR?.trim();
  return configured
    ? path.resolve(PROJECT_DIRECTORY, configured)
    : DEFAULT_DATA_DIRECTORY;
};

/** Keep writable plugin definitions inside the backed-up data root by default. */
export const resolvePluginsDirectory = (
  env: NodeJS.ProcessEnv = process.env,
  dataDirectory = resolveDataDirectory(env),
  projectDirectory = PROJECT_DIRECTORY
): string => {
  const configured = env.PLUGINS_DIR?.trim();
  return configured
    ? path.resolve(projectDirectory, configured)
    : path.join(dataDirectory, 'plugins');
};

/**
 * Return deterministic plugin read paths retained for compatibility. Relative
 * PLUGINS_DIR values used to resolve from the backend working directory, so
 * that historical location remains readable until operators migrate it.
 */
export const resolveLegacyPluginsDirectories = (
  env: NodeJS.ProcessEnv = process.env,
  locations: {
    backendDirectory?: string;
    projectDirectory?: string;
    historicalWorkingDirectory?: string;
  } = {}
): string[] => {
  const backendDirectory = locations.backendDirectory || BACKEND_DIRECTORY;
  const projectDirectory = locations.projectDirectory || PROJECT_DIRECTORY;
  const directories = [path.join(backendDirectory, 'plugins')];
  const configured = env.PLUGINS_DIR?.trim();
  if (configured && !path.isAbsolute(configured)) {
    const selectedDirectory = path.resolve(projectDirectory, configured);
    for (const historicalRoot of [
      backendDirectory,
      locations.historicalWorkingDirectory,
    ]) {
      if (!historicalRoot) continue;
      const historicalDirectory = path.resolve(historicalRoot, configured);
      if (historicalDirectory !== selectedDirectory) {
        directories.push(historicalDirectory);
      }
    }
  } else if (!configured && locations.historicalWorkingDirectory) {
    // Before plugin storage was canonicalized, the implicit writable/read path
    // was process.cwd()/plugins. Keep it conflict-only so npx callers do not
    // silently lose approved definitions from an arbitrary launch directory.
    const historicalDirectory = path.resolve(
      locations.historicalWorkingDirectory,
      'plugins'
    );
    if (historicalDirectory !== path.join(backendDirectory, 'plugins')) {
      directories.push(historicalDirectory);
    }
  }
  return Array.from(
    new Set(directories.map(directory => path.resolve(directory)))
  );
};

/**
 * Resolve a possibly not-yet-created path through its nearest existing
 * ancestor. This exposes ancestor symlink aliases without creating anything.
 */
export const resolvePhysicalPathCandidate = (candidate: string): string => {
  let existing = path.resolve(candidate);
  const missingSegments: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missingSegments.unshift(path.basename(existing));
    existing = parent;
  }
  const physicalAncestor = fs.realpathSync.native(existing);
  return path.join(physicalAncestor, ...missingSegments);
};

export const resolvePreflightDirectory = (
  env: NodeJS.ProcessEnv = process.env
): string => {
  const configured = env.PLATFORM_PREFLIGHT_TMP_DIR?.trim();
  return resolvePhysicalPathCandidate(
    configured
      ? path.resolve(PROJECT_DIRECTORY, configured)
      : DEFAULT_PREFLIGHT_DIRECTORY
  );
};

export const assertPreflightDirectoryOutsideDataDirectory = (
  dataDirectory: string,
  preflightDirectory: string
): void => {
  const relative = path.relative(
    resolvePhysicalPathCandidate(dataDirectory),
    resolvePhysicalPathCandidate(preflightDirectory)
  );
  if (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..')
  ) {
    throw new Error(
      'PLATFORM_PREFLIGHT_TMP_DIR must be outside DATA_DIR so startup validation cannot mutate durable application state.'
    );
  }
};

export const hasKeyDependentApplicationState = (dataDir: string): boolean => {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(path.join(dataDir, `data.sqlite${suffix}`))) return true;
  }
  const blobRoot = path.join(dataDir, 'blobs');
  try {
    const rootStat = fs.lstatSync(blobRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return true;

    const rootEntries = fs.readdirSync(blobRoot, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.name !== 'objects' && entry.name !== 'staging') return true;
      if (!entry.isDirectory() || entry.isSymbolicLink()) return true;
    }

    const objectsDirectory = path.join(blobRoot, 'objects');
    if (fs.existsSync(objectsDirectory)) {
      for (const firstShard of fs.readdirSync(objectsDirectory, {
        withFileTypes: true,
      })) {
        if (
          !/^[0-9a-f]{2}$/.test(firstShard.name) ||
          !firstShard.isDirectory() ||
          firstShard.isSymbolicLink()
        ) {
          return true;
        }
        const firstShardPath = path.join(objectsDirectory, firstShard.name);
        for (const secondShard of fs.readdirSync(firstShardPath, {
          withFileTypes: true,
        })) {
          if (
            !/^[0-9a-f]{2}$/.test(secondShard.name) ||
            !secondShard.isDirectory() ||
            secondShard.isSymbolicLink()
          ) {
            return true;
          }
          const secondShardPath = path.join(firstShardPath, secondShard.name);
          for (const object of fs.readdirSync(secondShardPath, {
            withFileTypes: true,
          })) {
            const match = /^([0-9a-f-]{36})\.blob$/.exec(object.name);
            const id = match?.[1];
            if (
              !id ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
                id
              ) ||
              id.slice(0, 2) !== firstShard.name ||
              id.slice(2, 4) !== secondShard.name ||
              !object.isFile() ||
              object.isSymbolicLink()
            ) {
              return true;
            }
            return true;
          }
        }
      }
    }

    const stagingDirectory = path.join(blobRoot, 'staging');
    if (fs.existsSync(stagingDirectory)) {
      for (const entry of fs.readdirSync(stagingDirectory, {
        withFileTypes: true,
      })) {
        // Staging files have not been published and are safe to discard during
        // recovery. Anything outside that private temporary-file shape is not
        // a pristine store and must fail closed.
        if (
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          !entry.name.endsWith('.tmp')
        ) {
          return true;
        }
      }
    }
    return false;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false;
    }
    // An unreadable or non-directory blob path is not a pristine install.
    return true;
  }
};

export const assertExistingStateHasLegacyEncryptionKey = (
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env
): void => {
  if (!hasKeyDependentApplicationState(dataDir)) return;
  const environmentKey = env.ENCRYPTION_KEY?.trim() || '';
  const persistentKeyPath = path.join(dataDir, '.encryption_key');
  if (/^[a-fA-F0-9]{64}$/.test(environmentKey)) return;
  if (fs.existsSync(persistentKeyPath)) return;
  throw new Error(
    'Existing encrypted application data requires its original ENCRYPTION_KEY or .encryption_key file; refusing to generate a replacement key.'
  );
};

/**
 * Refuse to hide data written by the historical cwd-dependent backend script.
 * Operators must deliberately set DATA_DIR or migrate while Libre is stopped.
 */
export const assertNoLegacyDataDirectoryConflict = (
  env: NodeJS.ProcessEnv = process.env,
  locations: {
    defaultDataDirectory?: string;
    legacyDataDirectory?: string;
    historicalWorkingDirectories?: string[];
  } = {}
): void => {
  const defaultDataDirectory =
    locations.defaultDataDirectory || DEFAULT_DATA_DIRECTORY;
  const legacyDataDirectory =
    locations.legacyDataDirectory || LEGACY_NESTED_DATA_DIRECTORY;
  const configuredDataDirectory = env.DATA_DIR?.trim();
  const selectedDataDirectory = configuredDataDirectory
    ? resolveDataDirectory(env)
    : defaultDataDirectory;
  if (configuredDataDirectory && !path.isAbsolute(configuredDataDirectory)) {
    const historicalCandidates = Array.from(
      new Set(
        (
          locations.historicalWorkingDirectories || [
            process.cwd(),
            BACKEND_DIRECTORY,
          ]
        ).map(workingDirectory =>
          path.resolve(workingDirectory, configuredDataDirectory)
        )
      )
    );
    for (const historicalDirectory of historicalCandidates) {
      if (
        path.resolve(historicalDirectory) !==
          path.resolve(selectedDataDirectory) &&
        hasKeyDependentApplicationState(historicalDirectory)
      ) {
        throw new Error(
          `Legacy data exists at ${historicalDirectory}, where the relative DATA_DIR=${configuredDataDirectory} resolved from a historical process working directory. Libre now resolves it to ${selectedDataDirectory}. Stop Libre and use an absolute DATA_DIR or migrate the full data directory deliberately; startup will not choose or copy between them.`
        );
      }
    }
  }
  if (
    configuredDataDirectory &&
    path.isAbsolute(configuredDataDirectory) &&
    path.resolve(selectedDataDirectory) !== path.resolve(defaultDataDirectory)
  ) {
    return;
  }
  if (
    configuredDataDirectory &&
    path.resolve(selectedDataDirectory) !== path.resolve(defaultDataDirectory)
  ) {
    return;
  }
  if (path.resolve(selectedDataDirectory) === path.resolve(legacyDataDirectory))
    return;
  const legacyDatabase = path.join(legacyDataDirectory, 'data.sqlite');
  if (!fs.existsSync(legacyDatabase)) return;
  const canonicalDatabase = path.join(selectedDataDirectory, 'data.sqlite');
  throw new Error(
    `Legacy data exists at ${legacyDatabase}. Libre is configured to use ${canonicalDatabase}. Stop Libre and either set DATA_DIR=${legacyDataDirectory} temporarily or migrate the full data directory deliberately; startup will not choose or copy between them.`
  );
};
