/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  ArrowDown,
  Brain,
  ChevronDown,
  FileText,
  Loader2,
  User as UserIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RichMessageContent } from '@/components/ui/RichMessageContent';
import { LogoMark } from '@/components/LogoMark';
import { StreamingMessageContent } from '@/components/ui/StreamingMessageContent';
import {
  ToolActivityRow,
  WorkLiveRunSurface,
} from '@/components/work/WorkLiveRunSurface';
import type { User } from '@/types';
import type {
  WorkLiveRun,
  WorkLiveToolActivity,
  WorkMessage,
  WorkTask,
} from '@/types/work';
import { cn } from '@/utils';

interface WorkConversationProps {
  task: WorkTask;
  user: User | null;
  loading: boolean;
  loadingOlder: boolean;
  liveRun?: WorkLiveRun;
  onLoadOlder: () => Promise<WorkMessage[]>;
  /** Open a workspace file from a conversation file chip. */
  onOpenFile?: (path: string) => void;
}

const detailsRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Files a tool group created or moved, in first-touch order. Only mutating
 * tools produce chips: a run that read twenty files but wrote one should
 * surface exactly that one artifact.
 */
function touchedFiles(tools: WorkLiveToolActivity[]): string[] {
  const paths: string[] = [];
  for (const tool of tools) {
    const details =
      detailsRecord(tool.metadata) ?? detailsRecord(tool.arguments);
    if (!details) continue;
    const candidate =
      tool.name === 'write_file'
        ? details.path
        : tool.name === 'move_file'
          ? details.to
          : undefined;
    if (
      typeof candidate === 'string' &&
      candidate &&
      !paths.includes(candidate)
    ) {
      paths.push(candidate);
    }
  }
  return paths;
}

interface WorkAvatarProps {
  role: 'assistant' | 'user';
  user?: User | null;
  size?: 'message' | 'empty';
}

function WorkAvatar({ role, user, size = 'message' }: WorkAvatarProps) {
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);

  if (role === 'assistant') {
    return (
      <div
        role='img'
        aria-label='Libre WebUI'
        data-testid='work-assistant-avatar'
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full border border-line bg-surface-raised text-ink shadow-subtle',
          size === 'empty' ? 'mx-auto mb-4 h-12 w-12' : 'mt-0.5 h-8 w-8'
        )}
      >
        <LogoMark
          label={null}
          className={cn(size === 'empty' ? 'h-6 w-6' : 'h-4 w-4')}
        />
      </div>
    );
  }

  const label = user?.username || 'User';
  const avatar = user?.avatar?.trim() || '';
  const hasAvatar = Boolean(avatar) && avatar !== failedAvatar;

  return (
    <div
      role={hasAvatar ? undefined : 'img'}
      aria-label={hasAvatar ? undefined : label}
      data-testid='work-user-avatar'
      className={cn(
        'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full',
        hasAvatar
          ? 'border border-line bg-surface-raised'
          : 'bg-ink text-ink-inverse'
      )}
      title={label}
    >
      {hasAvatar ? (
        <img
          src={avatar}
          alt={label}
          className='h-full w-full object-cover'
          onError={() => setFailedAvatar(avatar)}
        />
      ) : user ? (
        <span
          aria-hidden='true'
          className='text-xs font-medium uppercase leading-none'
        >
          {user.username.charAt(0)}
        </span>
      ) : (
        <UserIcon aria-hidden='true' className='h-4 w-4' />
      )}
    </div>
  );
}

const toolTitle = (message: WorkMessage, fallback: string): string => {
  const metadata = message.metadata;
  const name =
    metadata?.name ?? metadata?.toolName ?? metadata?.tool ?? metadata?.command;
  return typeof name === 'string' && name ? name : fallback;
};

const toolCallIdOf = (message: WorkMessage): string | null => {
  const value = message.metadata?.toolCallId;
  return typeof value === 'string' && value ? value : null;
};

type ConversationItem =
  | { type: 'message'; message: WorkMessage }
  | { type: 'reasoning'; message: WorkMessage }
  | { type: 'tools'; tools: WorkLiveToolActivity[] };

