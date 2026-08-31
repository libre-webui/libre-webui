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
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import {
  Server,
  Cloud,
  Cpu,
  Check,
  RefreshCw,
  PlugZap,
  ChevronRight,
  KeyRound,
  PowerOff,
} from 'lucide-react';
import { Button } from '@/components/ui';
import { ollamaApi, pluginApi } from '@/utils/api';
import { useAuthStore } from '@/store/authStore';
import { useChatStore } from '@/store/chatStore';
import { cn } from '@/utils';
import { createLogger } from '@/utils/logger';
import type { Plugin } from '@/types';

const logger = createLogger('components:connect-models');

/**
 * Local OpenAI-compatible servers. They all speak /v1, so one flow covers
 * every engine — only the default port and the display name differ.
 */
const LOCAL_PRESETS = [
  { id: 'llama-cpp', name: 'llama.cpp', baseUrl: 'http://localhost:8080/v1' },
  { id: 'vllm', name: 'vLLM', baseUrl: 'http://localhost:8000/v1' },
  { id: 'llama-swap', name: 'llama-swap', baseUrl: 'http://localhost:8080/v1' },
  { id: 'lm-studio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
  { id: 'mlx-lm', name: 'mlx-lm', baseUrl: 'http://localhost:8080/v1' },
] as const;

/** Bundled cloud plugins that only need an API key to light up. */
const CLOUD_PROVIDERS = [
  { id: 'openai', name: 'OpenAI' },
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'groq', name: 'Groq' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'gemini', name: 'Google Gemini' },
  { id: 'mistral', name: 'Mistral' },
] as const;

type OllamaProbe = 'checking' | 'healthy' | 'offline' | 'disabled';

interface ConnectModelsProps {
  /** 'setup' renders wizard-sized cards; 'inline' fits the chat empty state. */
  variant?: 'setup' | 'inline';
  onDone?: () => void;
}

