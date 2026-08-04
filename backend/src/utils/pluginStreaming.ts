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

import { formatPluginToolArguments } from './pluginResponse.js';
import {
  sendAssistantChunk,
  sendToolStatus,
  type WebSocketLike,
} from './websocketMessages.js';

export interface PluginStreamToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type PluginStreamChunk =
  | {
      type: 'content';
      content?: string;
    }
  | {
      type: 'reasoning';
      content?: string;
    }
  | {
      type: 'tool_call';
      toolCall?: PluginStreamToolCall;
    }
  | {
      type: 'usage';
      usage?: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
      };
    }
  | {
      type: 'done';
      doneReason?: string;
      providerMetadata?: Record<string, unknown>;
    };

export interface StreamPluginResponseOptions {
  ws: WebSocketLike;
  chunks: AsyncIterable<PluginStreamChunk>;
  messageId?: string;
  pauseThresholdMs?: number;
}

export interface PluginStreamResponseResult {
  content: string;
  thinking?: string;
  providerMetadata?: Record<string, unknown>;
}

const PAUSE_TOOL_ID = 'tool-activity';

export function formatPluginStreamToolCalls(
  toolCalls: readonly PluginStreamToolCall[]
): string {
  if (toolCalls.length === 0) {
    return '';
  }

  let toolContent = '\n\n---\n**🔧 Tool Calls:**\n';

  for (const toolCall of toolCalls) {
    const argsFormatted = formatPluginToolArguments(toolCall.arguments);
    toolContent += `\n**${toolCall.name}** (\`${toolCall.id}\`)\n\`\`\`json\n${argsFormatted}\n\`\`\`\n`;
  }

  return toolContent;
}

export async function streamPluginResponse({
  ws,
  chunks,
  messageId,
  pauseThresholdMs = 2000,
}: StreamPluginResponseOptions): Promise<PluginStreamResponseResult> {
  let totalContent = '';
  let totalThinking = '';
  let providerMetadata: Record<string, unknown> | undefined;
  const toolCalls: PluginStreamToolCall[] = [];
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;
  let toolActivitySent = false;

  const sendPauseToolStatus = (phase: string) => {
    sendToolStatus(
      ws,
      {
        toolCallId: PAUSE_TOOL_ID,
        name: 'working',
        phase,
      },
      { ignoreClosedSocket: true }
    );
  };

  const clearPauseTimer = () => {
    if (pauseTimer) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }
  };

  const startPauseDetection = () => {
    clearPauseTimer();
    pauseTimer = setTimeout(() => {
      if (!toolActivitySent) {
        toolActivitySent = true;
        sendPauseToolStatus('running');
      }
    }, pauseThresholdMs);
  };

  const finishToolActivity = () => {
    clearPauseTimer();
    if (toolActivitySent) {
      sendPauseToolStatus('done');
      toolActivitySent = false;
    }
  };

  startPauseDetection();

  try {
    for await (const chunk of chunks) {
      if (chunk.type === 'content' && chunk.content) {
        finishToolActivity();
        startPauseDetection();

        totalContent += chunk.content;
        sendAssistantChunk(ws, {
          content: chunk.content,
          total: totalContent,
          ...(totalThinking ? { thinkingTotal: totalThinking } : {}),
          done: false,
          messageId,
        });
      } else if (chunk.type === 'reasoning' && chunk.content) {
        finishToolActivity();
        startPauseDetection();

        totalThinking += chunk.content;
        sendAssistantChunk(ws, {
          content: '',
          total: totalContent,
          thinking: chunk.content,
          thinkingTotal: totalThinking,
          done: false,
          messageId,
        });
      } else if (chunk.type === 'tool_call' && chunk.toolCall) {
        clearPauseTimer();
        toolActivitySent = true;
        toolCalls.push(chunk.toolCall);
        sendToolStatus(
          ws,
          {
            toolCallId: PAUSE_TOOL_ID,
            name: chunk.toolCall.name,
            phase: 'running',
          },
          { ignoreClosedSocket: true }
        );
      } else if (chunk.type === 'done') {
        finishToolActivity();
        if (chunk.doneReason?.startsWith('incomplete:')) {
          const reason =
            chunk.doneReason.slice('incomplete:'.length) || 'unknown';
          throw new Error(
            `Provider returned an incomplete response (${reason})`
          );
        }
        providerMetadata = chunk.providerMetadata
          ? { ...providerMetadata, ...chunk.providerMetadata }
          : providerMetadata;
        totalContent += formatPluginStreamToolCalls(toolCalls);

        sendAssistantChunk(ws, {
          content: '',
          total: totalContent,
          ...(totalThinking ? { thinkingTotal: totalThinking } : {}),
          done: true,
          messageId,
        });
      }
    }
  } finally {
    clearPauseTimer();
  }

  return {
    content: totalContent,
    ...(totalThinking ? { thinking: totalThinking } : {}),
    ...(providerMetadata ? { providerMetadata } : {}),
  };
}
