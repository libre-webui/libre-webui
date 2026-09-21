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
 * The DSH engine bridge: a Cordis plugin that turns a mounted DSH composition
 * into the `libreDshEngine` contract.
 *
 * This is the only Libre WebUI module that names concrete `@deepseek-ai/dsh-*`
 * packages, and it does so for types alone. Everything it publishes is defined
 * in `cordis/contracts.ts`, so routes, the WebSocket bridge, and the frontend
 * client never learn that DSH exists.
 *
 * The plugin is mounted as a Loader row, which means Cordis owns it. Its
 * dependency injector, its `session/event` subscription, every agent handle it
 * creates, and the service it publishes all belong to that row's fiber.
 * Removing the row disposes the fiber, and all of it goes away together — that
 * single ownership edge is the rollback guarantee.
 *
 * @module cordis/dsh/engine-plugin
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { Session } from '@deepseek-ai/dsh-session';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import type { SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import { deleteJsonlSession } from './session-files.js';
import { installWorkspaceToolPolicy } from './workspace-policy.js';
import { appendSessionSettings, sessionSettings } from './session-settings.js';
import { isProviderModelIdentity } from './model-identity.js';
import {
  installModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent';
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
import { Service, type Context } from '@deepseek-ai/cordis';
import type {
  DshEngine,
  EngineAgentSummary,
  EngineSessionSettings,
  EngineApproval,
  EngineApprovalOutcome,
  EngineCreateSessionOptions,
  EngineMessage,
  EngineMessageRole,
  EngineServiceStatus,
  EngineSession,
  EngineSessionSummary,
  EngineStreamChunk,
  EngineStreamHandle,
  EngineToolSummary,
} from '../contracts.js';
import { DSH_ENGINE_SERVICE } from '../contracts.js';
import { createLogger } from '../../utils/logger.js';
import { resolveDataDirectory } from '../../utils/dataDirectory.js';

const logger = createLogger('cordis-dsh-engine');

/** Plugin name reported to Cordis diagnostics. */
export const name = 'libre-webui-dsh-engine';

/**
 * Services this plugin waits for.
 *
 * Declaring them is what makes the bridge start only once the engine is
 * usable, and — just as importantly — refuse to start at all when the engine
 * is absent. A bridge that published itself against a missing engine would
 * turn a configuration mistake into silently empty session lists.
 */
export const inject = ['sessions', 'agents', 'tools', 'llm'] as const;

/** Configuration accepted by the bridge row. */
export interface Config {
  /** Absolute directory used as the default workspace for new sessions. */
  readonly workspacePath?: string;
  /** Whether `sendMessage` may start model work. */
  readonly streaming?: boolean;
  /** Whether the registry may be listed. */
  readonly tools?: boolean;
  /** Exact local store whose session artifacts may be deleted. */
  readonly sessionStorePath?: string;
  /** Provider route pinned on agents this bridge creates. */
  readonly defaultProvider?: string;
  /** Model pinned on agents this bridge creates. */
  readonly defaultModel?: string;
}

/** The subset of a DSH session this bridge reads. */
interface DshSessionLike {
  readonly id: string;
  readonly header?: { readonly createdAt?: number; readonly cwd?: string };
  readonly seq?: number;
  deriveMessages(): readonly unknown[];
}

/** The subset of a DSH agent this bridge reads. */
interface DshAgentLike {
  readonly id: string;
  readonly session?: Session;
  whenIdle?(): Promise<void>;
  followup?(input: UserMessage): void;
  cancel?(cause: { kind: 'user' }): void;
}

/** The subset of a DSH agent handle this bridge reads. */
interface DshAgentHandleLike {
  readonly agent: DshAgentLike;
  dispose(): Promise<void>;
}

/** The subset of the DSH session store this bridge reads. */
interface DshSessionsLike {
  list(): readonly DshSessionLike[];
  get(id: string): DshSessionLike | undefined;
}

/** The subset of the DSH agent registry this bridge reads. */
interface DshAgentsLike {
  list(): readonly DshAgentLike[];
  roots(): readonly DshAgentLike[];
  resume(options: {
    readonly resumeSessionId: string;
    readonly signal?: AbortSignal;
    readonly agentOptions?: Record<string, unknown>;
    readonly setup?: (ctx: Context, agent: DshAgentLike) => void;
  }): Promise<DshAgentHandleLike>;
  create(options: {
    readonly signal?: AbortSignal;
    readonly sessionId: string;
    readonly meta?: { readonly cwd?: string };
    readonly agentOptions?: Record<string, unknown>;
    readonly setup?: (ctx: Context, agent: DshAgentLike) => void;
  }): Promise<DshAgentHandleLike>;
}

/** The subset of the DSH tool runtime this bridge reads. */
interface DshToolsLike {
  schemas(scope?: unknown): readonly {
    readonly name?: string;
    readonly description?: string;
  }[];
}

/**
 * One in-flight response for a session.
 *
 * Chunks are buffered until a subscriber attaches, because the HTTP handler
 * must await this handle before it can write response headers — a model that
 * answers faster than the round trip would otherwise lose its opening tokens.
 */
export class ResponseStream implements EngineStreamHandle {
  private readonly buffer: EngineStreamChunk[] = [];
  private readonly listeners = new Set<(chunk: EngineStreamChunk) => void>();
  private closed = false;
  private terminated = false;
  private errorReported = false;
  private bufferBytes = 0;
  private static readonly MAX_BUFFER_BYTES = 2 * 1024 * 1024;
  private static readonly MAX_BUFFER_CHUNKS = 10000;

  constructor(
    readonly sessionId: string,
    private readonly onClose?: () => void,
    private readonly onDone?: () => void
  ) {}

  /** Deliver a chunk to the buffer, or straight to attached listeners. */
  push(chunk: EngineStreamChunk): void {
    if (this.terminated) return;
    const bytes = Buffer.byteLength(JSON.stringify(chunk));
    if (
      chunk.type !== 'error' &&
      chunk.type !== 'done' &&
      (this.bufferBytes + bytes > ResponseStream.MAX_BUFFER_BYTES ||
        this.buffer.length >= ResponseStream.MAX_BUFFER_CHUNKS)
    ) {
      this.onClose?.();
      this.buffer.length = 0;
      this.bufferBytes = 0;
      this.push({
        type: 'error',
        code: 'CORDIS_STREAM_LIMIT',
        message: 'The engine response exceeded the stream buffer limit.',
      });
      this.push({ type: 'done', reason: 'error' });
      return;
    }
    if (chunk.type === 'error') {
      if (this.errorReported) return;
      this.errorReported = true;
    }
    if (chunk.type === 'done') {
      this.terminated = true;
      this.onDone?.();
    }
    if (this.closed) return;
    // Recorded here rather than read back from the buffer: a chunk delivered to
    // a live listener is never buffered, so the terminal chunk would be
    // invisible to a later check and the session would look busy forever.
    this.buffer.push(chunk);
    this.bufferBytes += bytes;
    for (const listener of this.listeners) {
      try {
        listener(chunk);
      } catch (error) {
        // A misbehaving consumer must not abort the model stream for other
        // consumers, nor for the engine that is publishing it.
        logger.warn('stream listener threw', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (this.terminated) this.listeners.clear();
  }

  /**
   * Mark the response finished and release every listener.
   *
   * Also called when a client disconnects, so an abandoned response stops
   * buffering for a reader that is gone.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    if (!this.terminated) {
      this.buffer.length = 0;
      this.bufferBytes = 0;
      this.onClose?.();
    }
  }

  /** Whether the response has already terminated. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Chunks buffered but not yet delivered. */
  get pending(): number {
    return this.buffer.length;
  }

  subscribe(listener: (chunk: EngineStreamChunk) => void): {
    unsubscribe(): void;
  } {
    // Replay first, so a subscriber attaching after a fast model answer still
    // sees the complete response. The buffer is retained rather than drained:
    // a turn can reach `done` before the HTTP handler attaches, and discarding
    // the chunks would deliver an empty response for a turn that succeeded.
    for (const chunk of this.buffer) listener(chunk);
    if (this.closed || this.terminated) return { unsubscribe: () => undefined };
    this.listeners.add(listener);
    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** Whether this response has produced its terminal chunk. */
  get isTerminated(): boolean {
    return this.terminated;
  }
}

/** Extract readable text from one DSH message content value. */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (block === null || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    // Content blocks are a union of text, image, and tool shapes. Only text is
    // projectable into a chat transcript; the rest is deliberately dropped
    // rather than stringified into something misleading.
    if (record.type === 'text' && typeof record.text === 'string') {
      parts.push(record.text);
    } else if (record.type === 'tool-result') {
      parts.push(extractText(record.content));
    }
  }
  return parts.join('');
}

/** Normalize a DSH message role into the contract's role vocabulary. */
export function normalizeRole(role: unknown): EngineMessageRole {
  if (
    role === 'user' ||
    role === 'assistant' ||
    role === 'system' ||
    role === 'tool'
  ) {
    return role;
  }
  return 'unknown';
}

/** Project one DSH message into the contract's message shape. */
export function projectMessage(raw: unknown, index: number): EngineMessage {
  if (raw === null || typeof raw !== 'object') {
    return { id: `message-${index}`, role: 'unknown', text: '' };
  }
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : `message-${index}`;
  const source =
    record.source && typeof record.source === 'object'
      ? (record.source as Record<string, unknown>)
      : undefined;
  const reasoning = Array.isArray(record.content)
    ? record.content
        .filter(
          (block: unknown) =>
            block !== null &&
            typeof block === 'object' &&
            (block as Record<string, unknown>).type === 'reasoning'
        )
        .map((block: { text?: string }) => block.text ?? '')
        .join('')
    : '';
  const blocks = Array.isArray(record.content)
    ? record.content.filter(
        (block): block is Record<string, unknown> =>
          !!block && typeof block === 'object'
      )
    : [];
  const toolCalls = blocks
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      callId: typeof block.id === 'string' ? block.id : '',
      name: typeof block.name === 'string' ? block.name : '',
      arguments:
        typeof block.arguments === 'string'
          ? block.arguments
          : JSON.stringify(block.arguments ?? {}),
    }));
  const toolResults = blocks
    .filter(block => block.type === 'tool-result')
    .map(block => ({
      callId: typeof block.toolCallId === 'string' ? block.toolCallId : '',
      output: extractText(block.content),
      isError: block.isError === true,
    }));
  const messageSource: EngineMessage['source'] =
    record.role === 'system'
      ? 'system'
      : source?.kind === 'plugin'
        ? 'context'
        : source?.kind === 'tool'
          ? 'tool'
          : source?.kind === 'model' || record.role === 'assistant'
            ? 'model'
            : source?.kind === 'user' || record.role === 'user'
              ? 'user'
              : undefined;
  const seq = typeof record.seq === 'number' ? record.seq : undefined;
  return {
    id,
    role: source?.kind === 'tool' ? 'tool' : normalizeRole(record.role),
    text: extractText(record.content),
    ...(reasoning ? { reasoning } : {}),
    ...(messageSource ? { source: messageSource } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(toolResults.length ? { toolResults } : {}),
    ...(seq === undefined ? {} : { seq }),
  };
}

/**
 * Map one DSH session event onto a contract stream chunk.
 *
 * A durable session event is an envelope: `type` and `seq` sit beside a `data`
 * object that carries the payload for that type. Reading the payload off the
 * envelope instead of `data` yields no chunk at all rather than an error, so
 * each branch unwraps `data` explicitly.
 * @param event - the session event envelope.
 * @returns the projected chunk, or undefined for an event the transcript omits.
 */
export function projectStreamEvent(
  event: Record<string, unknown>
): EngineStreamChunk | undefined {
  const type = event.type;
  const data =
    event.data !== null &&
    typeof event.data === 'object' &&
    !Array.isArray(event.data)
      ? (event.data as Record<string, unknown>)
      : {};
  if (type === 'assistant/message') {
    const message = data.message;
    const text =
      message !== null && typeof message === 'object'
        ? extractText((message as Record<string, unknown>).content)
        : '';
    return text.length > 0 ? { type: 'text', text } : undefined;
  }
  if (type === 'tool/call') {
    return {
      type: 'tool-call',
      callId: typeof data.callId === 'string' ? data.callId : '',
      name: typeof data.name === 'string' ? data.name : '',
      ...(typeof data.arguments === 'string'
        ? { arguments: data.arguments }
        : {}),
    };
  }
  if (type === 'tool/result') {
    // Current DSH stores correlation and error state in the tool-result
    // content block; retain legacy message fields for already-recorded logs.
    const message =
      data.message !== null &&
      typeof data.message === 'object' &&
      !Array.isArray(data.message)
        ? (data.message as Record<string, unknown>)
        : {};
    const error =
      data.error !== null &&
      typeof data.error === 'object' &&
      !Array.isArray(data.error)
        ? (data.error as Record<string, unknown>)
        : undefined;
    const block = Array.isArray(message.content)
      ? (message.content.find(
          (value: unknown) =>
            value !== null &&
            typeof value === 'object' &&
            (value as Record<string, unknown>).type === 'tool-result'
        ) as Record<string, unknown> | undefined)
      : undefined;
    const source =
      message.source && typeof message.source === 'object'
        ? (message.source as Record<string, unknown>)
        : undefined;
    const callId = block?.toolCallId ?? source?.callId ?? message.toolCallId;
    return {
      type: 'tool-result',
      callId: typeof callId === 'string' ? callId : '',
      // A tool result carries no tool name; the failure identity is the closest
      // thing, and an empty name is honest when the call succeeded.
      name: typeof error?.name === 'string' ? error.name : '',
      isError: block?.isError === true || message.isError === true,
      ...(block ? { output: extractText(block.content) } : {}),
    };
  }
  if (type === 'turn/end') {
    // The reason is a structured value, not a label: a failed turn carries the
    // provider's own error there. Reporting a bare status instead is how a
    // precise failure ("this route lists no models") reached the client as
    // "the turn ended".
    const reason = data.reason;
    const kind =
      reason !== null && typeof reason === 'object' && !Array.isArray(reason)
        ? (reason as Record<string, unknown>).kind
        : undefined;
    return {
      type: 'done',
      reason: typeof kind === 'string' ? kind : 'unknown',
      ...(data.interrupted === true ||
      kind === 'aborted' ||
      kind === 'interrupted'
        ? { interrupted: true }
        : {}),
    };
  }
  return undefined;
}

/**
 * Project the failure a finished turn recorded, if it recorded one.
 *
 * @param event - the `turn/end` envelope.
 * @returns the error chunk, or undefined when the turn ended normally.
 */
export function projectTurnFailure(
  event: Record<string, unknown>
): EngineStreamChunk | undefined {
  const data =
    event.data !== null &&
    typeof event.data === 'object' &&
    !Array.isArray(event.data)
      ? (event.data as Record<string, unknown>)
      : {};
  const reason = data.reason;
  if (reason === null || typeof reason !== 'object' || Array.isArray(reason)) {
    return undefined;
  }
  const record = reason as Record<string, unknown>;
  if (record.kind !== 'error') return undefined;
  const error = record.error;
  if (error === null || typeof error !== 'object') {
    return { type: 'error', message: 'The engine reported a failed turn.' };
  }
  const detail = error as Record<string, unknown>;
  const message =
    typeof detail.message === 'string' && detail.message.trim() !== ''
      ? detail.message
      : 'The engine reported a failed turn.';
  return {
    type: 'error',
    message,
    ...(typeof detail.code === 'string' ? { code: detail.code } : {}),
  };
}

/**
 * Build the session-id minter for one engine instance.
 *
 * A shared counter is not enough. `dsh-session-persistence-jsonl` indexes live
 * sessions process-wide, so two engine instances in one process that both mint
 * `session-1` collide, and the second fails with `SessionAlreadyExistsError`
 * even though the two hosts use different store directories. Prefixing with a
 * per-instance random component keeps ids unique across every host in the
 * process while staying readable in a session list.
 *
 * @returns a function minting an id no other engine instance will produce.
 */
function createSessionIdMinter(): () => string {
  const prefix = randomUUID().slice(0, 8);
  let counter = 0;
  return () => {
    counter += 1;
    return `session-${prefix}-${counter}`;
  };
}

/** Read a session's event count without depending on a concrete class. */
function eventCountOf(session: DshSessionLike): number {
  return typeof session.seq === 'number' && Number.isFinite(session.seq)
    ? session.seq
    : 0;
}

/** Project a session into its summary shape. */
export function projectSummary(session: DshSessionLike): EngineSessionSummary {
  const createdAt = session.header?.createdAt;
  const firstInput = session
    .deriveMessages()
    .map(projectMessage)
    .find(message => message.source === 'user' && message.text.trim());
  const title = firstInput?.text.replace(/\s+/g, ' ').trim().slice(0, 80);
  return {
    id: session.id,
    eventCount: eventCountOf(session),
    ...(title ? { title } : {}),
    ...(session.header?.cwd ? { workspacePath: session.header.cwd } : {}),
    ...(typeof createdAt === 'number' ? { createdAt } : {}),
  };
}

/**
 * The engine contract, published as the `libreDshEngine` Cordis service.
 *
 * It is a `Service` rather than a plain object so that Cordis owns its
 * lifecycle: the name is declared once, `ctx.get('libreDshEngine')` resolves it
 * for every consumer, and removing the bridge row withdraws it automatically.
 */
export class LibreDshEngineService extends Service implements DshEngine {
  /** Contract name under which this service is registered. */
  static readonly provide = DSH_ENGINE_SERVICE;

  private readonly streams = new Map<string, ResponseStream>();
  private readonly handles = new Map<string, DshAgentHandleLike>();
  /**
   * Sessions created by the UI that no agent owns yet.
   *
   * They are deliberately absent from the DSH store until the first message,
   * because the agent that will own one must be the component that enters it.
   */
  private readonly pending = new Map<string, EngineSessionSummary>();
  /** Working directory requested for each not-yet-owned session. */
  private readonly pendingCwd = new Map<string, string>();
  private readonly pendingNative = new Map<string, Session>();
  private readonly selections = new Map<string, ModelSelectionRef>();
  private readonly settingsUpdates = new Map<string, Promise<EngineSession>>();
  private readonly approvals = new Map<
    string,
    {
      approval: EngineApproval;
      promise: Promise<EngineApprovalOutcome>;
      resolve(outcome: EngineApprovalOutcome): void;
      decided: boolean;
    }
  >();
  /** Caller identity exists only while a model turn is in flight. */
  private readonly requestUsers = new Map<string, string>();
  private readonly agentUsers = new Map<string, string | undefined>();
  private readonly streamedText = new Set<string>();
  private readonly starting = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly deleting = new Map<string, Promise<boolean>>();
  private disposed = false;
  private readonly allowTools: boolean;
  private readonly sessionStorePath?: string;
  private readonly workspacePath: string;
  private readonly allowStreaming: boolean;
  private readonly defaultProvider: string | undefined;
  private readonly defaultModel: string | undefined;
  /** Mints session ids unique across every engine in this process. */
  private readonly mintSessionId = createSessionIdMinter();

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, DSH_ENGINE_SERVICE);
    this.workspacePath = path.resolve(
      config.workspacePath?.trim()
        ? config.workspacePath
        : path.join(resolveDataDirectory(), 'cordis-workspace')
    );
    installWorkspaceToolPolicy(ctx, this.workspacePath);
    this.allowStreaming = config.streaming !== false;
    this.allowTools = config.tools !== false;
    if (!this.allowTools)
      ctx.tools.guard(() => 'Cordis tools are disabled by configuration.');
    this.sessionStorePath = config.sessionStorePath;
    this.defaultProvider = config.defaultProvider;
    this.defaultModel = config.defaultModel;
    ctx.tools.guard(exec => {
      const args = exec.arguments as Record<string, unknown> | null;
      if (args?.sandbox_permissions === 'danger-full-access')
        return 'Unrestricted filesystem access is not available in the Cordis bridge.';
      const policy = this.ctx.get('sandboxPolicy');
      if ((exec.name === 'write' || exec.name === 'edit') && policy) {
        const mode = policy.resolve({
          ...(exec.agent ? { session: exec.agent.session } : {}),
        }).mode;
        if (mode === 'danger-full-access')
          return 'This session must select read-only or workspace-write permissions.';
        if (
          mode === 'read-only' &&
          args?.sandbox_permissions !== 'workspace-write'
        )
          return 'File changes require workspace-write mode or explicit approval for this operation.';
      }
      return undefined;
    });
    ctx.on(
      'approval/request',
      async (
        request: ApprovalRequest,
        next: () => Promise<EngineApprovalOutcome>
      ) => {
        const sessionId = request.agent.session.id;
        if (/-transient$/.test(sessionId)) return 'unavailable';
        if (!this.streams.has(sessionId)) return next();
        const pending = [...this.approvals.values()].find(
          value =>
            value.approval.sessionId === sessionId &&
            value.approval.callId === request.callId &&
            value.approval.toolName === request.toolName
        );
        if (!pending) return 'unavailable';
        const abort = () => {
          pending.decided = true;
          pending.resolve('cancelled');
        };
        request.signal?.addEventListener('abort', abort, { once: true });
        if (request.signal?.aborted) abort();
        try {
          return await pending.promise;
        } finally {
          request.signal?.removeEventListener('abort', abort);
        }
      }
    );

    // Each live frame carries its exact agent and session. Finished session
    // events still provide terminal/tool state and the durable transcript.
    // Live assistant frames are the token-level channel. Durable session events
    // carry a turn's finished message, so a client reading only those receives
    // a whole reply at once; these frames arrive per delta, which is what makes
    // a reply appear as it is written.
    ctx.on(
      'agent/assistant-stream' as never,
      ((payload: { agent?: DshAgentLike; frame?: Record<string, unknown> }) => {
        const { agent, frame } = payload;
        const sessionId = agent?.session?.id ?? agent?.id;
        if (!sessionId || !frame) return;
        const stream = this.streams.get(sessionId);
        if (!stream || stream.isClosed || stream.isTerminated) return;
        if (frame.type === 'start') {
          this.streamedText.delete(sessionId);
          return;
        }
        if (
          frame.type !== 'chunk' ||
          !frame.chunk ||
          typeof frame.chunk !== 'object'
        )
          return;
        const chunk = frame.chunk as Record<string, unknown>;
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          this.streamedText.add(sessionId);
          stream.push({ type: 'text', text: chunk.text });
        } else if (
          chunk.type === 'reasoning-delta' &&
          typeof chunk.text === 'string'
        ) {
          stream.push({ type: 'reasoning', text: chunk.text });
        }
      }) as never
    );

    ctx.on(
      'agent/error' as never,
      ((payload: { agent?: DshAgentLike; error?: unknown }) => {
        const sessionId = payload.agent?.session?.id ?? payload.agent?.id;
        const stream = sessionId ? this.streams.get(sessionId) : undefined;
        if (!stream || stream.isTerminated) return;
        stream.push({
          type: 'error',
          message:
            payload.error instanceof Error
              ? payload.error.message
              : String(payload.error),
        });
        // Disposal settles errors that happened before a durable turn boundary.
        if (sessionId)
          void this.cancel(sessionId).catch(error =>
            logger.warn('failed agent cleanup', { error: String(error) })
          );
      }) as never
    );

    ctx.on(
      'session/event' as never,
      ((session: unknown, event: unknown) => {
        if (event === null || typeof event !== 'object') return;
        const sessionId = (session as DshSessionLike | undefined)?.id;
        if (typeof sessionId !== 'string') return;
        const stream = this.streams.get(sessionId);
        if (!stream || stream.isTerminated) return;
        const envelope = event as Record<string, unknown>;
        const data = envelope.data as Record<string, unknown> | undefined;
        if (
          envelope.type === 'approval/asked' &&
          typeof data?.id === 'string' &&
          typeof data.toolName === 'string'
        ) {
          if (/-transient$/.test(sessionId)) return;
          const approval: EngineApproval = {
            id: data.id,
            sessionId,
            toolName: data.toolName,
            ...(typeof data.callId === 'string' ? { callId: data.callId } : {}),
            ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
          };
          let answer!: (outcome: EngineApprovalOutcome) => void;
          const promise = new Promise<EngineApprovalOutcome>(resolve => {
            answer = resolve;
          });
          this.approvals.set(approval.id, {
            approval,
            promise,
            resolve: answer,
            decided: false,
          });
          stream.push({ type: 'approval-request', approval });
          return;
        }
        if (
          envelope.type === 'approval/decided' &&
          typeof data?.id === 'string'
        ) {
          this.approvals.delete(data.id);
          stream.push({
            type: 'approval-decision',
            approvalId: data.id,
            outcome: data.outcome as EngineApprovalOutcome,
          });
          return;
        }
        // A failed turn is reported before its terminal chunk, so a consumer
        // that stops reading at `done` has already seen the reason.
        const failure = projectTurnFailure(envelope);
        if (failure) stream.push(failure);
        if (
          envelope.type === 'assistant/message' &&
          this.streamedText.has(sessionId)
        )
          return;
        const projected = projectStreamEvent(envelope);
        if (!projected) return;
        stream.push(projected);
      }) as never
    );

    // Every in-flight response and agent handle is owned by this fiber.
    // Disposing the bridge row releases all of them, so removing the plugin
    // cannot leave a model stream or a live agent behind.
    ctx.effect(
      () => async () => {
        this.disposed = true;
        await Promise.allSettled(
          [...this.streams.keys()].map(id => this.cancel(id))
        );
        await Promise.allSettled(
          [...this.handles.values()].map(handle => handle.dispose())
        );
        this.handles.clear();
        this.pending.clear();
        this.pendingCwd.clear();
        this.pendingNative.clear();
        for (const pending of this.approvals.values())
          pending.resolve('cancelled');
        this.approvals.clear();
        logger.info('libreDshEngine service withdrawn');
      },
      'libre-webui-dsh-engine.teardown'
    );
  }

  /** The DSH session store this bridge reads through. */
  private get sessions(): DshSessionsLike {
    return this.ctx.get('sessions') as unknown as DshSessionsLike;
  }

  /** The DSH agent registry this bridge drives. */
  private get agents(): DshAgentsLike {
    return this.ctx.get('agents') as unknown as DshAgentsLike;
  }

  /** The DSH tool runtime this bridge reads through. */
  private get tools(): DshToolsLike {
    return this.ctx.get('tools') as unknown as DshToolsLike;
  }

  modelConfiguration(): {
    readonly provider?: string;
    readonly model?: string;
  } {
    return { provider: this.defaultProvider, model: this.defaultModel };
  }

  status(): readonly EngineServiceStatus[] {
    const names = [
      'llm',
      'systemPrompt',
      'sessions',
      'tools',
      'agents',
    ] as const;
    return names.map(serviceName => ({
      name: serviceName,
      state: this.ctx.get(serviceName) === undefined ? 'pending' : 'ready',
    }));
  }

  private get persistence(): SessionPersistence | undefined {
    return this.ctx.get('sessionPersistence') as SessionPersistence | undefined;
  }

  async listSessions(): Promise<readonly EngineSessionSummary[]> {
    const summaries = new Map<string, EngineSessionSummary>();
    for (const stored of (await this.persistence?.list()) ?? []) {
      const summary: EngineSessionSummary = {
        id: stored.header.id,
        createdAt: stored.header.createdAt,
        eventCount: stored.eventCount ?? 0,
      };
      try {
        const session = await this.nativeSession(stored.header.id);
        summaries.set(
          stored.header.id,
          session ? projectSummary(session) : summary
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== 'SessionPersistenceCorruptionError'
        )
          throw error;
        summaries.set(stored.header.id, summary);
      }
    }
    for (const session of this.sessions.list())
      summaries.set(session.id, projectSummary(session));
    for (const session of this.pending.values()) {
      if (!summaries.has(session.id)) summaries.set(session.id, session);
    }
    return [...summaries.values()]
      .filter(session => !/-transient$/.test(session.id))
      .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
  }

  private async nativeSession(sessionId: string): Promise<Session | undefined> {
    const live = this.sessions.get(sessionId) as Session | undefined;
    if (live) return live;
    const pending = this.pendingNative.get(sessionId);
    if (pending) return pending;
    if (
      this.persistence &&
      (await this.persistence.stat(sessionId as SessionId))
    ) {
      const handle = await this.persistence.open(
        sessionId as SessionId,
        'read'
      );
      try {
        const read = await handle.read();
        return Session.fromRestore(
          handle.id,
          read.events,
          handle.header,
          handle.inheritedEventCount,
          read.eventState,
          (this.sessions as unknown as SessionStore).messageProjections
        );
      } finally {
        await handle.close();
      }
    }
    return this.pendingNative.get(sessionId);
  }

  async getSession(sessionId: string): Promise<EngineSession | undefined> {
    const session = await this.nativeSession(sessionId);
    if (!session) return undefined;
    return {
      ...projectSummary(session),
      ...(this.pending.get(sessionId)?.title
        ? { title: this.pending.get(sessionId)!.title }
        : {}),
      active:
        this.streams.has(sessionId) ||
        this.starting.has(sessionId) ||
        this.stopping.has(sessionId),
      settings: sessionSettings(session),
      capabilities: {
        permissions: !!this.ctx.get('sandboxPolicy'),
        approvals: !!this.ctx.get('approval') && !/-transient$/.test(sessionId),
      },
      approvals: [...this.approvals.values()]
        .filter(
          value => value.approval.sessionId === sessionId && !value.decided
        )
        .map(value => value.approval),
      messages: session.deriveMessages().map(projectMessage),
    };
  }

  private async validateSettings(
    settings: Partial<EngineSessionSettings>,
    userId?: string
  ): Promise<void> {
    if (settings.permissionMode !== undefined) {
      if (
        settings.permissionMode !== 'read-only' &&
        settings.permissionMode !== 'workspace-write'
      )
        throw new Error('Choose read-only or workspace-write permissions.');
      if (!this.ctx.get('sandboxPolicy'))
        throw new Error(
          'This composition does not provide filesystem permission controls.'
        );
    }
    if (settings.model !== undefined) {
      if (!isProviderModelIdentity(settings.model))
        throw new Error('Choose an available provider model.');
      const provider = this.ctx.get('libreCordisProvider') as
        | { resolveModel?(model: string, userId?: string): Promise<unknown> }
        | undefined;
      if (
        this.defaultProvider === 'libre-webui' &&
        !(await provider?.resolveModel?.(settings.model, userId))
      )
        throw new Error(
          'The selected provider model is not available for this account.'
        );
    }
  }

  async updateSessionSettings(
    sessionId: string,
    settings: Partial<EngineSessionSettings>,
    options?: { readonly userId?: string }
  ): Promise<EngineSession> {
    if (
      this.streams.has(sessionId) ||
      this.starting.has(sessionId) ||
      this.stopping.has(sessionId) ||
      this.deleting.has(sessionId) ||
      this.settingsUpdates.has(sessionId)
    )
      throw Object.assign(
        new Error(
          'Session settings cannot change while a turn or another operation is active.'
        ),
        { code: 'CORDIS_SESSION_BUSY' }
      );
    const update = (async () => {
      await this.validateSettings(settings, options?.userId);
      const owned = this.handles.get(sessionId);
      if (owned) {
        await owned.agent.whenIdle?.();
        if (!this.persistence && owned.agent.session) {
          appendSessionSettings(
            owned.agent.session,
            settings,
            this.defaultProvider ?? 'libre-webui'
          );
          if (settings.model && this.selections.has(sessionId))
            this.selections.get(sessionId)!.current = {
              provider: this.defaultProvider ?? 'libre-webui',
              model: settings.model,
            };
          return (await this.getSession(sessionId))!;
        }
        await owned.dispose();
        this.handles.delete(sessionId);
      }
      const stored = await this.persistence?.stat(sessionId as SessionId);
      if (stored && this.persistence) {
        const handle = await this.persistence.open(
          sessionId as SessionId,
          'write'
        );
        try {
          const read = await handle.read();
          const session = Session.fromRestore(
            handle.id,
            read.events,
            handle.header,
            handle.inheritedEventCount,
            read.eventState,
            (this.sessions as unknown as SessionStore).messageProjections
          );
          // fromRestore may add a native end-seed marker before our settings.
          // Persist that marker too so the appended suffix stays contiguous.
          const start = read.events.length;
          appendSessionSettings(
            session,
            settings,
            this.defaultProvider ?? 'libre-webui'
          );
          await handle.append(session.snapshotEvents().slice(start));
          await handle.flush();
          this.pendingNative.delete(sessionId);
        } finally {
          await handle.close();
        }
      } else {
        const session =
          this.pendingNative.get(sessionId) ??
          (this.sessions.get(sessionId) as Session | undefined);
        if (!session) throw new Error('Session not found.');
        appendSessionSettings(
          session,
          settings,
          this.defaultProvider ?? 'libre-webui'
        );
      }
      const result = await this.getSession(sessionId);
      if (!result) throw new Error('Session not found.');
      return result;
    })();
    this.settingsUpdates.set(sessionId, update);
    try {
      return await update;
    } finally {
      this.settingsUpdates.delete(sessionId);
    }
  }

  async decideApproval(
    sessionId: string,
    approvalId: string,
    outcome: 'allowed-once' | 'rejected'
  ): Promise<boolean> {
    if (outcome !== 'allowed-once' && outcome !== 'rejected')
      throw new Error('Invalid approval outcome.');
    const pending = this.approvals.get(approvalId);
    if (!pending || pending.decided || pending.approval.sessionId !== sessionId)
      return false;
    pending.decided = true;
    pending.resolve(outcome);
    return true;
  }

  private async resolveWorkspace(cwd: string): Promise<string> {
    await mkdir(this.workspacePath, { recursive: true });
    const root = await realpath(this.workspacePath);
    const requested = await realpath(cwd || root);
    const relative = path.relative(root, requested);
    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        'The session workspace must be inside the configured Cordis workspace.'
      );
    }
    return requested;
  }

  async createSession(
    options: EngineCreateSessionOptions
  ): Promise<EngineSession> {
    if (this.disposed) throw new Error('The Cordis engine is stopped.');
    await this.validateSettings(options, options.userId);
    const cwd = await this.resolveWorkspace(options.cwd);
    const id = this.mintSessionId() + (options.transient ? '-transient' : '');
    const summary: EngineSessionSummary = {
      id,
      eventCount: 0,
      createdAt: Date.now(),
      ...(options.title === undefined ? {} : { title: options.title }),
    };
    const prepared = (this.sessions as unknown as SessionStore).prepare(
      id as SessionId,
      { meta: { cwd } }
    );
    appendSessionSettings(
      prepared,
      {
        ...options,
        ...(this.ctx.get('sandboxPolicy')
          ? { permissionMode: options.permissionMode ?? 'read-only' }
          : {}),
      },
      this.defaultProvider ?? 'libre-webui'
    );
    if (this.persistence) {
      const handle = await this.persistence.create(prepared.header);
      try {
        if (prepared.seq) await handle.append(prepared.snapshotEvents());
        await handle.flush();
      } finally {
        await handle.close();
      }
    }
    this.pendingNative.set(id, prepared);
    this.pending.set(id, summary);
    this.pendingCwd.set(id, cwd);
    return (await this.getSession(id))!;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const existing = this.deleting.get(sessionId);
    if (existing) return existing;
    const remove = (async () => {
      // Removing an invalid transcript must not require replaying its body.
      // The persistence catalog still validates its identity and header; the
      // deletion adapter separately validates the artifact's canonical path.
      await this.settingsUpdates.get(sessionId)?.catch(() => undefined);
      const exists =
        this.pending.has(sessionId) ||
        this.sessions.get(sessionId) ||
        (await this.persistence?.stat(sessionId as SessionId));
      if (!exists) return false;
      await this.cancel(sessionId);
      const handle = this.handles.get(sessionId);
      if (handle) {
        await handle.dispose();
        this.handles.delete(sessionId);
      }
      const stored = await this.persistence?.stat(sessionId as SessionId);
      if (stored) {
        if (!this.sessionStorePath)
          throw new Error(
            'The configured persistence backend does not support session deletion.'
          );
        await deleteJsonlSession(this.sessionStorePath, stored.header);
      }
      this.pending.delete(sessionId);
      this.pendingCwd.delete(sessionId);
      this.pendingNative.delete(sessionId);
      this.agentUsers.delete(sessionId);
      return true;
    })();
    this.deleting.set(sessionId, remove);
    try {
      return await remove;
    } finally {
      this.deleting.delete(sessionId);
    }
  }

  async listAgents(): Promise<readonly EngineAgentSummary[]> {
    const roots = new Set(this.agents.roots().map(agent => agent.id));
    return this.agents
      .list()
      .map(agent => ({ id: agent.id, root: roots.has(agent.id) }));
  }

  async listTools(): Promise<readonly EngineToolSummary[]> {
    if (!this.allowTools) return [];
    // No scope yields the deployment-wide registry; per-agent restrictions are
    // applied by the tool runtime at dispatch time, not at listing time.
    return this.tools
      .schemas()
      .filter(
        (schema): schema is { name: string; description?: string } =>
          typeof schema.name === 'string'
      )
      .map(schema => ({
        name: schema.name,
        description:
          typeof schema.description === 'string' ? schema.description : '',
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async sendMessage(
    sessionId: string,
    text: string,
    options?: { readonly cwd?: string; readonly userId?: string }
  ): Promise<EngineStreamHandle> {
    if (this.disposed) throw new Error('The Cordis engine is stopped.');
    if (!this.allowStreaming)
      throw new Error(
        'cordis dsh engine: streaming is disabled by configuration'
      );
    if (
      this.streams.has(sessionId) ||
      this.stopping.has(sessionId) ||
      this.deleting.has(sessionId) ||
      this.settingsUpdates.has(sessionId)
    ) {
      throw new Error(
        `cordis dsh engine: session "${sessionId}" already has a response in flight`
      );
    }
    if (options?.userId) this.requestUsers.set(sessionId, options.userId);
    const controller = new AbortController();
    this.controllers.set(sessionId, controller);
    const stream = new ResponseStream(
      sessionId,
      () => {
        void this.cancel(sessionId).catch(error =>
          logger.warn('stream cancellation failed', { error: String(error) })
        );
      },
      () => {
        if (this.streams.get(sessionId) === stream)
          this.streams.delete(sessionId);
        this.streamedText.delete(sessionId);
        this.controllers.delete(sessionId);
        this.requestUsers.delete(sessionId);
      }
    );
    this.streams.set(sessionId, stream);
    const start = (async () => {
      const details = await this.getSession(sessionId);
      if (!details)
        throw new Error(
          `cordis dsh engine: session "${sessionId}" does not exist; create it first`
        );
      let handle = this.handles.get(sessionId);
      if (
        handle &&
        (this.agentUsers.get(sessionId) !== options?.userId ||
          details.settings.model === undefined ||
          !isProviderModelIdentity(
            this.selections.get(sessionId)?.current?.model
          ))
      ) {
        await handle.dispose();
        this.handles.delete(sessionId);
        handle = undefined;
      }
      if (!handle) {
        const userId = options?.userId;
        const provider = this.ctx.get('libreCordisProvider') as
          | { defaultModel?(userId?: string): Promise<string | undefined> }
          | undefined;
        const selectedModel = details.settings.model;
        const model = isProviderModelIdentity(selectedModel)
          ? selectedModel
          : isProviderModelIdentity(this.defaultModel)
            ? this.defaultModel
            : await provider?.defaultModel?.(userId);
        const agentOptions: Record<string, unknown> = {};
        if (this.defaultProvider) agentOptions.provider = this.defaultProvider;
        if (model) agentOptions.model = model;
        const setup = (agentCtx: Context, agent: DshAgentLike) => {
          if (!this.allowTools) agentCtx.tools.restrict({ allow: [] });
          if (agent.session && this.ctx.get('sandboxPolicy')) {
            // Even an operator's broader default cannot widen this bridge's
            // two-mode contract. Persist the actual mode enforced on resume.
            appendSessionSettings(
              agent.session,
              { permissionMode: details.settings.permissionMode },
              this.defaultProvider ?? 'libre-webui'
            );
          }
          if (model && this.defaultProvider) {
            const selection: ModelSelectionRef = {
              current: { provider: this.defaultProvider, model },
              assembled: undefined,
            };
            this.selections.set(sessionId, selection);
            installModelSelection(agentCtx, selection);
          }
        };
        const stored = await this.persistence?.stat(sessionId as SessionId);
        if (stored) {
          await this.resolveWorkspace(stored.header.cwd ?? '');
          handle = await this.agents.resume({
            resumeSessionId: sessionId,
            agentOptions,
            signal: controller.signal,
            setup,
          });
        } else {
          const cwd = await this.resolveWorkspace(
            options?.cwd ?? this.pendingCwd.get(sessionId) ?? ''
          );
          handle = await this.agents.create({
            sessionId,
            meta: { cwd },
            agentOptions,
            signal: controller.signal,
            setup,
          });
        }
        this.handles.set(sessionId, handle);
        this.agentUsers.set(sessionId, userId);
        this.pending.delete(sessionId);
        this.pendingCwd.delete(sessionId);
        this.pendingNative.delete(sessionId);
      }
      controller.signal.throwIfAborted();
      if (typeof handle.agent.followup !== 'function')
        throw new Error(
          'cordis dsh engine: the mounted engine has no agent driver that accepts messages'
        );
      handle.agent.followup(
        createUserMessage({
          source: { kind: 'user' },
          content: [{ type: 'text', text }],
        })
      );
    })();
    this.starting.set(sessionId, start);
    try {
      await start;
      return stream;
    } catch (error) {
      stream.push({ type: 'done', reason: 'error' });
      stream.close();
      throw error;
    } finally {
      this.starting.delete(sessionId);
    }
  }

  requestUserId(sessionId: string): string | undefined {
    return this.requestUsers.get(sessionId);
  }

  async cancel(sessionId: string): Promise<boolean> {
    const inProgress = this.stopping.get(sessionId);
    if (inProgress) {
      await inProgress;
      return true;
    }
    const stream = this.streams.get(sessionId);
    const handle = this.handles.get(sessionId);
    if (!stream && !handle && !this.starting.has(sessionId)) return false;
    this.controllers.get(sessionId)?.abort();
    const stop = (async () => {
      await this.starting.get(sessionId)?.catch(() => undefined);
      const owned = this.handles.get(sessionId);
      if (owned) {
        owned.agent.cancel?.({ kind: 'user' });
        if (!this.persistence && owned.agent.whenIdle) {
          // Without a persistence backend, the live agent owns the only copy
          // of the transcript. Drain cancellation without deleting that copy.
          await owned.agent.whenIdle();
        } else {
          await owned.dispose();
          this.handles.delete(sessionId);
        }
      }
      stream?.push({ type: 'done', reason: 'cancelled', interrupted: true });
    })();
    this.stopping.set(sessionId, stop);
    try {
      await stop;
    } finally {
      this.stopping.delete(sessionId);
    }
    return true;
  }
}

/**
 * Mount the bridge on a context that already provides the engine services.
 * @param ctx - context carrying `sessions`, `agents`, and `tools`.
 * @param config - bridge configuration from the composition row.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.plugin(LibreDshEngineService, config);
}
