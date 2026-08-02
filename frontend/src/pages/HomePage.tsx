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

import React, { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Briefcase,
  Database,
  Ghost,
  MessageSquare,
  Sparkles,
  User as UserIcon,
} from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { useChatStore } from '@/store/chatStore';
import { useWorkStore } from '@/store/workStore';
import {
  startIncognitoChat,
  startNewChat,
  startNewWork,
} from '@/utils/appNavigation';
import { workStatusPresentation } from '@/utils/workStatus';
import { isWorkTaskActive } from '@/types/work';
import { cn, formatTimestamp, isMac } from '@/utils';

const greetingKeyForHour = (hour: number): [string, string] => {
  if (hour < 5) return ['home.greeting.night', 'Up late'];
  if (hour < 12) return ['home.greeting.morning', 'Morning'];
  if (hour < 18) return ['home.greeting.afternoon', 'Afternoon'];
  return ['home.greeting.evening', 'Evening'];
};

const sectionLabelClass =
  'mb-2 text-xs font-medium text-gray-500 dark:text-dark-500';

const rowClass =
  'group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-start text-sm text-gray-700 transition-colors hover:bg-white hover:text-gray-950 dark:text-dark-700 dark:hover:bg-dark-200 dark:hover:text-dark-950 outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40';

export const HomePage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user, systemInfo, isAdmin } = useAuthStore();
  const sessions = useChatStore(state => state.sessions);
  const workTasks = useWorkStore(state => state.tasks);
  const capabilities = useWorkStore(state => state.capabilities);
  const loadWorkTasks = useWorkStore(state => state.loadTasks);
  const loadCapabilities = useWorkStore(state => state.loadCapabilities);

  const showWork = systemInfo?.requiresAuth === false || isAdmin();

  useEffect(() => {
    if (!showWork) return;
    loadWorkTasks(true).catch(() => {});
    loadCapabilities().catch(() => {});
  }, [showWork, loadWorkTasks, loadCapabilities]);

  const [greetingKey, greetingDefault] = greetingKeyForHour(
    new Date().getHours()
  );
  const greeting = t(greetingKey, greetingDefault);
  const name = user?.username;

  const recentSessions = [...sessions]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 4);
  const recentWork = [...workTasks]
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
    .slice(0, 3);
  const activeRuntimes = capabilities?.activeRuntimes?.user ?? 0;
  const mod = isMac() ? '⌘' : 'Ctrl';

  const hasContinue = recentSessions.length > 0 || recentWork.length > 0;

  return (
    <div
      data-testid='home-page'
      className='h-full overflow-y-auto scrollbar-thin'
    >
      <div className='mx-auto flex min-h-full w-full max-w-xl flex-col justify-center px-6 py-12'>
        <h1 className='text-2xl font-semibold tracking-tight text-gray-950 dark:text-dark-950'>
          {name ? `${greeting}, ${name}.` : `${greeting}.`}
        </h1>
        <p className='mt-1 font-mono text-xs text-gray-400 dark:text-dark-500'>
          {window.location.host || 'Libre WebUI'}
          {systemInfo?.version ? ` · v${systemInfo.version}` : ''}
        </p>

        <div className='mt-8'>
          <p className={sectionLabelClass}>{t('home.start', 'Start')}</p>
          <div className='-mx-2.5 flex flex-col'>
            <button
              type='button'
              data-testid='home-new-chat'
              className={rowClass}
              onClick={() => startNewChat(navigate)}
            >
              <MessageSquare className='h-4 w-4 shrink-0 text-gray-400 transition-colors group-hover:text-gray-600 dark:text-dark-500 dark:group-hover:text-dark-700' />
              <span className='flex-1'>{t('tabs.newChat', 'New Chat')}</span>
              <span className='font-mono text-[10px] tracking-wide text-gray-400 opacity-0 transition-opacity group-hover:opacity-100 dark:text-dark-500'>
                {mod}⇧O
              </span>
            </button>
            <button
              type='button'
              data-testid='home-incognito-chat'
              className={rowClass}
              onClick={() => startIncognitoChat(navigate)}
            >
              <Ghost className='h-4 w-4 shrink-0 text-gray-400 transition-colors group-hover:text-gray-600 dark:text-dark-500 dark:group-hover:text-dark-700' />
              <span className='flex-1'>
                {t('chat.session.incognito', 'Incognito Chat')}
              </span>
            </button>
            {showWork && (
              <button
                type='button'
                data-testid='home-new-work'
                className={rowClass}
                onClick={() => startNewWork(navigate)}
              >
                <Briefcase className='h-4 w-4 shrink-0 text-gray-400 transition-colors group-hover:text-gray-600 dark:text-dark-500 dark:group-hover:text-dark-700' />
                <span className='flex-1'>{t('tabs.newWork', 'New Work')}</span>
                <span className='font-mono text-[10px] tracking-wide text-gray-400 opacity-0 transition-opacity group-hover:opacity-100 dark:text-dark-500'>
                  {mod}⇧U
                </span>
              </button>
            )}
          </div>
        </div>

        {hasContinue && (
          <div className='mt-8'>
            <div className='mb-2 flex items-baseline justify-between'>
              <p className={cn(sectionLabelClass, 'mb-0')}>
                {t('home.continue', 'Continue')}
              </p>
              {showWork && activeRuntimes > 0 && (
                <span className='flex items-center gap-1.5 font-mono text-[10px] text-gray-400 dark:text-dark-500'>
                  <span className='h-1.5 w-1.5 animate-pulse-subtle rounded-full bg-[rgb(48,121,255)]' />
                  {activeRuntimes} {t('home.active', 'active')}
                </span>
              )}
            </div>
            <div className='-mx-2.5 flex flex-col'>
              {recentWork.map(task => {
                const status = workStatusPresentation[task.status];
                return (
                  <button
                    key={task.id}
                    type='button'
                    data-testid='home-continue-work'
                    className={rowClass}
                    onClick={() => navigate(`/work/${task.id}`)}
                  >
                    <span
                      aria-hidden='true'
                      className={cn(
                        'h-2 w-2 shrink-0 rounded-full ring-1 ring-black/[0.06] dark:ring-white/[0.1]',
                        status.animated && 'animate-pulse-subtle'
                      )}
                      style={{ backgroundColor: status.color }}
                    />
                    <span className='min-w-0 flex-1 truncate'>
                      {task.title || t('work.tasks.untitled', 'Untitled task')}
                    </span>
                    {task.hostPath && (
                      <span
                        className='hidden max-w-[14rem] shrink-0 truncate font-mono text-[10px] text-gray-400 sm:inline dark:text-dark-500'
                        title={task.hostPath}
                      >
                        {task.hostPath}
                      </span>
                    )}
                    <span className='shrink-0 font-mono text-[10px] text-gray-400 dark:text-dark-500'>
                      {isWorkTaskActive(task)
                        ? t(status.labelKey, status.label)
                        : formatTimestamp(
                            new Date(task.updatedAt).getTime(),
                            i18n.language
                          )}
                    </span>
                  </button>
                );
              })}
              {recentSessions.map(session => (
                <button
                  key={session.id}
                  type='button'
                  data-testid='home-continue-chat'
                  className={rowClass}
                  onClick={() => navigate(`/c/${session.id}`)}
                >
                  <MessageSquare className='h-4 w-4 shrink-0 text-gray-400 dark:text-dark-500' />
                  <span className='min-w-0 flex-1 truncate'>
                    {session.title || t('tabs.chat', 'Chat')}
                  </span>
                  <span className='hidden shrink-0 font-mono text-[10px] text-gray-400 sm:inline dark:text-dark-500'>
                    {session.model}
                  </span>
                  <span className='shrink-0 font-mono text-[10px] text-gray-400 dark:text-dark-500'>
                    {formatTimestamp(session.updatedAt, i18n.language)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className='mt-8'>
          <p className={sectionLabelClass}>{t('home.explore', 'Explore')}</p>
          <div className='-mx-2.5 flex flex-col'>
            {(
              [
                ['/models', Database, t('sidebar.navigation.models', 'Models')],
                [
                  '/personas',
                  UserIcon,
                  t('sidebar.navigation.personas', 'Personas'),
                ],
                [
                  '/gallery',
                  Sparkles,
                  t('sidebar.navigation.imagine', 'Imagine'),
                ],
                ['/agents', Bot, t('sidebar.navigation.agents', 'Agents')],
              ] as Array<
                [string, React.ComponentType<{ className?: string }>, string]
              >
            ).map(([path, Icon, label]) => (
              <button
                key={path}
                type='button'
                className={rowClass}
                onClick={() => navigate(path)}
              >
                <Icon className='h-4 w-4 shrink-0 text-gray-400 transition-colors group-hover:text-gray-600 dark:text-dark-500 dark:group-hover:text-dark-700' />
                <span className='flex-1'>{label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default HomePage;
