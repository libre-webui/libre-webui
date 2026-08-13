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

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ChatMessage } from '../types/index.js';
import { PluginStreamChunk } from '../utils/pluginStreaming.js';
import { userModel } from '../models/userModel.js';
import { createLogger } from '../utils/logger.js';
import { getAgentsEnabled } from './agentAccessService.js';
import pluginUsageService from './pluginUsageService.js';
import {
  ChatGenerationCancelledError,
  throwIfChatGenerationCancelled,
} from '../utils/chatCancellation.js';

const logger = createLogger('agent-cli');

export interface AgentCliModelOption {
  /** Model identifier passed to the CLI; selector id is "<cliId>:<id>". */
  id: string;
  /** Human-readable label shown next to the CLI name. */
  label: string;
}

export interface AgentCliDefinition {
  /** Stable id used as providerId, e.g. "claude-code". */
  id: string;
  /** Human-readable name shown in the model selector. */
  name: string;
  /** Binary looked up on PATH. */
  command: string;
  parser: 'claude' | 'codex' | 'opencode' | 'pi';
  buildArgs: (model?: string) => string[];
  /** Fixed model choices offered beside the CLI-default entry. */
  modelOptions?: AgentCliModelOption[];
  /** Discover model choices from the installed CLI; results are cached. */
  discoverModels?: (binaryPath: string) => Promise<AgentCliModelOption[]>;
  /**
   * Omit the CLI-default entry: running this CLI without an explicit model
   * depends on local user configuration that may be broken or absent.
   */
  requiresModel?: boolean;
}

export interface AgentCliModel {
  id: string;
  name: string;
  command: string;
  binaryPath: string;
  /** CLI id — used as the chat providerId for every entry of this CLI. */
  agentId: string;
}

const NEUTRAL_SYSTEM_PROMPT =
  'You are a helpful assistant replying in a chat conversation.';

export const AGENT_CLI_DEFINITIONS: AgentCliDefinition[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    parser: 'claude',
    // -p reads the prompt from stdin; stream-json gives line-delimited events.
    buildArgs: model => [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      ...(model ? ['--model', model] : []),
    ],
    modelOptions: [
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'opus', label: 'Opus' },
      { id: 'haiku', label: 'Haiku' },
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    parser: 'codex',
    buildArgs: model => [
      'exec',
      '--json',
      '--skip-git-repo-check',
      ...(model ? ['-m', model] : []),
      '-',
    ],
    // The ChatGPT sign-in family from developers.openai.com/codex/models.
    modelOptions: [
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
      { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    parser: 'opencode',
    // The prompt arrives on stdin (read to EOF). A model is required because
    // the CLI-default can point at an unreachable local server and hang until
    // our timeout.
    requiresModel: true,
    buildArgs: model => [
      'run',
      '--format',
      'json',
      ...(model ? ['-m', model] : []),
    ],
    discoverModels: binaryPath => discoverOpencodeModels(binaryPath),
  },
  {
    id: 'pi',
    name: 'Pi',
    command: 'pi',
    parser: 'pi',
    // --no-session keeps chats out of the server user's pi session store and
    // the neutral system prompt overrides any personal persona configured for
    // the server user's own pi usage.
    buildArgs: model => [
      '-p',
      '--mode',
      'json',
      '--no-session',
      '--no-tools',
      '--system-prompt',
      NEUTRAL_SYSTEM_PROMPT,
      ...(model ? ['--model', model] : []),
    ],
  },
];

const AGENT_TIMEOUT_MS = Math.max(
  30_000,
  parseInt(process.env.AGENT_CLI_TIMEOUT_MS || '600000', 10) || 600_000
);
const MAX_OUTPUT_CHARS = 2_000_000;
const MAX_STDERR_CHARS = 8_000;
const MAX_CONTEXT_MESSAGES = 30;

const agentsEnabled = (): boolean => getAgentsEnabled();

function resolveBinary(command: string): string | null {
  const pathValue = process.env.PATH || '';
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep scanning
    }
  }
  return null;
}

const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
const MODEL_DISCOVERY_TTL_MS = 5 * 60_000;
const MAX_DISCOVERED_MODELS = 40;
const discoveryCache = new Map<
  string,
  { at: number; options: AgentCliModelOption[] }
>();

