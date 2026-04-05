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
