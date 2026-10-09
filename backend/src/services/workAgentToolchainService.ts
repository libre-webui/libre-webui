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

/**
 * The shared toolchain agent CLIs run from inside Work sandboxes.
 *
 * One Docker volume holds a Node runtime and each CLI at a pinned version.
 * Sandboxes mount it read-only, so nothing a run does can alter another
 * run's tools. A CLI is installed the first time a run needs it, by a
 * short-lived installer container with network access; sandboxes never
 * install anything themselves. Every version lives in its own directory and
 * `current` is switched with an atomic rename, so a sandbox that is using
 * one version keeps working while the next is installed.
 *
 * Layout under the mount:
 *   node/<version>/bin/node, node/current -> <version>
 *   cli/<id>/<version>/bin/<executable>, cli/<id>/current -> <version>
 *   cli/<id>/<version>/.libre-installed  (written last)
 */

import { createLogger } from '../utils/logger.js';
import {
  KIRO_KAS_SERVER,
  WORK_AGENT_CLI_IDS,
  WORK_AGENT_CLIS,
  type WorkAgentCliId,
  type WorkAgentCliSpec,
} from './workAgentCatalog.js';
import {
  WORK_AGENT_TOOLCHAIN_MOUNT,
  WorkRuntimeError,
  workAgentToolchainVolume,
  workRuntimeConfig,
} from './workRuntimeShared.js';

export {
  WORK_AGENT_TOOLCHAIN_MOUNT,
  workAgentToolchainVolume,
} from './workRuntimeShared.js';

const logger = createLogger('services:work-agent-toolchain');

const INSTALL_TIMEOUT_MS = 15 * 60_000;
const STATUS_TIMEOUT_MS = 60_000;
const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,64}$/;
const PACKAGE_PATTERN = /^(?:@[a-z0-9-]+\/)?[a-z0-9.-]+$/;

/** PATH inside the sandbox for one CLI: its bin, the toolchain Node, then the image's. */
export function workAgentSandboxPath(cli: WorkAgentCliId): string {
  return [
    `${WORK_AGENT_TOOLCHAIN_MOUNT}/cli/${cli}/current/bin`,
    `${WORK_AGENT_TOOLCHAIN_MOUNT}/node/current/bin`,
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin',
  ].join(':');
}

/** Absolute path of a CLI's executable inside the sandbox. */
export function workAgentExecutable(cli: WorkAgentCliSpec): string {
  return `${WORK_AGENT_TOOLCHAIN_MOUNT}/cli/${cli.id}/current/bin/${cli.executable}`;
}

/** The toolchain's Node, which runs the egress relay in any glibc image. */
export const WORK_AGENT_NODE = `${WORK_AGENT_TOOLCHAIN_MOUNT}/node/current/bin/node`;

/**
 * POSIX shell run by the installer container (as root, with network). It
 * reads everything it needs from the environment and installs exactly one
 * CLI version, idempotently.
 */