/** `opencode models` prints one provider/model id per line. */
async function discoverOpencodeModels(
  binaryPath: string
): Promise<AgentCliModelOption[]> {
  const cached = discoveryCache.get(binaryPath);
  if (cached && Date.now() - cached.at < MODEL_DISCOVERY_TTL_MS) {
    return cached.options;
  }
  const options = await new Promise<AgentCliModelOption[]>(resolve => {
    const child = spawn(binaryPath, ['models'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve([]);
    }, MODEL_DISCOVERY_TIMEOUT_MS);
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
      if (output.length > 100_000) child.kill('SIGKILL');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(
        output
          .split('\n')
          .map(line => line.trim())
          .filter(line => /^[\w.-]+\/[\w./:@-]+$/.test(line))
          .slice(0, MAX_DISCOVERED_MODELS)
          .map(id => ({ id, label: id }))
      );
    });
  });
  discoveryCache.set(binaryPath, { at: Date.now(), options });
  return options;
}

function roleLabel(role: ChatMessage['role']): string {
  if (role === 'assistant') return 'Assistant';
  if (role === 'system') return 'System';
  return 'User';
}

export function buildAgentPrompt(messages: readonly ChatMessage[]): string {
  const context = messages.slice(-MAX_CONTEXT_MESSAGES);
  const transcript = context
    .map(message => `${roleLabel(message.role)}: ${message.content}`)
    .join('\n\n');

  return [
    'You are the assistant in an ongoing chat conversation. The conversation so far:',
    '',
    transcript,
    '',
    'Reply to the last user message. Respond with the reply text only — no role prefix.',
  ].join('\n');
}

/** Simple push-based async queue bridging child-process events to a generator. */
class ChunkQueue {
  private chunks: PluginStreamChunk[] = [];
  private waiters: Array<() => void> = [];
  private finished = false;
  private failure: Error | null = null;

  push(chunk: PluginStreamChunk) {
    if (this.finished) return;
    this.chunks.push(chunk);
    this.wake();
  }

  finish(error?: Error) {
    if (this.finished) return;
    this.finished = true;
    this.failure = error ?? null;
    this.wake();
  }

  private wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  async *drain(): AsyncGenerator<PluginStreamChunk, void, unknown> {
    for (;;) {
      while (this.chunks.length > 0) {
        yield this.chunks.shift() as PluginStreamChunk;
      }
      if (this.finished) {
        if (this.failure) throw this.failure;
        return;
      }
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
  }
}

export interface AgentParserSink {
  push(chunk: PluginStreamChunk): void;
}

export interface ParserState {
  emittedContent: boolean;
  agentSessionId?: string;
  itemErrors: string[];
  /** Per-part emitted text length for parsers that stream snapshots. */
  partTextLengths: Record<string, number>;
}

export function parseClaudeLine(
  line: string,
  queue: AgentParserSink,
  state: ParserState
): void {
  const event = JSON.parse(line) as Record<string, unknown>;
  if (event.type === 'system' && event.subtype === 'init') {
    if (typeof event.session_id === 'string') {
      state.agentSessionId = event.session_id;
    }
    return;
  }
  if (event.type === 'stream_event') {
    const inner = event.event as
      | {
          type?: string;
          delta?: { type?: string; text?: string; thinking?: string };
        }
      | undefined;
    if (inner?.type === 'content_block_delta') {
      if (inner.delta?.type === 'text_delta' && inner.delta.text) {
        state.emittedContent = true;
        queue.push({ type: 'content', content: inner.delta.text });
      } else if (
        inner.delta?.type === 'thinking_delta' &&
        inner.delta.thinking
      ) {
        queue.push({ type: 'reasoning', content: inner.delta.thinking });
      }
    }
    return;
  }
  if (event.type === 'result') {
    if (event.is_error) {
      const detail =
        typeof event.result === 'string' ? event.result : 'agent error';
      throw new Error(`Claude Code failed: ${detail}`);
    }
    // Older CLIs without partial events still return the final text here.
    if (!state.emittedContent && typeof event.result === 'string') {
      state.emittedContent = true;
      queue.push({ type: 'content', content: event.result });
    }
  }
}

export function parseCodexLine(
  line: string,
  queue: AgentParserSink,
  state: ParserState
): void {
  const event = JSON.parse(line) as Record<string, unknown>;
  if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
    state.agentSessionId = event.thread_id;
    return;
  }
  if (event.type === 'item.completed') {
    const item = event.item as
      { type?: string; text?: string; message?: string } | undefined;
    if (item?.type === 'agent_message' && item.text) {
      state.emittedContent = true;
      queue.push({ type: 'content', content: item.text });
    } else if (item?.type === 'reasoning' && item.text) {
      queue.push({ type: 'reasoning', content: item.text });
    } else if (item?.type === 'error' && (item.message || item.text)) {
      // Codex reports non-fatal warnings as error items; only surface them if
      // the run produces no answer at all.
      state.itemErrors.push(item.message || item.text || 'unknown error');
    }
    return;
  }
  if (event.type === 'turn.failed') {
    const error = event.error as { message?: string } | undefined;
    throw new Error(`Codex failed: ${error?.message || 'turn failed'}`);
  }
}

