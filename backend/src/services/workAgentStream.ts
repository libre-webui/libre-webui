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
 * One vocabulary for what an agent CLI did during a Work run. Each CLI's
 * JSON Lines stream is read here into text, reasoning, tool activity, and
 * a final answer; Work turns those into its own events and transcript.
 * The CLI executes its own tools inside the sandbox, so tool events are a
 * record of what happened, never requests Work must fulfil.
 *
 * Every field is read defensively: an unknown event or shape is skipped,
 * because CLI output formats change between releases.
 */

import {
  captureAgentCliUsage,
  type AgentCliUsageState,
} from './agentCliUsage.js';
import type { WorkAgentCliId } from './workAgentCatalog.js';

export type WorkAgentStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool_start';
      id: string;
      name: string;
      input?: Record<string, unknown>;
    }
  | {
      type: 'tool_end';
      id: string;
      name: string;
      output: string;
      isError: boolean;
    }
  /** The answer the CLI reports at the end, when it reports one. */
  | { type: 'final'; text: string }
  /** A fatal error the CLI reported; the run fails with this message. */
  | { type: 'failure'; message: string };

export interface WorkAgentStreamState {
  usage?: AgentCliUsageState;
  /** Tool names by call id, for results that only carry the id. */
  readonly tools: Map<string, string>;
  /** Calls already reported as started, so repeated updates stay quiet. */
  readonly started: Set<string>;
  /** Calls already reported as finished. */
  readonly finished: Set<string>;
  /** OpenCode emits each text part whole; remember which were seen. */
  readonly seenParts: Set<string>;
  /** Text since the last tool activity: the best final-answer fallback. */
  trailingText: string;
}

export function createWorkAgentStreamState(): WorkAgentStreamState {
  return {
    tools: new Map(),
    started: new Set(),
    finished: new Set(),
    seenParts: new Set(),
    trailingText: '',
  };
}

const MAX_TOOL_OUTPUT_CHARS = 8_000;

type Json = Record<string, unknown>;

const record = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

function bounded(value: string): string {
  return value.length > MAX_TOOL_OUTPUT_CHARS
    ? `${value.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n... output truncated ...`
    : value;
}

/** Text from string, {text}, or arrays of content blocks. */
function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map(item => contentText(item))
      .filter(Boolean)
      .join('\n');
  }
  const object = record(value);
  if (!object) return '';
  if (typeof object.text === 'string') return object.text;
  if (object.content !== undefined) return contentText(object.content);
  return '';
}

