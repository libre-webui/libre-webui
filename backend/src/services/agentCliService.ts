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

const logger = createLogger('agent-cli');

export interface AgentCliDefinition {
  /** Stable id used as providerId and model name, e.g. "claude-code". */
  id: string;
  /** Human-readable name shown in the model selector. */
  name: string;
  /** Binary looked up on PATH. */
  command: string;
  parser: 'claude' | 'codex';
  buildArgs: () => string[];
}

export interface AgentCliModel {
  id: string;
  name: string;
  command: string;
  binaryPath: string;
}

const AGENT_CLI_DEFINITIONS: AgentCliDefinition[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    parser: 'claude',
    // -p reads the prompt from stdin; stream-json gives line-delimited events.
    buildArgs: () => [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    parser: 'codex',
    buildArgs: () => ['exec', '--json', '--skip-git-repo-check', '-'],
  },
];

const AGENT_TIMEOUT_MS = Math.max(
  30_000,
  parseInt(process.env.AGENT_CLI_TIMEOUT_MS || '600000', 10) || 600_000
);
const MAX_OUTPUT_CHARS = 2_000_000;
const MAX_STDERR_CHARS = 8_000;
const MAX_CONTEXT_MESSAGES = 30;

const agentsEnabled = (): boolean =>
  process.env.AGENT_CLI_MODELS_ENABLED !== 'false';

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

interface ParserState {
  emittedContent: boolean;
  agentSessionId?: string;
  itemErrors: string[];
}

function parseClaudeLine(
  line: string,
  queue: ChunkQueue,
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

function parseCodexLine(
  line: string,
  queue: ChunkQueue,
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

export class AgentCliService {
  listAgentModels(): AgentCliModel[] {
    if (!agentsEnabled()) return [];
    const models: AgentCliModel[] = [];
    for (const definition of AGENT_CLI_DEFINITIONS) {
      const binaryPath = resolveBinary(definition.command);
      if (binaryPath) {
        models.push({
          id: definition.id,
          name: definition.name,
          command: definition.command,
          binaryPath,
        });
      }
    }
    return models;
  }

  isAdminUser(userId: string): boolean {
    const user = userModel.getUserById(userId);
    return user?.role === 'admin';
  }

  assertAgentAccess(userId: string): AgentCliDefinition[] {
    if (!agentsEnabled()) {
      throw new Error('Agent CLI models are disabled on this server.');
    }
    if (!this.isAdminUser(userId)) {
      throw new Error('Agent CLI models require an admin account.');
    }
    return AGENT_CLI_DEFINITIONS;
  }

  executeAgentStreamRequest(
    agentId: string,
    messages: readonly ChatMessage[],
    userId: string,
    options: { cwd?: string } = {}
  ): AsyncGenerator<PluginStreamChunk, void, unknown> {
    this.assertAgentAccess(userId);
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

    const cwd =
      options.cwd && fs.existsSync(options.cwd) ? options.cwd : os.homedir();
    const prompt = buildAgentPrompt(messages);
    const queue = new ChunkQueue();
    const state: ParserState = { emittedContent: false, itemErrors: [] };
    const parseLine =
      definition.parser === 'claude' ? parseClaudeLine : parseCodexLine;

    logger.info(
      `Spawning agent CLI ${definition.id} (${binaryPath}) in ${cwd} for user ${userId}`
    );

    const child = spawn(binaryPath, definition.buildArgs(), {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let totalChars = 0;
    let settled = false;

    const timeout = setTimeout(() => {
      fail(new Error(`Agent CLI timed out after ${AGENT_TIMEOUT_MS}ms.`));
      child.kill('SIGKILL');
    }, AGENT_TIMEOUT_MS);

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      queue.finish(error);
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const metadata: Record<string, unknown> = { agentCli: definition.id };
      if (state.agentSessionId) {
        metadata.agentSessionId = state.agentSessionId;
      }
      queue.push({ type: 'done', providerMetadata: metadata });
      queue.finish();
    };

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
      if (settled) return;
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
    child.stdin.write(prompt);
    child.stdin.end();

    return queue.drain();
  }
}

const agentCliService = new AgentCliService();
export default agentCliService;
