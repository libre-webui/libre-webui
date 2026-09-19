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
 * Transport- and implementation-neutral contracts for the embedded DSH engine.
 *
 * Everything Libre WebUI consumes from the DSH engine crosses this file. The
 * route layer, the WebSocket bridge, and the frontend client all program
 * against these shapes, and the `dsh-engine` Cordis plugin is what satisfies
 * them. No Libre WebUI module outside `src/cordis/dsh/` may import a concrete
 * `@deepseek-ai/dsh-*` package: that restriction is what makes the engine
 * hot-swappable and what keeps the Cordis bridge a genuine seam rather than a
 * direct dependency in disguise.
 *
 * @module cordis/contracts
 */

/** Stable Cordis service name under which the engine contract is published. */
export const DSH_ENGINE_SERVICE = 'libreDshEngine' as const;

/** Lifecycle phase of one engine service, mirroring Cordis fiber states. */
export type EngineServiceState =
  /** The providing plugin has not been mounted yet. */
  | 'pending'
  /** The providing plugin is mounted and the service is usable. */
  | 'ready'
  /** The providing plugin is mounted but cannot serve requests. */
  | 'failed';

/** One engine service as observed through the contract. */
export interface EngineServiceStatus {
  /** Service name as registered on the Cordis context. */
  readonly name: string;
  /** Current lifecycle phase. */
  readonly state: EngineServiceState;
  /** Human-readable reason, present only when `state` is `failed`. */
  readonly detail?: string;
}

/** Role of one message projected from an engine session log. */
export type EngineMessageRole =
  'user' | 'assistant' | 'system' | 'tool' | 'unknown';

/** One message projected from an engine session log. */
export interface EngineMessage {
  /** Engine-assigned identifier, stable within a session. */
  readonly id: string;
  /** Projected author role. */
  readonly role: EngineMessageRole;
  /** Flattened text content; empty when the message carried none. */
  readonly text: string;
  /** Reasoning exposed by the provider, kept separate from the answer. */
  readonly reasoning?: string;
  /** Distinguishes human input from harness-injected runtime context. */
  readonly source?: 'user' | 'model' | 'system' | 'context' | 'tool';
  readonly toolCalls?: readonly EngineToolCall[];
  readonly toolResults?: readonly EngineToolResult[];
  /** Engine sequence number of the originating event, when known. */
  readonly seq?: number;
}

/** One structured model-requested operation. */
export interface EngineToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
}

/** One structured operation result. */
export interface EngineToolResult {
  readonly callId: string;
  readonly name?: string;
  readonly output: string;
  readonly isError: boolean;
}

export type EnginePermissionMode = 'read-only' | 'workspace-write';

export interface EngineSessionSettings {
  readonly model?: string;
  readonly permissionMode: EnginePermissionMode;
}

export interface EngineApproval {
  readonly id: string;
  readonly sessionId: string;
  readonly callId?: string;
  readonly toolName: string;
  readonly reason?: string;
}

export type EngineApprovalOutcome =
  'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/** Summary of one engine session. */
export interface EngineSessionSummary {
  /** Opaque session identifier used by every other session operation. */
  readonly id: string;
  /** Engine-supplied title, absent until one is generated. */
  readonly title?: string;
  /** Epoch milliseconds when the session was created, when known. */
  readonly createdAt?: number;
  /** Number of events currently recorded for the session. */
  readonly eventCount: number;
  /** Canonical working directory recorded for this session. */
  readonly workspacePath?: string;
}

/** A live or restored engine session. */
export interface EngineSession extends EngineSessionSummary {
  readonly active: boolean;
  readonly settings: EngineSessionSettings;
  readonly capabilities: {
    readonly permissions: boolean;
    readonly approvals: boolean;
  };
  readonly approvals: readonly EngineApproval[];
  /** Messages projected from the session log, oldest first. */
  readonly messages: readonly EngineMessage[];
}

/** Identifies one live agent. */
export interface EngineAgentSummary {
  /** Agent identifier, equal to its backing session id. */
  readonly id: string;
  /** Whether this agent is a runtime root rather than a child of another. */
  readonly root: boolean;
}

/** One tool the engine can expose to a model. */
export interface EngineToolSummary {
  /** Model-facing tool name. */
  readonly name: string;
  /** Model-facing description, empty when the tool declared none. */
  readonly description: string;
}

/** Options accepted when creating an engine session. */
export interface EngineCreateSessionOptions {
  /** Absolute working directory recorded in the session header. */
  readonly cwd: string;
  /** A temporary Chat invocation, excluded from the engine console. */
  readonly transient?: boolean;
  readonly model?: string;
  readonly permissionMode?: EnginePermissionMode;
  /** Authenticated caller used to validate a requested model; never persisted. */
  readonly userId?: string;
  /** Optional author-supplied title. */
  readonly title?: string;
}

