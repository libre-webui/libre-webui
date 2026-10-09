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
 * The agent CLIs that can run inside a Work sandbox, and everything Work
 * needs to know about each: how it is installed into the shared toolchain
 * and how a non-interactive turn is started. Which login a run uses, and
 * where its tokens may travel, lives in workAgentHostLogins.ts.
 */

import { WORK_AGENT_TOOLCHAIN_MOUNT } from './workRuntimeShared.js';

export type WorkAgentCliId =
  'claude-code' | 'codex' | 'kiro' | 'opencode' | 'pi';

export const WORK_AGENT_CLI_IDS: readonly WorkAgentCliId[] = [
  'claude-code',
  'codex',
  'kiro',
  'opencode',
  'pi',
];

export type WorkAgentInstall =
  | {
      readonly kind: 'npm';
      readonly package: string;
      readonly version: string;
    }
  | {
      readonly kind: 'kiro';
      readonly version: string;
      /** SHA-256 of kirocli-<arch>-linux-musl.tar.gz from the release manifest. */
      readonly sha256: Readonly<Record<'x86_64' | 'aarch64', string>>;
    };

export interface WorkAgentCliSpec {
  readonly id: WorkAgentCliId;
  readonly name: string;
  readonly install: WorkAgentInstall;
  /** Executable in the installed CLI's bin directory. */
  readonly executable: string;
  /** Non-credential hosts reachable even when the task has no network. */
  readonly supportHosts: readonly string[];
  /** Static environment: telemetry, update checks, and similar off. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Arguments for one non-interactive turn whose prompt arrives on stdin.
   * Tools are auto-approved: the sandbox, not the CLI, is the boundary.
   */
  buildArgs(model: string | undefined): string[];
}

/** Kiro's v3 engine server, relative to its unpacked `kas` directory. */
export const KIRO_KAS_SERVER =
  'node_modules/@kiro/agent/dist/server/acp-server.js';
const KIRO_ROOT = `${WORK_AGENT_TOOLCHAIN_MOUNT}/cli/kiro/current`;

export const WORK_AGENT_CLIS: Readonly<
  Record<WorkAgentCliId, WorkAgentCliSpec>
> = {
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    install: {
      kind: 'npm',
      package: '@anthropic-ai/claude-code',
      version: '2.1.295',
    },
    executable: 'claude',
    supportHosts: [],
    env: {
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    buildArgs: model => [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
      ...(model ? ['--model', model] : []),
    ],
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    install: { kind: 'npm', package: '@openai/codex', version: '0.162.0' },
    executable: 'codex',
    supportHosts: [],
    env: {},
    buildArgs: model => [
      'exec',
      '--json',
      '--skip-git-repo-check',
      // The Work sandbox is the boundary; Codex's own Linux sandbox needs
      // kernel features a locked-down container does not grant.
      '--dangerously-bypass-approvals-and-sandbox',
      ...(model ? ['-m', model] : []),
      '-',
    ],
  },
  kiro: {
    id: 'kiro',
    name: 'Kiro',
    install: {
      kind: 'kiro',
      version: '2.28.0',
      sha256: {
        x86_64:
          '4835d269f227658816492d30bc81b9becdf06f1fc98dfd7c780d734cff72ea73',
        aarch64:
          'b237d942ab57fc634d5ff2ea25aaaa9efe02cc5274128f47a422c2ee9f50e706',
      },
    },
    executable: 'kiro-cli',
    supportHosts: [],
    env: {
      KIRO_NO_AUTO_UPDATE: '1',
      // The v3 engine, unpacked into the read-only toolchain at install:
      // Kiro's own unpack target, under the agent home in /tmp, is noexec.
      KIRO_KAS_NODE_PATH: `${KIRO_ROOT}/kas-node`,
      KIRO_KAS_SERVER_PATH: `${KIRO_ROOT}/kas/${KIRO_KAS_SERVER}`,
      KIRO_DISABLE_TELEMETRY: '1',
      Q_DISABLE_TELEMETRY: '1',
    },
    buildArgs: model => [
      'chat',
      '--no-interactive',
      '--trust-all-tools',
      '--output-format',
      'stream-json',
      '--agent-engine',
      'v3',
      '--agent',
      'vibe',
      ...(model ? ['--model', model] : []),
    ],
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    install: { kind: 'npm', package: 'opencode-ai', version: '1.18.35' },
    executable: 'opencode',
    // OpenCode reads its model catalog before every run.
    supportHosts: ['models.dev', 'models.opencode.ai'],
    env: {
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
      // Everything is allowed: the sandbox is the boundary.
      OPENCODE_PERMISSION: '{"edit":"allow","bash":"allow","webfetch":"allow"}',
    },
    buildArgs: model => [
      'run',
      '--format',
      'json',
      ...(model ? ['-m', model] : []),
    ],
  },
  pi: {
    id: 'pi',
    name: 'Pi',
    install: {
      kind: 'npm',
      package: '@earendil-works/pi-coding-agent',
      version: '1.1.0',
    },
    executable: 'pi',
    supportHosts: [],
    env: {},
    buildArgs: model => {
      const [provider, ...rest] = (model ?? '').split('/');
      return [
        '--mode',
        'json',
        '-p',
        '--no-session',
        ...(provider ? ['--provider', provider] : []),
        ...(provider && rest.join('/') ? ['--model', rest.join('/')] : []),
      ];
    },
  },
};

export function isWorkAgentCliId(value: unknown): value is WorkAgentCliId {
  return (
    typeof value === 'string' &&
    (WORK_AGENT_CLI_IDS as readonly string[]).includes(value)
  );
}

/**
 * Split a Work selection: providerId names the CLI, and the model is the
 * CLI id alone (its default) or `<cli>:<model>`.
 */
export function parseWorkAgentModel(
  cliId: WorkAgentCliId,
  model: string
): string | undefined {
  const trimmed = model.trim();
  if (trimmed === cliId) return undefined;
  return trimmed.startsWith(`${cliId}:`)
    ? trimmed.slice(cliId.length + 1) || undefined
    : undefined;
}
