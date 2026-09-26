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
 * The Strands agent engine behind /api/strands and the Chat agent model.
 *
 * Each engine session is a Strands harness agent with a private, jailed
 * workspace, the read/write/edit file tools, and the todos planner. The
 * harness defaults that reach past the account (shell, web access, host
 * AGENTS.md injection, cwd-relative memory and skills, console printing) are
 * all switched off. Strands keeps its own snapshot for model context; this
 * module keeps a display transcript and a small registry per account.
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Agent, MessageData } from '@strands-agents/sdk';
import { resolveDataDirectory } from '../utils/dataDirectory.js';
import { createLogger } from '../utils/logger.js';
import type { ChatMessage } from '../types/index.js';
import { resolveStrandsRoute, type ResolvedStrandsRoute } from './catalog.js';
import { LibreWebUiModel } from './model.js';
import { STRANDS_WORKSPACE_ROOT, WorkspaceSandbox } from './sandbox.js';
import { loadHarness } from './harness.js';

const logger = createLogger('strands-engine');

export const STRANDS_MAX_TURNS = 24;
export const STRANDS_MAX_SESSIONS_PER_USER = 200;
export const STRANDS_MAX_PROMPT_CHARS = 32_000;
const MAX_TOOL_OUTPUT_CHARS = 4_000;
const MAX_CACHED_AGENTS = 16;
const AGENT_IDLE_MS = 15 * 60 * 1000;

export const STRANDS_INSTRUCTIONS = `You are the Strands agent inside Libre WebUI.
You have a private workspace at ${STRANDS_WORKSPACE_ROOT}. File tools take absolute paths under ${STRANDS_WORKSPACE_ROOT}; nothing outside it exists for you.
You cannot run shell commands or reach the network. Plan multi-step work with the todo tool, keep answers concise, and say plainly when something is outside what you can do.`;

export type StrandsTurnEvent =
  | { type: 'turn-start'; sessionId: string; messageId: string }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-start'; toolUseId: string; name: string; input: unknown }
  | {
      type: 'tool-result';
      toolUseId: string;
      status: 'success' | 'error';
      output: string;
    }
  | {
      type: 'done';
      stopReason: string;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { type: 'error'; message: string };

export interface StrandsToolTrace {
  id: string;
  name: string;
  input: unknown;
  status?: 'success' | 'error';
  output?: string;
}

export interface StrandsTranscriptEntry {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  tools?: StrandsToolTrace[];
  stopReason?: string;
  error?: string;
  createdAt: number;
}

export interface StrandsSessionSummary {
  id: string;
  title: string;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export class StrandsEngineError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = 'StrandsEngineError';
  }
}

function userKey(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 32);
}

export function strandsDataDirectory(): string {
  return path.join(process.env.DATA_DIR || resolveDataDirectory(), 'strands');
}

function userDirectory(userId: string): string {
  return path.join(strandsDataDirectory(), 'users', userKey(userId));
}

