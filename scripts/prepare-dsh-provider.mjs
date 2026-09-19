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

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryUrl = 'https://github.com/libre-webui/dsh-native-provider';
const description =
  'Use DeepSeek Harness providers in Libre WebUI over a private local connection.';

function validatePath(value, label) {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    value === path.parse(value).root ||
    /[\x00-\x1f\x7f]/u.test(value)
  )
    throw new Error(
      `${label} must be an absolute normalized path without control characters.`
    );
}

/** Prepare an opt-in local bundle without changing either application's configuration. */
export async function prepareDshProviderBundle({
  outputDirectory,
  socketPath,
}) {
  validatePath(outputDirectory, 'Output directory');
  validatePath(socketPath, 'Socket path');
  if (Buffer.byteLength(socketPath, 'utf8') > 100)
    throw new Error('Socket path must be at most 100 UTF-8 bytes.');
  if (outputDirectory === socketPath)
    throw new Error('Output directory and socket path must be different.');
  const source = new URL('../backend/dist/cordis/dsh/', import.meta.url);
  const files = ['native-provider-plugin.js', 'native-provider-protocol.js'];
  // Read every input before claiming a new directory. A missing build or
  // license must not leave a broken installable bundle behind.
  const inputs = await Promise.all([
    ...files.map(file => readFile(new URL(file, source))),
    readFile(new URL('../LICENSE', import.meta.url)),
  ]);
  const outputs = new Map(files.map((file, index) => [file, inputs[index]]));
  outputs.set('LICENSE', inputs[files.length]);
  outputs.set(
    'package.json',
    `${JSON.stringify(
      {
        name: '@libre-webui/dsh-native-provider',
        version: '0.1.0',
        description,
        license: 'Apache-2.0',
        repository: { type: 'git', url: `git+${repositoryUrl}.git` },
        homepage: `${repositoryUrl}#readme`,
        bugs: { url: `${repositoryUrl}/issues` },
        // This generated bundle contains a machine-specific socket setting.
        private: true,
        type: 'module',
        main: './native-provider-plugin.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      null,
      2
    )}\n`
  );
  outputs.set(
    'cordis.patch.yml',
    `- insert:\n    - id: libre-webui-native-provider\n      name: '@libre-webui/dsh-native-provider'\n      config:\n        socketPath: ${JSON.stringify(socketPath)}\n`
  );
  outputs.set(
    'README.md',
    `# DeepSeek Harness provider connection\n\n${description}\n\nThis local bundle is generated from Libre WebUI's mirrored provider plugin.\nThe standalone source and installation instructions are at ${repositoryUrl}.\n\nInstall with \`dsh plugin --profile web add /absolute/bundle-directory\`,\nthen restart the DSH profile. Use the profile your DSH instance runs.\nThe socket path is configured in \`cordis.patch.yml\`; configure the same path\nin Libre WebUI. Both processes must use the same Unix host and OS account.\nThe socket parent must be a physical, account-owned directory with mode 0700;\nthe socket uses mode 0600. Provider credentials stay in DSH.\n\nThe plugin exposes only model catalog and inference operations. It does not\ncreate agent sessions or execute native tools. An unavailable connection or\nmodel fails without switching providers.\n\nLicense: Apache-2.0. See [LICENSE](./LICENSE).\n`
  );
  // Non-recursive mkdir claims only a previously nonexistent output path.
  // In particular, an existing directory or symlink is never overwritten.
  await mkdir(outputDirectory, { mode: 0o700 });
  try {
    for (const [file, contents] of outputs)
      await writeFile(path.join(outputDirectory, file), contents, {
        flag: 'wx',
      });
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
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
