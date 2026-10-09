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
 * needs to know about each: how it is installed into the shared toolchain,
 * which headless credential it reads and where that credential may travel,
 * and how a non-interactive turn is started.
 *
 * Hosts are the only places the egress proxy will put a real secret, so
 * they are exact service endpoints, never a provider-wide wildcard that a
 * customer could also host content under.
 */

export type WorkAgentCliId =
  'claude-code' | 'codex' | 'kiro' | 'opencode' | 'pi';

export const WORK_AGENT_CLI_IDS: readonly WorkAgentCliId[] = [
  'claude-code',
  'codex',
  'kiro',
  'opencode',
  'pi',
];

/** Provider families an OpenCode or Pi model can be routed through. */
export type WorkAgentProviderFamily = 'openrouter' | 'anthropic' | 'openai';

export interface WorkAgentCredentialSlot {
  /** Environment variable the CLI reads; also the setting's identity. */
  readonly env: string;
  /** Hosts where the proxy replaces the placeholder with the secret. */
  readonly hosts: readonly string[];
  /** Bundled provider whose saved key can fill this slot. */
  readonly providerPlugin?: string;
  /** Provider family an OpenCode or Pi model prefix maps to. */
  readonly family?: WorkAgentProviderFamily;
  /** Non-secret environment the CLI needs alongside this credential. */
  readonly env_extra?: Readonly<Record<string, string>>;
}

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

export interface WorkAgentModelOption {
  readonly id: string;
  readonly label: string;
}

export interface WorkAgentCliSpec {
  readonly id: WorkAgentCliId;
  readonly name: string;
  readonly install: WorkAgentInstall;
  /** Executable in the installed CLI's bin directory. */
  readonly executable: string;
  /**
   * Credential slots in preference order. Claude Code, Codex, and Kiro need
   * any one; OpenCode and Pi need the slot for the chosen model's provider.
   */
  readonly credentials: readonly WorkAgentCredentialSlot[];
  /** Non-credential hosts reachable even when the task has no network. */
  readonly supportHosts: readonly string[];
  /** Static environment: telemetry, update checks, and similar off. */
  readonly env: Readonly<Record<string, string>>;
  /** Whether a model must be chosen (it encodes the provider). */
  readonly requiresModel: boolean;
  /** Fixed model choices offered beside the CLI default. */
  readonly modelOptions: readonly WorkAgentModelOption[];
  /**
   * Arguments for one non-interactive turn whose prompt arrives on stdin.
   * Tools are auto-approved: the sandbox, not the CLI, is the boundary.
   */
  buildArgs(model: string | undefined): string[];
}

const ANTHROPIC_API_HOSTS = ['api.anthropic.com'];
const OPENAI_API_HOSTS = ['api.openai.com'];
const OPENROUTER_API_HOSTS = ['openrouter.ai'];

const PROVIDER_KEYS: readonly WorkAgentCredentialSlot[] = [
  {
    env: 'OPENROUTER_API_KEY',
    hosts: OPENROUTER_API_HOSTS,
    providerPlugin: 'openrouter',
    family: 'openrouter',
  },
  {
    env: 'ANTHROPIC_API_KEY',
    hosts: ANTHROPIC_API_HOSTS,
    providerPlugin: 'anthropic',
    family: 'anthropic',
  },
  {
    env: 'OPENAI_API_KEY',
    hosts: OPENAI_API_HOSTS,
    providerPlugin: 'openai',
    family: 'openai',
  },
];

/** `provider/model` → the provider family, when it is one Work can key. */
export function workAgentModelFamily(
  model: string | undefined
): WorkAgentProviderFamily | undefined {
  const prefix = model?.split('/')[0]?.trim().toLowerCase();
  return prefix === 'openrouter' ||
    prefix === 'anthropic' ||
    prefix === 'openai'
    ? prefix
    : undefined;
}

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
    credentials: [
      // A subscription token from `claude setup-token`.
      { env: 'CLAUDE_CODE_OAUTH_TOKEN', hosts: ANTHROPIC_API_HOSTS },
      {
        env: 'ANTHROPIC_API_KEY',
        hosts: ANTHROPIC_API_HOSTS,
        providerPlugin: 'anthropic',
      },
      {
        // Claude through Amazon Bedrock with a Bedrock API key.
        env: 'AWS_BEARER_TOKEN_BEDROCK',
        hosts: ['bedrock-runtime.*.amazonaws.com'],
        providerPlugin: 'bedrock',
        env_extra: { CLAUDE_CODE_USE_BEDROCK: '1' },
      },
    ],
    supportHosts: [],
    env: {
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    requiresModel: false,
    modelOptions: [
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      { id: 'opus', label: 'Opus' },
      { id: 'claude-opus-5-5', label: 'Opus 5.5' },
      { id: 'haiku', label: 'Haiku' },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
    ],
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
    credentials: [
      {
        env: 'CODEX_API_KEY',
        hosts: OPENAI_API_HOSTS,
        providerPlugin: 'openai',
      },
    ],
    supportHosts: [],
    env: {},
    requiresModel: false,
    modelOptions: [],
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
    credentials: [
      {
        // A `ksk_` key from app.kiro.dev (Kiro Pro and above).
        env: 'KIRO_API_KEY',
        hosts: [
          'management.*.kiro.dev',
          'runtime.*.kiro.dev',
          'q.*.amazonaws.com',
          'codewhisperer.*.amazonaws.com',
        ],
      },
    ],
    supportHosts: [],
    env: {
      KIRO_NO_AUTO_UPDATE: '1',
      KIRO_DISABLE_TELEMETRY: '1',
      Q_DISABLE_TELEMETRY: '1',
    },
    requiresModel: false,
    modelOptions: [],
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
    credentials: PROVIDER_KEYS,
    // OpenCode reads its model catalog before every run.
    supportHosts: ['models.dev', 'models.opencode.ai'],
    env: {
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
      // Everything is allowed: the sandbox is the boundary.
      OPENCODE_PERMISSION: '{"edit":"allow","bash":"allow","webfetch":"allow"}',
    },
    requiresModel: true,
    modelOptions: [],
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
    credentials: PROVIDER_KEYS,
    supportHosts: [],
    env: {},
    requiresModel: true,
    modelOptions: [],
    buildArgs: model => {
      const [provider, ...rest] = (model ?? '').split('/');
      return [
        '--mode',
        'json',
        '-p',
        '--no-session',
        ...(provider && rest.length > 0
          ? ['--provider', provider, '--model', rest.join('/')]
          : []),
      ];
    },
  },
};

/** Credential slots a run of this CLI and model can use, in order. */
export function workAgentCredentialSlots(
  cli: WorkAgentCliSpec,
  model: string | undefined
): readonly WorkAgentCredentialSlot[] {
  if (!cli.requiresModel) return cli.credentials;
  const family = workAgentModelFamily(model);
  return cli.credentials.filter(slot => slot.family === family);
}

/** Every distinct credential environment name the catalog knows. */
export function workAgentCredentialNames(): string[] {
  const names = new Set<string>();
  for (const id of WORK_AGENT_CLI_IDS) {
    for (const slot of WORK_AGENT_CLIS[id].credentials) names.add(slot.env);
  }
  return [...names];
}

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
