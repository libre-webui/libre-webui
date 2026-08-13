/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
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
  type VideoGenerationJob,
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
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<MediaGenerationKind>(initialKind);
  const [catalog, setCatalog] = useState<MediaModelCatalog>(EMPTY_CATALOG);
  const [selected, setSelected] = useState('');
  const [prompt, setPrompt] = useState('');
  const [voice, setVoice] = useState('');
  const [cloneVoice, setCloneVoice] = useState(false);
  const [referenceAudio, setReferenceAudio] = useState<File | null>(null);
  const [referenceText, setReferenceText] = useState('');
  const [saveVoiceProfile, setSaveVoiceProfile] = useState(false);
  const [voiceProfileName, setVoiceProfileName] = useState('');
  const [consentToStore, setConsentToStore] = useState(false);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [resolution, setResolution] = useState('');
  const [aspectRatio, setAspectRatio] = useState('');
  const [duration, setDuration] = useState('');
  const [generateAudio, setGenerateAudio] = useState(true);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [videoJobs, setVideoJobs] = useState<VideoGenerationJob[]>([]);
  const generationControllerRef = useRef<AbortController | null>(null);
  const titleId = React.useId();

  const resetVoiceCloneInputs = () => {
    setCloneVoice(false);
    setReferenceAudio(null);
    setReferenceText('');
    setSaveVoiceProfile(false);
    setVoiceProfileName('');
    setConsentToStore(false);
    setFileInputKey(value => value + 1);
  };

  const handleClose = () => {
    generationControllerRef.current?.abort();
    resetVoiceCloneInputs();
    onClose();
  };

  useEffect(
    () => () => {
      generationControllerRef.current?.abort();
      generationControllerRef.current = null;
    },
    []
  );

  useEffect(() => {
    if (!isOpen) generationControllerRef.current?.abort();
  }, [isOpen]);

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

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void mediaApi
      .listVideoJobs({ limit: 100, active: true })
      .then(response => {
        if (!cancelled && response.success && response.data) {
          setVideoJobs(response.data.jobs);
        }
      })
      .catch(() => {
        if (!cancelled) {
          toast.error(
            t('mediaGeneration.jobsLoadFailed', {
              defaultValue: 'Failed to load saved video jobs',
            })
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, t]);

  const models = kind === 'video' ? catalog.video : catalog.audio;
  const recoverableVideoJobs = videoJobs.filter(
    job => job.status !== 'completed'
  );

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
  const supportsVoiceCloning = Boolean(
    audioModel?.mode === 'speech' && audioModel.config?.supports_voice_cloning
  );
  const cloneRequiresTranscript = Boolean(
    audioModel?.config?.clone_requires_transcript
  );
  const useVoiceClone = supportsVoiceCloning && cloneVoice;
  const allowsVoiceInput = Boolean(
    audioModel?.mode !== 'speech' ||
    audioModel.config?.allows_custom_voice !== false ||
    audioModel.config?.voices?.length
  );
  const speechMaxCharacters =
    audioModel?.mode === 'speech'
      ? audioModel.config?.max_characters
      : undefined;

  const followVideoJob = async (
    job: VideoGenerationJob,
    controller: AbortController,
    waitBeforePoll: boolean,
    transientFailures = 0
  ): Promise<VideoGenerationJob> => {
    if (job.status !== 'pending' && job.status !== 'in_progress') return job;
    if (waitBeforePoll) await delay(30_000, controller.signal);
    try {
      const response = await mediaApi.resumeVideoJob(job.id, controller.signal);
      if (!response.success || !response.data) {
        throw new Error(response.message || t('mediaGeneration.failed'));
      }
      const nextJob = response.data;
      setVideoJobs(current => [
        nextJob,
        ...current.filter(candidate => candidate.id !== nextJob.id),
      ]);
      return followVideoJob(nextJob, controller, true);
    } catch (error) {
      if (controller.signal.aborted || transientFailures >= 4) throw error;
      return followVideoJob(job, controller, true, transientFailures + 1);
    }
  };

  const handleResumeVideoJob = async (initialJob: VideoGenerationJob) => {
    const controller = new AbortController();
    generationControllerRef.current?.abort();
    generationControllerRef.current = controller;
    setGenerating(true);
    try {
      const job = await followVideoJob(initialJob, controller, false);
      if (controller.signal.aborted) return;
      if (job.status === 'failed') {
        throw new Error(job.error || t('mediaGeneration.failed'));
      }
      toast.success(t('mediaGeneration.success'));
      onGenerated();
    } catch (error) {
      if (controller.signal.aborted) return;
      toast.error(
        error instanceof Error ? error.message : t('mediaGeneration.failed')
      );
    } finally {
      if (generationControllerRef.current === controller) {
        generationControllerRef.current = null;
        setGenerating(false);
      }
    }
  };

  const handleCancelVideoJob = async (job: VideoGenerationJob) => {
    try {
      const response = await mediaApi.cancelVideoJob(job.id);
      if (!response.success) {
        throw new Error(response.message || t('mediaGeneration.failed'));
      }
      setVideoJobs(current =>
        current.filter(candidate => candidate.id !== job.id)
      );
      toast.success(
        t('mediaGeneration.jobCancelled', {
          defaultValue: 'Video job cancelled at the provider',
        })
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('mediaGeneration.failed')
      );
    }
  };

  const handleGenerate = async () => {
    if (!selectedModel || !prompt.trim()) return;
    const controller = new AbortController();
    generationControllerRef.current?.abort();
    generationControllerRef.current = controller;
    setGenerating(true);
    try {
      if (kind === 'audio') {
        const responseFormat = resolveSpeechFormat(
          audioModel?.config?.default_format
        );
        const response = useVoiceClone
          ? await mediaApi.cloneVoice(
              {
                model: selectedModel.model,
                pluginId: selectedModel.plugin,
                input: prompt.trim(),
                referenceAudio: referenceAudio!,
                referenceText: referenceText.trim() || undefined,
                responseFormat,
                saveVoiceName: saveVoiceProfile
                  ? voiceProfileName.trim()
                  : undefined,
                consentToStore: saveVoiceProfile && consentToStore,
              },
              controller.signal
            )
          : audioModel?.mode === 'sound'
            ? await mediaApi.generateSound(
                {
                  model: selectedModel.model,
                  pluginId: selectedModel.plugin,
                  prompt: prompt.trim(),
                  voice:
                    voice.trim() ||
                    audioModel?.config?.default_voice ||
                    undefined,
                  format: 'wav',
                },
                controller.signal
              )
            : await mediaApi.generateAudio(
                {
                  model: selectedModel.model,
                  pluginId: selectedModel.plugin,
                  input: prompt.trim(),
                  voice:
                    voice.trim() ||
                    audioModel?.config?.default_voice ||
                    undefined,
                  response_format: responseFormat,
                },
                controller.signal
              );
        if (controller.signal.aborted) return;
        if (!response.success) throw new Error(response.message);
        if (useVoiceClone && saveVoiceProfile) {
          await queryClient.invalidateQueries({
            queryKey: ['tts-voice-profiles'],
          });
          if (controller.signal.aborted) return;
        }
      } else {
        const submitted = await mediaApi.generateVideo(
          {
            model: selectedModel.model,
            pluginId: selectedModel.plugin,
            prompt: prompt.trim(),
            ...(duration ? { duration: Number(duration) } : {}),
            ...(resolution ? { resolution } : {}),
            ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
            ...(videoConfig?.supports_audio
              ? { generate_audio: generateAudio }
              : {}),
          },
          controller.signal
        );
        if (controller.signal.aborted) return;
        if (!submitted.success || !submitted.data) {
          throw new Error(submitted.message || t('mediaGeneration.failed'));
        }
        const submittedJob = submitted.data;
        setVideoJobs(current => [
          submittedJob,
          ...current.filter(job => job.id !== submittedJob.id),
        ]);
        const job = await followVideoJob(submittedJob, controller, true);
        if (job.status === 'failed') {
          throw new Error(job.error || t('mediaGeneration.failed'));
        }
      }
      if (controller.signal.aborted) return;
      toast.success(
        useVoiceClone && saveVoiceProfile
          ? t('mediaGeneration.successWithSavedVoice', {
              name: voiceProfileName.trim(),
              defaultValue:
                'Media generated and “{{name}}” is now available in Speech settings',
            })
          : t('mediaGeneration.success')
      );
      setPrompt('');
      resetVoiceCloneInputs();
      onGenerated();
      onClose();
    } catch (error) {
      if (controller.signal.aborted) return;
      toast.error(
        error instanceof Error ? error.message : t('mediaGeneration.failed')
      );
    } finally {
      if (generationControllerRef.current === controller) {
        generationControllerRef.current = null;
        setGenerating(false);
      }
    }
  };

  const handleCancelGeneration = () => {
    generationControllerRef.current?.abort();
  };

  if (!isOpen) return null;

  return createPortal(
    <div className='fixed inset-0 z-[99999] flex items-center justify-center p-3 sm:p-6'>
      <button
        className='absolute inset-0 bg-black/55 backdrop-blur-sm'
        onClick={handleClose}
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
          <button onClick={handleClose} className='rounded-xl p-2'>
            <X className='h-5 w-5' />
          </button>
        </div>

        <div className='scroll-region min-h-0 flex-1 space-y-4 p-4 sm:p-5'>
          <div className='grid grid-cols-2 gap-2 rounded-xl bg-gray-100 p-1 dark:bg-white/[0.05]'>
            {(['video', 'audio'] as const).map(option => (
              <button
                key={option}
                type='button'
                disabled={generating}
                onClick={() => {
                  setKind(option);
                  setSelected('');
                  setVoice('');
                  resetVoiceCloneInputs();
                }}
                className={cn(
                  'flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors',
                  option === kind
                    ? 'bg-white text-gray-950 shadow-sm dark:bg-white/10 dark:text-white'
                    : 'text-gray-500 dark:text-dark-500',
                  generating && 'cursor-not-allowed opacity-50'
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

          {kind === 'video' && recoverableVideoJobs.length > 0 && (
            <section className='space-y-2 rounded-xl border border-gray-200/80 bg-gray-50/80 p-3 dark:border-white/10 dark:bg-white/[0.025]'>
              <div>
                <h3 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
                  {t('mediaGeneration.savedJobs', {
                    defaultValue: 'Saved video jobs',
                  })}
                </h3>
                <p className='mt-0.5 text-xs text-gray-500 dark:text-dark-500'>
                  {t('mediaGeneration.savedJobsDescription', {
                    defaultValue:
                      'Closing this panel only stops waiting. Reopen it to resume any provider job listed here.',
                  })}
                </p>
              </div>
              {recoverableVideoJobs.map(job => (
                <div
                  key={job.id}
                  data-testid={`video-job-${job.id}`}
                  className='flex items-center gap-3 rounded-lg border border-gray-200/70 bg-white/80 p-2.5 dark:border-white/10 dark:bg-dark-50/70'
                >
                  <div className='min-w-0 flex-1'>
                    <p className='truncate text-sm text-gray-900 dark:text-gray-100'>
                      {job.prompt || job.model}
                    </p>
                    <p className='text-xs text-gray-500 dark:text-dark-500'>
                      {job.model} ·{' '}
                      {t(`mediaGeneration.jobStatus.${job.status}`, {
                        defaultValue: job.status.replace('_', ' '),
                      })}
                    </p>
                    {job.error && (
                      <p className='mt-1 text-xs text-red-600 dark:text-red-300'>
                        {job.error}
                      </p>
                    )}
                  </div>
                  {(job.status === 'pending' ||
                    job.status === 'in_progress') && (
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      disabled={generating}
                      onClick={() => void handleResumeVideoJob(job)}
                    >
                      {t('mediaGeneration.resumeJob', {
                        defaultValue: 'Resume',
                      })}
                    </Button>
                  )}
                  {job.cancellable && (
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      disabled={generating}
                      onClick={() => void handleCancelVideoJob(job)}
                    >
                      {t('mediaGeneration.cancelJob', {
                        defaultValue: 'Cancel job',
                      })}
                    </Button>
                  )}
                </div>
              ))}
            </section>
          )}

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
                    setVoice('');
                    resetVoiceCloneInputs();
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

              {kind === 'audio' && !useVoiceClone && allowsVoiceInput ? (
                <Field label={t('mediaGeneration.voice')}>
                  <input
                    value={voice}
                    onChange={event => setVoice(event.target.value)}
                    className={inputClass}
                    placeholder={
                      audioModel?.config?.default_voice ||
                      t('mediaGeneration.providerDefault')
                    }
                  />
                </Field>
              ) : kind === 'video' ? (
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
              ) : null}

              {supportsVoiceCloning && (
                <div className='space-y-3 rounded-xl border border-primary-500/20 bg-primary-500/[0.06] p-4'>
                  <label className='flex items-start gap-3 text-sm'>
                    <input
                      type='checkbox'
                      checked={useVoiceClone}
                      onChange={event => {
                        if (event.target.checked) {
                          setCloneVoice(true);
                        } else {
                          resetVoiceCloneInputs();
                        }
                      }}
                      className='mt-0.5'
                    />
                    <span>
                      <span className='block font-medium text-gray-900 dark:text-gray-100'>
                        {t('mediaGeneration.cloneVoice')}
                      </span>
                      <span className='mt-0.5 block text-xs font-normal text-gray-500 dark:text-dark-500'>
                        {t('mediaGeneration.cloneVoiceDescription')}
                      </span>
                    </span>
                  </label>

                  {useVoiceClone && (
                    <div className='space-y-3 border-t border-primary-500/15 pt-3'>
                      <Field label={t('mediaGeneration.referenceAudio')}>
                        <input
                          key={fileInputKey}
                          type='file'
                          accept={
                            audioModel?.config?.clone_audio_mime_types?.join(
                              ','
                            ) || 'audio/wav,audio/mpeg,audio/flac,audio/ogg'
                          }
                          onChange={event => {
                            const file = event.target.files?.[0] || null;
                            const maxBytes =
                              audioModel?.config?.clone_max_audio_bytes;
                            if (file && maxBytes && file.size > maxBytes) {
                              toast.error(
                                t('mediaGeneration.referenceAudioTooLarge', {
                                  max: formatBytes(maxBytes),
                                })
                              );
                              event.target.value = '';
                              setReferenceAudio(null);
                              return;
                            }
                            setReferenceAudio(file);
                          }}
                          className={cn(
                            inputClass,
                            'file:me-3 file:rounded-lg file:border-0 file:bg-primary-500/10 file:px-3 file:py-1 file:text-primary-700 dark:file:text-primary-300'
                          )}
                        />
                      </Field>
                      <Field label={t('mediaGeneration.referenceTranscript')}>
                        <textarea
                          value={referenceText}
                          onChange={event =>
                            setReferenceText(event.target.value)
                          }
                          rows={3}
                          required={cloneRequiresTranscript}
                          className={cn(inputClass, 'resize-none')}
                          placeholder={t(
                            'mediaGeneration.referenceTranscriptPlaceholder'
                          )}
                        />
                      </Field>
                      <label className='flex items-start gap-3 text-sm'>
                        <input
                          type='checkbox'
                          checked={saveVoiceProfile}
                          onChange={event => {
                            setSaveVoiceProfile(event.target.checked);
                            if (!event.target.checked) {
                              setVoiceProfileName('');
                              setConsentToStore(false);
                            }
                          }}
                          className='mt-0.5'
                        />
                        <span>
                          <span className='block font-medium text-gray-900 dark:text-gray-100'>
                            {t('mediaGeneration.saveVoiceProfile', {
                              defaultValue: 'Save as a reusable voice',
                            })}
                          </span>
                          <span className='mt-0.5 block text-xs font-normal text-gray-500 dark:text-dark-500'>
                            {t('mediaGeneration.saveVoiceProfileDescription', {
                              defaultValue:
                                'Store this reference recording and transcript securely. Libre WebUI sends them to the selected provider for every Speech batch that uses this voice.',
                            })}
                          </span>
                        </span>
                      </label>
                      {saveVoiceProfile && (
                        <div className='space-y-3 rounded-lg border border-primary-500/15 bg-white/60 p-3 dark:bg-dark-100/50'>
                          <Field
                            label={t('mediaGeneration.voiceProfileName', {
                              defaultValue: 'Saved voice name',
                            })}
                          >
                            <input
                              type='text'
                              value={voiceProfileName}
                              onChange={event =>
                                setVoiceProfileName(event.target.value)
                              }
                              maxLength={80}
                              autoComplete='off'
                              className={inputClass}
                              placeholder={t(
                                'mediaGeneration.voiceProfileNamePlaceholder',
                                { defaultValue: 'For example, My voice' }
                              )}
                            />
                          </Field>
                          <label className='flex items-start gap-3 text-xs text-amber-700 dark:text-amber-300'>
                            <input
                              type='checkbox'
                              checked={consentToStore}
                              onChange={event =>
                                setConsentToStore(event.target.checked)
                              }
                              className='mt-0.5'
                            />
                            <span>
                              {t('mediaGeneration.voiceStorageConsent', {
                                defaultValue:
                                  'I confirm that I have the speaker’s permission to clone and store this voice. The reference stays saved until I delete it.',
                              })}
                            </span>
                          </label>
                        </div>
                      )}
                      {!saveVoiceProfile && (
                        <p className='text-xs font-normal text-amber-700 dark:text-amber-300'>
                          {t('mediaGeneration.cloneConsent')}
                        </p>
                      )}
                    </div>
                  )}
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
                  maxLength={speechMaxCharacters}
                  className={cn(inputClass, 'resize-none')}
                  placeholder={t(
                    kind === 'audio' && audioModel?.mode === 'sound'
                      ? 'mediaGeneration.soundPlaceholder'
                      : `mediaGeneration.${kind}Placeholder`
                  )}
                />
                {speechMaxCharacters && (
                  <span className='block text-end text-xs font-normal text-gray-500 dark:text-dark-500'>
                    {prompt.length} / {speechMaxCharacters}
                  </span>
                )}
              </Field>
            </>
          )}
        </div>

        {models.length > 0 && (
          <div className='border-t border-gray-200/70 p-4 dark:border-white/[0.08] sm:px-5'>
            <Button
              onClick={generating ? handleCancelGeneration : handleGenerate}
              disabled={
                generating
                  ? false
                  : !selectedModel ||
                    !prompt.trim() ||
                    Boolean(
                      speechMaxCharacters && prompt.length > speechMaxCharacters
                    ) ||
                    (useVoiceClone &&
                      (!referenceAudio ||
                        (cloneRequiresTranscript && !referenceText.trim()) ||
                        (saveVoiceProfile &&
                          (!voiceProfileName.trim() || !consentToStore))))
              }
              className='w-full gap-2'
            >
              {generating ? (
                <X className='h-4 w-4' />
              ) : (
                <Sparkles className='h-4 w-4' />
              )}
              {generating
                ? kind === 'video'
                  ? t('mediaGeneration.stopWaiting', {
                      defaultValue: 'Stop waiting',
                    })
                  : t('common.cancel')
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

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      window.clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function resolveSpeechFormat(
  format?: string
): 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm' {
  return ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'].includes(format || '')
    ? (format as 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm')
    : 'mp3';
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.ceil(bytes / (1024 * 1024))} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

const inputClass =
  'w-full rounded-xl border border-gray-200/80 bg-white/70 px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:border-white/10 dark:bg-white/[0.035] dark:text-gray-100';

export default MediaGenerationPanel;