const toToolActivity = (
  call: WorkMessage | undefined,
  result: WorkMessage | undefined,
  fallbackName: string
): WorkLiveToolActivity => {
  const source = call ?? result;
  const failed =
    result?.kind === 'error' ||
    result?.metadata?.isError === true ||
    (!result && source?.kind === 'error');
  const durationMs = result?.metadata?.durationMs;
  return {
    id: (call ?? result)?.id ?? 'tool',
    name: source ? toolTitle(source, fallbackName) : fallbackName,
    status: failed ? 'error' : 'completed',
    arguments: call?.metadata,
    output: result?.content || (!result && call ? call.content : undefined),
    durationMs: typeof durationMs === 'number' ? durationMs : undefined,
  };
};

const buildConversationItems = (
  messages: WorkMessage[],
  fallbackName: string
): Array<{ key: string; item: ConversationItem }> => {
  const items: Array<{ key: string; item: ConversationItem }> = [];
  const pendingCalls = new Map<
    string,
    { itemIndex: number; toolIndex: number; call: WorkMessage }
  >();

  const pushTool = (activity: WorkLiveToolActivity, key: string): number => {
    const last = items[items.length - 1];
    if (last?.item.type === 'tools') {
      last.item.tools.push(activity);
      return last.item.tools.length - 1;
    }
    items.push({ key, item: { type: 'tools', tools: [activity] } });
    return 0;
  };

  for (const message of messages) {
    if (message.kind === 'reasoning') {
      items.push({ key: message.id, item: { type: 'reasoning', message } });
      continue;
    }
    if (message.role !== 'tool' && message.kind === 'message') {
      items.push({ key: message.id, item: { type: 'message', message } });
      continue;
    }
    const toolCallId = toolCallIdOf(message);
    if (message.kind === 'tool_call' && toolCallId) {
      const toolIndex = pushTool(
        toToolActivity(message, undefined, fallbackName),
        message.id
      );
      pendingCalls.set(toolCallId, {
        itemIndex: items.length - 1,
        toolIndex,
        call: message,
      });
      continue;
    }
    if (message.kind === 'tool_result' && toolCallId) {
      const pending = pendingCalls.get(toolCallId);
      if (pending) {
        const entry = items[pending.itemIndex];
        if (entry.item.type === 'tools') {
          entry.item.tools[pending.toolIndex] = toToolActivity(
            pending.call,
            message,
            fallbackName
          );
          pendingCalls.delete(toolCallId);
          continue;
        }
      }
    }
    pushTool(
      toToolActivity(
        message.kind === 'tool_call' ? message : undefined,
        message.kind === 'tool_call' ? undefined : message,
        fallbackName
      ),
      message.id
    );
  }

  return items;
};

function ProviderReasoningMessage({ message }: { message: WorkMessage }) {
  const { t } = useTranslation();
  return (
    <details
      data-testid='work-provider-reasoning'
      className='group ms-14 overflow-hidden rounded-xl border border-line bg-surface-subtle/70'
    >
      <summary className='flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-ink-muted marker:hidden [&::-webkit-details-marker]:hidden'>
        <span className='flex min-w-0 items-center gap-2'>
          <Brain className='h-3.5 w-3.5 shrink-0 text-[rgb(48,121,255)]' />
          <span className='truncate'>
            {t('libreClaw.metrics.reasoning', {
              defaultValue: 'Reasoning',
            })}
          </span>
        </span>
        <ChevronDown className='h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180' />
      </summary>
      <div
        dir='auto'
        className='border-t border-line px-3 py-2.5 text-xs leading-relaxed text-ink-muted'
      >
        {/* Markdown, so fenced code inside provider reasoning renders like
            message code instead of collapsing into plain text. */}
        <RichMessageContent content={message.content} className='text-xs' />
      </div>
    </details>
  );
}