export const WORK_AGENT_INSTALL_SCRIPT = String.raw`set -eu
root="$LIBRE_TOOLCHAIN_ROOT"
umask 022
mkdir -p "$root/node" "$root/cli/$CLI_ID"
# The toolchain Node, copied from this image, so the relay and the npm CLIs
# run even when a sandbox image has no Node of its own.
node_version=$(node -p 'process.version')
if [ ! -x "$root/node/$node_version/bin/node" ]; then
  staging=$(mktemp -d "$root/node/.staging-XXXXXX")
  mkdir -p "$staging/bin"
  cp "$(command -v node)" "$staging/bin/node"
  chmod -R a+rX "$staging"
  # Another installer may have finished first; never replace a live copy.
  if [ -x "$root/node/$node_version/bin/node" ]; then
    rm -rf "$staging"
  else
    mv -T "$staging" "$root/node/$node_version"
  fi
fi
link=$(mktemp -u "$root/node/.current-XXXXXX")
ln -s "$node_version" "$link"
mv -T "$link" "$root/node/current"
dest="$root/cli/$CLI_ID/$CLI_VERSION"
# A Kiro install from before its engine was unpacked here is incomplete.
if [ ! -f "$dest/.libre-installed" ] ||
  { [ "$CLI_KIND" = kiro ] && [ ! -x "$dest/kas-node" ]; }; then
  staging=$(mktemp -d "$root/cli/$CLI_ID/.staging-XXXXXX")
  mkdir -p "$staging/bin"
  if [ "$CLI_KIND" = npm ]; then
    npm install -g --prefix "$staging" --no-fund --no-audit \
      --no-update-notifier "$CLI_PACKAGE@$CLI_VERSION"
  else
    case "$(uname -m)" in
      x86_64|amd64) arch=x86_64; want="$KIRO_SHA256_X86_64" ;;
      aarch64|arm64) arch=aarch64; want="$KIRO_SHA256_AARCH64" ;;
      *) echo "Unsupported architecture $(uname -m)" >&2; exit 4 ;;
    esac
    archive="/tmp/kirocli-$arch-linux-musl.tar.gz"
    curl -fsSL "https://prod.download.cli.kiro.dev/stable/$CLI_VERSION/kirocli-$arch-linux-musl.tar.gz" -o "$archive"
    got=$(sha256sum "$archive" | cut -d' ' -f1)
    if [ "$got" != "$want" ]; then
      echo "Kiro CLI checksum mismatch: $got" >&2
      exit 5
    fi
    mkdir -p /tmp/kiro-extract
    tar -xzf "$archive" -C /tmp/kiro-extract
    cp -R /tmp/kiro-extract/kirocli/bin/. "$staging/bin/"
    rm -rf /tmp/kiro-extract "$archive"
    # Kiro's v3 engine (a Node server with its own node) unpacks itself into
    # the data directory on a first chat. Unpack it here, where it can run: a
    # sandbox's /tmp is noexec and its image is read-only. The key is a dummy;
    # the run only has to get far enough to unpack, not to answer.
    warm=$(mktemp -d /tmp/kiro-warm-XXXXXX)
    echo hi | HOME="$warm" PATH="$staging/bin:$PATH" \
      KIRO_API_KEY=ksk_libre_toolchain_unpack timeout 180 \
      kiro-cli chat --no-interactive --output-format stream-json \
      --agent-engine v3 --agent vibe >/dev/null 2>&1 || true
    data="$warm/.local/share/kiro-cli"
    for kas in "$data/kas/$CLI_VERSION"-*; do
      if [ -d "$kas" ]; then mv -T "$kas" "$staging/kas"; fi
    done
    if [ -x "$data/node" ]; then mv "$data/node" "$staging/kas-node"; fi
    rm -rf "$warm"
    if [ ! -x "$staging/kas-node" ] ||
      [ ! -f "$staging/kas/$KIRO_KAS_SERVER" ]; then
      echo "Kiro's v3 engine did not unpack." >&2
      exit 6
    fi
  fi
  printf '{"cli":"%s","version":"%s"}\n' "$CLI_ID" "$CLI_VERSION" > "$staging/.libre-installed"
  chmod -R a+rX "$staging"
  if [ -f "$dest/.libre-installed" ]; then
    rm -rf "$staging"
  else
    rm -rf "$dest"
    mv -T "$staging" "$dest"
  fi
fi
link=$(mktemp -u "$root/cli/$CLI_ID/.current-XXXXXX")
ln -s "$CLI_VERSION" "$link"
mv -T "$link" "$root/cli/$CLI_ID/current"
chmod a+rX "$root" "$root/cli" "$root/cli/$CLI_ID" "$root/node"
`;

/** Prints `<cli> <version>` for every installed `current`, nothing else. */
const STATUS_SCRIPT = String.raw`root="$LIBRE_TOOLCHAIN_ROOT"
for marker in "$root"/cli/*/current/.libre-installed; do
  [ -f "$marker" ] || continue
  cli=$(basename "$(dirname "$(dirname "$marker")")")
  # Kiro is only usable with its unpacked v3 engine beside it.
  [ "$cli" = kiro ] && [ ! -x "$(dirname "$marker")/kas-node" ] && continue
  version=$(basename "$(readlink "$(dirname "$marker")")")
  [ -x "$root/node/current/bin/node" ] && echo "$cli $version"
done
exit 0
`;

export interface WorkAgentToolchainState {
  readonly id: WorkAgentCliId;
  readonly name: string;
  readonly wantedVersion: string;
  readonly installedVersion?: string;
  readonly installing: boolean;
}

