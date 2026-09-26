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

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  MessageSquarePlus,
  Send,
  Square,
  Trash2,
  Wrench,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { Button, Select, Textarea } from '@/components/ui';
import { MessageContent } from '@/components/ui/MessageContent';
import { composerSurfaceClass } from '@/components/composer/composerStyles';
import strandsApi, {
  type StrandsHealth,
  type StrandsMessage,
  type StrandsModel,
  type StrandsSession,
  type StrandsToolTrace,
  type StrandsTurnEvent,
} from '@/utils/api/strandsApi';
import { isHttpError } from '@/utils/api/client';
import { cn } from '@/utils';

const errorMessage = (error: unknown, fallback: string): string => {
  if (isHttpError(error)) {
    const body = error.response?.data as { error?: unknown } | undefined;
    if (typeof body?.error === 'string') return body.error;
  }
  return error instanceof Error ? error.message : fallback;
};

const inputPreview = (input: unknown): string => {
  if (input === undefined || input === null) return '';
  try {
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  } catch {
    return '';
  }
};

/** Fold one streamed event into the assistant message being built. */
const applyEvent = (
  message: StrandsMessage,
  event: StrandsTurnEvent
): StrandsMessage => {
  switch (event.type) {
    case 'text':
      return { ...message, content: message.content + event.text };
    case 'reasoning':
      return { ...message, thinking: (message.thinking ?? '') + event.text };
    case 'tool-start':
      return {
        ...message,
        tools: [
          ...(message.tools ?? []),
          { id: event.toolUseId, name: event.name, input: event.input },
        ],
      };
    case 'tool-result':
      return {
        ...message,
        tools: (message.tools ?? []).map(tool =>
          tool.id === event.toolUseId
            ? { ...tool, status: event.status, output: event.output }
            : tool
        ),
      };
    case 'done':
      return { ...message, stopReason: event.stopReason };
    case 'error':
      return { ...message, error: event.message };
    default:
      return message;
  }
};

const ToolTrace: React.FC<{ tool: StrandsToolTrace }> = ({ tool }) => {
  const { t } = useTranslation();
  const input = inputPreview(tool.input);
  return (
    <details
      className='rounded-lg border border-line bg-surface-subtle px-3 py-2 text-xs'
      data-testid='strands-tool-trace'
    >
      <summary className='flex cursor-pointer items-center gap-2 text-ink-muted'>
        <Wrench className='h-3.5 w-3.5 shrink-0' aria-hidden='true' />
        <span dir='ltr' className='font-mono text-ink'>
          {tool.name}
        </span>
        <span>
          {tool.status === 'error'
            ? t('strands.tool.failed')
            : tool.status === 'success'
              ? t('strands.tool.done')
              : t('strands.tool.running')}
        </span>
      </summary>
      {input && (
        <pre
          dir='ltr'
          className='mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-ink-muted'
        >
          {input}
        </pre>
      )}
      {tool.output && (
        <pre
          dir='ltr'
          className='mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-ink'
        >
          {tool.output}
        </pre>
      )}
    </details>
  );
};

