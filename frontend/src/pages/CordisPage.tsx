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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Check,
  ChevronDown,
  Copy,
  MessageSquarePlus,
  Search,
  Send,
  Shield,
  Square,
  Trash2,
  Wrench,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { Button, Input, Select, Textarea } from '@/components/ui';
import { MessageContent } from '@/components/ui/MessageContent';
import { composerSurfaceClass } from '@/components/composer/composerStyles';
import cordisApi, {
  type CordisApproval,
  type CordisHealth,
  type CordisMessage,
  type CordisModelCatalog,
  type CordisSession,
  type CordisSessionSettings,
  type CordisSessionSummary,
  type CordisTool,
} from '@/utils/api/cordisApi';
import { cn, formatTimestamp } from '@/utils';
import { createLogger } from '@/utils/logger';
import { isHttpError } from '@/utils/api/client';

const logger = createLogger('pages:cordis');
const focusRing =
  'rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40';

const errorMessage = (error: unknown, fallback: string): string => {
  if (isHttpError(error)) {
    const body = error.response?.data as { error?: unknown } | undefined;
    if (typeof body?.error === 'string') return body.error;
  }
  return error instanceof Error ? error.message : fallback;
};

interface ActiveTurn {
  sessionId: string;
  controller: AbortController;
  cancellation?: Promise<boolean>;
}
interface ToolActivity {
  instanceId?: number;
  callId: string;
  name: string;
  arguments?: string;
  output?: string;
  status:
    | 'awaiting_approval'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'denied'
    | 'cancelled';
}
const cancelTurn = (turn: ActiveTurn): Promise<boolean> => {
  turn.cancellation ??= cordisApi.cancel(turn.sessionId).catch(error => {
    turn.cancellation = undefined;
    throw error;
  });
  return turn.cancellation;
};
const isContext = (message: CordisMessage): boolean =>
  message.role === 'system' ||
  message.source === 'system' ||
  message.source === 'context';
const readableArguments = (value: string): string => {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
};
const toolMessageKey = (messageId: string, callId: string): string =>
  JSON.stringify([messageId, callId]);
const Reasoning = ({ text }: { text: string }) => {
  const { t } = useTranslation();
  return (
    <details className='mb-3 text-ink-muted' data-testid='cordis-reasoning'>
      <summary className={cn('cursor-pointer text-xs', focusRing)}>
        {t('chatMessage.thinking')}
      </summary>
      <div className='mt-3 border-s border-line ps-3'>
        <MessageContent content={text} />
      </div>
    </details>
  );
};
const ToolCard = ({ tool }: { tool: ToolActivity }) => {
  const { t } = useTranslation();
  return (
    <details
      className='group rounded-xl border border-line bg-surface-subtle'
      data-testid='cordis-tool-activity'
      data-call-id={tool.callId}
    >
      <summary
        className={cn(
          'flex cursor-pointer items-center gap-2 px-3 py-2.5 text-sm',
          focusRing
        )}
      >
        <Wrench
          className='h-4 w-4 shrink-0 text-ink-muted'
          aria-hidden='true'
        />
        <span
          dir='ltr'
          className='min-w-0 flex-1 truncate font-mono text-xs text-ink'
        >
          {tool.name}
        </span>
        <span className='text-xs text-ink-muted'>
          {t(`tools.callStatus.${tool.status}`)}
        </span>
        <ChevronDown
          className='h-3.5 w-3.5 shrink-0 text-ink-muted transition-transform group-open:rotate-180 motion-reduce:transition-none'
          aria-hidden='true'
        />
      </summary>
      <div className='space-y-3 border-t border-line px-3 py-3'>
        {tool.arguments && (
          <div>
            <p className='mb-1 text-xs text-ink-muted'>
              {t('tools.arguments')}
            </p>
            <pre
              dir='ltr'
              className='max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-ink'
            >
              {readableArguments(tool.arguments)}
            </pre>
          </div>
        )}
        {tool.output !== undefined && (
          <div>
            <p className='mb-1 text-xs text-ink-muted'>{t('tools.result')}</p>
            <pre
              dir='ltr'
              className='max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-ink'
            >
              {tool.output}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
};
const MessageBubble = ({
  message,
  streaming = false,
}: {
  message: CordisMessage;
  streaming?: boolean;
}) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopied(true);
    } catch {
      toast.error(t('settings.apiKeys.copyFailed'));
    }
  };
  return (
    <article
      data-role={message.role}
      data-testid={streaming ? 'cordis-streaming' : 'cordis-message'}
      className={cn(
        'min-w-0 text-sm',
        message.role === 'user'
          ? 'ms-auto max-w-[90%] rounded-2xl bg-surface-subtle px-4 py-3'
          : 'w-full py-2'
      )}
    >
      <div className='mb-2 flex items-center gap-2 text-xs text-ink-muted'>
        <span className='flex-1'>{t(`cordis.role.${message.role}`)}</span>
        {!streaming && message.text && (
          <button
            type='button'
            className={cn('p-1 text-ink-muted hover:text-ink', focusRing)}
            aria-label={
              copied ? t('chatMessage.copied') : t('chatMessage.copyMessage')
            }
            onClick={() => void copy()}
          >
            {copied ? (
              <Check className='h-3.5 w-3.5' />
            ) : (
              <Copy className='h-3.5 w-3.5' />
            )}
          </button>
        )}
      </div>
      {message.reasoning && <Reasoning text={message.reasoning} />}
      {message.text && (
        <MessageContent content={message.text} isStreaming={streaming} />
      )}
    </article>
  );
};

