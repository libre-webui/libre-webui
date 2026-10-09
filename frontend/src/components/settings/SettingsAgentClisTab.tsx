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

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { Button, Input } from '@/components/ui';
import { SettingsTabHeader } from '@/components/settings/SettingsTabHeader';
import type { WorkAgentCredential, WorkAgentToolchain } from '@/types/work';
import { workApi } from '@/utils/api';

const AGENT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  kiro: 'Kiro',
  opencode: 'OpenCode',
  pi: 'Pi',
};

const PROVIDER_NAMES: Record<string, string> = {
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  bedrock: 'Amazon Bedrock',
};

/** How long the page keeps polling while an install is in progress. */
const INSTALL_POLL_MS = 4_000;

/**
 * Administrator setup for agent CLIs in Work: the headless keys the egress
 * proxy injects, and the shared toolchain the agents run from. Who may use
 * them is a separate card in User Management.
 */
export const SettingsAgentClisTab: React.FC = () => {
  const { t } = useTranslation();
  const [credentials, setCredentials] = useState<WorkAgentCredential[] | null>(
    null
  );
  const [toolchain, setToolchain] = useState<WorkAgentToolchain | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const loadToolchain = useCallback(async () => {
    const response = await workApi.agentToolchain();
    if (response.success && response.data) setToolchain(response.data);
    return response.data;
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([workApi.agentCredentials(), workApi.agentToolchain()])
      .then(([credentialResponse, toolchainResponse]) => {
        if (cancelled) return;
        if (
          !credentialResponse.success ||
          !credentialResponse.data ||
          !toolchainResponse.success ||
          !toolchainResponse.data
        ) {
          setLoadFailed(true);
          return;
        }
        setCredentials(credentialResponse.data);
        setToolchain(toolchainResponse.data);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  // Follow an install until it lands; the server reports `installing`.
  const installing = toolchain?.agents.some(agent => agent.installing);
  useEffect(() => {
    if (!installing) return;
    const timer = setInterval(() => {
      void loadToolchain().catch(() => undefined);
    }, INSTALL_POLL_MS);
    return () => clearInterval(timer);
  }, [installing, loadToolchain]);

  const saveCredential = async (name: string, value: string) => {
    setBusy(name);
    try {
      const response = await workApi.setAgentCredential(name, value);
      if (!response.success || !response.data) throw new Error();
      setCredentials(response.data);
      setDrafts(current => ({ ...current, [name]: '' }));
      toast.success(
        t(
          value
            ? 'settings.agentClis.keySaved'
            : 'settings.agentClis.keyRemoved'
        )
      );
    } catch {
      toast.error(t('settings.agentClis.keyFailed'));
    } finally {
      setBusy(null);
    }
  };

  const install = async (id: string) => {
    setBusy(`install:${id}`);
    try {
      const response = await workApi.installAgent(id);
      if (!response.success) throw new Error();
      toast.success(
        t('settings.agentClis.installStarted', {
          agent: AGENT_NAMES[id] ?? id,
        })
      );
      await loadToolchain();
    } catch {
      toast.error(t('settings.agentClis.installFailed'));
    } finally {
      setBusy(null);
    }
  };

  if (loadFailed && !credentials) {
    return (
      <div className='space-y-4' data-testid='settings-agent-clis'>
        <SettingsTabHeader title={t('settings.agentClis.title')} />
        <div className='flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-300 dark:bg-dark-100'>
          <p className='text-sm text-gray-600 dark:text-gray-400'>
            {t('settings.agentClis.loadFailed')}
          </p>
          <Button
            size='sm'
            variant='outline'
            onClick={() => {
              setLoadFailed(false);
              setLoadAttempt(attempt => attempt + 1);
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className='space-y-4' data-testid='settings-agent-clis'>
      <SettingsTabHeader
        title={t('settings.agentClis.title')}
        description={t('settings.agentClis.description')}
      />
      <p className='text-xs text-gray-500 dark:text-gray-400'>
        {t('settings.agentClis.accessHint')}
      </p>

      {toolchain && !toolchain.available && (
        <p
          className='rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'
          role='status'
        >
          {t('settings.agentClis.unavailable')}
        </p>
      )}

      <section className='rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-300 dark:bg-dark-100'>
        <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
          {t('settings.agentClis.keysTitle')}
        </h4>
        <p className='mt-1 text-xs text-gray-500 dark:text-gray-400'>
          {t('settings.agentClis.keysDescription')}
        </p>
        <ul className='mt-3 divide-y divide-gray-200 dark:divide-dark-300'>
          {(credentials ?? []).map(credential => {
            const draft = drafts[credential.name] ?? '';
            const inputId = `agent-key-${credential.name}`;
            return (
              <li
                key={credential.name}
                className='py-3'
                data-testid={`agent-credential-${credential.name}`}
              >
                <div className='flex flex-wrap items-baseline justify-between gap-2'>
                  <label
                    htmlFor={inputId}
                    className='font-mono text-sm text-gray-900 dark:text-gray-100'
                    dir='ltr'
                  >
                    {credential.name}
                  </label>
                  <span className='text-xs text-gray-500 dark:text-gray-400'>
                    {credential.source === 'stored'
                      ? t('settings.agentClis.saved')
                      : credential.source === 'environment'
                        ? t('settings.agentClis.environment')
                        : t('settings.agentClis.missing')}
                  </span>
                </div>
                <p className='mt-0.5 text-xs text-gray-500 dark:text-gray-400'>
                  {t('settings.agentClis.usedBy', {
                    agents: credential.usedBy
                      .map(id => AGENT_NAMES[id] ?? id)
                      .join(', '),
                  })}
                  {credential.providerPlugin
                    ? ` · ${t('settings.agentClis.providerFallback', {
                        provider:
                          PROVIDER_NAMES[credential.providerPlugin] ??
                          credential.providerPlugin,
                      })}`
                    : ''}
                </p>
                <div className='mt-2 flex flex-wrap gap-2'>
                  <div className='min-w-0 flex-[1_1_16rem]'>
                    <Input
                      id={inputId}
                      type='password'
                      autoComplete='off'
                      spellCheck={false}
                      dir='ltr'
                      value={draft}
                      placeholder={t('settings.agentClis.placeholder')}
                      onChange={event =>
                        setDrafts(current => ({
                          ...current,
                          [credential.name]: event.target.value,
                        }))
                      }
                    />
                  </div>
                  <Button
                    size='sm'
                    onClick={() =>
                      void saveCredential(credential.name, draft.trim())
                    }
                    disabled={busy !== null || !draft.trim()}
                  >
                    {t('settings.agentClis.save')}
                  </Button>
                  {credential.source === 'stored' && (
                    <Button
                      size='sm'
                      variant='outline'
                      onClick={() => void saveCredential(credential.name, '')}
                      disabled={busy !== null}
                    >
                      {t('settings.agentClis.remove')}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className='rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-300 dark:bg-dark-100'>
        <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
          {t('settings.agentClis.toolchainTitle')}
        </h4>
        <p className='mt-1 text-xs text-gray-500 dark:text-gray-400'>
          {t('settings.agentClis.toolchainDescription')}
        </p>
        <ul className='mt-3 divide-y divide-gray-200 dark:divide-dark-300'>
          {(toolchain?.agents ?? []).map(agent => {
            const current = agent.installedVersion === agent.wantedVersion;
            return (
              <li
                key={agent.id}
                className='flex flex-wrap items-center justify-between gap-2 py-2.5'
                data-testid={`agent-toolchain-${agent.id}`}
              >
                <div className='min-w-0'>
                  <span className='text-sm text-gray-900 dark:text-gray-100'>
                    {agent.name}
                  </span>
                  <span className='ms-2 text-xs text-gray-500 dark:text-gray-400'>
                    {agent.installing
                      ? t('settings.agentClis.installing')
                      : agent.installedVersion
                        ? t('settings.agentClis.installed', {
                            version: agent.installedVersion,
                          })
                        : t('settings.agentClis.notInstalled')}
                  </span>
                </div>
                {!current && !agent.installing && (
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => void install(agent.id)}
                    disabled={busy !== null || toolchain?.available === false}
                  >
                    {t('settings.agentClis.install')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
};

export default SettingsAgentClisTab;
