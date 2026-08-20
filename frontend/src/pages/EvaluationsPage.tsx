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

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import {
  Download,
  Loader2,
  Play,
  Plus,
  Swords,
  Trash2,
  Trophy,
  X,
} from 'lucide-react';
import { Button, PageHeader, PageShell } from '@/components/ui';
import { useChatStore } from '@/store/chatStore';
import {
  evaluationsApi,
  type ArenaLeaderboardRow,
  type ArenaMatch,
  type EvalRunView,
  type EvalSetView,
  type FeedbackView,
} from '@/utils/api/evaluationsApi';
import { cn } from '@/utils';

type EvaluationsTab = 'arena' | 'leaderboard' | 'sets' | 'feedback';

const inputClass =
  'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-dark-300 dark:bg-dark-50';

/**
 * Evaluation platform (ADMIN-02): blind arena matches with an Elo
 * leaderboard, reusable evaluation sets with reproducible durable runs,
 * and the caller's feedback dataset.
 */
export const EvaluationsPage: React.FC = () => {
  const { t } = useTranslation();
  const models = useChatStore(state => state.models);
  const loadModels = useChatStore(state => state.loadModels);
  const [tab, setTab] = useState<EvaluationsTab>('arena');
  const [refresh, setRefresh] = useState(0);

  // Arena state
  const [arenaPrompt, setArenaPrompt] = useState('');
  const [arenaModelA, setArenaModelA] = useState('');
  const [arenaModelB, setArenaModelB] = useState('');
  const [arenaMatch, setArenaMatch] = useState<ArenaMatch | null>(null);
  const [arenaVoted, setArenaVoted] = useState(false);
  const [arenaBusy, setArenaBusy] = useState(false);

  // Data
  const [leaderboard, setLeaderboard] = useState<ArenaLeaderboardRow[]>([]);
  const [sets, setSets] = useState<EvalSetView[]>([]);
  const [runs, setRuns] = useState<EvalRunView[]>([]);
  const [feedback, setFeedback] = useState<FeedbackView[]>([]);

  // Set editor
  const [setName, setSetName] = useState('');
  const [setPrompts, setSetPrompts] = useState('');
  const [runModel, setRunModel] = useState('');

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      evaluationsApi.leaderboard(),
      evaluationsApi.listSets(),
      evaluationsApi.listRuns(),
      evaluationsApi.listFeedback(),
    ])
      .then(([board, setList, runList, feedbackList]) => {
        if (cancelled) return;
        if (board.success && board.data) setLeaderboard(board.data);
        if (setList.success && setList.data) setSets(setList.data);
        if (runList.success && runList.data) setRuns(runList.data);
        if (feedbackList.success && feedbackList.data) {
          setFeedback(feedbackList.data);
        }
      })
      .catch(() => toast.error(t('evaluations.loadFailed')));
    return () => {
      cancelled = true;
    };
  }, [refresh, t]);

  // Poll active runs until they settle.
  useEffect(() => {
    if (
      !runs.some(run => run.status === 'queued' || run.status === 'running')
    ) {
      return;
    }
    const timer = window.setInterval(
      () => setRefresh(value => value + 1),
      4000
    );
    return () => window.clearInterval(timer);
  }, [runs]);

  const modelNames = models.map(model => model.name);

  const handleArenaMatch = async () => {
    if (!arenaPrompt.trim() || !arenaModelA || !arenaModelB || arenaBusy) {
      return;
    }
    setArenaBusy(true);
    setArenaMatch(null);
    setArenaVoted(false);
    try {
      const response = await evaluationsApi.runArenaMatch({
        prompt: arenaPrompt.trim(),
        modelA: arenaModelA,
        modelB: arenaModelB,
      });
      if (!response.success || !response.data) {
        throw new Error(response.message || response.error);
      }
      setArenaMatch(response.data);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('evaluations.matchFailed')
      );
    } finally {
      setArenaBusy(false);
    }
  };

  const handleArenaVote = async (winner: 'a' | 'b' | 'tie' | 'both-bad') => {
    if (!arenaMatch || arenaVoted) return;
    try {
      const modelA = arenaMatch.candidates.find(c => c.key === 'a')?.model;
      const modelB = arenaMatch.candidates.find(c => c.key === 'b')?.model;
      if (!modelA || !modelB) return;
      const response = await evaluationsApi.voteArena({
        compareGroup: arenaMatch.compareGroup,
        modelA,
        modelB,
        winner,
      });
      if (!response.success) throw new Error(response.message);
      setArenaVoted(true);
      setRefresh(value => value + 1);
      toast.success(t('evaluations.voteRecorded'));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('evaluations.voteFailed')
      );
    }
  };

  const handleSaveSet = async () => {
    const prompts = setPrompts
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    if (!setName.trim() || prompts.length === 0) return;
    try {
      const response = await evaluationsApi.saveSet({
        name: setName.trim(),
        items: prompts.map(prompt => ({ prompt })),
      });
      if (!response.success) throw new Error(response.message);
      setSetName('');
      setSetPrompts('');
      setRefresh(value => value + 1);
      toast.success(t('evaluations.setSaved'));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('evaluations.saveFailed')
      );
    }
  };

  const handleStartRun = async (setId: string) => {
    if (!runModel) {
      toast.error(t('evaluations.pickModel'));
      return;
    }
    try {
      const response = await evaluationsApi.startRun({
        setId,
        model: runModel,
      });
      if (!response.success) throw new Error(response.message);
      setRefresh(value => value + 1);
      toast.success(t('evaluations.runStarted'));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('evaluations.saveFailed')
      );
    }
  };

  const handleExportRun = async (runId: string) => {
    try {
      const blob = await evaluationsApi.exportRun(runId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `eval-run-${runId}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(t('evaluations.exportFailed'));
    }
  };

  const tabs: Array<{ id: EvaluationsTab; label: string }> = [
    { id: 'arena', label: t('evaluations.tabs.arena') },
    { id: 'leaderboard', label: t('evaluations.tabs.leaderboard') },
    { id: 'sets', label: t('evaluations.tabs.sets') },
    { id: 'feedback', label: t('evaluations.tabs.feedback') },
  ];

  return (
    <PageShell width='wide'>
      <PageHeader
        title={t('evaluations.title')}
        description={t('evaluations.description')}
      />
      <div className='mb-4 inline-flex rounded-xl border border-gray-200 bg-white/70 p-1 dark:border-white/[0.08] dark:bg-dark-100/70'>
        {tabs.map(entry => (
          <button
            key={entry.id}
            type='button'
            onClick={() => setTab(entry.id)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
              tab === entry.id
                ? 'bg-gray-950 text-white dark:bg-white dark:text-gray-950'
                : 'text-gray-500 hover:text-gray-900 dark:text-dark-500 dark:hover:text-dark-900'
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'arena' && (
        <div className='space-y-4' data-testid='arena-tab'>
          <div className='rounded-xl border border-gray-200 bg-white p-4 dark:border-dark-300 dark:bg-dark-100'>
            <div className='grid gap-2 sm:grid-cols-2'>
              <label className='text-xs text-gray-600 dark:text-gray-300'>
                {t('evaluations.arenaModelA')}
                <select
                  className={`${inputClass} mt-1`}
                  value={arenaModelA}
                  onChange={event => setArenaModelA(event.target.value)}
                >
                  <option value=''>—</option>
                  {modelNames.map(name => (
                    <option key={`a-${name}`} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label className='text-xs text-gray-600 dark:text-gray-300'>
                {t('evaluations.arenaModelB')}
                <select
                  className={`${inputClass} mt-1`}
                  value={arenaModelB}
                  onChange={event => setArenaModelB(event.target.value)}
                >
                  <option value=''>—</option>
                  {modelNames.map(name => (
                    <option key={`b-${name}`} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <textarea
              className={`${inputClass} mt-2`}
              rows={3}
              placeholder={t('evaluations.arenaPrompt')}
              value={arenaPrompt}
              onChange={event => setArenaPrompt(event.target.value)}
              data-testid='arena-prompt'
            />
            <Button
              className='mt-2'
              onClick={() => void handleArenaMatch()}
              disabled={
                arenaBusy ||
                !arenaPrompt.trim() ||
                !arenaModelA ||
                !arenaModelB ||
                arenaModelA === arenaModelB
              }
              data-testid='arena-start'
            >
              {arenaBusy ? (
                <Loader2 className='mr-1 h-4 w-4 animate-spin' />
              ) : (
                <Swords className='mr-1 h-4 w-4' />
              )}
              {t('evaluations.startMatch')}
            </Button>
            <p className='mt-1 text-xs text-gray-500'>
              {t('evaluations.arenaHint')}
            </p>
          </div>

          {arenaMatch && (
            <div className='grid gap-3 sm:grid-cols-2'>
              {arenaMatch.candidates.map((candidate, index) => (
                <div
                  key={candidate.key}
                  className='rounded-xl border border-gray-200 bg-white p-3 dark:border-dark-300 dark:bg-dark-100'
                >
                  <p className='mb-2 text-xs font-semibold text-gray-500'>
                    {arenaVoted
                      ? candidate.model
                      : t('evaluations.candidate', { letter: index + 1 })}
                  </p>
                  <div className='max-h-80 overflow-y-auto whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-200'>
                    {candidate.output || '—'}
                  </div>
                </div>
              ))}
              {!arenaVoted && (
                <div className='sm:col-span-2 flex flex-wrap gap-2'>
                  <Button
                    size='sm'
                    onClick={() =>
                      void handleArenaVote(arenaMatch.candidates[0].key)
                    }
                  >
                    {t('evaluations.voteFirst')}
                  </Button>
                  <Button
                    size='sm'
                    onClick={() =>
                      void handleArenaVote(arenaMatch.candidates[1].key)
                    }
                  >
                    {t('evaluations.voteSecond')}
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => void handleArenaVote('tie')}
                  >
                    {t('evaluations.voteTie')}
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => void handleArenaVote('both-bad')}
                  >
                    {t('evaluations.voteBothBad')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'leaderboard' && (
        <div className='rounded-xl border border-gray-200 bg-white p-4 dark:border-dark-300 dark:bg-dark-100'>
          <table className='w-full text-left text-sm'>
            <thead className='text-xs text-gray-500'>
              <tr>
                <th className='py-1 pr-2'>#</th>
                <th className='py-1 pr-2'>{t('evaluations.model')}</th>
                <th className='py-1 pr-2'>{t('evaluations.rating')}</th>
                <th className='py-1 pr-2'>{t('evaluations.record')}</th>
                <th className='py-1'>{t('evaluations.votes')}</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((row, index) => (
                <tr
                  key={row.model}
                  className='border-t border-gray-100 dark:border-dark-300'
                >
                  <td className='py-1.5 pr-2'>
                    {index === 0 ? (
                      <Trophy className='h-4 w-4 text-amber-500' />
                    ) : (
                      index + 1
                    )}
                  </td>
                  <td className='py-1.5 pr-2 font-medium'>{row.model}</td>
                  <td className='py-1.5 pr-2'>{row.rating}</td>
                  <td className='py-1.5 pr-2 text-xs text-gray-500'>
                    {row.wins}W · {row.losses}L · {row.ties}T
                  </td>
                  <td className='py-1.5'>{row.votes}</td>
                </tr>
              ))}
              {leaderboard.length === 0 && (
                <tr>
                  <td colSpan={5} className='py-3 text-sm text-gray-500'>
                    {t('evaluations.noVotes')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'sets' && (
        <div className='space-y-4'>
          <div className='rounded-xl border border-gray-200 bg-white p-4 dark:border-dark-300 dark:bg-dark-100'>
            <h3 className='mb-2 text-sm font-semibold'>
              {t('evaluations.newSet')}
            </h3>
            <input
              className={inputClass}
              placeholder={t('evaluations.setName')}
              value={setName}
              onChange={event => setSetName(event.target.value)}
            />
            <textarea
              className={`${inputClass} mt-2`}
              rows={4}
              placeholder={t('evaluations.setPrompts')}
              value={setPrompts}
              onChange={event => setSetPrompts(event.target.value)}
            />
            <Button
              size='sm'
              className='mt-2'
              onClick={() => void handleSaveSet()}
              disabled={!setName.trim() || !setPrompts.trim()}
            >
              <Plus className='mr-1 h-3.5 w-3.5' />
              {t('evaluations.saveSet')}
            </Button>
          </div>

          <div className='rounded-xl border border-gray-200 bg-white p-4 dark:border-dark-300 dark:bg-dark-100'>
            <div className='mb-2 flex items-center justify-between gap-2'>
              <h3 className='text-sm font-semibold'>
                {t('evaluations.yourSets')}
              </h3>
              <select
                className='rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs dark:border-dark-300 dark:bg-dark-50'
                value={runModel}
                onChange={event => setRunModel(event.target.value)}
              >
                <option value=''>{t('evaluations.pickModel')}</option>
                {modelNames.map(name => (
                  <option key={`run-${name}`} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            {sets.length === 0 && (
              <p className='text-sm text-gray-500'>{t('evaluations.noSets')}</p>
            )}
            <div className='space-y-2'>
              {sets.map(set => (
                <div
                  key={set.id}
                  className='rounded-lg border border-gray-200 p-2 dark:border-dark-300'
                >
                  <div className='flex items-center justify-between gap-2'>
                    <span className='min-w-0 truncate text-sm font-medium'>
                      {set.name}
                      <span className='ml-2 text-xs font-normal text-gray-500'>
                        {t('evaluations.itemCount', {
                          total: set.items.length,
                        })}
                      </span>
                    </span>
                    <div className='flex shrink-0 gap-1'>
                      <Button
                        size='sm'
                        variant='outline'
                        onClick={() => void handleStartRun(set.id)}
                      >
                        <Play className='mr-1 h-3 w-3' />
                        {t('evaluations.run')}
                      </Button>
                      <button
                        onClick={() => {
                          void evaluationsApi
                            .deleteSet(set.id)
                            .then(() => setRefresh(value => value + 1))
                            .catch(() =>
                              toast.error(t('evaluations.saveFailed'))
                            );
                        }}
                        className='rounded p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30'
                        aria-label={t('evaluations.deleteSet')}
                      >
                        <Trash2 className='h-3.5 w-3.5' />
                      </button>
                    </div>
                  </div>
                  {runs
                    .filter(run => run.setId === set.id)
                    .slice(0, 5)
                    .map(run => (
                      <div
                        key={run.id}
                        className='mt-1 flex items-center justify-between gap-2 rounded bg-gray-50 px-2 py-1 text-xs dark:bg-dark-50'
                      >
                        <span className='min-w-0 truncate'>
                          {run.model} · {t(`evaluations.status.${run.status}`)}
                          {run.error ? ` — ${run.error}` : ''}
                        </span>
                        <div className='flex shrink-0 gap-1'>
                          {(run.status === 'queued' ||
                            run.status === 'running') && (
                            <button
                              onClick={() => {
                                void evaluationsApi
                                  .cancelRun(run.id)
                                  .then(() => setRefresh(value => value + 1))
                                  .catch(() => undefined);
                              }}
                              className='rounded p-1 text-gray-500 hover:bg-gray-200 dark:hover:bg-dark-200'
                              aria-label={t('evaluations.cancelRun')}
                            >
                              <X className='h-3 w-3' />
                            </button>
                          )}
                          {run.status === 'completed' && (
                            <button
                              onClick={() => void handleExportRun(run.id)}
                              className='rounded p-1 text-gray-500 hover:bg-gray-200 dark:hover:bg-dark-200'
                              aria-label={t('evaluations.exportRun')}
                            >
                              <Download className='h-3 w-3' />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'feedback' && (
        <div className='rounded-xl border border-gray-200 bg-white p-4 dark:border-dark-300 dark:bg-dark-100'>
          {feedback.length === 0 && (
            <p className='text-sm text-gray-500'>
              {t('evaluations.noFeedback')}
            </p>
          )}
          <div className='space-y-2'>
            {feedback.map(entry => (
              <div
                key={entry.id}
                className='rounded-lg border border-gray-200 p-2 text-sm dark:border-dark-300'
              >
                <div className='flex items-center justify-between gap-2 text-xs text-gray-500'>
                  <span>
                    {entry.rating === 1 ? '👍' : '👎'} {entry.model ?? ''}
                    {entry.tags.length > 0 && ` · ${entry.tags.join(', ')}`}
                  </span>
                  <span>
                    {new Intl.DateTimeFormat(undefined, {
                      dateStyle: 'medium',
                    }).format(entry.createdAt)}
                  </span>
                </div>
                {entry.snapshot && (
                  <p className='mt-1 line-clamp-2 text-xs text-gray-600 dark:text-gray-300'>
                    {entry.snapshot.assistant}
                  </p>
                )}
                {entry.comment && (
                  <p className='mt-1 text-xs italic text-gray-500'>
                    “{entry.comment}”
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </PageShell>
  );
};

export default EvaluationsPage;
