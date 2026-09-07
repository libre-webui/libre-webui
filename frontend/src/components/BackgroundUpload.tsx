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

import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Image as ImageIcon, Loader2, Upload, X } from 'lucide-react';
import { Button, Select } from '@/components/ui';
import { WallpaperLayer } from '@/components/BackgroundRenderer';
import { useAppStore } from '@/store/appStore';
import { useAuthStore } from '@/store/authStore';
import {
  normalizeBackgroundSettings,
  type NormalizedBackgroundSettings,
} from '@/utils/backgroundSettings';
import toast from 'react-hot-toast';
import { cn } from '@/utils';
import { createLogger } from '@/utils/logger';

const logger = createLogger('components:background-upload');

interface BackgroundUploadProps {
  className?: string;
}

export const BackgroundUpload: React.FC<BackgroundUploadProps> = props => {
  const ownerId = useAuthStore(state => state.user?.id);
  // Files and retry closures belong to the account that opened these controls.
  return <BackgroundUploadControls key={ownerId ?? 'solo'} {...props} />;
};

const BackgroundUploadControls: React.FC<BackgroundUploadProps> = ({
  className = '',
}) => {
  const { t, i18n } = useTranslation();
  const {
    preferences,
    backgroundImage,
    updateBackgroundSettings,
    uploadBackgroundImage,
    removeBackgroundImage,
  } = useAppStore();
  const id = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const operationIdRef = useRef(0);
  const retryRef = useRef<(() => Promise<void>) | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [saveState, setSaveState] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');

  useEffect(
    () => () => {
      operationIdRef.current += 1;
      retryRef.current = null;
    },
    []
  );

  const settings = normalizeBackgroundSettings({
    ...preferences.backgroundSettings,
    imageUrl: backgroundImage || preferences.backgroundSettings?.imageUrl || '',
  });
  const hasImage = Boolean(settings.imageUrl);

  const save = async (operation: () => Promise<void>) => {
    const operationId = ++operationIdRef.current;
    retryRef.current = operation;
    setSaveState('saving');
    try {
      await operation();
      if (operationId === operationIdRef.current) setSaveState('saved');
    } catch (error) {
      if (operationId !== operationIdRef.current) return;
      if (error instanceof DOMException && error.name === 'AbortError') {
        setSaveState('idle');
        return;
      }
      logger.error('Failed to save background settings:', error);
      setSaveState('error');
    }
  };

  const changeSettings = (updates: Partial<NormalizedBackgroundSettings>) =>
    void save(() => updateBackgroundSettings(updates));

  const handleFileSelect = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      toast.error(t('personaBackground.invalidFile'));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error(t('settings.appearance.background.fileTooLarge'));
      return;
    }
    setUploading(true);
    try {
      await save(() => uploadBackgroundImage(file));
    } finally {
      setUploading(false);
    }
  };

  const enabledId = id + '-enabled';
  const blurId = id + '-blur';
  const intensityId = id + '-intensity';
  const intensity = new Intl.NumberFormat(i18n.language, {
    style: 'percent',
    maximumFractionDigits: 0,
  }).format(settings.opacity);

  return (
    <div className={cn('space-y-4', className)} data-testid='background-upload'>
      <div className='flex items-start justify-between gap-4'>
        <div className='min-w-0'>
          <h4 className='text-sm font-medium text-ink'>
            {t('settings.appearance.background.title')}
          </h4>
          <p className='mt-1 text-xs leading-5 text-ink-muted'>
            {t('settings.appearance.background.enableDescription')}
          </p>
        </div>
        <label
          htmlFor={enabledId}
          className='touch-target relative inline-flex shrink-0 cursor-pointer items-center gap-2'
        >
          <span className='sr-only'>
            {t('settings.appearance.background.enable')}
          </span>
          <input
            id={enabledId}
            type='checkbox'
            className='peer sr-only'
            checked={settings.enabled}
            onChange={event =>
              changeSettings({ enabled: event.target.checked })
            }
            data-testid='background-enabled'
          />
          <span className='relative h-6 w-11 rounded-full bg-surface-raised ring-1 ring-inset ring-line transition-colors peer-checked:bg-primary-600 peer-focus-visible:ring-2 peer-focus-visible:ring-primary-500 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface motion-reduce:transition-none'>
            <span
              className={cn(
                'absolute start-1 top-1 h-4 w-4 rounded-full bg-white shadow-subtle transition-transform motion-reduce:transition-none',
                settings.enabled && 'translate-x-5 rtl:-translate-x-5'
              )}
            />
          </span>
        </label>
      </div>

      <div
        className={cn(
          'overflow-hidden rounded-xl border border-line bg-surface-subtle',
          dragOver && 'border-primary-500 ring-2 ring-primary-500/20'
        )}
        onDragOver={event => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={event => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          ) {
            setDragOver(false);
          }
        }}
        onDrop={event => {
          event.preventDefault();
          setDragOver(false);
          const file = event.dataTransfer.files?.[0];
          if (file && !uploading) void handleFileSelect(file);
        }}
      >
        {hasImage ? (
          <>
            <div
              role='img'
              aria-label={t('settings.appearance.background.preview')}
              className='relative aspect-video overflow-hidden bg-canvas'
              data-testid='background-preview'
            >
              <WallpaperLayer
                settings={{ ...settings, enabled: true }}
                testId='background-preview-layer'
              />
            </div>
            <div className='flex flex-wrap items-center justify-between gap-3 border-t border-line px-3 py-2.5'>
              <span className='text-xs text-ink-muted'>
                {t('settings.appearance.background.preview')}
              </span>
              <div className='flex flex-wrap items-center gap-2'>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  data-testid='background-change'
                >
                  <Upload className='h-3.5 w-3.5' aria-hidden='true' />
                  {t('settings.appearance.background.change')}
                </Button>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  onClick={() =>
                    void save(async () => {
                      await removeBackgroundImage();
                    })
                  }
                  disabled={uploading}
                  className='text-error-600 hover:text-error-700 dark:text-error-400'
                  data-testid='background-remove'
                >
                  <X className='h-3.5 w-3.5' aria-hidden='true' />
                  {t('common.remove')}
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div className='flex flex-col items-center gap-3 px-4 py-6 text-center'>
            <ImageIcon className='h-7 w-7 text-ink-subtle' aria-hidden='true' />
            <p className='text-xs leading-5 text-ink-muted'>
              {t('settings.appearance.background.dragDrop')}
            </p>
            <Button
              type='button'
              variant='outline'
              size='sm'
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              data-testid='background-change'
            >
              <Upload className='h-3.5 w-3.5' aria-hidden='true' />
              {uploading
                ? t('common.loading')
                : t('settings.appearance.background.chooseImage')}
            </Button>
          </div>
        )}
        <input
          ref={fileInputRef}
          type='file'
          accept='image/*'
          disabled={uploading}
          className='hidden'
          data-testid='background-file-input'
          onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void handleFileSelect(file);
          }}
        />
      </div>

      {hasImage && (
        <div className='space-y-4'>
          <Select
            label={t('settings.appearance.background.effect')}
            value={settings.effect}
            onChange={event =>
              changeSettings({
                effect: event.target
                  .value as NormalizedBackgroundSettings['effect'],
              })
            }
            options={[
              {
                value: 'dither',
                label: t('settings.appearance.background.dither'),
              },
              {
                value: 'original',
                label: t('settings.appearance.background.original'),
              },
              {
                value: 'blur',
                label: t('settings.appearance.background.blurred'),
              },
            ]}
            data-testid='background-effect'
          />

          {settings.effect === 'blur' && (
            <div>
              <label
                htmlFor={blurId}
                className='mb-2 flex items-center justify-between gap-3 text-sm text-ink'
              >
                <span>{t('settings.appearance.background.blur')}</span>
                <span dir='ltr' className='text-xs tabular-nums text-ink-muted'>
                  {settings.blurAmount}px
                </span>
              </label>
              <input
                id={blurId}
                type='range'
                min={0}
                max={30}
                step={1}
                value={settings.blurAmount}
                onChange={event =>
                  changeSettings({ blurAmount: Number(event.target.value) })
                }
                className='h-6 w-full cursor-pointer accent-primary-600'
                data-testid='background-blur'
              />
            </div>
          )}

          <div>
            <label
              htmlFor={intensityId}
              className='mb-2 flex items-center justify-between gap-3 text-sm text-ink'
            >
              <span>{t('settings.appearance.background.intensity')}</span>
              <span className='text-xs tabular-nums text-ink-muted'>
                {intensity}
              </span>
            </label>
            <input
              id={intensityId}
              type='range'
              min={0}
              max={1}
              step={0.05}
              value={settings.opacity}
              aria-valuetext={intensity}
              onChange={event =>
                changeSettings({ opacity: Number(event.target.value) })
              }
              className='h-6 w-full cursor-pointer accent-primary-600'
              data-testid='background-intensity'
            />
          </div>
          <p className='text-xs leading-5 text-ink-muted'>
            {t('settings.appearance.background.originalPreserved')}
          </p>
        </div>
      )}

      <div
        role={
          saveState === 'idle'
            ? undefined
            : saveState === 'error'
              ? 'alert'
              : 'status'
        }
        className={cn(
          'flex min-h-5 flex-wrap items-center gap-2 text-xs',
          saveState === 'error'
            ? 'text-error-600 dark:text-error-400'
            : 'text-ink-muted'
        )}
        data-testid='background-save-status'
      >
        {saveState === 'saving' && (
          <>
            <Loader2
              className='h-3.5 w-3.5 animate-spin motion-reduce:animate-none'
              aria-hidden='true'
            />
            {t('common.saving')}
          </>
        )}
        {saveState === 'saved' && (
          <>
            <Check className='h-3.5 w-3.5' aria-hidden='true' />
            {t('settings.appearance.background.saved')}
          </>
        )}
        {saveState === 'error' && (
          <>
            <span>{t('settings.appearance.background.saveFailed')}</span>
            <Button
              type='button'
              variant='ghost'
              size='sm'
              onClick={() => {
                if (retryRef.current) void save(retryRef.current);
              }}
            >
              {t('common.retry')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
};