function serialized(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function toolStart(
  state: WorkAgentStreamState,
  id: string,
  name: string,
  input?: Json
): WorkAgentStreamEvent[] {
  state.tools.set(id, name);
  state.trailingText = '';
  if (state.started.has(id)) return [];
  state.started.add(id);
  return [{ type: 'tool_start', id, name, ...(input ? { input } : {}) }];
}

function toolEnd(
  state: WorkAgentStreamState,
  id: string,
  output: string,
  isError: boolean,
  name?: string
): WorkAgentStreamEvent[] {
  if (state.finished.has(id)) return [];
  const resolved = name ?? state.tools.get(id) ?? 'tool';
  const events = state.started.has(id) ? [] : toolStart(state, id, resolved);
  state.finished.add(id);
  return [
    ...events,
    { type: 'tool_end', id, name: resolved, output: bounded(output), isError },
  ];
}

function streamedText(
  state: WorkAgentStreamState,
  value: string
): WorkAgentStreamEvent[] {
  state.trailingText += value;
  return [{ type: 'text', text: value }];
}

function parseClaude(event: Json, state: WorkAgentStreamState) {
  captureAgentCliUsage('claude', event, state);
  const events: WorkAgentStreamEvent[] = [];
  if (event.type === 'stream_event') {
    const inner = record(event.event);
    const delta = record(inner?.delta);
    if (inner?.type === 'content_block_delta' && delta) {
      if (delta.type === 'text_delta' && text(delta.text)) {
        events.push(...streamedText(state, delta.text as string));
      } else if (delta.type === 'thinking_delta' && text(delta.thinking)) {
        events.push({ type: 'reasoning', text: delta.thinking as string });
      }
    }
    return events;
  }
  if (event.type === 'assistant') {
    const message = record(event.message);
    for (const block of Array.isArray(message?.content)
      ? message.content
      : []) {
      const item = record(block);
      if (item?.type === 'tool_use' && text(item.id) && text(item.name)) {
        events.push(
          ...toolStart(
            state,
            item.id as string,
            item.name as string,
            record(item.input)
          )
        );
      }
    }
    return events;
  }
  if (event.type === 'user') {
    const message = record(event.message);
    for (const block of Array.isArray(message?.content)
      ? message.content
      : []) {
      const item = record(block);
      if (item?.type === 'tool_result' && text(item.tool_use_id)) {
        events.push(
          ...toolEnd(
            state,
            item.tool_use_id as string,
            contentText(item.content),
            item.is_error === true
          )
        );
      }
    }
    return events;
  }
  if (event.type === 'result') {
    if (event.is_error === true) {
      events.push({
        type: 'failure',
        message:
          text(event.result) ??
          (typeof event.subtype === 'string'
            ? event.subtype
            : 'Claude Code failed.'),
      });
    } else if (text(event.result)) {
      events.push({ type: 'final', text: event.result as string });
    }
  }
  return events;
}

function codexToolName(item: Json): string | undefined {
  switch (item.type) {
    case 'command_execution':
      return 'shell';
    case 'file_change':
      return 'apply_patch';
    case 'web_search':
      return 'web_search';
    case 'mcp_tool_call':
      return (
        [item.server, item.tool]
          .filter(part => typeof part === 'string')
          .join('.') || 'mcp'
      );
    default:
      return undefined;
  }
}

function codexToolInput(item: Json): Json | undefined {
  if (item.type === 'command_execution' && text(item.command)) {
    return { command: item.command };
  }
  if (item.type === 'file_change' && Array.isArray(item.changes)) {
    return { changes: item.changes };
  }
  if (item.type === 'web_search' && text(item.query))
    return { query: item.query };
  if (item.type === 'mcp_tool_call') return record(item.arguments);
  return undefined;
}

function parseCodex(event: Json, state: WorkAgentStreamState) {
  captureAgentCliUsage('codex', event, state);
  const events: WorkAgentStreamEvent[] = [];
  const item = record(event.item);
  if (
    (event.type === 'item.started' || event.type === 'item.updated') &&
    item
  ) {
    const name = codexToolName(item);
    if (name && text(item.id)) {
      events.push(
        ...toolStart(state, item.id as string, name, codexToolInput(item))
      );
    }
    return events;
  }
  if (event.type === 'item.completed' && item) {
    if (item.type === 'agent_message' && text(item.text)) {
      events.push(...streamedText(state, item.text as string));
      return events;
    }
    if (item.type === 'reasoning' && text(item.text)) {
      events.push({ type: 'reasoning', text: item.text as string });
      return events;
    }
    const name = codexToolName(item);
    if (name && text(item.id)) {
      const output =
        item.type === 'command_execution'
          ? serialized(item.aggregated_output)
          : item.type === 'file_change'
            ? serialized(item.changes)
            : serialized(item.result ?? item.error ?? '');
      const failed =
        item.status === 'failed' ||
        (typeof item.exit_code === 'number' && item.exit_code !== 0);
      events.push(...toolEnd(state, item.id as string, output, failed, name));
    }
    return events;
  }
  if (event.type === 'turn.failed') {
    const error = record(event.error);
    events.push({
      type: 'failure',
      message: text(error?.message) ?? 'Codex turn failed.',
    });
  }
  return events;
}

function parseKiro(event: Json, state: WorkAgentStreamState) {
  const events: WorkAgentStreamEvent[] = [];
  const data = record(event.data);
  if (event.type === 'runError') {
    events.push({
      type: 'failure',
      message: `Kiro failed: ${text(data?.message) ?? 'agent error'}`,
    });
    return events;
  }
  if (event.type === 'runFinished') {
    if (typeof data?.status === 'string' && data.status !== 'success') {
      events.push({ type: 'failure', message: `Kiro failed: ${data.status}` });
    } else if (text(data?.finalText)) {
      events.push({ type: 'final', text: data?.finalText as string });
    }
    return events;
  }
  if (event.type !== 'sessionUpdate') return events;
  const update = record(data?.update);
  if (!update) return events;
  const kind = update.sessionUpdate;
  if (kind === 'agent_message_chunk') {
    const chunk = contentText(update.content);
    if (chunk) events.push(...streamedText(state, chunk));
  } else if (kind === 'agent_thought_chunk') {
    const chunk = contentText(update.content);
    if (chunk) events.push({ type: 'reasoning', text: chunk });
  } else if (kind === 'tool_call' || kind === 'tool_call_update') {
    const id = text(update.toolCallId);
    if (!id) return events;
    const name =
      text(update.title) ?? text(update.kind) ?? state.tools.get(id) ?? 'tool';
    if (kind === 'tool_call' || !state.started.has(id)) {
      events.push(...toolStart(state, id, name, record(update.rawInput)));
    }
    if (update.status === 'completed' || update.status === 'failed') {
      const output =
        contentText(update.content) || serialized(update.rawOutput);
      events.push(...toolEnd(state, id, output, update.status === 'failed'));
    }
  }
  return events;
}

function parseOpencode(event: Json, state: WorkAgentStreamState) {
  captureAgentCliUsage('opencode', event, state);
  const events: WorkAgentStreamEvent[] = [];
  if (event.type === 'error') {
    const error = record(event.error);
    const data = record(error?.data);
    events.push({
      type: 'failure',
      message: text(data?.message) ?? text(error?.name) ?? 'OpenCode failed.',
    });
    return events;
  }
  const part = record(event.part);
  if (!part || part.ignored === true) return events;
  if ((part.type === 'text' || part.type === 'reasoning') && text(part.text)) {
    const key = `${part.type}:${text(part.id) ?? 'default'}`;
    if (state.seenParts.has(key)) return events;
    state.seenParts.add(key);
    if (part.type === 'text') {
      events.push(...streamedText(state, part.text as string));
    } else {
      events.push({ type: 'reasoning', text: part.text as string });
    }
    return events;
  }
  if (part.type === 'tool') {
    const id = text(part.callID) ?? text(part.id);
    const name = text(part.tool) ?? 'tool';
    const toolState = record(part.state);
    if (!id || !toolState) return events;
    events.push(...toolStart(state, id, name, record(toolState.input)));
    if (toolState.status === 'completed' || toolState.status === 'error') {
      events.push(
        ...toolEnd(
          state,
          id,
          serialized(toolState.output ?? toolState.error ?? ''),
          toolState.status === 'error',
          name
        )
      );
    }
  }
  return events;
}

function parsePi(event: Json, state: WorkAgentStreamState) {
  captureAgentCliUsage('pi', event, state);
  const events: WorkAgentStreamEvent[] = [];
  if (event.type === 'message_update') {
    const inner = record(event.assistantMessageEvent);
    if (inner?.type === 'text_delta' && text(inner.delta)) {
      events.push(...streamedText(state, inner.delta as string));
    } else if (inner?.type === 'thinking_delta' && text(inner.delta)) {
      events.push({ type: 'reasoning', text: inner.delta as string });
    }
    return events;
  }
  if (event.type === 'tool_execution_start' && text(event.toolCallId)) {
    events.push(
      ...toolStart(
        state,
        event.toolCallId as string,
        text(event.toolName) ?? 'tool',
        record(event.args)
      )
    );
    return events;
  }
  if (event.type === 'tool_execution_end' && text(event.toolCallId)) {
    events.push(
      ...toolEnd(
        state,
        event.toolCallId as string,
        contentText(record(event.result)?.content ?? event.result),
        event.isError === true,
        text(event.toolName)
      )
    );
    return events;
  }
  if (event.type === 'message_end') {
    const message = record(event.message);
    if (
      message?.role === 'assistant' &&
      message.stopReason === 'error' &&
      text(message.errorMessage)
    ) {
      events.push({ type: 'failure', message: message.errorMessage as string });
    }
    return events;
  }
  if (event.type === 'error' && text(event.message)) {
    events.push({ type: 'failure', message: event.message as string });
  }
  return events;
}

const PARSERS: Record<
  WorkAgentCliId,
  (event: Json, state: WorkAgentStreamState) => WorkAgentStreamEvent[]
> = {
  'claude-code': parseClaude,
  codex: parseCodex,
  kiro: parseKiro,
  opencode: parseOpencode,
  pi: parsePi,
};

/** Events for one output line; non-JSON lines and unknown events yield none. */
export function parseWorkAgentLine(
  cli: WorkAgentCliId,
  line: string,
  state: WorkAgentStreamState
): WorkAgentStreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];
  let event: Json | undefined;
  try {
    event = record(JSON.parse(trimmed));
  } catch {
    return [];
  }
  if (!event) return [];
  return PARSERS[cli](event, state);
}
