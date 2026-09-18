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

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Prepare an opt-in local bundle without changing either application's configuration. */
export async function prepareDshProviderBundle({
  outputDirectory,
  socketPath,
}) {
  if (!path.isAbsolute(outputDirectory) || !path.isAbsolute(socketPath))
    throw new Error('Output directory and socket path must be absolute.');
  const source = new URL('../backend/dist/cordis/dsh/', import.meta.url);
  const files = ['native-provider-plugin.js', 'native-provider-protocol.js'];
  // Verify the compiled plugin exists before creating any installation output.
  await Promise.all(files.map(file => readFile(new URL(file, source))));
  await mkdir(outputDirectory, { mode: 0o700 });
  for (const file of files)
    await copyFile(new URL(file, source), path.join(outputDirectory, file));
  await writeFile(
    path.join(outputDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: '@libre-webui/dsh-native-provider',
        version: '0.0.0',
        private: true,
        type: 'module',
        main: './native-provider-plugin.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    path.join(outputDirectory, 'cordis.patch.yml'),
    `- insert:\n    - id: libre-webui-native-provider\n      name: '@libre-webui/dsh-native-provider'\n      config:\n        socketPath: ${JSON.stringify(socketPath)}\n`
  );
  return outputDirectory;
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const [outputDirectory, socketPath] = process.argv.slice(2);
  if (!outputDirectory || !socketPath || process.argv.length !== 4) {
    console.error(
      `Usage: node ${fileURLToPath(import.meta.url)} /absolute/bundle-directory /absolute/private-directory/provider.sock`
    );
    process.exitCode = 1;
  } else {
    try {
      console.log(
        await prepareDshProviderBundle({ outputDirectory, socketPath })
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
