/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Film, Loader2, Sparkles, Volume2, X } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';
import { cn } from '@/utils';
import {
  type AudioGenModel,
  mediaApi,
  type MediaModelCatalog,
  type VideoGenModel,
} from '@/utils/api';

type MediaGenerationKind = 'video' | 'audio';

interface MediaGenerationPanelProps {
  isOpen: boolean;
  initialKind: MediaGenerationKind;
  onClose: () => void;
  onGenerated: () => void;
}

const EMPTY_CATALOG: MediaModelCatalog = { video: [], audio: [] };

export function MediaGenerationPanel({
  isOpen,
  initialKind,
  onClose,
  onGenerated,
}: MediaGenerationPanelProps) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<MediaGenerationKind>(initialKind);
  const [catalog, setCatalog] = useState<MediaModelCatalog>(EMPTY_CATALOG);
  const [selected, setSelected] = useState('');
  const [prompt, setPrompt] = useState('');
  const [voice, setVoice] = useState('alloy');
  const [resolution, setResolution] = useState('');
  const [aspectRatio, setAspectRatio] = useState('');
  const [duration, setDuration] = useState('');
  const [generateAudio, setGenerateAudio] = useState(true);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const titleId = React.useId();

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void mediaApi
      .getModels()
      .then(response => {
        if (cancelled || !response.success || !response.data) return;
        setCatalog(response.data);
      })
      .catch(() => {
        if (!cancelled) toast.error(t('mediaGeneration.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, t]);

  const models = kind === 'video' ? catalog.video : catalog.audio;

  const effectiveSelected = models.some(model => modelKey(model) === selected)
    ? selected
    : models[0]
      ? modelKey(models[0])
      : '';

  const selectedModel = useMemo(
    () => models.find(model => modelKey(model) === effectiveSelected),
    [effectiveSelected, models]
  );
  const videoConfig =
    kind === 'video'
      ? (selectedModel as VideoGenModel | undefined)?.config
      : undefined;
  const audioModel =
    kind === 'audio' ? (selectedModel as AudioGenModel | undefined) : undefined;

  const handleGenerate = async () => {
    if (!selectedModel || !prompt.trim()) return;
    setGenerating(true);
    try {
      if (kind === 'audio') {
        const response =
          audioModel?.mode === 'sound'
            ? await mediaApi.generateSound({
                model: selectedModel.model,
                pluginId: selectedModel.plugin,
                prompt: prompt.trim(),
                voice: voice.trim() || undefined,
                format: 'wav',
              })
            : await mediaApi.generateAudio({
                model: selectedModel.model,
                pluginId: selectedModel.plugin,
                input: prompt.trim(),
                voice: voice.trim() || undefined,
                response_format: 'mp3',
              });
        if (!response.success) throw new Error(response.message);
      } else {
        const submitted = await mediaApi.generateVideo({
          model: selectedModel.model,
          pluginId: selectedModel.plugin,
          prompt: prompt.trim(),
          ...(duration ? { duration: Number(duration) } : {}),
          ...(resolution ? { resolution } : {}),
          ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
          ...(videoConfig?.supports_audio
            ? { generate_audio: generateAudio }
            : {}),
        });
        if (!submitted.success || !submitted.data) {
          throw new Error(submitted.message || t('mediaGeneration.failed'));
        }
        let job = submitted.data;
        let transientFailures = 0;
        while (job.status === 'pending' || job.status === 'in_progress') {
          await delay(30_000);
          try {
            const response = await mediaApi.getVideoJob(job.id);
            if (!response.success || !response.data) {
              throw new Error(response.message || t('mediaGeneration.failed'));
            }
            job = response.data;
            transientFailures = 0;
          } catch (error) {
            transientFailures += 1;
            if (transientFailures >= 5) throw error;
          }
        }
        if (job.status === 'failed') {
          throw new Error(job.error || t('mediaGeneration.failed'));
        }
      }
      toast.success(t('mediaGeneration.success'));
      setPrompt('');
      onGenerated();
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('mediaGeneration.failed')
      );
    } finally {
      setGenerating(false);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div className='fixed inset-0 z-[99999] flex items-center justify-center p-3 sm:p-6'>
      <button
        className='absolute inset-0 bg-black/55 backdrop-blur-sm'
        onClick={onClose}
        aria-label={t('common.close')}
      />
      <div
        role='dialog'
        aria-modal='true'
        aria-labelledby={titleId}
        className='relative flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-200/80 bg-white/95 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-dark-25/95'
      >
        <div className='flex items-center justify-between border-b border-gray-200/70 px-4 py-3 dark:border-white/[0.08] sm:px-5'>
          <div>
            <h2
              id={titleId}
              className='text-xl text-gray-950 dark:text-dark-950'
            >
              {t('mediaGeneration.title')}
            </h2>
            <p className='mt-1 text-sm text-gray-500 dark:text-dark-500'>
              {t('mediaGeneration.description')}
            </p>
          </div>
          <button onClick={onClose} className='rounded-xl p-2'>
            <X className='h-5 w-5' />
          </button>
        </div>

        <div className='scroll-region min-h-0 flex-1 space-y-4 p-4 sm:p-5'>
          <div className='grid grid-cols-2 gap-2 rounded-xl bg-gray-100 p-1 dark:bg-white/[0.05]'>
            {(['video', 'audio'] as const).map(option => (
              <button
                key={option}
                type='button'
                onClick={() => setKind(option)}
                className={cn(
                  'flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors',
                  option === kind
                    ? 'bg-white text-gray-950 shadow-sm dark:bg-white/10 dark:text-white'
                    : 'text-gray-500 dark:text-dark-500'
                )}
              >
                {option === 'video' ? (
                  <Film className='h-4 w-4' />
                ) : (
                  <Volume2 className='h-4 w-4' />
                )}
                {t(`mediaGeneration.${option}`)}
              </button>
            ))}
          </div>

          {loading ? (
            <div className='flex justify-center py-12'>
              <Loader2 className='h-7 w-7 animate-spin' />
            </div>
          ) : models.length === 0 ? (
            <div className='rounded-xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200'>
              {t('mediaGeneration.noModels', {
                kind: t(`mediaGeneration.${kind}`),
              })}
            </div>
          ) : (
            <>
              <Field label={t('mediaGeneration.model')}>
                <select
                  value={effectiveSelected}
                  onChange={event => {
                    setSelected(event.target.value);
                    setResolution('');
                    setAspectRatio('');
                    setDuration('');
                    setGenerateAudio(true);
                  }}
                  className={inputClass}
                >
                  {models.map(model => (
                    <option key={modelKey(model)} value={modelKey(model)}>
                      {model.model} ({model.plugin}
                      {'mode' in model
                        ? ` · ${t(`mediaGeneration.${model.mode}`)}`
                        : ''}
                      )
                    </option>
                  ))}
                </select>
              </Field>

              {kind === 'audio' ? (
                <Field label={t('mediaGeneration.voice')}>
                  <input
                    value={voice}
                    onChange={event => setVoice(event.target.value)}
                    className={inputClass}
                    placeholder='alloy'
                  />
                </Field>
              ) : (
                <div className='grid gap-4 sm:grid-cols-3'>
                  <Field label={t('mediaGeneration.resolution')}>
                    <select
                      value={resolution}
                      onChange={event => setResolution(event.target.value)}
                      className={inputClass}
                    >
                      <option value=''>
                        {t('mediaGeneration.providerDefault')}
                      </option>
                      {videoConfig?.resolutions?.map(value => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('mediaGeneration.aspectRatio')}>
                    <select
                      value={aspectRatio}
                      onChange={event => setAspectRatio(event.target.value)}
                      className={inputClass}
                    >
                      <option value=''>
                        {t('mediaGeneration.providerDefault')}
                      </option>
                      {videoConfig?.aspect_ratios?.map(value => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('mediaGeneration.duration')}>
                    <select
                      value={duration}
                      onChange={event => setDuration(event.target.value)}
                      className={inputClass}
                    >
                      <option value=''>
                        {t('mediaGeneration.providerDefault')}
                      </option>
                      {videoConfig?.durations?.map(value => (
                        <option key={value} value={value}>
                          {value}s
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              )}

              {kind === 'video' && videoConfig?.supports_audio && (
                <label className='flex items-center gap-3 text-sm'>
                  <input
                    type='checkbox'
                    checked={generateAudio}
                    onChange={event => setGenerateAudio(event.target.checked)}
                  />
                  {t('mediaGeneration.generateAudio')}
                </label>
              )}

              <Field
                label={
                  kind === 'video'
                    ? t('mediaGeneration.prompt')
                    : audioModel?.mode === 'sound'
                      ? t('mediaGeneration.prompt')
                      : t('mediaGeneration.text')
                }
              >
                <textarea
                  value={prompt}
                  onChange={event => setPrompt(event.target.value)}
                  rows={6}
                  className={cn(inputClass, 'resize-none')}
                  placeholder={t(
                    kind === 'audio' && audioModel?.mode === 'sound'
                      ? 'mediaGeneration.soundPlaceholder'
                      : `mediaGeneration.${kind}Placeholder`
                  )}
                />
              </Field>
            </>
          )}
        </div>

        {models.length > 0 && (
          <div className='border-t border-gray-200/70 p-4 dark:border-white/[0.08] sm:px-5'>
            <Button
              onClick={handleGenerate}
              disabled={generating || !selectedModel || !prompt.trim()}
              className='w-full gap-2'
            >
              {generating ? (
                <Loader2 className='h-4 w-4 animate-spin' />
              ) : (
                <Sparkles className='h-4 w-4' />
              )}
              {generating
                ? t('mediaGeneration.generating')
                : t('mediaGeneration.generate')}
            </Button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className='block space-y-1.5 text-sm font-medium text-gray-700 dark:text-gray-300'>
      <span>{label}</span>
      {children}
    </label>
  );
}

function modelKey(model: {
  model: string;
  plugin: string;
  mode?: 'speech' | 'sound';
}): string {
  return `${model.mode || 'default'}::${model.plugin}::${model.model}`;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

const inputClass =
  'w-full rounded-xl border border-gray-200/80 bg-white/70 px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:border-white/10 dark:bg-white/[0.035] dark:text-gray-100';

export default MediaGenerationPanel;