export const ConnectModels: React.FC<ConnectModelsProps> = ({
  variant = 'setup',
  onDone,
}) => {
  const { t } = useTranslation();
  const { user, systemInfo } = useAuthStore();
  const loadModels = useChatStore(state => state.loadModels);
  const isAdmin = user?.role === 'admin' || systemInfo?.requiresAuth === false;

  const [ollamaStatus, setOllamaStatus] = useState<OllamaProbe>(() =>
    systemInfo?.ollamaEnabled === false ? 'disabled' : 'checking'
  );
  const [openSection, setOpenSection] = useState<'local' | 'cloud' | null>(
    null
  );

  // Local-server form
  const [preset, setPreset] = useState<(typeof LOCAL_PRESETS)[number]>(
    LOCAL_PRESETS[0]
  );
  const [localUrl, setLocalUrl] = useState<string>(LOCAL_PRESETS[0].baseUrl);
  const [localKey, setLocalKey] = useState('');
  const [probing, setProbing] = useState(false);
  const [probedModels, setProbedModels] = useState<string[] | null>(null);
  const [enablingLocal, setEnablingLocal] = useState(false);

  // Cloud form
  const [cloudProvider, setCloudProvider] = useState<
    (typeof CLOUD_PROVIDERS)[number] | null
  >(null);
  const [cloudKey, setCloudKey] = useState('');
  const [savingCloud, setSavingCloud] = useState(false);

  // Does NOT set 'checking' itself: the initial state already is, and event
  // handlers set it before calling.
  const checkOllama = useCallback(async () => {
    try {
      const response = await ollamaApi.checkHealth();
      if (response.success && response.data?.status === 'disabled') {
        setOllamaStatus('disabled');
      } else if (response.success && response.data?.status === 'healthy') {
        setOllamaStatus('healthy');
      } else {
        setOllamaStatus('offline');
      }
    } catch {
      setOllamaStatus('offline');
    }
  }, []);

  useEffect(() => {
    if (systemInfo?.ollamaEnabled === false) return;
    // Defer the probe until after the effect completes so its async result can
    // update component state without triggering a cascading-effect warning.
    const probe = window.setTimeout(() => {
      void checkOllama();
    }, 0);
    return () => window.clearTimeout(probe);
  }, [checkOllama, systemInfo?.ollamaEnabled]);

  const setOllamaEnabled = async (enabled: boolean) => {
    try {
      const response = await ollamaApi.updateSettings({ enabled });
      if (response.success) {
        toast.success(
          enabled
            ? t('connectModels.ollama.enabledToast')
            : t('connectModels.ollama.disabledToast')
        );
        if (enabled) {
          setOllamaStatus('checking');
          void checkOllama();
        } else {
          setOllamaStatus('disabled');
        }
      } else {
        toast.error(t('connectModels.ollama.settingsFailed'));
      }
    } catch (error) {
      logger.error('Failed to update Ollama settings:', error);
      toast.error(t('connectModels.ollama.settingsFailed'));
    }
  };

  const handleProbe = async () => {
    setProbing(true);
    setProbedModels(null);
    try {
      const response = await pluginApi.probeEndpoint(localUrl, 'openai');
      if (response.success && response.data?.reachable) {
        setProbedModels(response.data.models);
        toast.success(
          t('connectModels.local.reachable', {
            count: response.data.models.length,
          })
        );
      } else {
        setProbedModels([]);
        toast.error(response.message || t('connectModels.local.unreachable'));
      }
    } catch (error) {
      logger.error('Endpoint probe failed:', error);
      setProbedModels([]);
      toast.error(t('connectModels.local.unreachable'));
    } finally {
      setProbing(false);
    }
  };

  const handleEnableLocal = async () => {
    setEnablingLocal(true);
    try {
      const trimmed = localUrl.replace(/\/+$/, '');
      const root = trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
      const usesKey = localKey.trim().length > 0;
      const keyEnv = `${preset.id.toUpperCase().replace(/-/g, '_')}_API_KEY`;
      const definition: Omit<Plugin, 'created_at' | 'updated_at'> = {
        id: preset.id,
        name: preset.name,
        type: 'completion',
        endpoint: `${root}/chat/completions`,
        api_mode: 'chat_completions',
        base_url: root,
        auth: usesKey
          ? { header: 'Authorization', prefix: 'Bearer ', key_env: keyEnv }
          : { header: '', prefix: '', key_env: '' },
        model_map: (probedModels ?? []).slice(0, 50),
      };
      const installed = await pluginApi.installPlugin(definition);
      if (!installed.success) {
        // Already-installed presets are updated in place instead.
        const updated = await pluginApi.updatePlugin(preset.id, definition);
        if (!updated.success) {
          toast.error(t('connectModels.local.enableFailed'));
          return;
        }
      }
      if (usesKey) {
        await pluginApi.setApiKey(preset.id, localKey.trim());
      }
      await pluginApi.activatePlugin(preset.id);
      await loadModels({ quiet: true });
      toast.success(t('connectModels.local.enabled', { name: preset.name }));
      onDone?.();
    } catch (error) {
      logger.error('Failed to enable local provider:', error);
      toast.error(t('connectModels.local.enableFailed'));
    } finally {
      setEnablingLocal(false);
    }
  };

  const handleSaveCloud = async () => {
    if (!cloudProvider || !cloudKey.trim()) return;
    setSavingCloud(true);
    try {
      const saved = await pluginApi.setApiKey(
        cloudProvider.id,
        cloudKey.trim()
      );
      if (!saved.success) {
        toast.error(t('connectModels.cloud.saveFailed'));
        return;
      }
      await pluginApi.activatePlugin(cloudProvider.id);
      await loadModels({ quiet: true });
      toast.success(
        t('connectModels.cloud.connected', { name: cloudProvider.name })
      );
      setCloudKey('');
      onDone?.();
    } catch (error) {
      logger.error('Failed to connect cloud provider:', error);
      toast.error(t('connectModels.cloud.saveFailed'));
    } finally {
      setSavingCloud(false);
    }
  };

  const cardClass =
    'rounded-2xl border border-gray-200/80 bg-white/80 p-4 dark:border-white/10 dark:bg-white/[0.04]';
  const inputClass =
    'w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-primary-400 focus:outline-none dark:border-white/10 dark:bg-white/[0.035] dark:text-dark-800 dark:placeholder-dark-500';

  const statusDot = {
    checking: 'bg-gray-400 animate-pulse',
    healthy: 'bg-green-500',
    offline: 'bg-red-500',
    disabled: 'bg-gray-400',
  }[ollamaStatus];

  return (
    <div
      className={cn(
        'flex w-full flex-col gap-3',
        variant === 'setup' ? 'max-w-lg' : 'max-w-lg'
      )}
    >
      {/* ------------------------------------------------ Ollama */}
      <div className={cardClass}>
        <div className='flex items-center gap-3'>
          <div className='rounded-xl border border-gray-200 bg-gray-50 p-2 dark:border-white/10 dark:bg-white/[0.05]'>
            <Cpu className='h-5 w-5 text-gray-700 dark:text-dark-700' />
          </div>
          <div className='min-w-0 flex-1'>
            <div className='flex items-center gap-2'>
              <span className='text-sm font-medium text-gray-900 dark:text-dark-900'>
                Ollama
              </span>
              <span className={cn('h-2 w-2 rounded-full', statusDot)} />
            </div>
            <p className='truncate text-xs text-gray-500 dark:text-dark-500'>
              {t(`connectModels.ollama.status.${ollamaStatus}`)}
            </p>
          </div>
          <div className='flex items-center gap-1.5'>
            {ollamaStatus !== 'disabled' && (
              <Button
                variant='ghost'
                size='sm'
                onClick={() => {
                  setOllamaStatus('checking');
                  void checkOllama();
                }}
                title={t('connectModels.ollama.recheck')}
              >
                <RefreshCw
                  className={cn(
                    'h-4 w-4',
                    ollamaStatus === 'checking' && 'animate-spin'
                  )}
                />
              </Button>
            )}
            {isAdmin && ollamaStatus === 'offline' && (
              <Button
                variant='ghost'
                size='sm'
                onClick={() => void setOllamaEnabled(false)}
                title={t('connectModels.ollama.disable')}
              >
                <PowerOff className='h-4 w-4' />
              </Button>
            )}
            {isAdmin && ollamaStatus === 'disabled' && (
              <Button
                variant='ghost'
                size='sm'
                onClick={() => void setOllamaEnabled(true)}
              >
                {t('connectModels.ollama.enable')}
              </Button>
            )}
          </div>
        </div>
        {ollamaStatus === 'offline' && (
          <p className='mt-3 text-xs leading-relaxed text-gray-500 dark:text-dark-500'>
            {t('connectModels.ollama.offlineHint')}
          </p>
        )}
        {ollamaStatus === 'healthy' && (
          <p className='mt-3 text-xs leading-relaxed text-green-600 dark:text-green-400'>
            {t('connectModels.ollama.healthyHint')}
          </p>
        )}
      </div>

      {/* ------------------------------------------------ Local server */}
      <div className={cardClass}>
        <button
          type='button'
          className='flex w-full items-center gap-3 text-start'
          onClick={() =>
            setOpenSection(openSection === 'local' ? null : 'local')
          }
        >
          <div className='rounded-xl border border-gray-200 bg-gray-50 p-2 dark:border-white/10 dark:bg-white/[0.05]'>
            <Server className='h-5 w-5 text-gray-700 dark:text-dark-700' />
          </div>
          <div className='min-w-0 flex-1'>
            <span className='text-sm font-medium text-gray-900 dark:text-dark-900'>
              {t('connectModels.local.title')}
            </span>
            <p className='truncate text-xs text-gray-500 dark:text-dark-500'>
              {t('connectModels.local.subtitle')}
            </p>
          </div>
          <ChevronRight
            className={cn(
              'h-4 w-4 text-gray-400 transition-transform',
              openSection === 'local' && 'rotate-90'
            )}
          />
        </button>

        {openSection === 'local' && (
          <div className='mt-4 flex flex-col gap-3'>
            {!isAdmin ? (
              <p className='text-xs text-gray-500 dark:text-dark-500'>
                {t('connectModels.adminOnly')}
              </p>
            ) : (
              <>
                <div className='flex flex-wrap gap-1.5'>
                  {LOCAL_PRESETS.map(candidate => (
                    <button
                      key={candidate.id}
                      type='button'
                      onClick={() => {
                        setPreset(candidate);
                        setLocalUrl(candidate.baseUrl);
                        setProbedModels(null);
                      }}
                      className={cn(
                        'rounded-full border px-3 py-1 text-xs transition-colors',
                        preset.id === candidate.id
                          ? 'border-primary-400 bg-primary-500/10 text-primary-600 dark:text-primary-400'
                          : 'border-gray-200 text-gray-600 hover:border-gray-300 dark:border-white/10 dark:text-dark-600'
                      )}
                    >
                      {candidate.name}
                    </button>
                  ))}
                </div>
                <input
                  className={inputClass}
                  value={localUrl}
                  onChange={event => {
                    setLocalUrl(event.target.value);
                    setProbedModels(null);
                  }}
                  placeholder='http://localhost:8080/v1'
                  spellCheck={false}
                />
                <input
                  className={inputClass}
                  value={localKey}
                  onChange={event => setLocalKey(event.target.value)}
                  placeholder={t('connectModels.local.keyPlaceholder')}
                  type='password'
                  autoComplete='off'
                />
                <div className='flex items-center gap-2'>
                  <Button
                    variant='outline'
                    size='sm'
                    onClick={() => void handleProbe()}
                    disabled={probing || !localUrl.trim()}
                  >
                    <PlugZap className='me-1.5 h-4 w-4' />
                    {probing
                      ? t('connectModels.local.testing')
                      : t('connectModels.local.test')}
                  </Button>
                  <Button
                    size='sm'
                    onClick={() => void handleEnableLocal()}
                    disabled={
                      enablingLocal ||
                      !probedModels ||
                      probedModels.length === 0
                    }
                  >
                    <Check className='me-1.5 h-4 w-4' />
                    {enablingLocal
                      ? t('connectModels.local.enabling')
                      : t('connectModels.local.enable')}
                  </Button>
                </div>
                {probedModels && probedModels.length > 0 && (
                  <div className='flex flex-wrap gap-1'>
                    {probedModels.slice(0, 8).map(model => (
                      <span
                        key={model}
                        className='rounded-md bg-gray-100 px-2 py-0.5 font-mono text-[10px] text-gray-700 dark:bg-white/[0.06] dark:text-dark-700'
                      >
                        {model}
                      </span>
                    ))}
                    {probedModels.length > 8 && (
                      <span className='px-1 text-[10px] text-gray-400'>
                        +{probedModels.length - 8}
                      </span>
                    )}
                  </div>
                )}
                {probedModels && probedModels.length === 0 && (
                  <p className='text-xs text-red-500'>
                    {t('connectModels.local.noModels')}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* ------------------------------------------------ Cloud API */}
      <div className={cardClass}>
        <button
          type='button'
          className='flex w-full items-center gap-3 text-start'
          onClick={() =>
            setOpenSection(openSection === 'cloud' ? null : 'cloud')
          }
        >
          <div className='rounded-xl border border-gray-200 bg-gray-50 p-2 dark:border-white/10 dark:bg-white/[0.05]'>
            <Cloud className='h-5 w-5 text-gray-700 dark:text-dark-700' />
          </div>
          <div className='min-w-0 flex-1'>
            <span className='text-sm font-medium text-gray-900 dark:text-dark-900'>
              {t('connectModels.cloud.title')}
            </span>
            <p className='truncate text-xs text-gray-500 dark:text-dark-500'>
              {t('connectModels.cloud.subtitle')}
            </p>
          </div>
          <ChevronRight
            className={cn(
              'h-4 w-4 text-gray-400 transition-transform',
              openSection === 'cloud' && 'rotate-90'
            )}
          />
        </button>

        {openSection === 'cloud' && (
          <div className='mt-4 flex flex-col gap-3'>
            {!isAdmin ? (
              <p className='text-xs text-gray-500 dark:text-dark-500'>
                {t('connectModels.adminOnly')}
              </p>
            ) : (
              <>
                <div className='flex flex-wrap gap-1.5'>
                  {CLOUD_PROVIDERS.map(candidate => (
                    <button
                      key={candidate.id}
                      type='button'
                      onClick={() => setCloudProvider(candidate)}
                      className={cn(
                        'rounded-full border px-3 py-1 text-xs transition-colors',
                        cloudProvider?.id === candidate.id
                          ? 'border-primary-400 bg-primary-500/10 text-primary-600 dark:text-primary-400'
                          : 'border-gray-200 text-gray-600 hover:border-gray-300 dark:border-white/10 dark:text-dark-600'
                      )}
                    >
                      {candidate.name}
                    </button>
                  ))}
                </div>
                {cloudProvider && (
                  <>
                    <div className='relative'>
                      <KeyRound className='absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400' />
                      <input
                        className={cn(inputClass, 'ps-9')}
                        value={cloudKey}
                        onChange={event => setCloudKey(event.target.value)}
                        placeholder={t('connectModels.cloud.keyPlaceholder', {
                          name: cloudProvider.name,
                        })}
                        type='password'
                        autoComplete='off'
                      />
                    </div>
                    <div>
                      <Button
                        size='sm'
                        onClick={() => void handleSaveCloud()}
                        disabled={savingCloud || !cloudKey.trim()}
                      >
                        <Check className='me-1.5 h-4 w-4' />
                        {savingCloud
                          ? t('connectModels.cloud.connecting')
                          : t('connectModels.cloud.connect')}
                      </Button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {variant === 'setup' && (
        <div className='mt-1 text-center'>
          <button
            type='button'
            onClick={() => onDone?.()}
            className='text-sm text-gray-500 underline-offset-4 hover:underline dark:text-dark-500'
          >
            {t('connectModels.skip')}
          </button>
        </div>
      )}
    </div>
  );
};
