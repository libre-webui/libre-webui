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

import React, { useRef } from 'react';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { cn } from '@/utils';

interface ModalShellProps {
  titleId: string;
  title: React.ReactNode;
  /** Optional line under the title, for the one-sentence explainers. */
  subtitle?: React.ReactNode;
  onClose: () => void;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  widthClassName?: string;
  testId?: string;
}

/** Field styling shared by the workspace forms, matching the automations modal. */
export const modalFieldClass =
  'w-full rounded-lg border border-black/[0.08] bg-white px-2.5 py-1.5 text-[13px] text-gray-900 focus:border-primary-500/40 focus:outline-none dark:border-white/[0.08] dark:bg-dark-100 dark:text-dark-900';

export const modalLabelClass =
  'mb-1 block text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-dark-500';

/**
 * Centered dialog chrome shared by the prompt, skill and tool forms so the
 * workspace pages stay visually identical without repeating the portal,
 * backdrop and close-button wiring three times over.
 */
export const ModalShell: React.FC<ModalShellProps> = ({
  titleId,
  title,
  subtitle,
  onClose,
  children,
  footer,
  widthClassName = 'max-w-lg',
  testId,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, { onClose });

  return createPortal(
    <div
      className='fixed inset-0 z-[2147483647] flex items-center justify-center bg-gray-950/55 p-4 backdrop-blur-md'
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role='dialog'
        aria-modal='true'
        aria-labelledby={titleId}
        data-testid={testId}
        className={cn(
          'max-h-[90vh] w-full overflow-y-auto rounded-3xl border border-black/[0.07] bg-white p-6 shadow-[0_24px_80px_rgba(0,0,0,0.24)] animate-scale-in scrollbar-thin dark:border-white/[0.08] dark:bg-dark-25',
          widthClassName
        )}
        onClick={event => event.stopPropagation()}
      >
        <ModalHeader
          titleId={titleId}
          title={title}
          subtitle={subtitle}
          onClose={onClose}
        />
        {children && <div className='space-y-4'>{children}</div>}
        {footer && (
          <div className='mt-5 flex justify-end gap-3 border-t border-gray-200 pt-4 dark:border-dark-300'>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};

const ModalHeader: React.FC<
  Pick<ModalShellProps, 'titleId' | 'title' | 'subtitle' | 'onClose'>
> = ({ titleId, title, subtitle, onClose }) => {
  const { t } = useTranslation();
  return (
    <div className='mb-4 flex items-start justify-between gap-4'>
      <div className='min-w-0'>
        <h3
          id={titleId}
          className='text-lg font-medium tracking-[-0.02em] text-gray-950 dark:text-dark-950'
        >
          {title}
        </h3>
        {subtitle && (
          <p className='mt-1 text-[12px] leading-5 text-gray-500 dark:text-dark-500'>
            {subtitle}
          </p>
        )}
      </div>
      <button
        type='button'
        onClick={onClose}
        aria-label={t('common.close')}
        className='shrink-0 rounded-xl p-2 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:hover:bg-dark-200'
      >
        <X size={20} className='text-gray-500' />
      </button>
    </div>
  );
};
