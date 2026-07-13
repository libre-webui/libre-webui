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

import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { AvatarUpload } from '@/components/AvatarUpload';

interface AvatarModalProps {
  open: boolean;
  value: string;
  saving: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
}

export function AvatarModal({
  open,
  value,
  saving,
  onChange,
  onClose,
  onSave,
}: AvatarModalProps) {
  const { t } = useTranslation();

  if (!open) return null;

  return createPortal(
    <div
      className='fixed inset-0 z-[2147483647] flex items-center justify-center bg-gray-950/55 p-4 backdrop-blur-md'
      onClick={onClose}
    >
      <div
        role='dialog'
        aria-modal='true'
        aria-labelledby='avatar-modal-title'
        className='bg-white dark:bg-dark-25 rounded-3xl shadow-[0_24px_80px_rgba(0,0,0,0.24)] p-6 w-full max-w-md border border-black/[0.07] dark:border-white/[0.08] animate-scale-in'
        onClick={e => e.stopPropagation()}
      >
        <div className='flex items-center justify-between mb-4'>
          <h3
            id='avatar-modal-title'
            className='text-lg font-medium tracking-[-0.02em] text-gray-950 dark:text-dark-950'
          >
            {t('user.avatar.title')}
          </h3>
          <button
            onClick={onClose}
            className='p-2 hover:bg-gray-100 dark:hover:bg-dark-200 rounded-xl transition-colors'
          >
            <X size={20} className='text-gray-500' />
          </button>
        </div>

        <div className='space-y-4'>
          <AvatarUpload value={value} onChange={onChange} />

          <div className='flex justify-end gap-3 pt-4 border-t border-gray-200 dark:border-dark-300'>
            <button
              onClick={onClose}
              className='px-4 py-2 text-sm font-medium text-gray-700 dark:text-dark-700 hover:bg-gray-100 dark:hover:bg-dark-200 rounded-xl transition-colors'
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={onSave}
              disabled={saving}
              className='px-4 py-2 text-sm font-medium text-white bg-gray-950 hover:bg-gray-800 dark:bg-white dark:text-gray-950 dark:hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors'
            >
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