export function parseOpencodeLine(
  line: string,
  queue: AgentParserSink,
  state: ParserState
): void {
  const event = JSON.parse(line) as Record<string, unknown>;
  if (typeof event.sessionID === 'string' && !state.agentSessionId) {
    state.agentSessionId = event.sessionID;
  }
  if (event.type === 'error') {
    const error = event.error as
      { name?: string; data?: { message?: string } } | undefined;
    state.itemErrors.push(
      error?.data?.message || error?.name || 'opencode error'
    );
    return;
  }
  const part = event.part as
    | { id?: string; type?: string; text?: string; ignored?: boolean }
    | undefined;
  if (!part || typeof part.type !== 'string' || part.ignored) return;

  // v1.16 emits each text/reasoning part once, complete, when it finishes —
  // there is no delta stream. The part-id guard dedupes defensively.
  if (
    (part.type === 'text' || part.type === 'reasoning') &&
    typeof part.text === 'string' &&
    part.text
  ) {
    const key = `${part.type}:${part.id || 'default'}`;
    if (state.partTextLengths[key]) return;
    state.partTextLengths[key] = part.text.length;
    if (part.type === 'text') {
      state.emittedContent = true;
      queue.push({ type: 'content', content: part.text });
    } else {
      queue.push({ type: 'reasoning', content: part.text });
    }
  }
}

export function parsePiLine(
  line: string,
  queue: AgentParserSink,
  state: ParserState
): void {
  const event = JSON.parse(line) as Record<string, unknown>;
  if (event.type === 'session' && typeof event.id === 'string') {
    state.agentSessionId = event.id;
    return;
  }
  if (event.type === 'message_update') {
    const inner = event.assistantMessageEvent as
      { type?: string; delta?: string } | undefined;
    if (inner?.type === 'text_delta' && inner.delta) {
      state.emittedContent = true;
      queue.push({ type: 'content', content: inner.delta });
    } else if (inner?.type === 'thinking_delta' && inner.delta) {
      queue.push({ type: 'reasoning', content: inner.delta });
    }
    return;
  }
  if (event.type === 'turn_end' && !state.emittedContent) {
    const message = event.message as
      | { role?: string; content?: Array<{ type?: string; text?: string }> }
      | undefined;
    if (message?.role === 'assistant') {
      const text = (message.content || [])
        .filter(item => item.type === 'text' && item.text)
        .map(item => item.text)
        .join('');
      if (text) {
        state.emittedContent = true;
        queue.push({ type: 'content', content: text });
      }
    }
    return;
  }
  if (event.type === 'error') {
    const detail =
      typeof event.message === 'string' ? event.message : 'agent error';
    state.itemErrors.push(detail);
  }
}

export class AgentCliService {
  async listAgentModels(): Promise<AgentCliModel[]> {
    if (!agentsEnabled()) return [];
    const models: AgentCliModel[] = [];
    for (const definition of AGENT_CLI_DEFINITIONS) {
      const binaryPath = resolveBinary(definition.command);
      if (!binaryPath) continue;

      if (!definition.requiresModel) {
        models.push({
          id: definition.id,
          name: definition.name,
          command: definition.command,
          binaryPath,
          agentId: definition.id,
        });
      }

      let options = definition.modelOptions ?? [];
      if (definition.discoverModels) {
        try {
          const discovered = await definition.discoverModels(binaryPath);
          if (discovered.length > 0) options = discovered;
        } catch (error) {
          logger.warn(
            `Model discovery failed for ${definition.command}:`,
            error
          );
        }
      }
      for (const option of options) {
        models.push({
          id: `${definition.id}:${option.id}`,
          name: `${definition.name} · ${option.label}`,
          command: definition.command,
          binaryPath,
          agentId: definition.id,
        });
      }
    }
    return models;
  }

  async isAdminUser(userId: string): Promise<boolean> {
    const user = await userModel.getUserById(userId);
    return user?.role === 'admin';
  }

  async assertAgentAccess(userId: string): Promise<AgentCliDefinition[]> {
    if (!agentsEnabled()) {
      throw new Error('Agent CLI models are disabled on this server.');
    }
    if (!(await this.isAdminUser(userId))) {
      throw new Error('Agent CLI models require an admin account.');
    }
    return AGENT_CLI_DEFINITIONS;
  }