function isSessionId(value: string): boolean {
  return /^[a-f0-9-]{36}$/.test(value);
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n[truncated]` : value;
}

function toolResultText(result: {
  content: ReadonlyArray<{ type: string; text?: string; json?: unknown }>;
}): string {
  return truncate(
    result.content
      .map(item =>
        item.type === 'textBlock'
          ? (item.text ?? '')
          : item.type === 'jsonBlock'
            ? JSON.stringify(item.json)
            : `[${item.type}]`
      )
      .join('\n'),
    MAX_TOOL_OUTPUT_CHARS
  );
}

interface AgentOptions {
  userId: string;
  target: ResolvedStrandsRoute;
  workspace: string;
  session?: { id: string; dir: string };
  messages?: MessageData[];
  instructions?: string;
}

/** Build a harness agent with Libre WebUI's locked-down defaults. */
export async function createStrandsAgent(
  options: AgentOptions
): Promise<Agent> {
  const { createHarness } = await loadHarness();
  return createHarness({
    model: new LibreWebUiModel(options.target, options.userId),
    instructions: options.instructions ?? STRANDS_INSTRUCTIONS,
    builtinTools: ['read', 'write', 'edit'],
    builtinPlugins: ['todos'],
    backgroundTasks: false,
    caching: false,
    skills: null,
    memory: null,
    printer: false,
    sandbox: new WorkspaceSandbox(options.workspace),
    ...(options.session
      ? { session: options.session }
      : { session: null, contextManager: null }),
    ...(options.messages?.length ? { messages: options.messages } : {}),
  });
}

/**
 * Run one agent invocation and translate the Strands stream into the
 * engine's event vocabulary. Returns the stop reason.
 */
export async function* streamAgentTurn(
  agent: Agent,
  prompt: string,
  signal?: AbortSignal
): AsyncGenerator<StrandsTurnEvent, void, undefined> {
  const stream = agent.stream(prompt, {
    ...(signal ? { cancelSignal: signal } : {}),
    limits: { turns: STRANDS_MAX_TURNS },
  });
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;
  for (;;) {
    const next = await stream.next();
    if (next.done) {
      yield {
        type: 'done',
        stopReason: String(next.value?.stopReason ?? 'endTurn'),
        ...(sawUsage ? { usage: { inputTokens, outputTokens } } : {}),
      };
      return;
    }
    const event = next.value;
    if (event.type === 'modelStreamUpdateEvent') {
      const inner = event.event;
      if (inner.type === 'modelContentBlockDeltaEvent') {
        if (inner.delta.type === 'textDelta' && inner.delta.text) {
          yield { type: 'text', text: inner.delta.text };
        } else if (
          inner.delta.type === 'reasoningContentDelta' &&
          inner.delta.text
        ) {
          yield { type: 'reasoning', text: inner.delta.text };
        }
      } else if (inner.type === 'modelMetadataEvent' && inner.usage) {
        sawUsage = true;
        inputTokens += inner.usage.inputTokens ?? 0;
        outputTokens += inner.usage.outputTokens ?? 0;
      }
    } else if (event.type === 'contentBlockEvent') {
      const block = event.contentBlock;
      if (block.type === 'toolUseBlock') {
        yield {
          type: 'tool-start',
          toolUseId: block.toolUseId,
          name: block.name,
          input: block.input,
        };
      }
    } else if (event.type === 'toolResultEvent') {
      yield {
        type: 'tool-result',
        toolUseId: event.result.toolUseId,
        status: event.result.status,
        output: toolResultText(event.result),
      };
    }
  }
}

/** Fold engine events into a transcript entry as they stream. */
export function applyTurnEvent(
  entry: StrandsTranscriptEntry,
  event: StrandsTurnEvent
): void {
  if (event.type === 'text') entry.content += event.text;
  else if (event.type === 'reasoning') {
    entry.thinking = (entry.thinking ?? '') + event.text;
  } else if (event.type === 'tool-start') {
    (entry.tools ??= []).push({
      id: event.toolUseId,
      name: event.name,
      input: event.input,
    });
  } else if (event.type === 'tool-result') {
    const trace = entry.tools?.find(tool => tool.id === event.toolUseId);
    if (trace) {
      trace.status = event.status;
      trace.output = event.output;
    }
  } else if (event.type === 'done') entry.stopReason = event.stopReason;
  else if (event.type === 'error') entry.error = event.message;
}

interface Registry {
  sessions: StrandsSessionSummary[];
}

interface CachedAgent {
  agent: Agent;
  modelId: string;
  lastUsed: number;
}

export class StrandsEngine {
  private readonly agents = new Map<string, CachedAgent>();
  private readonly active = new Map<string, AbortController>();
  private readonly locks = new Map<string, Promise<unknown>>();

  /** Serialize registry writes per account. */
  private async withUserLock<T>(userId: string, work: () => Promise<T>) {
    const key = userKey(userId);
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    this.locks.set(
      key,
      run.finally(() => {
        if (this.locks.get(key) === run) this.locks.delete(key);
      })
    );
    return run;
  }

  private registryFile(userId: string) {
    return path.join(userDirectory(userId), 'registry.json');
  }

  private transcriptFile(userId: string, sessionId: string) {
    return path.join(userDirectory(userId), 'transcripts', `${sessionId}.json`);
  }

  private workspaceDirectory(userId: string, sessionId: string) {
    return path.join(userDirectory(userId), 'workspaces', sessionId);
  }

  private snapshotDirectory(userId: string) {
    return path.join(userDirectory(userId), 'sessions');
  }

  private async registry(userId: string): Promise<Registry> {
    const registry = await readJson<Registry>(this.registryFile(userId), {
      sessions: [],
    });
    return Array.isArray(registry.sessions) ? registry : { sessions: [] };
  }

  async listSessions(userId: string): Promise<StrandsSessionSummary[]> {
    return [...(await this.registry(userId)).sessions].sort(
      (a, b) => b.updatedAt - a.updatedAt
    );
  }

  async getSession(
    userId: string,
    sessionId: string
  ): Promise<StrandsSessionSummary> {
    if (!isSessionId(sessionId)) {
      throw new StrandsEngineError('Strands session not found.', 404);
    }
    const session = (await this.registry(userId)).sessions.find(
      candidate => candidate.id === sessionId
    );
    if (!session)
      throw new StrandsEngineError('Strands session not found.', 404);
    return session;
  }

  async createSession(
    userId: string,
    input: { title?: string; model?: string | null } = {}
  ): Promise<StrandsSessionSummary> {
    const model = input.model?.trim() || null;
    if (model) await resolveStrandsRoute(model, userId);
    return this.withUserLock(userId, async () => {
      const registry = await this.registry(userId);
      if (registry.sessions.length >= STRANDS_MAX_SESSIONS_PER_USER) {
        throw new StrandsEngineError(
          'Delete an old Strands session before creating another.',
          409
        );
      }
      const now = Date.now();
      const session: StrandsSessionSummary = {
        id: randomUUID(),
        title: input.title?.trim().slice(0, 120) || 'New session',
        model,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
      };
      registry.sessions.push(session);
      await writeJsonAtomic(this.registryFile(userId), registry);
      return session;
    });
  }

  async updateSession(
    userId: string,
    sessionId: string,
    input: { title?: string; model?: string | null }
  ): Promise<StrandsSessionSummary> {
    await this.getSession(userId, sessionId);
    if (input.model) await resolveStrandsRoute(input.model, userId);
    return this.withUserLock(userId, async () => {
      const registry = await this.registry(userId);
      const session = registry.sessions.find(item => item.id === sessionId);
      if (!session) {
        throw new StrandsEngineError('Strands session not found.', 404);
      }
      if (typeof input.title === 'string' && input.title.trim()) {
        session.title = input.title.trim().slice(0, 120);
      }
      if (input.model !== undefined)
        session.model = input.model?.trim() || null;
      session.updatedAt = Date.now();
      await writeJsonAtomic(this.registryFile(userId), registry);
      return session;
    });
  }

  async deleteSession(userId: string, sessionId: string): Promise<void> {
    await this.getSession(userId, sessionId);
    const key = `${userKey(userId)}:${sessionId}`;
    this.active.get(key)?.abort(new Error('Session deleted'));
    this.agents.delete(key);
    await this.withUserLock(userId, async () => {
      const registry = await this.registry(userId);
      registry.sessions = registry.sessions.filter(
        item => item.id !== sessionId
      );
      await writeJsonAtomic(this.registryFile(userId), registry);
    });
    await Promise.all([
      fs.rm(this.transcriptFile(userId, sessionId), { force: true }),
      fs.rm(this.workspaceDirectory(userId, sessionId), {
        recursive: true,
        force: true,
      }),
      fs.rm(path.join(this.snapshotDirectory(userId), sessionId), {
        recursive: true,
        force: true,
      }),
    ]);
  }

  async transcript(
    userId: string,
    sessionId: string
  ): Promise<StrandsTranscriptEntry[]> {
    await this.getSession(userId, sessionId);
    return readJson<StrandsTranscriptEntry[]>(
      this.transcriptFile(userId, sessionId),
      []
    );
  }

  isRunning(userId: string, sessionId: string): boolean {
    return this.active.has(`${userKey(userId)}:${sessionId}`);
  }

  cancel(userId: string, sessionId: string): boolean {
    const controller = this.active.get(`${userKey(userId)}:${sessionId}`);
    if (!controller) return false;
    controller.abort(new Error('Cancelled'));
    return true;
  }

  private evictIdle(now = Date.now()) {
    for (const [key, cached] of this.agents) {
      if (this.active.has(key)) continue;
      if (
        now - cached.lastUsed > AGENT_IDLE_MS ||
        this.agents.size > MAX_CACHED_AGENTS
      ) {
        this.agents.delete(key);
      }
    }
  }

  private async sessionAgent(
    userId: string,
    session: StrandsSessionSummary
  ): Promise<Agent> {
    const key = `${userKey(userId)}:${session.id}`;
    const target = await resolveStrandsRoute(
      session.model ?? undefined,
      userId
    );
    const cached = this.agents.get(key);
    if (cached && cached.modelId === target.id) {
      cached.lastUsed = Date.now();
      return cached.agent;
    }
    const agent = await createStrandsAgent({
      userId,
      target,
      workspace: this.workspaceDirectory(userId, session.id),
      session: { id: session.id, dir: this.snapshotDirectory(userId) },
    });
    this.agents.set(key, { agent, modelId: target.id, lastUsed: Date.now() });
    this.evictIdle();
    return agent;
  }

  /** Send one message to a session and stream the turn. */
  async *sendMessage(
    userId: string,
    sessionId: string,
    text: string,
    signal?: AbortSignal
  ): AsyncGenerator<StrandsTurnEvent, void, undefined> {
    const prompt = text.trim();
    if (!prompt) throw new StrandsEngineError('A message is required.');
    if (prompt.length > STRANDS_MAX_PROMPT_CHARS) {
      throw new StrandsEngineError('The message is too long.', 413);
    }
    const session = await this.getSession(userId, sessionId);
    const key = `${userKey(userId)}:${sessionId}`;
    if (this.active.has(key)) {
      throw new StrandsEngineError(
        'This session is already running a turn.',
        409
      );
    }
    const controller = new AbortController();
    this.active.set(key, controller);
    const turnSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const transcript = await readJson<StrandsTranscriptEntry[]>(
      this.transcriptFile(userId, sessionId),
      []
    );
    const now = Date.now();
    transcript.push({
      id: randomUUID(),
      role: 'user',
      content: prompt,
      createdAt: now,
    });
    const reply: StrandsTranscriptEntry = {
      id: randomUUID(),
      role: 'assistant',
      content: '',
      createdAt: now,
    };
    try {
      yield { type: 'turn-start', sessionId, messageId: reply.id };
      const agent = await this.sessionAgent(userId, session);
      for await (const event of streamAgentTurn(agent, prompt, turnSignal)) {
        applyTurnEvent(reply, event);
        yield event;
      }
    } catch (error) {
      const message = turnSignal.aborted
        ? 'The turn was cancelled.'
        : error instanceof Error
          ? error.message
          : String(error);
      if (!turnSignal.aborted) {
        logger.warn('Strands turn failed', { error });
      }
      // A failed invocation can leave the agent mid-turn; rebuild it from
      // the persisted snapshot on the next message.
      this.agents.delete(key);
      const event: StrandsTurnEvent = turnSignal.aborted
        ? { type: 'done', stopReason: 'cancelled' }
        : { type: 'error', message };
      applyTurnEvent(reply, event);
      yield event;
    } finally {
      this.active.delete(key);
      transcript.push(reply);
      await writeJsonAtomic(this.transcriptFile(userId, sessionId), transcript);
      await this.withUserLock(userId, async () => {
        const registry = await this.registry(userId);
        const entry = registry.sessions.find(item => item.id === sessionId);
        if (!entry) return;
        entry.updatedAt = Date.now();
        entry.messageCount = transcript.length;
        if (entry.title === 'New session') {
          entry.title = prompt.replace(/\s+/g, ' ').slice(0, 80);
        }
        await writeJsonAtomic(this.registryFile(userId), registry);
      }).catch(error =>
        logger.warn('Could not update Strands registry', error)
      );
    }
  }

  /**
   * One Chat turn. Chat owns its transcript, so the agent is rebuilt from it
   * each time with no snapshot, and files land in a per-account scratch
   * workspace.
   */
  async *chatTurn(
    userId: string,
    messages: readonly ChatMessage[],
    options: { model?: string; signal?: AbortSignal } = {}
  ): AsyncGenerator<StrandsTurnEvent, void, undefined> {
    const target = await resolveStrandsRoute(options.model, userId);
    const system = messages
      .filter(message => message.role === 'system' && message.content.trim())
      .map(message => message.content.trim());
    const turns = messages.filter(
      message =>
        (message.role === 'user' || message.role === 'assistant') &&
        message.content.trim()
    );
    const last = turns[turns.length - 1];
    if (!last || last.role !== 'user') {
      throw new StrandsEngineError('A user message is required.');
    }
    const history: MessageData[] = [];
    for (const message of turns.slice(0, -1)) {
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      // Strands expects alternating roles; merge consecutive messages.
      const previous = history[history.length - 1];
      if (previous && previous.role === role) {
        previous.content.push({ text: `\n\n${message.content}` });
      } else {
        history.push({ role, content: [{ text: message.content }] });
      }
    }
    if (history[history.length - 1]?.role === 'user') {
      history.push({ role: 'assistant', content: [{ text: '(no reply)' }] });
    }
    const agent = await createStrandsAgent({
      userId,
      target,
      workspace: path.join(userDirectory(userId), 'chat-workspace'),
      messages: history,
      instructions: [STRANDS_INSTRUCTIONS, ...system].join('\n\n'),
    });
    yield* streamAgentTurn(agent, last.content, options.signal);
  }

  async stop(): Promise<void> {
    for (const controller of this.active.values()) {
      controller.abort(new Error('Server shutting down'));
    }
    this.active.clear();
    this.agents.clear();
  }
}

export const strandsEngine = new StrandsEngine();