export function WorkConversation({
  task,
  user: currentUser,
  loading,
  loadingOlder,
  liveRun,
  onLoadOlder,
  onOpenFile,
}: WorkConversationProps) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement>(null);
  const followTailRef = useRef(true);
  const [showNewActivity, setShowNewActivity] = useState(false);
  const messages = useMemo(
    () =>
      [...(task.messages || [])].sort(
        (a, b) =>
          a.messageIndex - b.messageIndex ||
          a.createdAt - b.createdAt ||
          a.id.localeCompare(b.id)
      ),
    [task.messages]
  );
  const liveRunId = liveRun?.runId;
  const conversationItems = useMemo(
    () =>
      buildConversationItems(
        messages.filter(
          message =>
            !(
              liveRunId &&
              message.runId === liveRunId &&
              message.role !== 'user'
            )
        ),
        t('work.activity.toolActivity', {
          defaultValue: 'Tool activity',
        })
      ),
    [liveRunId, messages, t]
  );
  const lastAssistantId = [...messages]
    .reverse()
    .find(
      message => message.role === 'assistant' && message.kind === 'message'
    )?.id;

  useEffect(() => {
    followTailRef.current = true;
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
    const frame = window.requestAnimationFrame(() => setShowNewActivity(false));
    return () => window.cancelAnimationFrame(frame);
  }, [task.id]);

  useEffect(() => {
    const viewport = viewportRef.current;
    let frame: number | undefined;
    if (viewport && followTailRef.current) {
      viewport.scrollTop = viewport.scrollHeight;
      frame = window.requestAnimationFrame(() => setShowNewActivity(false));
    } else if (viewport && liveRun) {
      frame = window.requestAnimationFrame(() => setShowNewActivity(true));
    }
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [liveRun, messages, task.status]);

  const loadOlder = async () => {
    const viewport = viewportRef.current;
    const previousHeight = viewport?.scrollHeight ?? 0;
    const previousTop = viewport?.scrollTop ?? 0;
    followTailRef.current = false;
    try {
      await onLoadOlder();
      requestAnimationFrame(() => {
        const updatedViewport = viewportRef.current;
        if (updatedViewport) {
          updatedViewport.scrollTop =
            previousTop + updatedViewport.scrollHeight - previousHeight;
        }
      });
    } catch {
      // The Work page renders the store error.
    }
  };

  if (loading && messages.length === 0) {
    return (
      <div className='flex min-h-0 flex-1 items-center justify-center text-ink-muted'>
        <Loader2 className='h-6 w-6 animate-spin' />
      </div>
    );
  }

  return (
    <div className='relative flex min-h-0 flex-1'>
      <div
        ref={viewportRef}
        onScroll={event => {
          const viewport = event.currentTarget;
          followTailRef.current =
            viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <
            80;
          if (followTailRef.current) setShowNewActivity(false);
        }}
        className='min-h-0 flex-1 overflow-y-auto'
      >
        <div className='mx-auto flex min-h-full max-w-3xl flex-col px-4 py-6 md:px-6'>
          {messages.length === 0 && !liveRun ? (
            <div className='m-auto max-w-md text-center'>
              <WorkAvatar role='assistant' size='empty' />
              <h2 className='text-lg font-semibold tracking-tight text-ink'>
                {t('work.conversation.ready', {
                  defaultValue: 'Workspace ready',
                })}
              </h2>
              <p className='mt-2 text-sm leading-relaxed text-ink-muted'>
                {t('work.conversation.empty', {
                  defaultValue:
                    'Continue the task below. This conversation and its files stay attached to this workspace.',
                })}
              </p>
            </div>
          ) : (
            <div className='space-y-6'>
              {task.hasMoreMessages && (
                <div className='flex justify-center'>
                  <button
                    type='button'
                    data-testid='work-load-older-messages'
                    disabled={loadingOlder}
                    onClick={() => void loadOlder()}
                    className='inline-flex items-center gap-2 rounded-lg border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-subtle hover:text-ink disabled:cursor-not-allowed disabled:opacity-60'
                  >
                    {loadingOlder && (
                      <Loader2 className='h-3.5 w-3.5 animate-spin' />
                    )}
                    {t('work.conversation.loadOlder', {
                      defaultValue: 'Load older messages',
                    })}
                  </button>
                </div>
              )}
              {conversationItems.map(({ key, item }) => {
                if (item.type === 'reasoning') {
                  return (
                    <ProviderReasoningMessage
                      key={key}
                      message={item.message}
                    />
                  );
                }
                if (item.type === 'tools') {
                  const files = onOpenFile ? touchedFiles(item.tools) : [];
                  return (
                    <div key={key} className='ms-14 space-y-1.5'>
                      {item.tools.map(tool => (
                        <ToolActivityRow
                          key={tool.id}
                          tool={tool}
                          expandedByDefault={false}
                        />
                      ))}
                      {files.length > 0 && (
                        <div
                          data-testid='work-file-chips'
                          className='flex flex-wrap gap-1.5 pt-0.5'
                        >
                          {files.map(path => {
                            const name =
                              path.split('/').filter(Boolean).pop() ?? path;
                            return (
                              <button
                                key={path}
                                type='button'
                                data-testid='work-file-chip'
                                data-path={path}
                                onClick={() => onOpenFile?.(path)}
                                title={path}
                                aria-label={t('work.conversation.openFile', {
                                  defaultValue: 'Open {{name}}',
                                  name,
                                })}
                                className='flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1 text-[11px] text-ink transition-colors hover:border-line-strong hover:bg-surface-subtle'
                              >
                                <FileText className='h-3 w-3 shrink-0 text-ink-muted' />
                                <span className='truncate' dir='ltr'>
                                  {name}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }
                const message = item.message;
                const isUserMessage = message.role === 'user';
                const streaming =
                  !isUserMessage &&
                  task.status === 'running' &&
                  message.id === lastAssistantId &&
                  message.runId === task.activeRun?.id;
                return (
                  <article
                    key={message.id}
                    className={cn(
                      'flex gap-3',
                      isUserMessage && 'flex-row-reverse'
                    )}
                  >
                    <WorkAvatar
                      role={isUserMessage ? 'user' : 'assistant'}
                      user={isUserMessage ? currentUser : undefined}
                    />
                    <div
                      className={cn(
                        'min-w-0 max-w-[88%]',
                        isUserMessage &&
                          'rounded-2xl rounded-se-md bg-ink px-4 py-2.5 text-ink-inverse'
                      )}
                    >
                      {isUserMessage ? (
                        <p
                          dir='auto'
                          className='whitespace-pre-wrap break-words text-sm leading-relaxed'
                        >
                          {message.content}
                        </p>
                      ) : streaming ? (
                        <StreamingMessageContent
                          content={message.content}
                          className='text-ink'
                        />
                      ) : (
                        <RichMessageContent
                          content={message.content}
                          className='text-sm text-ink'
                        />
                      )}
                    </div>
                  </article>
                );
              })}
              {liveRun && (
                <article
                  className='flex gap-3'
                  data-testid='work-live-run-message'
                >
                  <WorkAvatar role='assistant' />
                  <div className='min-w-0 max-w-[92%] flex-1'>
                    <WorkLiveRunSurface run={liveRun} />
                  </div>
                </article>
              )}
              {!liveRun &&
                (task.status === 'preparing' || task.status === 'running') && (
                  <div className='flex items-center gap-2 ps-14 text-xs text-ink-muted'>
                    <Loader2 className='h-3.5 w-3.5 animate-spin' />
                    {task.status === 'preparing'
                      ? t('work.status.preparing', {
                          defaultValue: 'Preparing isolated workspace…',
                        })
                      : t('work.status.running', {
                          defaultValue: 'Working in the local workspace…',
                        })}
                  </div>
                )}
            </div>
          )}
        </div>
      </div>
      {showNewActivity && (
        <button
          type='button'
          data-testid='work-new-activity-button'
          onClick={() => {
            const viewport = viewportRef.current;
            if (viewport) viewport.scrollTop = viewport.scrollHeight;
            followTailRef.current = true;
            setShowNewActivity(false);
          }}
          className='absolute bottom-4 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface-overlay/95 px-3 py-2 text-xs font-medium text-ink shadow-overlay backdrop-blur transition-colors hover:bg-surface-raised'
        >
          <ArrowDown className='h-3.5 w-3.5' />
          {t('work.live.newActivity', { defaultValue: 'New activity' })}
        </button>
      )}
    </div>
  );
}