/** Runs one Docker CLI command; the Docker driver provides it. */
export type ToolchainDockerRunner = (
  args: string[],
  options: { timeoutMs: number; abortSignal?: AbortSignal }
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export class WorkAgentToolchainService {
  private readonly installs = new Map<WorkAgentCliId, Promise<void>>();
  /** Versions proven installed since this process started. */
  private readonly installed = new Map<WorkAgentCliId, string>();
  private statusLoaded = false;

  constructor(
    private readonly runDocker: () => ToolchainDockerRunner | undefined,
    private readonly installerImage: () => string = () =>
      workRuntimeConfig.image
  ) {}

  /** Why agent CLIs cannot run in this deployment's sandboxes, if so. */
  unavailableReason(): string | null {
    if (!workAgentToolchainVolume()) {
      return 'Agent CLIs in Work are turned off (WORK_AGENT_TOOLCHAIN_VOLUME is empty).';
    }
    if (!this.runDocker()) {
      return 'Agent CLIs in Work need the Docker runtime.';
    }
    return null;
  }

  async status(signal?: AbortSignal): Promise<WorkAgentToolchainState[]> {
    if (!this.statusLoaded && !this.unavailableReason()) {
      try {
        await this.loadStatus(signal);
      } catch (error) {
        logger.warn('Could not read the agent toolchain status:', error);
      }
    }
    return WORK_AGENT_CLI_IDS.map(id => ({
      id,
      name: WORK_AGENT_CLIS[id].name,
      wantedVersion: WORK_AGENT_CLIS[id].install.version,
      installedVersion: this.installed.get(id),
      installing: this.installs.has(id),
    }));
  }

  isCurrent(cli: WorkAgentCliSpec): boolean {
    return this.installed.get(cli.id) === cli.install.version;
  }

  /**
   * Make the CLI's pinned version the toolchain's current one. Concurrent
   * callers for the same CLI share one installer run.
   */
  async ensureInstalled(
    cli: WorkAgentCliSpec,
    signal?: AbortSignal
  ): Promise<void> {
    const reason = this.unavailableReason();
    if (reason) {
      throw new WorkRuntimeError(
        reason,
        409,
        'WORK_AGENT_TOOLCHAIN_UNAVAILABLE'
      );
    }
    if (!this.statusLoaded) {
      try {
        await this.loadStatus(signal);
      } catch (error) {
        logger.warn('Could not read the agent toolchain status:', error);
      }
    }
    if (this.isCurrent(cli)) return;
    let install = this.installs.get(cli.id);
    if (!install) {
      install = this.install(cli).finally(() => this.installs.delete(cli.id));
      this.installs.set(cli.id, install);
    }
    if (!signal) {
      await install;
      return;
    }
    // A cancelled run stops waiting; the shared install still finishes.
    await new Promise<void>((resolve, reject) => {
      const abort = (): void =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error('Cancelled.')
        );
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      install!.then(
        () => {
          signal.removeEventListener('abort', abort);
          resolve();
        },
        error => {
          signal.removeEventListener('abort', abort);
          reject(error);
        }
      );
    });
  }

  private async loadStatus(signal?: AbortSignal): Promise<void> {
    const docker = this.runDocker();
    const volume = workAgentToolchainVolume();
    if (!docker || !volume) return;
    const result = await docker(
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--entrypoint',
        'sh',
        '--env',
        `LIBRE_TOOLCHAIN_ROOT=${WORK_AGENT_TOOLCHAIN_MOUNT}`,
        '--mount',
        `type=volume,src=${volume},dst=${WORK_AGENT_TOOLCHAIN_MOUNT},readonly`,
        this.installerImage(),
        '-c',
        STATUS_SCRIPT,
      ],
      { timeoutMs: STATUS_TIMEOUT_MS, abortSignal: signal }
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || 'toolchain status failed');
    }
    this.installed.clear();
    for (const line of result.stdout.split('\n')) {
      const [id, version] = line.trim().split(' ');
      if (
        WORK_AGENT_CLI_IDS.includes(id as WorkAgentCliId) &&
        version &&
        VERSION_PATTERN.test(version)
      ) {
        this.installed.set(id as WorkAgentCliId, version);
      }
    }
    this.statusLoaded = true;
  }

  private async install(cli: WorkAgentCliSpec): Promise<void> {
    const docker = this.runDocker();
    const volume = workAgentToolchainVolume();
    if (!docker || !volume) {
      throw new WorkRuntimeError(
        this.unavailableReason() ?? 'The agent toolchain is unavailable.',
        409,
        'WORK_AGENT_TOOLCHAIN_UNAVAILABLE'
      );
    }
    const { install } = cli;
    if (!VERSION_PATTERN.test(install.version)) {
      throw new Error(`Invalid pinned version for ${cli.name}.`);
    }
    const env: Record<string, string> = {
      LIBRE_TOOLCHAIN_ROOT: WORK_AGENT_TOOLCHAIN_MOUNT,
      CLI_ID: cli.id,
      CLI_VERSION: install.version,
      CLI_KIND: install.kind,
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    };
    if (install.kind === 'npm') {
      if (!PACKAGE_PATTERN.test(install.package)) {
        throw new Error(`Invalid package name for ${cli.name}.`);
      }
      env.CLI_PACKAGE = install.package;
    } else {
      env.KIRO_SHA256_X86_64 = install.sha256.x86_64;
      env.KIRO_SHA256_AARCH64 = install.sha256.aarch64;
      env.KIRO_KAS_SERVER = KIRO_KAS_SERVER;
    }
    logger.info(
      `Installing ${cli.name} ${install.version} into the Work agent toolchain`
    );
    await docker(
      [
        'volume',
        'create',
        '--label',
        'ai.libre-webui.managed=true',
        '--label',
        'ai.libre-webui.role=work-agent-toolchain',
        volume,
      ],
      { timeoutMs: STATUS_TIMEOUT_MS }
    );
    const args = ['run', '--rm', '--entrypoint', 'sh'];
    for (const [name, value] of Object.entries(env)) {
      args.push('--env', `${name}=${value}`);
    }
    args.push(
      '--mount',
      `type=volume,src=${volume},dst=${WORK_AGENT_TOOLCHAIN_MOUNT}`,
      this.installerImage(),
      '-c',
      WORK_AGENT_INSTALL_SCRIPT
    );
    const result = await docker(args, { timeoutMs: INSTALL_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout)
        .trim()
        .split('\n')
        .slice(-5)
        .join('\n');
      throw new WorkRuntimeError(
        `Could not install ${cli.name} ${install.version} for Work: ${detail || `exit code ${result.exitCode}`}`,
        503,
        'WORK_AGENT_INSTALL_FAILED'
      );
    }
    this.installed.set(cli.id, install.version);
    logger.info(`Installed ${cli.name} ${install.version} for Work`);
  }
}
