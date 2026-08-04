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

import type { PluginResponse } from '../types/index.js';

type ContentBlock = {
  type?: string;
  text?: string;
  image_url?: string | { url?: string };
};

type ToolCall = {
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type PluginMessageWithExtensions = {
  content?: unknown;
  reasoning_content?: unknown;
  reasoning?: unknown;
  reasoning_details?: unknown;
  tool_calls?: unknown;
};

export function formatPluginToolArguments(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

function imageUrlFromBlock(block: ContentBlock): string | undefined {
  if (typeof block.image_url === 'string') {
    return block.image_url;
  }

  return block.image_url?.url;
}

export function formatPluginContent(content: unknown): string {
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .flatMap(block => {
        if (block.type === 'text' && block.text) {
          return [block.text];
        }

        if (block.type === 'image_url') {
          const imageUrl = imageUrlFromBlock(block);
          return imageUrl ? [`![image](${imageUrl})`] : [];
        }

        return [];
      })
      .join('\n\n');
  }

  return typeof content === 'string' ? content : '';
}

export function formatPluginToolCalls(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return '';
  }

  let toolContent = '\n\n---\n**🔧 Tool Calls:**\n';

  for (const toolCall of toolCalls as ToolCall[]) {
    const name = toolCall.function?.name || 'unknown';
    const id = toolCall.id || '';
    const args = formatPluginToolArguments(toolCall.function?.arguments || '');
    toolContent += `\n**${name}** (\`${id}\`)\n\`\`\`json\n${args}\n\`\`\`\n`;
  }

  return toolContent;
}

export function extractPluginAssistantContent(
  response: PluginResponse
): string {
  if (!response?.choices?.length) {
    throw new Error('Plugin returned empty or invalid response');
  }

  const choice = response.choices[0];
  const message = choice?.message as PluginMessageWithExtensions | undefined;

  return (
    formatPluginContent(message?.content) +
    formatPluginToolCalls(message?.tool_calls)
  );
}

export function extractPluginAssistantThinking(
  response: PluginResponse
): string | undefined {
  const message = response?.choices?.[0]?.message as
    PluginMessageWithExtensions | undefined;
  const reasoning = message?.reasoning_content ?? message?.reasoning;

  if (typeof reasoning === 'string' && reasoning.length > 0) {
    return reasoning;
  }

  return extractPluginReasoningDetails(message?.reasoning_details);
}

export function extractPluginReasoningDetails(
  details: unknown
): string | undefined {
  if (!Array.isArray(details)) {
    return undefined;
  }

  const detailText = details
    .flatMap(detail => {
      if (!detail || typeof detail !== 'object') {
        return [];
      }

      const record = detail as Record<string, unknown>;
      if (typeof record.text === 'string' && record.text.length > 0) {
        return [record.text];
      }
      if (typeof record.summary === 'string' && record.summary.length > 0) {
        return [record.summary];
      }
      return [];
    })
    .join('');

  return detailText || undefined;
}