/** Options accepted when creating an agent bound to a session. */
export interface EngineCreateAgentOptions {
  /** Session the agent should operate on. */
  readonly sessionId: string;
  /** Absolute working directory recorded in the session header. */
  readonly cwd: string;
  /** Provider route name, when the caller wants to pin one. */
  readonly provider?: string;
  /** Model identifier, when the caller wants to pin one. */
  readonly model?: string;
}

/** One increment of a streaming agent response. */
export type EngineStreamChunk =
  /** Incremental assistant text. */
  | { readonly type: 'text'; readonly text: string }
  /**
   * Incremental reasoning the model exposed.
   *
   * Separate from `text` because it is not part of the reply: a consumer may
   * show it, collapse it, or drop it, and mixing it into the answer would make
   * that choice impossible.
   */
  | { readonly type: 'reasoning'; readonly text: string }
  /**
   * The turn failed before producing a reply.
   *
   * Carried separately from `done` because the engine reports a structured
   * failure reason, and collapsing it into a terminal status would leave a
   * caller with "the turn ended" and no way to say why.
   */
  | {
      readonly type: 'error';
      readonly message: string;
      readonly code?: string;
    }
  /** A tool call the agent started. */
  | {
      readonly type: 'tool-call';
      readonly callId: string;
      readonly name: string;
      readonly arguments?: string;
    }
  /** A tool call that finished, successfully or not. */
  | {
      readonly type: 'tool-result';
      readonly callId: string;
      readonly name: string;
      readonly isError: boolean;
      readonly output?: string;
    }
  | { readonly type: 'approval-request'; readonly approval: EngineApproval }
  | {
      readonly type: 'approval-decision';
      readonly approvalId: string;
      readonly outcome: EngineApprovalOutcome;
    }
  /** A turn boundary; the terminal chunk of one response. */
  | {
      readonly type: 'done';
      readonly reason: string;
      readonly interrupted?: boolean;
    };

/** Subscription handle returned by {@link EngineStreamHandle}. */
export interface EngineStreamSubscription {
  /** Stop receiving chunks. Safe to call more than once. */
  unsubscribe(): void;
}

/** Handle over one in-flight streaming response. */
export interface EngineStreamHandle {
  /** Session the response belongs to. */
  readonly sessionId: string;
  /**
   * Register a chunk listener.
   *
   * Everything the response has already produced is replayed first, so a
   * listener that attaches after a fast answer still receives it.
   */
  subscribe(
    listener: (chunk: EngineStreamChunk) => void
  ): EngineStreamSubscription;
  /**
   * Release this handle's resources.
   *
   * Called when a client disconnects, so an abandoned response stops buffering
   * for a reader that is gone. The turn stays durable: its transcript remains
   * readable and the next message is not blocked.
   */
  close(): void;
}

/**
 * The engine contract published as the `libreDshEngine` Cordis service.
 *
 * Every method rejects rather than returning a partial result when the engine
 * is not ready, so callers never mistake an unmounted engine for an empty one.
 */
export interface DshEngine {
  /** Report the lifecycle state of each engine service. */
  status(): readonly EngineServiceStatus[];

  /** Model defaults of the running composition, before per-session choices. */
  modelConfiguration(): { readonly provider?: string; readonly model?: string };

  /** List live and restored sessions, newest first. */
  listSessions(): Promise<readonly EngineSessionSummary[]>;

  /** Read one session with its projected messages. */
  getSession(sessionId: string): Promise<EngineSession | undefined>;

  /** Create a session. */
  createSession(options: EngineCreateSessionOptions): Promise<EngineSession>;

  updateSessionSettings(
    sessionId: string,
    settings: Partial<EngineSessionSettings>,
    options?: { readonly userId?: string }
  ): Promise<EngineSession>;

  decideApproval(
    sessionId: string,
    approvalId: string,
    outcome: 'allowed-once' | 'rejected'
  ): Promise<boolean>;

  /** Delete a session and dispose any agent still bound to it. */
  deleteSession(sessionId: string): Promise<boolean>;

  /** List live agents. */
  listAgents(): Promise<readonly EngineAgentSummary[]>;

  /** List tools currently registered with the engine. */
  listTools(): Promise<readonly EngineToolSummary[]>;

  /**
   * Send a user message to a session and stream the agent response.
   *
   * The returned handle is usable immediately: chunks emitted before the first
   * subscriber attaches are buffered and replayed to that subscriber, so a
   * caller can await the HTTP response and then attach without losing text.
   */
  sendMessage(
    sessionId: string,
    text: string,
    options?: { readonly cwd?: string; readonly userId?: string }
  ): Promise<EngineStreamHandle>;

  /** Authenticated actor attached to the current turn only. */
  requestUserId(sessionId: string): string | undefined;

  /** Cancel the in-flight response for a session, if any. */
  cancel(sessionId: string): Promise<boolean>;
}