const MessageView: React.FC<{
  message: StrandsMessage;
  streaming?: boolean;
}> = ({ message, streaming = false }) => {
  const { t } = useTranslation();
  if (message.role === 'user') {
    return (
      <div className='flex justify-end' data-testid='strands-user-message'>
        <div className='max-w-[85%] whitespace-pre-wrap rounded-2xl bg-surface-subtle px-4 py-2.5 text-sm text-ink'>
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className='space-y-2' data-testid='strands-assistant-message'>
      {message.thinking && (
        <details className='text-xs text-ink-muted'>
          <summary className='cursor-pointer'>{t('strands.reasoning')}</summary>
          <p className='mt-1 whitespace-pre-wrap'>{message.thinking}</p>
        </details>
      )}
      {(message.tools ?? []).map(tool => (
        <ToolTrace key={tool.id} tool={tool} />
      ))}
      {message.content && (
        <div className='text-sm text-ink'>
          <MessageContent content={message.content} isStreaming={streaming} />
        </div>
      )}
      {message.error && (
        <p role='alert' className='text-sm text-error-600 dark:text-error-400'>
          {message.error}
        </p>
      )}
      {message.stopReason === 'cancelled' && (
        <p className='text-xs text-ink-muted'>{t('strands.cancelled')}</p>
      )}
      {message.stopReason === 'limitTurns' && (
        <p className='text-xs text-ink-muted'>{t('strands.turnLimit')}</p>
      )}
    </div>
  );
};

export default function StrandsPage() {
  const { t } = useTranslation();
  const [health, setHealth] = useState<StrandsHealth | null>(null);
  const [models, setModels] = useState<StrandsModel[]>([]);
  const [sessions, setSessions] = useState<StrandsSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<StrandsMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState<StrandsMessage | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const freshSessionRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const active = sessions.find(session => session.id === activeId) ?? null;

  const refreshSessions = useCallback(async () => {
    const response = await strandsApi.listSessions();
    if (response.success && response.data) setSessions(response.data);
    return response.data ?? [];
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [healthResponse, modelResponse, sessionList] = await Promise.all([
          strandsApi.health(),
          strandsApi.models(),
          refreshSessions(),
        ]);
        if (cancelled) return;
        if (healthResponse.success && healthResponse.data)
          setHealth(healthResponse.data);
        if (modelResponse.success && modelResponse.data)
          setModels(modelResponse.data);
        setActiveId(current => current ?? sessionList[0]?.id ?? null);
      } catch (error) {
        if (!cancelled)
          setLoadError(errorMessage(error, t('strands.loadFailed')));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshSessions, t]);

  useEffect(() => {
    // A session created in this view starts empty; fetching it could race the
    // first turn and drop the optimistic user message.
    if (!activeId || freshSessionRef.current === activeId) return;
    let cancelled = false;
    strandsApi
      .getSession(activeId)
      .then(response => {
        if (!cancelled && response.success && response.data)
          setMessages(response.data.messages);
      })
      .catch(error => {
        if (!cancelled)
          toast.error(errorMessage(error, t('strands.loadFailed')));
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, t]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streaming]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const createSession = async () => {
    try {
      const response = await strandsApi.createSession({
        model: active?.model ?? null,
      });
      if (!response.success || !response.data) throw new Error(response.error);
      freshSessionRef.current = response.data.id;
      setSessions(current => [response.data!, ...current]);
      setMessages([]);
      setActiveId(response.data.id);
      return response.data;
    } catch (error) {
      toast.error(errorMessage(error, t('strands.createFailed')));
      return null;
    }
  };

  const deleteSession = async (session: StrandsSession) => {
    if (!window.confirm(t('strands.deleteConfirm', { title: session.title })))
      return;
    try {
      await strandsApi.deleteSession(session.id);
      const remaining = sessions.filter(item => item.id !== session.id);
      setSessions(remaining);
      if (activeId === session.id) {
        setMessages([]);
        setActiveId(remaining[0]?.id ?? null);
      }
    } catch (error) {
      toast.error(errorMessage(error, t('strands.deleteFailed')));
    }
  };

  const changeModel = async (model: string) => {
    if (!active) return;
    try {
      const response = await strandsApi.updateSession(active.id, {
        model: model || null,
      });
      if (response.success && response.data) {
        setSessions(current =>
          current.map(item => (item.id === active.id ? response.data! : item))
        );
      }
    } catch (error) {
      toast.error(errorMessage(error, t('strands.saveFailed')));
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || streaming) return;
    const session = active ?? (await createSession());
    if (!session) return;
    const now = Date.now();
    setDraft('');
    setMessages(current => [
      ...current,
      { id: `local-${now}`, role: 'user', content: text, createdAt: now },
    ]);
    let reply: StrandsMessage = {
      id: `local-reply-${now}`,
      role: 'assistant',
      content: '',
      createdAt: now,
    };
    setStreaming(reply);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await strandsApi.sendMessage(session.id, text, {
        signal: controller.signal,
        onEvent: event => {
          reply = applyEvent(reply, event);
          setStreaming(reply);
        },
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        reply = {
          ...reply,
          error: errorMessage(error, t('strands.turnFailed')),
        };
      } else {
        reply = { ...reply, stopReason: 'cancelled' };
      }
    } finally {
      abortRef.current = null;
      setMessages(current => [...current, reply]);
      setStreaming(null);
      void refreshSessions();
    }
  };

  const stop = async () => {
    if (!active) return;
    await strandsApi.cancel(active.id).catch(() => undefined);
    abortRef.current?.abort();
  };

  const modelOptions = [
    { value: '', label: t('strands.defaultModel') },
    ...models.map(model => ({
      value: model.id,
      label: `${model.name} · ${model.providerName}`,
    })),
  ];

  return (
    <div
      className='flex h-full min-h-0 flex-col bg-surface'
      data-testid='strands-page'
    >
      <header className='flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-6'>
        <div className='min-w-0'>
          <h1 className='truncate text-lg font-medium text-ink'>
            {t('strands.title')}
          </h1>
          <p className='truncate text-xs text-ink-muted'>
            {health?.harnessVersion
              ? t('strands.subtitleVersion', {
                  version: health.harnessVersion,
                })
              : t('strands.subtitle')}
          </p>
        </div>
        <Button
          size='sm'
          variant='outline'
          onClick={() => void createSession()}
          disabled={!!streaming}
          data-testid='strands-new-session'
        >
          <MessageSquarePlus className='me-2 h-4 w-4' aria-hidden='true' />
          {t('strands.newSession')}
        </Button>
      </header>

      {loadError && (
        <div
          role='alert'
          className='m-4 rounded-xl border border-line bg-surface-subtle p-4 text-sm text-ink'
        >
          {loadError}
        </div>
      )}

      <div className='flex min-h-0 flex-1 flex-col lg:flex-row'>
        <aside
          aria-label={t('strands.sessions')}
          className='shrink-0 border-b border-line bg-surface-subtle/30 lg:flex lg:w-64 lg:min-h-0 lg:flex-col lg:border-b-0 lg:border-e'
        >
          <div className='min-h-0 overflow-auto p-2 lg:flex-1 lg:p-3'>
            <ul className='flex gap-1 lg:block lg:space-y-1'>
              {sessions.map(session => (
                <li key={session.id} className='min-w-44 lg:min-w-0'>
                  <div
                    className={cn(
                      'group flex items-center gap-1 rounded-lg',
                      session.id === activeId
                        ? 'bg-surface-raised'
                        : 'hover:bg-surface-raised/60'
                    )}
                  >
                    <button
                      type='button'
                      className='min-w-0 flex-1 rounded-lg px-3 py-2 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40'
                      onClick={() => {
                        if (session.id === activeId) return;
                        setMessages([]);
                        setActiveId(session.id);
                      }}
                      aria-current={
                        session.id === activeId ? 'page' : undefined
                      }
                      disabled={!!streaming}
                    >
                      <span className='block truncate text-sm text-ink'>
                        {session.title}
                      </span>
                      <span className='mt-0.5 block truncate text-xs text-ink-muted'>
                        {t('strands.messageCount', {
                          count: session.messageCount,
                        })}
                      </span>
                    </button>
                    <button
                      type='button'
                      className='me-1 rounded p-1.5 text-ink-muted opacity-70 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 group-hover:opacity-100'
                      aria-label={`${t('strands.deleteSession')}: ${session.title}`}
                      onClick={() => void deleteSession(session)}
                      disabled={!!streaming}
                    >
                      <Trash2 className='h-3.5 w-3.5' aria-hidden='true' />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            {!loading && sessions.length === 0 && (
              <p className='p-2 text-xs text-ink-muted'>
                {t('strands.noSessions')}
              </p>
            )}
          </div>
        </aside>

        <section className='flex min-h-0 min-w-0 flex-1 flex-col'>
          <div className='scroll-region min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6'>
            <div className='mx-auto max-w-3xl space-y-5'>
              {loading ? (
                <p role='status' className='text-sm text-ink-muted'>
                  {t('common.loading')}
                </p>
              ) : messages.length === 0 && !streaming ? (
                <div className='py-12 text-center'>
                  <Bot
                    className='mx-auto mb-3 h-7 w-7 text-ink-muted'
                    aria-hidden='true'
                  />
                  <p className='text-sm text-ink-muted'>{t('strands.empty')}</p>
                </div>
              ) : (
                messages.map(message => (
                  <MessageView key={message.id} message={message} />
                ))
              )}
              {streaming && <MessageView message={streaming} streaming />}
              <div ref={bottomRef} />
            </div>
          </div>

          <div className='shrink-0 px-4 pb-4 sm:px-6'>
            <div className={cn('mx-auto max-w-3xl', composerSurfaceClass)}>
              <Textarea
                value={draft}
                onChange={event => setDraft(event.target.value)}
                onKeyDown={event => {
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void send();
                  }
                }}
                placeholder={t('strands.placeholder')}
                aria-label={t('strands.placeholder')}
                rows={2}
                className='resize-none border-0 bg-transparent shadow-none focus:ring-0'
                data-testid='strands-input'
              />
              <div className='flex items-center justify-between gap-2 px-1 pt-1'>
                <div className='w-56 max-w-[60%]'>
                  <Select
                    aria-label={t('strands.model')}
                    data-testid='strands-model-select'
                    value={active?.model ?? ''}
                    onChange={event => void changeModel(event.target.value)}
                    disabled={!active || !!streaming}
                    options={modelOptions}
                    className='h-9 py-1 text-sm'
                  />
                </div>
                {streaming ? (
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => void stop()}
                    aria-label={t('strands.stop')}
                    data-testid='strands-stop'
                  >
                    <Square className='h-4 w-4' aria-hidden='true' />
                  </Button>
                ) : (
                  <Button
                    size='sm'
                    onClick={() => void send()}
                    disabled={!draft.trim()}
                    aria-label={t('strands.send')}
                    data-testid='strands-send'
                  >
                    <Send className='h-4 w-4' aria-hidden='true' />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