export const CordisPage: React.FC = () => {
  const { t } = useTranslation();
  const [health, setHealth] = useState<CordisHealth | null>(null);
  const [sessions, setSessions] = useState<CordisSessionSummary[]>([]);
  const [tools, setTools] = useState<CordisTool[]>([]);
  const [catalog, setCatalog] = useState<CordisModelCatalog>({ models: [] });
  const [newSettings, setNewSettings] = useState<CordisSessionSettings>({
    permissionMode: 'read-only',
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [session, setSession] = useState<CordisSession | null>(null);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [managingSession, setManagingSession] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [streamText, setStreamText] = useState('');
  const [streamReasoning, setStreamReasoning] = useState('');
  const [streamTools, setStreamTools] = useState<ToolActivity[]>([]);
  const [approvals, setApprovals] = useState<CordisApproval[]>([]);
  const [decidingApproval, setDecidingApproval] = useState<string | null>(null);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [lastPrompt, setLastPrompt] = useState('');
  const activeTurnRef = useRef<ActiveTurn | null>(null);
  const sessionReadVersion = useRef(0);
  const approvalVersion = useRef(0);
  const toolInstance = useRef(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followTailRef = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(
    () => () => {
      const turn = activeTurnRef.current;
      activeTurnRef.current = null;
      if (turn)
        void cancelTurn(turn)
          .catch(error =>
            logger.error('cancelling a departed turn failed', error)
          )
          .finally(() => turn.controller.abort());
    },
    []
  );

  useEffect(() => {
    let cancelled = false;
    void cordisApi
      .getHealth()
      .then(async nextHealth => {
        if (cancelled) return;
        setHealth(nextHealth);
        if (!nextHealth.ready) return;
        const [nextSessions, nextTools, nextCatalog] = await Promise.all([
          cordisApi.listSessions(),
          cordisApi.listTools(),
          cordisApi.getModels(),
        ]);
        if (cancelled) return;
        setSessions(nextSessions);
        setTools(nextTools);
        // Only provider-backed catalogue entries can be chosen by this engine.
        setCatalog({
          ...nextCatalog,
          models: nextCatalog.models.filter(
            model =>
              (model.providerType === 'ollama' &&
                model.id.startsWith('lwui:ollama:')) ||
              (model.providerType === 'plugin' &&
                model.id.startsWith('lwui:plugin:')) ||
              (model.providerType === 'dsh' && model.id.startsWith('native:'))
          ),
        });
        setNewSettings(previous => ({
          ...previous,
          model: previous.model ?? nextCatalog.defaultModel,
        }));
        setSelectedId(previous => previous ?? nextSessions[0]?.id ?? null);
      })
      .catch(error => {
        if (!cancelled)
          setHealth({
            enabled: true,
            ready: false,
            error: errorMessage(error, t('cordis.unavailableTitle')),
          });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, t]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    const version = ++sessionReadVersion.current;
    const approvalsVersion = ++approvalVersion.current;
    void cordisApi
      .getSession(selectedId)
      .then(next => {
        if (
          cancelled ||
          version !== sessionReadVersion.current ||
          activeTurnRef.current?.sessionId === next.id
        )
          return;
        setSession(next);
        if (approvalsVersion === approvalVersion.current)
          setApprovals(next.approvals ?? []);
        setSessionError(null);
      })
      .catch(error => {
        if (!cancelled && version === sessionReadVersion.current)
          setSessionError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, sessionAttempt]);

  const currentSession = session?.id === selectedId ? session : null;
  const active = sending || currentSession?.active === true;
  useEffect(() => {
    if (!selectedId || !currentSession?.active || sending) return;
    let cancelled = false;
    let reading = false;
    const timer = window.setInterval(() => {
      if (reading) return;
      reading = true;
      const approvalsVersion = ++approvalVersion.current;
      void cordisApi
        .getSession(selectedId)
        .then(next => {
          if (cancelled || approvalsVersion !== approvalVersion.current) return;
          setSession(next);
          setApprovals(next.approvals ?? []);
        })
        .catch(error => {
          if (!cancelled) setSessionError(String(error));
        })
        .finally(() => {
          reading = false;
        });
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedId, currentSession?.active, sending]);
  const messages = useMemo(
    () => currentSession?.messages ?? [],
    [currentSession]
  );
  const contexts = useMemo(() => messages.filter(isContext), [messages]);
  const conversation = useMemo(
    () => messages.filter(message => !isContext(message)),
    [messages]
  );
  const { toolResults, matchedResults, currentPendingCalls } = useMemo(() => {
    type Result = NonNullable<CordisMessage['toolResults']>[number];
    const results = new Map<string, Result>();
    const matched = new Set<Result>();
    const pending = new Map<string, string>();
    const currentCalls = new Set<string>();
    const lastUserIndex = conversation.reduce(
      (last, message, index) => (message.role === 'user' ? index : last),
      -1
    );
    // Providers may reuse a call ID in a later turn. Bind each result to its
    // nearest preceding call, rather than overwriting earlier cards.
    for (const [index, message] of conversation.entries()) {
      for (const call of message.toolCalls ?? []) {
        const key = toolMessageKey(message.id, call.callId);
        pending.set(call.callId, key);
        if (index > lastUserIndex) currentCalls.add(key);
      }
      for (const result of message.toolResults ?? []) {
        const key = pending.get(result.callId);
        if (!key) continue;
        results.set(key, result);
        matched.add(result);
        pending.delete(result.callId);
      }
    }
    return {
      toolResults: results,
      matchedResults: matched,
      currentPendingCalls: new Set(
        [...pending.values()].filter(key => currentCalls.has(key))
      ),
    };
  }, [conversation]);
  const settings = currentSession?.settings ?? newSettings;
  const controlsDisabled =
    loading ||
    active ||
    managingSession ||
    health?.ready !== true ||
    (selectedId !== null && currentSession === null);
  const composerDisabled = controlsDisabled || selectedId === null;
  const filteredSessions = sessions.filter(item =>
    `${item.title ?? ''} ${item.id}`
      .toLowerCase()
      .includes(search.toLowerCase())
  );
  const pendingToolStatus = (
    callId: string,
    name: string
  ): ToolActivity['status'] =>
    approvals.some(
      approval =>
        approval.sessionId === selectedId &&
        (approval.callId
          ? approval.callId === callId
          : approval.toolName === name)
    )
      ? 'awaiting_approval'
      : 'running';

  useEffect(() => {
    const viewport = transcriptRef.current;
    if (viewport && followTailRef.current)
      viewport.scrollTop = viewport.scrollHeight;
  }, [messages, streamText, streamReasoning, streamTools, approvals]);
  useEffect(() => {
    const input = composerRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 176)}px`;
  }, [draft]);

  const selectSession = (id: string) => {
    if (
      activeTurnRef.current ||
      managingSession ||
      decidingApproval ||
      stopping
    )
      return;
    setSelectedId(id);
    approvalVersion.current += 1;
    setTurnError(null);
    setSessionError(null);
    setSettingsError(null);
    setApprovals([]);
    setDraft('');
    followTailRef.current = true;
  };
  const handleCreate = async () => {
    if (activeTurnRef.current || managingSession) return;
    setManagingSession(true);
    try {
      const next = await cordisApi.createSession(newSettings);
      setSessions(previous => [next, ...previous]);
      setSelectedId(next.id);
      setSession(next);
      approvalVersion.current += 1;
      setApprovals(next.approvals ?? []);
      setTurnError(null);
      setSessionError(null);
      setSettingsError(null);
      setDraft('');
      followTailRef.current = true;
    } catch (error) {
      logger.error('creating a session failed', error);
      toast.error(t('cordis.createFailed'));
    } finally {
      setManagingSession(false);
    }
  };
  const handleDelete = async (id: string) => {
    if (activeTurnRef.current || managingSession) return;
    setManagingSession(true);
    try {
      await cordisApi.deleteSession(id);
      setSessions(previous => previous.filter(item => item.id !== id));
      if (selectedId === id) {
        setSelectedId(null);
        setSession(null);
        approvalVersion.current += 1;
        setApprovals([]);
        setTurnError(null);
        setSessionError(null);
        setDraft('');
      }
    } catch (error) {
      logger.error('deleting a session failed', error);
      toast.error(t('cordis.deleteFailed'));
    } finally {
      setManagingSession(false);
    }
  };
  const updateSettings = async (next: Partial<CordisSessionSettings>) => {
    if (controlsDisabled) return;
    if (!selectedId) {
      setNewSettings(previous => ({ ...previous, ...next }));
      return;
    }
    sessionReadVersion.current += 1;
    const approvalsVersion = ++approvalVersion.current;
    setManagingSession(true);
    setSettingsError(null);
    try {
      const updated = await cordisApi.updateSettings(selectedId, next);
      setSession(updated);
      if (approvalsVersion === approvalVersion.current)
        setApprovals(updated.approvals ?? []);
    } catch (error) {
      setSettingsError(errorMessage(error, t('chat.controls.saveFailed')));
    } finally {
      setManagingSession(false);
    }
  };
  const decideApproval = async (
    approval: CordisApproval,
    decision: 'allowed-once' | 'rejected'
  ) => {
    approvalVersion.current += 1;
    setDecidingApproval(approval.id);
    try {
      await cordisApi.decideApproval(approval.sessionId, approval.id, decision);
      approvalVersion.current += 1;
      setApprovals(previous =>
        previous.filter(item => item.id !== approval.id)
      );
    } catch (error) {
      logger.error('deciding a tool approval failed', error);
      toast.error(t('work.approval.failed'));
      const approvalsVersion = ++approvalVersion.current;
      const latest = await cordisApi
        .getSession(approval.sessionId)
        .catch(() => null);
      if (latest && approvalsVersion === approvalVersion.current)
        setApprovals(latest.approvals ?? []);
    } finally {
      setDecidingApproval(null);
    }
  };

  const handleSend = useCallback(
    async (retryText?: string) => {
      const text = (retryText ?? draft).trim();
      if (
        !selectedId ||
        !text ||
        activeTurnRef.current ||
        managingSession ||
        session?.id !== selectedId
      )
        return;
      const turn: ActiveTurn = {
        sessionId: selectedId,
        controller: new AbortController(),
      };
      sessionReadVersion.current += 1;
      activeTurnRef.current = turn;
      const isCurrent = () => activeTurnRef.current === turn;
      setDraft('');
      setLastPrompt(text);
      setSending(true);
      setStreamText('');
      setStreamReasoning('');
      setStreamTools([]);
      setTurnError(null);
      followTailRef.current = true;
      setSession({
        ...session,
        messages: [
          ...session.messages,
          { id: `pending-${Date.now()}`, role: 'user', source: 'user', text },
        ],
      });
      let reportedFailure = false;
      try {
        await cordisApi.sendMessage(selectedId, text, {
          signal: turn.controller.signal,
          onChunk: chunk => {
            if (!isCurrent()) return;
            if (chunk.type === 'text')
              setStreamText(previous => previous + chunk.text);
            if (chunk.type === 'reasoning')
              setStreamReasoning(previous => previous + chunk.text);
            if (chunk.type === 'error') {
              reportedFailure = true;
              setTurnError(chunk.message);
            }
            if (chunk.type === 'tool-call' || chunk.type === 'tool-result') {
              const instanceId = ++toolInstance.current;
              setStreamTools(previous => {
                if (chunk.type === 'tool-call')
                  return [
                    ...previous,
                    {
                      instanceId,
                      callId: chunk.callId,
                      name: chunk.name,
                      arguments: chunk.arguments,
                      status: 'running',
                    },
                  ];
                const index = previous.reduce(
                  (last, tool, index) =>
                    tool.callId === chunk.callId && tool.status === 'running'
                      ? index
                      : last,
                  -1
                );
                const updated: ToolActivity = {
                  instanceId,
                  ...previous[index],
                  callId: chunk.callId,
                  name: chunk.name,
                  output: chunk.output,
                  status: chunk.isError ? 'failed' : 'succeeded',
                };
                return index < 0
                  ? [...previous, updated]
                  : previous.map((tool, position) =>
                      position === index ? updated : tool
                    );
              });
            }
            if (chunk.type === 'approval-request') {
              approvalVersion.current += 1;
              setApprovals(previous => [
                ...previous.filter(item => item.id !== chunk.approval.id),
                chunk.approval,
              ]);
            }
            if (chunk.type === 'approval-decision') {
              approvalVersion.current += 1;
              setApprovals(previous =>
                previous.filter(item => item.id !== chunk.approvalId)
              );
            }
          },
        });
      } catch (error) {
        if (isCurrent() && !turn.controller.signal.aborted && !reportedFailure)
          setTurnError(
            error instanceof Error ? error.message : t('cordis.sendFailed')
          );
      } finally {
        if (isCurrent()) {
          await turn.cancellation?.catch(() => undefined);
          try {
            const approvalsVersion = ++approvalVersion.current;
            const [updated, refreshed] = await Promise.all([
              cordisApi.getSession(turn.sessionId),
              cordisApi.listSessions(),
            ]);
            if (isCurrent()) {
              setSession(updated);
              setSessions(refreshed);
              if (approvalsVersion === approvalVersion.current)
                setApprovals(updated.approvals ?? []);
            }
          } catch (error) {
            logger.error('refreshing a completed turn failed', error);
            if (isCurrent()) setSessionError(String(error));
          }
          if (isCurrent()) {
            activeTurnRef.current = null;
            setSending(false);
            setStopping(false);
            setStreamText('');
            setStreamReasoning('');
            setStreamTools([]);
          }
        }
      }
    },
    [draft, managingSession, selectedId, session, t]
  );
  const handleStop = async () => {
    const turn = activeTurnRef.current;
    if (turn?.cancellation || (!turn && !currentSession?.active)) return;
    setStopping(true);
    try {
      if (turn) {
        await cancelTurn(turn);
        turn.controller.abort();
      } else if (selectedId) {
        await cordisApi.cancel(selectedId);
        const approvalsVersion = ++approvalVersion.current;
        const updated = await cordisApi.getSession(selectedId);
        setSession(updated);
        if (approvalsVersion === approvalVersion.current)
          setApprovals(updated.approvals ?? []);
        setStopping(false);
      }
    } catch (error) {
      logger.error('cancelling a turn failed', error);
      if (activeTurnRef.current === turn) {
        setStopping(false);
        toast.error(t('cordis.sendFailed'));
      }
    }
  };

  const modelOptions = catalog.models.map(model => ({
    value: model.id,
    label: model.providerName
      ? `${model.name} · ${model.providerName}`
      : model.name,
  }));
  if (
    settings.model &&
    !modelOptions.some(option => option.value === settings.model)
  )
    modelOptions.unshift({ value: settings.model, label: settings.model });
  if (!modelOptions.length)
    modelOptions.push({ value: '', label: t('models.noModelsFound') });

  return (
    <div
      className='flex h-full min-h-0 flex-col bg-surface'
      data-testid='cordis-page'
    >
      <header className='flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-6'>
        <div className='min-w-0'>
          <h1 className='truncate text-lg font-medium text-ink'>
            {t('cordis.title')}
          </h1>
          <p className='truncate text-xs text-ink-muted'>
            {currentSession?.title ?? t('cordis.description')}
          </p>
        </div>
        <Button
          variant='outline'
          size='sm'
          onClick={() => void handleCreate()}
          disabled={
            loading ||
            health?.ready !== true ||
            sending ||
            managingSession ||
            decidingApproval !== null ||
            stopping
          }
          data-testid='cordis-create-session'
        >
          <MessageSquarePlus className='me-2 h-4 w-4' aria-hidden='true' />
          {t('cordis.newSession')}
        </Button>
      </header>
      {!loading && health?.ready !== true && (
        <div
          role='status'
          data-testid='cordis-unavailable'
          className='m-4 rounded-xl border border-line bg-surface-subtle p-4 text-sm'
        >
          <p className='font-medium text-ink'>
            {health?.enabled
              ? t('cordis.unavailableTitle')
              : t('cordis.disabledTitle')}
          </p>
          <p className='mt-1 text-ink-muted'>
            {health?.error ?? t('cordis.disabledHint')}
          </p>
          <Button
            className='mt-3'
            variant='outline'
            size='sm'
            onClick={() => {
              setLoading(true);
              setLoadAttempt(value => value + 1);
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      )}
      <div className='flex min-h-0 flex-1 flex-col lg:flex-row'>
        <aside
          aria-label={t('cordis.sessionsHeading')}
          className='shrink-0 border-b border-line bg-surface-subtle/30 lg:flex lg:w-64 lg:min-h-0 lg:flex-col lg:border-b-0 lg:border-e'
        >
          <div className='hidden px-4 pt-4 lg:block'>
            <label className='sr-only' htmlFor='cordis-session-search'>
              {t('common.search')}
            </label>
            <div className='relative'>
              <Search
                className='pointer-events-none absolute start-3 top-3 h-4 w-4 text-ink-muted'
                aria-hidden='true'
              />
              <Input
                id='cordis-session-search'
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder={t('common.search')}
                className='ps-9'
              />
            </div>
          </div>
          <div className='min-h-0 overflow-auto p-2 lg:flex-1 lg:p-3'>
            <ul
              className='flex gap-1 lg:block lg:space-y-1'
              data-testid='cordis-session-list'
            >
              {filteredSessions.map(item => (
                <li key={item.id} className='min-w-44 lg:min-w-0'>
                  <div
                    className={cn(
                      'flex items-center gap-1 rounded-lg px-2 py-2',
                      selectedId === item.id
                        ? 'bg-surface-raised'
                        : 'hover:bg-surface-subtle'
                    )}
                  >
                    <button
                      type='button'
                      onClick={() => selectSession(item.id)}
                      disabled={
                        sending ||
                        managingSession ||
                        decidingApproval !== null ||
                        stopping
                      }
                      aria-current={selectedId === item.id}
                      aria-label={item.title ?? item.id}
                      className={cn(
                        'min-w-0 flex-1 text-start disabled:opacity-60',
                        focusRing
                      )}
                    >
                      <span className='block truncate text-sm text-ink'>
                        {item.title ?? t('cordis.newSession')}
                      </span>
                      <span className='mt-0.5 block truncate text-xs text-ink-muted'>
                        {item.createdAt
                          ? formatTimestamp(item.createdAt)
                          : t('cordis.unknownTime')}
                      </span>
                    </button>
                    <Button
                      variant='ghost'
                      size='sm'
                      aria-label={t('cordis.deleteSession')}
                      disabled={
                        sending ||
                        managingSession ||
                        decidingApproval !== null ||
                        stopping
                      }
                      onClick={() => void handleDelete(item.id)}
                    >
                      <Trash2 className='h-3.5 w-3.5' aria-hidden='true' />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            {!sessions.length && health?.ready && (
              <p className='p-2 text-xs text-ink-muted'>
                {t('cordis.noSessions')}
              </p>
            )}
            {sessions.length > 0 && !filteredSessions.length && (
              <p className='p-2 text-xs text-ink-muted'>
                {t('common.noResults')}
              </p>
            )}
          </div>
          <details
            className='hidden shrink-0 border-t border-line p-4 lg:block'
            data-testid='cordis-tools-disclosure'
          >
            <summary
              className={cn('cursor-pointer text-xs text-ink-muted', focusRing)}
            >
              {t('cordis.toolsHeading')} ({tools.length})
            </summary>
            <ul
              className='mt-3 max-h-48 space-y-3 overflow-y-auto'
              data-testid='cordis-tool-list'
            >
              {tools.map(tool => (
                <li key={tool.name}>
                  <span dir='ltr' className='block font-mono text-xs text-ink'>
                    {tool.name}
                  </span>
                  <p className='mt-1 text-xs text-ink-muted'>
                    {tool.description}
                  </p>
                </li>
              ))}
            </ul>
            {!tools.length && (
              <p className='mt-2 text-xs text-ink-muted'>
                {t('cordis.noTools')}
              </p>
            )}
          </details>
        </aside>
        <section
          aria-label={t('cordis.transcriptHeading')}
          className='flex min-h-0 min-w-0 flex-1 flex-col'
          data-testid='cordis-transcript'
        >
          <div
            ref={transcriptRef}
            data-testid='cordis-transcript-scroll'
            className='scroll-region min-h-0 flex-1 px-4 py-5 sm:px-6'
            onScroll={event => {
              const node = event.currentTarget;
              followTailRef.current =
                node.scrollHeight - node.scrollTop - node.clientHeight < 80;
            }}
          >
            <div className='mx-auto max-w-3xl space-y-5'>
              {loading && (
                <p role='status' className='text-sm text-ink-muted'>
                  {t('common.loading')}
                </p>
              )}
              {selectedId === null && !loading && (
                <div className='py-12 text-center'>
                  <Bot
                    className='mx-auto mb-3 h-7 w-7 text-ink-muted'
                    aria-hidden='true'
                  />
                  <p className='text-sm text-ink-muted'>
                    {t('cordis.selectSession')}
                  </p>
                </div>
              )}
              {contexts.length > 0 && (
                <details
                  data-testid='cordis-context'
                  className='rounded-xl border border-line bg-surface-subtle p-3'
                >
                  <summary
                    className={cn(
                      'cursor-pointer text-xs text-ink-muted',
                      focusRing
                    )}
                  >
                    {t('cordis.context')}
                  </summary>
                  <div className='mt-3 space-y-4'>
                    {contexts.map(message => (
                      <pre
                        key={message.id}
                        dir='auto'
                        className='max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs text-ink-muted'
                      >
                        {message.text}
                      </pre>
                    ))}
                  </div>
                </details>
              )}
              {conversation.map(message => (
                <div key={message.id} className='space-y-3'>
                  {(message.text || message.reasoning) &&
                    !message.toolResults?.length && (
                      <MessageBubble message={message} />
                    )}
                  {message.toolCalls?.map(call => {
                    const key = toolMessageKey(message.id, call.callId);
                    const result = toolResults.get(key);
                    return (
                      <ToolCard
                        key={call.callId}
                        tool={{
                          ...call,
                          output: result?.output,
                          status: result
                            ? result.isError
                              ? 'failed'
                              : 'succeeded'
                            : active && currentPendingCalls.has(key)
                              ? pendingToolStatus(call.callId, call.name)
                              : 'cancelled',
                        }}
                      />
                    );
                  })}
                  {message.toolResults
                    ?.filter(result => !matchedResults.has(result))
                    .map(result => (
                      <ToolCard
                        key={result.callId}
                        tool={{
                          ...result,
                          name: result.name ?? t('cordis.role.tool'),
                          status: result.isError ? 'failed' : 'succeeded',
                        }}
                      />
                    ))}
                </div>
              ))}
              {sending && (streamText || streamReasoning) && (
                <MessageBubble
                  streaming
                  message={{
                    id: 'stream',
                    role: 'assistant',
                    text: streamText,
                    reasoning: streamReasoning,
                  }}
                />
              )}
              {streamTools.map(tool => (
                <ToolCard
                  key={tool.instanceId}
                  tool={
                    tool.status === 'running'
                      ? {
                          ...tool,
                          status: pendingToolStatus(tool.callId, tool.name),
                        }
                      : tool
                  }
                />
              ))}
              {approvals
                .filter(approval => approval.sessionId === selectedId)
                .map(approval => (
                  <div
                    key={approval.id}
                    role='alert'
                    data-testid='cordis-approval'
                    className='rounded-xl border border-warning-500/40 bg-surface-subtle p-4'
                  >
                    <p className='mb-2 flex items-center gap-2 text-sm font-medium text-ink'>
                      <Shield className='h-4 w-4' aria-hidden='true' />
                      {t('work.approval.title')}
                    </p>
                    <p className='text-sm text-ink'>
                      {t('work.approval.description', {
                        tool: approval.toolName,
                      })}
                    </p>
                    {approval.reason && (
                      <p className='mt-2 whitespace-pre-wrap text-xs text-ink-muted'>
                        {approval.reason}
                      </p>
                    )}
                    <div className='mt-3 flex gap-2'>
                      <Button
                        size='sm'
                        disabled={decidingApproval !== null}
                        onClick={() =>
                          void decideApproval(approval, 'allowed-once')
                        }
                      >
                        {t('work.approval.allowOnce')}
                      </Button>
                      <Button
                        size='sm'
                        variant='outline'
                        disabled={decidingApproval !== null}
                        onClick={() =>
                          void decideApproval(approval, 'rejected')
                        }
                      >
                        {t('work.approval.deny')}
                      </Button>
                    </div>
                  </div>
                ))}
              {turnError && (
                <div
                  role='alert'
                  data-testid='cordis-turn-error'
                  className='rounded-xl border border-error-500/40 bg-error-500/10 p-4 text-sm text-ink'
                >
                  <p className='font-medium'>{t('cordis.turnFailed')}</p>
                  <p className='mt-1 whitespace-pre-wrap break-words'>
                    {turnError}
                  </p>
                  {!active && lastPrompt && (
                    <Button
                      className='mt-3'
                      variant='outline'
                      size='sm'
                      onClick={() => void handleSend(lastPrompt)}
                    >
                      {t('common.retry')}
                    </Button>
                  )}
                </div>
              )}
              {sessionError && (
                <div
                  role='alert'
                  className='rounded-xl border border-line p-4 text-sm text-ink'
                >
                  <p>{sessionError}</p>
                  <Button
                    className='mt-2'
                    size='sm'
                    variant='outline'
                    disabled={sending}
                    onClick={() => {
                      setSessionError(null);
                      setSessionAttempt(value => value + 1);
                    }}
                  >
                    {t('common.retry')}
                  </Button>
                </div>
              )}
              {active &&
                !streamText &&
                !streamReasoning &&
                !approvals.length && (
                  <p
                    role='status'
                    className='flex items-center gap-2 text-sm text-ink-muted'
                  >
                    <Bot className='h-4 w-4' aria-hidden='true' />
                    {t('cordis.working')}
                  </p>
                )}
            </div>
          </div>
          <form
            className='shrink-0 border-t border-line px-4 py-3 sm:px-6'
            onSubmit={event => {
              event.preventDefault();
              void handleSend();
            }}
          >
            <div className='mx-auto max-w-3xl'>
              <div className='mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2'>
                <Select
                  label={t('cordis.permissions')}
                  data-testid='cordis-permission-select'
                  value={settings.permissionMode}
                  options={[
                    { value: 'read-only', label: t('cordis.readOnly') },
                    {
                      value: 'workspace-write',
                      label: t('cordis.workspaceWrite'),
                    },
                  ]}
                  disabled={
                    controlsDisabled ||
                    (selectedId !== null &&
                      currentSession?.capabilities?.permissions !== true)
                  }
                  onChange={event =>
                    void updateSettings({
                      permissionMode: event.target
                        .value as CordisSessionSettings['permissionMode'],
                    })
                  }
                  className='py-2 text-sm'
                />
                <Select
                  label={t('personas.model')}
                  dir='ltr'
                  data-testid='cordis-model-select'
                  value={settings.model ?? catalog.defaultModel ?? ''}
                  options={modelOptions}
                  disabled={controlsDisabled || !catalog.models.length}
                  onChange={event =>
                    void updateSettings({ model: event.target.value })
                  }
                  className='py-2 text-sm'
                />
              </div>
              <p className='mb-3 text-xs text-ink-muted'>
                {t('cordis.permissionHint')}
              </p>
              {currentSession?.workspacePath && (
                <p
                  className='mb-3 flex min-w-0 gap-2 text-xs text-ink-muted'
                  data-testid='cordis-workspace-scope'
                >
                  <span>{t('work.mobile.workspace')}</span>
                  <code
                    dir='ltr'
                    title={currentSession.workspacePath}
                    className='truncate'
                  >
                    {currentSession.workspacePath}
                  </code>
                </p>
              )}
              {settingsError && (
                <p
                  role='alert'
                  className='mb-2 text-xs text-error-600 dark:text-error-400'
                >
                  {settingsError}
                </p>
              )}
              <div className={composerSurfaceClass}>
                <label htmlFor='cordis-composer' className='sr-only'>
                  {t('cordis.composerLabel')}
                </label>
                <Textarea
                  ref={composerRef}
                  id='cordis-composer'
                  dir='auto'
                  value={draft}
                  onChange={event => setDraft(event.target.value)}
                  placeholder={t('cordis.composerPlaceholder')}
                  rows={2}
                  disabled={composerDisabled}
                  data-testid='cordis-composer'
                  className='min-h-16 max-h-44 resize-none border-0 bg-transparent shadow-none focus:ring-0'
                  onKeyDown={event => {
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void handleSend();
                    }
                  }}
                />
                <div className='mt-2 flex items-center justify-end gap-2'>
                  {managingSession && (
                    <span
                      role='status'
                      className='me-auto text-xs text-ink-muted'
                    >
                      {t('common.saving')}
                    </span>
                  )}
                  {active ? (
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      onClick={() => void handleStop()}
                      disabled={stopping}
                      data-testid='cordis-stop'
                    >
                      <Square className='me-2 h-4 w-4' aria-hidden='true' />
                      {t('cordis.stop')}
                    </Button>
                  ) : (
                    <Button
                      type='submit'
                      size='sm'
                      disabled={composerDisabled || !draft.trim()}
                      data-testid='cordis-send'
                    >
                      <Send className='me-2 h-4 w-4' aria-hidden='true' />
                      {t('cordis.send')}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
};
export default CordisPage;
