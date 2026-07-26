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
  Bot,
  ChevronDown,
  CircleAlert,
  Loader2,
  TerminalSquare,
  User,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RichMessageContent } from '@/components/ui/RichMessageContent';
import { StreamingMessageContent } from '@/components/ui/StreamingMessageContent';
import { WorkLiveRunSurface } from '@/components/work/WorkLiveRunSurface';
import type { WorkLiveRun, WorkMessage, WorkTask } from '@/types/work';
import { cn } from '@/utils';

interface WorkConversationProps {
  task: WorkTask;
  loading: boolean;
  loadingOlder: boolean;
  liveRun?: WorkLiveRun;
  onLoadOlder: () => Promise<WorkMessage[]>;
}

const metadataText = (
  metadata: Record<string, unknown> | null | undefined
): string | null => {
  if (!metadata || Object.keys(metadata).length === 0) return null;
  try {
    return JSON.stringify(metadata, null, 2);
  } catch {
    return null;
  }
};

const toolTitle = (message: WorkMessage, fallback: string): string => {
  const metadata = message.metadata;
  const name =
    metadata?.name ?? metadata?.toolName ?? metadata?.tool ?? metadata?.command;
  return typeof name === 'string' && name ? name : fallback;
};

function ProviderReasoningMessage({ message }: { message: WorkMessage }) {
  const { t } = useTranslation();
  return (
    <details
      data-testid='work-provider-reasoning'
      className='group ms-11 overflow-hidden rounded-xl border border-line bg-surface-subtle/70'
    >
      <summary className='flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-ink-muted marker:hidden [&::-webkit-details-marker]:hidden'>
        <span className='flex min-w-0 items-center gap-2'>
          <Brain className='h-3.5 w-3.5 shrink-0 text-[rgb(48,121,255)]' />
          <span className='truncate'>
            {t('libreClaw.metrics.provider', { defaultValue: 'Provider' })} ·{' '}
            {t('libreClaw.metrics.reasoning', {
              defaultValue: 'Reasoning',
            })}
          </span>
        </span>
        <ChevronDown className='h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180' />
      </summary>
      <p
        dir='auto'
        className='whitespace-pre-wrap break-words border-t border-line px-3 py-2.5 text-xs leading-relaxed text-ink-muted'
      >
        {message.content}
      </p>
    </details>
  );
}

function ToolMessage({ message }: { message: WorkMessage }) {
  const { t } = useTranslation();
  const details = metadataText(message.metadata);
  const error = message.kind === 'error';
  const kindLabel = {
    message: t('work.activity.kinds.message', {
      defaultValue: 'Message',
    }),
    reasoning: t('libreClaw.metrics.reasoning', {
      defaultValue: 'Reasoning',
    }),
    tool_call: t('work.activity.kinds.toolCall', {
      defaultValue: 'Tool call',
    }),
    tool_result: t('work.activity.kinds.toolResult', {
      defaultValue: 'Tool result',
    }),
    error: t('work.activity.kinds.error', {
      defaultValue: 'Error',
    }),
  }[message.kind];
  return (
    <div
      className={cn(
        'rounded-xl border bg-surface-subtle',
        error ? 'border-error-500/30' : 'border-line'
      )}
    >
      <div className='flex items-center gap-2 border-b border-line px-3 py-2'>
        {error ? (
          <CircleAlert className='h-4 w-4 text-error-500' />
        ) : (
          <TerminalSquare className='h-4 w-4 text-ink-muted' />
        )}
        <span
          dir='auto'
          className='min-w-0 flex-1 truncate font-mono text-xs font-medium text-ink'
        >
          {toolTitle(
            message,
            t('work.activity.toolActivity', {
              defaultValue: 'Tool activity',
            })
          )}
        </span>
        <span className='rounded-md bg-surface-raised px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted rtl:tracking-normal'>
          {kindLabel}
        </span>
      </div>
      {message.content && (
        <pre
          dir='ltr'
          className='max-h-56 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 text-left font-mono text-xs leading-relaxed text-ink-muted'
        >
          {message.content}
        </pre>
      )}
      {details && (
        <details className='border-t border-line px-3 py-2'>
          <summary className='cursor-pointer text-[11px] font-medium text-ink-muted'>
            {t('work.activity.details', { defaultValue: 'Details' })}
          </summary>
          <pre
            dir='ltr'
            className='mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-left font-mono text-[11px] text-ink-muted'
          >
            {details}
          </pre>
        </details>
      )}
    </div>
  );
}

export function WorkConversation({
  task,
  loading,
  loadingOlder,
  liveRun,
  onLoadOlder,
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
              <div className='mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-surface-raised text-ink-muted'>
                <Bot className='h-6 w-6' />
              </div>
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
              {messages.map(message => {
                if (
                  liveRun &&
                  message.runId === liveRun.runId &&
                  message.role !== 'user'
                ) {
                  return null;
                }
                if (message.kind === 'reasoning') {
                  return (
                    <ProviderReasoningMessage
                      key={message.id}
                      message={message}
                    />
                  );
                }
                if (message.role === 'tool' || message.kind !== 'message') {
                  return <ToolMessage key={message.id} message={message} />;
                }
                const user = message.role === 'user';
                const streaming =
                  !user &&
                  task.status === 'running' &&
                  message.id === lastAssistantId &&
                  message.runId === task.activeRun?.id;
                return (
                  <article
                    key={message.id}
                    className={cn('flex gap-3', user && 'flex-row-reverse')}
                  >
                    <div
                      className={cn(
                        'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl',
                        user
                          ? 'bg-ink text-ink-inverse'
                          : 'border border-line bg-surface-raised text-ink-muted'
                      )}
                    >
                      {user ? (
                        <User className='h-4 w-4' />
                      ) : (
                        <Bot className='h-4 w-4' />
                      )}
                    </div>
                    <div
                      className={cn(
                        'min-w-0 max-w-[88%]',
                        user &&
                          'rounded-2xl rounded-se-md bg-ink px-4 py-2.5 text-ink-inverse'
                      )}
                    >
                      {user ? (
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
                  <div className='mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-line bg-surface-raised text-ink-muted'>
                    <Bot className='h-4 w-4' />
                  </div>
                  <div className='min-w-0 max-w-[92%] flex-1'>
                    <WorkLiveRunSurface run={liveRun} />
                  </div>
                </article>
              )}
              {!liveRun &&
                (task.status === 'preparing' || task.status === 'running') && (
                  <div className='flex items-center gap-2 ps-11 text-xs text-ink-muted'>
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
