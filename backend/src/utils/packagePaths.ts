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

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APP_PACKAGE_NAME = 'libre-webui';
const DEFAULT_VERSION = '0.0.0';

export interface AppPackageMetadata {
  name?: string;
  version?: string;
  [key: string]: unknown;
}

function readPackageJson(packageJsonPath: string): AppPackageMetadata | null {
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    return JSON.parse(
      fs.readFileSync(packageJsonPath, 'utf8')
    ) as AppPackageMetadata;
  } catch {
    return null;
  }
}

export function getModuleDir(moduleUrl: string): string {
  return path.dirname(fileURLToPath(moduleUrl));
}

export function resolveAppPackageRoot(moduleUrl: string): string | null {
  let currentDir = getModuleDir(moduleUrl);

  while (true) {
    const pkg = readPackageJson(path.join(currentDir, 'package.json'));
    if (pkg?.name === APP_PACKAGE_NAME) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export function loadAppPackage(moduleUrl: string): AppPackageMetadata {
  const packageRoot = resolveAppPackageRoot(moduleUrl);
  const pkg = packageRoot
    ? readPackageJson(path.join(packageRoot, 'package.json'))
    : null;

  return pkg ?? { version: DEFAULT_VERSION };
}

export function resolveBundledPluginsDir(
  moduleUrl: string,
  cwd: string = process.cwd()
): string {
  const moduleDir = getModuleDir(moduleUrl);
  const packageRoot = resolveAppPackageRoot(moduleUrl);
  const candidates = [
    packageRoot ? path.join(packageRoot, 'plugins') : null,
    path.resolve(moduleDir, '../../../plugins'),
    path.join(cwd, 'plugins'),
  ];

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  return packageRoot
    ? path.join(packageRoot, 'plugins')
    : path.join(cwd, 'plugins');
}

export function resolveFrontendDist(
  moduleUrl: string,
  cwd: string = process.cwd()
): string {
  const moduleDir = getModuleDir(moduleUrl);
  const packageRoot = resolveAppPackageRoot(moduleUrl);
  const candidates = [
    packageRoot ? path.join(packageRoot, 'frontend', 'dist') : null,
    packageRoot ? path.join(packageRoot, 'dist', 'frontend') : null,
    path.resolve(moduleDir, '../../frontend/dist'),
    path.resolve(moduleDir, '../../../frontend/dist'),
    path.join(cwd, 'frontend', 'dist'),
    path.join(cwd, 'dist', 'frontend'),
    path.join(cwd, 'dist'),
  ];

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    if (fs.existsSync(path.join(candidate, 'index.html'))) {
      return candidate;
    }
  }

  return '';
}
