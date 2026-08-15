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

const os = require('os');
const path = require('path');

const configuredPath = (value, cwd) => {
  const trimmed = value?.trim();
  return trimmed ? path.resolve(cwd, trimmed) : undefined;
};

const isInside = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..')
  );
};

const userCacheDirectory = ({ env, homeDirectory, platform }) => {
  if (platform === 'win32') {
    const localAppData = configuredPath(env.LOCALAPPDATA, homeDirectory);
    return localAppData || path.join(homeDirectory, 'AppData', 'Local');
  }
  if (platform === 'darwin') {
    return path.join(homeDirectory, 'Library', 'Caches');
  }
  const xdgCache = env.XDG_CACHE_HOME?.trim();
  return xdgCache && path.isAbsolute(xdgCache)
    ? path.normalize(xdgCache)
    : path.join(homeDirectory, '.cache');
};

/**
 * Resolve the writable paths owned by the packaged CLI before it imports the
 * backend. Explicit relative paths retain the historical caller-cwd meaning;
 * defaults never point into an npm cache, global installation, or Homebrew
 * Cellar.
 */
const resolveCliRuntimePaths = (
  env = process.env,
  {
    cwd = process.cwd(),
    homeDirectory = os.homedir(),
    platform = process.platform,
    tempDirectory = os.tmpdir(),
    uid = typeof process.getuid === 'function' ? process.getuid() : undefined,
  } = {}
) => {
  const dataDirectory =
    configuredPath(env.DATA_DIR, cwd) ||
    path.join(homeDirectory, '.libre-webui');
  // Always pass an absolute plugin root to the backend. Older packaged
  // launchers selected DATA_DIR/plugins, never process.cwd()/plugins; leaving
  // this unset would make source-only legacy detection inspect an unrelated
  // caller directory during npx and Homebrew launches.
  const pluginsDirectory =
    configuredPath(env.PLUGINS_DIR, cwd) || path.join(dataDirectory, 'plugins');
  const configuredPreflight = configuredPath(
    env.PLATFORM_PREFLIGHT_TMP_DIR,
    cwd
  );
  let preflightDirectory =
    configuredPreflight ||
    path.join(
      userCacheDirectory({ env, homeDirectory, platform }),
      'libre-webui',
      'preflight'
    );

  // An unusual DATA_DIR may itself be the user cache root. Keep the generated
  // scratch path outside it; the backend performs the stronger physical-path
  // check and rejects symlink aliases before creating anything.
  if (!configuredPreflight && isInside(dataDirectory, preflightDirectory)) {
    preflightDirectory = path.join(
      tempDirectory,
      `libre-webui-${uid === undefined ? 'user' : uid}`,
      'preflight'
    );
  }
  if (isInside(dataDirectory, preflightDirectory)) {
    throw new Error(
      'PLATFORM_PREFLIGHT_TMP_DIR must resolve outside DATA_DIR.'
    );
  }

  return {
    dataDirectory,
    pluginsDirectory,
    preflightDirectory,
  };
};

module.exports = { resolveCliRuntimePaths };