  async *executeAgentStreamRequest(
    agentId: string,
    messages: readonly ChatMessage[],
    userId: string,
    options: { cwd?: string; model?: string; signal?: AbortSignal } = {}
  ): AsyncGenerator<PluginStreamChunk, void, unknown> {
    throwIfChatGenerationCancelled(options.signal);
    await this.assertAgentAccess(userId);
    const definition = AGENT_CLI_DEFINITIONS.find(
      candidate => candidate.id === agentId
    );
    if (!definition) {
      throw new Error(`Unknown agent CLI "${agentId}".`);
    }
    const binaryPath = resolveBinary(definition.command);
    if (!binaryPath) {
      throw new Error(
        `The "${definition.command}" CLI is not installed on this server.`
      );
    }

    // Selector entries are "<cliId>" (CLI default) or "<cliId>:<model>".
    const model =
      options.model && options.model.startsWith(`${definition.id}:`)
        ? options.model.slice(definition.id.length + 1)
        : undefined;
    if (definition.requiresModel && !model) {
      throw new Error(
        `${definition.name} needs an explicit model — pick one from the Agents group.`
      );
    }

    const cwd =
      options.cwd && fs.existsSync(options.cwd) ? options.cwd : os.homedir();
    const prompt = buildAgentPrompt(messages);
    const queue = new ChunkQueue();
    const state: ParserState = {
      emittedContent: false,
      itemErrors: [],
      partTextLengths: {},
    };
    const parseLine = {
      claude: parseClaudeLine,
      codex: parseCodexLine,
      opencode: parseOpencodeLine,
      pi: parsePiLine,
    }[definition.parser];

    logger.info(
      `Spawning agent CLI ${definition.id} (${binaryPath}) in ${cwd} for user ${userId}`
    );

    const child = spawn(binaryPath, definition.buildArgs(model), {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let totalChars = 0;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();

    const recordUsage = (status: 'success' | 'error' | 'cancelled') => {
      pluginUsageService.record({
        userId,
        pluginId: `agent-cli:${definition.id}`,
        pluginName: definition.name,
        capability: 'chat',
        model: options.model || definition.id,
        status,
        durationMs: Date.now() - startedAt,
      });
    };

    const timeout = setTimeout(() => {
      fail(new Error(`Agent CLI timed out after ${AGENT_TIMEOUT_MS}ms.`));
      child.kill('SIGKILL');
    }, AGENT_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener('abort', cancel);
    };

    const fail = (error: Error, status: 'error' | 'cancelled' = 'error') => {
      if (settled) return;
      settled = true;
      cleanup();
      recordUsage(status);
      queue.finish(error);
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      recordUsage('success');
      const metadata: Record<string, unknown> = { agentCli: definition.id };
      if (state.agentSessionId) {
        metadata.agentSessionId = state.agentSessionId;
      }
      queue.push({ type: 'done', providerMetadata: metadata });
      queue.finish();
    };

    const cancel = () => {
      const reason =
        options.signal?.reason instanceof Error
          ? options.signal.reason
          : new ChatGenerationCancelledError();
      fail(reason, 'cancelled');
      if (!child.killed) {
        child.kill('SIGTERM');
        forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
        forceKillTimer.unref?.();
      }
    };

    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      try {
        parseLine(trimmed, queue, state);
      } catch (error) {
        if (error instanceof SyntaxError) return; // partial/non-JSON line
        fail(error instanceof Error ? error : new Error(String(error)));
        child.kill('SIGKILL');
      }
    };

    child.stdout.on('data', (data: Buffer) => {
      totalChars += data.length;
      if (totalChars > MAX_OUTPUT_CHARS) {
        fail(new Error('Agent CLI output exceeded the size limit.'));
        child.kill('SIGKILL');
        return;
      }
      stdoutBuffer += data.toString();
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        handleLine(stdoutBuffer.slice(0, newlineIndex));
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      if (stderrBuffer.length < MAX_STDERR_CHARS) {
        stderrBuffer += data.toString().slice(0, MAX_STDERR_CHARS);
      }
    });

    child.on('error', error => {
      fail(
        new Error(`Failed to start ${definition.command}: ${error.message}`)
      );
    });

    child.on('close', code => {
      if (stdoutBuffer) handleLine(stdoutBuffer);
      if (settled) {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        return;
      }
      if (state.emittedContent) {
        succeed();
        return;
      }
      const detail =
        state.itemErrors[0] || stderrBuffer.trim() || `exit code ${code}`;
      fail(new Error(`${definition.name} produced no reply (${detail}).`));
    });

    child.stdin.on('error', () => {
      // The CLI may exit before consuming the prompt; close handles reporting.
    });
    if (!settled) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    yield* queue.drain();
  }
}

const agentCliService = new AgentCliService();
export default agentCliService;
