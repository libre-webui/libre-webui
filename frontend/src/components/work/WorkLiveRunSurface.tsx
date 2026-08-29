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

import {
  Brain,
  Check,
  ChevronDown,
  CircleAlert,
  LoaderCircle,
  Sparkles,
  TerminalSquare,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StreamingMessageContent } from '@/components/ui/StreamingMessageContent';
import { WorkRunStats } from '@/components/work/WorkRunStats';
import type {
  WorkLiveRun,
  WorkLiveSegment,
  WorkLiveToolActivity,
  WorkLiveRunPhase,
} from '@/types/work';
import { cn } from '@/utils';
import { recordWorkSkillTrace } from '@/utils/api/workScreen';

interface WorkLiveRunSurfaceProps {
  run: WorkLiveRun;
  variant?: 'conversation' | 'activity';
}

const serializeDetail = (value: unknown): string | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const formatElapsed = (milliseconds: number): string => {
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}:${String(seconds).padStart(2, '0')}`
    : `${seconds}s`;
};

const approximateTokenCount = (content: string): number => {
  if (!content) return 0;
  const characters = Array.from(content).length;
  const words = content.trim() ? content.trim().split(/\s+/u).length : 0;
  return Math.max(words, Math.ceil(characters / 4));
};

function ElapsedTime({ run }: { run: WorkLiveRun }) {
  const [now, setNow] = useState<number>();
  useEffect(() => {
    if (run.terminal || !run.startedAt) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run.startedAt, run.terminal]);
  if (!run.startedAt) return null;
  const end = run.finishedAt || now;
  if (!end) return null;
  return (
    <span dir='ltr' className='tabular-nums text-ink-subtle' aria-hidden='true'>
      {formatElapsed(end - run.startedAt)}
    </span>
  );
}

export function ToolActivityRow({
  tool,
  expandedByDefault,
}: {
  tool: WorkLiveToolActivity;
  expandedByDefault: boolean;
}) {
  const { t } = useTranslation();
  const [initialStatus] = useState(tool.status);
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const argumentsText = useMemo(
    () => serializeDetail(tool.arguments),
    [tool.arguments]
  );
  const outputText = tool.output || null;
  const hasDetails = Boolean(argumentsText || outputText);
  const error = tool.status === 'error';
  const running = tool.status === 'running';
  const detailId = useId();
  const kindLabel = error
    ? t('work.activity.kinds.error', { defaultValue: 'Error' })
    : running
      ? t('work.activity.kinds.toolCall', { defaultValue: 'Tool call' })
      : t('work.activity.kinds.toolResult', { defaultValue: 'Tool result' });
  const expanded =
    userExpanded ??
    (tool.status === initialStatus
      ? expandedByDefault
      : tool.status === 'error');

  return (
    <div
      data-testid='work-live-tool'
      data-tool-id={tool.id}
      className={cn(
        'overflow-hidden rounded-xl border bg-surface-raised transition-colors',
        error ? 'border-error-500/30' : 'border-line'
      )}
    >
      <button
        type='button'
        disabled={!hasDetails}
        onClick={() => {
          setUserExpanded(!expanded);
        }}
        aria-expanded={hasDetails ? expanded : undefined}
        aria-controls={hasDetails ? detailId : undefined}
        aria-label={`${kindLabel}: ${tool.name}`}
        className='flex min-h-10 w-full items-center gap-2 px-3 py-2 text-start outline-none hover:bg-surface-subtle focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 disabled:cursor-default disabled:hover:bg-transparent'
      >
        <span className='flex h-5 w-5 shrink-0 items-center justify-center'>
          {error ? (
            <CircleAlert className='h-3.5 w-3.5 text-error-500' />
          ) : running ? (
            <LoaderCircle className='h-3.5 w-3.5 animate-spin text-[rgb(48,121,255)] motion-reduce:animate-none' />
          ) : (
            <Check className='h-3.5 w-3.5 text-[rgb(76,212,117)]' />
          )}
        </span>
        <span
          dir='ltr'
          className='min-w-0 flex-1 truncate font-mono text-xs text-ink'
        >
          {tool.name}
        </span>
        {tool.durationMs !== undefined && (
          <span className='shrink-0 text-[10px] tabular-nums text-ink-subtle'>
            {formatElapsed(tool.durationMs)}
          </span>
        )}
        {hasDetails && (
          <ChevronDown
            aria-hidden='true'
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-ink-subtle transition-transform',
              expanded && 'rotate-180'
            )}
          />
        )}
      </button>
      {hasDetails && expanded && (
        <div
          id={detailId}
          className='border-t border-line bg-surface-subtle/50'
        >
          {argumentsText && (
            <pre
              dir='ltr'
              className='max-h-48 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 text-left font-mono text-[11px] leading-relaxed text-ink-muted'
            >
              {argumentsText}
            </pre>
          )}
          {outputText && (
            <pre
              dir='ltr'
              className={cn(
                'max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-line px-3 py-2.5 text-left font-mono text-[11px] leading-relaxed',
                error ? 'text-error-600' : 'text-ink-muted'
              )}
            >
              {outputText}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

const lastThoughtLine = (content: string): string => {
  const lines = content.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line) return line;
  }
  return '';
};

function ThinkingBlock({
  content,
  streaming,
}: {
  content: string;
  streaming: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const preview = streaming && !expanded ? lastThoughtLine(content) : '';
  return (
    <details
      data-testid='work-live-reasoning'
      open={expanded}
      onToggle={event => setExpanded(event.currentTarget.open)}
      className='group overflow-hidden rounded-xl border border-line bg-surface-subtle/70'
    >
      <summary className='flex cursor-pointer list-none flex-col gap-1 px-3 py-2 marker:hidden [&::-webkit-details-marker]:hidden'>
        <span className='flex items-center justify-between gap-3 text-xs font-medium text-ink-muted'>
          <span className='flex min-w-0 items-center gap-2'>
            <Brain
              className={cn(
                'h-3.5 w-3.5 shrink-0 text-[rgb(48,121,255)]',
                streaming && 'animate-pulse-subtle motion-reduce:animate-none'
              )}
            />
            {streaming ? (
              <span className='animate-shimmer truncate bg-gradient-to-r from-ink-subtle via-ink to-ink-subtle bg-[length:200%_100%] bg-clip-text text-transparent motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-ink-muted'>
                {t('work.statusLabels.thinking', {
                  defaultValue: 'Thinking',
                })}
                …
              </span>
            ) : (
              <span className='truncate'>
                {t('libreClaw.metrics.reasoning', {
                  defaultValue: 'Reasoning',
                })}
              </span>
            )}
          </span>
          <ChevronDown className='h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180' />
        </span>
        {preview && (
          <span
            dir='auto'
            data-testid='work-live-reasoning-preview'
            className='block truncate text-[11px] leading-relaxed text-ink-subtle'
          >
            {preview}
          </span>
        )}
      </summary>
      <div className='border-t border-line px-3 py-2.5'>
        <StreamingMessageContent
          content={content}
          isStreaming={streaming}
          className='text-xs text-ink-muted'
        />
      </div>
    </details>
  );
}

const phaseLabel = (
  phase: WorkLiveRunPhase,
  t: ReturnType<typeof useTranslation>['t'],
  activeTool?: WorkLiveToolActivity
): string => {
  if (phase === 'queued' || phase === 'preparing') {
    return t('work.status.preparing', {
      defaultValue: 'Preparing isolated workspace…',
    });
  }
  if (phase === 'using_tool') {
    return activeTool?.name
      ? `${t('work.activity.toolActivity', {
          defaultValue: 'Tool activity',
        })} · ${activeTool.name}`
      : t('work.activity.toolActivity', { defaultValue: 'Tool activity' });
  }
  if (phase === 'completed') {
    return t('work.statusLabels.complete', { defaultValue: 'Complete' });
  }
  if (phase === 'needs_input') {
    return t('work.statusLabels.needsInput', {
      defaultValue: 'Needs input',
    });
  }
  if (phase === 'failed') {
    return t('work.statusLabels.error', { defaultValue: 'Error' });
  }
  if (phase === 'cancelled') {
    return t('work.statusLabels.needsInput', {
      defaultValue: 'Needs input',
    });
  }
  if (phase === 'responding') {
    return t('work.status.running', {
      defaultValue: 'Working in the local workspace…',
    });
  }
  return t('work.statusLabels.thinking', { defaultValue: 'Thinking' });
};

const connectionLabel = (
  connection: WorkLiveRun['connection'],
  t: ReturnType<typeof useTranslation>['t']
): string | undefined => {
  if (connection === 'connecting') {
    return t('work.live.connecting', {
      defaultValue: 'Connecting to live updates…',
    });
  }
  if (connection === 'reconnecting') {
    return t('work.live.reconnecting', {
      defaultValue: 'Reconnecting to live updates…',
    });
  }
  if (connection === 'error') {
    return t('work.live.unavailable', {
      defaultValue: 'Live updates unavailable',
    });
  }
  return undefined;
};

export function WorkLiveRunSurface({
  run,
  variant = 'conversation',
}: WorkLiveRunSurfaceProps) {
  const { t } = useTranslation();
  const activeTool = [...run.tools]
    .reverse()
    .find(tool => tool.status === 'running');
  const label =
    connectionLabel(run.connection, t) || phaseLabel(run.phase, t, activeTool);
  const active = !run.terminal;
  const [skillTraces, setSkillTraces] = useState<
    Record<string, 'success' | 'failure'>
  >({});
  const recordSkillTraceClick = useCallback(
    (slug: string, outcome: 'success' | 'failure') => {
      setSkillTraces(current => ({ ...current, [slug]: outcome }));
      recordWorkSkillTrace(slug, outcome).catch(() => {
        setSkillTraces(current => {
          const next = { ...current };
          delete next[slug];
          return next;
        });
      });
    },
    []
  );
  const exactOutputTokens = run.usage?.outputTokens;
  const liveTokenContent = run.reasoning + run.response;
  const outputTokens =
    exactOutputTokens !== undefined && exactOutputTokens > 0
      ? exactOutputTokens
      : liveTokenContent
        ? approximateTokenCount(liveTokenContent)
        : exactOutputTokens;
  const outputTokensApproximate =
    (exactOutputTokens === undefined || exactOutputTokens === 0) &&
    Boolean(liveTokenContent) &&
    outputTokens !== undefined;
  const tokensPerSecond = run.usage?.tokensPerSecond;

  return (
    <section
      data-testid='work-live-run'
      data-run-id={run.runId}
      data-phase={run.phase}
      aria-busy={active || undefined}
      className={cn(
        'min-w-0',
        variant === 'activity' &&
          'rounded-2xl border border-line bg-surface p-3 shadow-subtle'
      )}
    >
      <div className='mb-3 flex min-h-6 items-center gap-2 text-xs'>
        <span
          aria-hidden='true'
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            run.phase === 'failed'
              ? 'bg-[rgb(255,61,129)]'
              : run.phase === 'completed'
                ? 'bg-[rgb(76,212,117)]'
                : run.phase === 'needs_input' || run.phase === 'cancelled'
                  ? 'bg-[rgb(255,204,0)]'
                  : run.connection === 'error'
                    ? 'bg-[rgb(255,61,129)]'
                    : 'bg-[rgb(48,121,255)]',
            active && 'animate-pulse motion-reduce:animate-none'
          )}
        />
        <span
          dir='auto'
          title={run.connectionError}
          className='min-w-0 flex-1 truncate font-medium text-ink-muted'
        >
          {label}
        </span>
        {run.round !== undefined && (
          <span dir='ltr' className='shrink-0 tabular-nums text-ink-subtle'>
            {run.roundLimit !== undefined
              ? `${run.round}/${run.roundLimit}`
              : `#${run.round}`}
          </span>
        )}
        <ElapsedTime run={run} />
      </div>

      {variant === 'conversation' && (
        <span
          className='sr-only'
          role='status'
          aria-live='polite'
          aria-atomic='true'
        >
          {label}
        </span>
      )}

      {run.skills.length > 0 && (
        <div className='mb-3 flex flex-wrap items-center gap-1.5'>
          <span className='inline-flex items-center gap-1 rounded-full border border-line bg-surface-raised px-2 py-1 text-[10px] text-ink-muted'>
            <Sparkles className='h-3 w-3 text-primary-500' aria-hidden='true' />
            <span dir='auto'>
              {t('work.live.skillsLoaded', {
                count: run.skills.length,
                defaultValue: 'Workspace skills · {{count}}',
              })}
            </span>
          </span>
          {/* A finished run is the user's chance to grade taught procedures:
              each review click appends a dated line to the skill's Track
              record and creates a reviewable version. */}
          {run.terminal &&
            run.skills
              .filter(skill => skill.id.startsWith('taught:'))
              .map(skill => {
                const slug = skill.id.slice('taught:'.length);
                const traced = skillTraces[slug];
                return (
                  <span
                    key={skill.id}
                    className='inline-flex items-center gap-1 rounded-full border border-line bg-surface-raised px-2 py-1 text-[10px] text-ink-muted'
                  >
                    <span dir='auto'>{skill.name}</span>
                    {traced ? (
                      <span className='text-primary-500'>
                        {t('work.live.skillTraceSaved', {
                          defaultValue: 'noted',
                        })}
                      </span>
                    ) : (
                      <>
                        <button
                          type='button'
                          data-testid={`skill-trace-success-${slug}`}
                          aria-label={t('work.live.skillWorked', {
                            defaultValue: 'This procedure worked',
                          })}
                          title={t('work.live.skillWorked', {
                            defaultValue: 'This procedure worked',
                          })}
                          onClick={() => recordSkillTraceClick(slug, 'success')}
                          className='rounded px-1 hover:text-primary-600'
                        >
                          ✓
                        </button>
                        <button
                          type='button'
                          data-testid={`skill-trace-failure-${slug}`}
                          aria-label={t('work.live.skillFailed', {
                            defaultValue: 'This procedure failed',
                          })}
                          title={t('work.live.skillFailed', {
                            defaultValue: 'This procedure failed',
                          })}
                          onClick={() => recordSkillTraceClick(slug, 'failure')}
                          className='rounded px-1 hover:text-red-600'
                        >
                          ✕
                        </button>
                      </>
                    )}
                  </span>
                );
              })}
        </div>
      )}

      {variant === 'conversation'
        ? run.timeline.length > 0 && (
            <div data-testid='work-live-timeline' className='space-y-2'>
              {run.timeline.map((segment: WorkLiveSegment, index) => {
                const isLast = index === run.timeline.length - 1;
                if (segment.kind === 'reasoning') {
                  return (
                    <ThinkingBlock
                      key={`segment-${index}`}
                      content={segment.text}
                      streaming={active && isLast}
                    />
                  );
                }
                if (segment.kind === 'tool') {
                  const tool = run.tools.find(
                    candidate => candidate.id === segment.toolId
                  );
                  if (!tool) return null;
                  return (
                    <ToolActivityRow
                      key={tool.id}
                      tool={tool}
                      expandedByDefault={tool.status === 'error'}
                    />
                  );
                }
                return (
                  <StreamingMessageContent
                    key={`segment-${index}`}
                    content={segment.text}
                    isStreaming={active && isLast}
                    className='text-ink'
                  />
                );
              })}
            </div>
          )
        : run.tools.length > 0 && (
            <div data-testid='work-live-tools' className='space-y-1.5'>
              {run.tools.map(tool => (
                <ToolActivityRow
                  key={tool.id}
                  tool={tool}
                  expandedByDefault={
                    tool.status === 'running' || tool.status === 'error'
                  }
                />
              ))}
            </div>
          )}

      {run.error && (
        <div
          role='alert'
          dir='auto'
          className='mt-3 flex items-start gap-2 rounded-xl border border-error-500/30 bg-error-500/10 px-3 py-2.5 text-xs leading-relaxed text-error-600'
        >
          <CircleAlert className='mt-0.5 h-3.5 w-3.5 shrink-0' />
          <span>{run.error}</span>
        </div>
      )}

      {(outputTokens !== undefined || tokensPerSecond !== undefined) && (
        <div className='mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2 text-[10px] tabular-nums text-ink-subtle'>
          {outputTokens !== undefined && (
            <span dir='auto'>
              {t('generationStats.generatedTokens', {
                defaultValue: 'Generated tokens:',
              })}{' '}
              <bdi dir='ltr'>
                {outputTokensApproximate && '≈'}
                {outputTokens.toLocaleString()}
              </bdi>
            </span>
          )}
          {tokensPerSecond !== undefined && (
            <span dir='auto'>
              {t('generationStats.speed', { defaultValue: 'Speed:' })}{' '}
              <bdi dir='ltr'>{tokensPerSecond.toFixed(1)} t/s</bdi>
            </span>
          )}
        </div>
      )}

      {run.terminal && run.loopStats && (
        <WorkRunStats
          stats={run.loopStats}
          budgetReason={run.budgetReason}
          className='mt-2'
        />
      )}

      {active && !run.reasoning && !run.response && run.tools.length === 0 && (
        <div
          aria-hidden='true'
          className='flex h-5 items-center gap-1 text-[rgb(48,121,255)]'
        >
          <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none' />
          <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:160ms] motion-reduce:animate-none' />
          <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:320ms] motion-reduce:animate-none' />
        </div>
      )}

      {variant === 'activity' && run.tools.length === 0 && (
        <div className='flex items-center gap-2 text-xs text-ink-muted'>
          <TerminalSquare className='h-3.5 w-3.5' />
          {t('work.activity.empty', {
            defaultValue:
              'Commands, file operations, and tool results will appear here.',
          })}
        </div>
      )}
    </section>
  );
}
