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
import React from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Compass } from 'lucide-react';

/**
 * Shown inside the shell for any unmatched path, so a stale bookmark or a
 * mistyped URL lands on a clear way back instead of an empty content card.
 */
const NotFoundPage: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className='flex h-full items-center justify-center p-6'>
      <div className='max-w-sm text-center' data-testid='not-found-page'>
        <div className='mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-surface-subtle text-ink-muted'>
          <Compass className='h-6 w-6' />
        </div>
        <h1 className='mb-2 text-xl font-semibold text-ink'>
          {t('notFound.title')}
        </h1>
        <p className='mb-5 text-sm leading-6 text-ink-muted'>
          {t('notFound.description')}
        </p>
        <Link
          to='/'
          className='inline-flex h-10 items-center justify-center rounded-xl bg-ink px-4 text-sm font-medium text-ink-inverse shadow-subtle transition-opacity duration-150 hover:opacity-90'
        >
          {t('errorBoundary.goHome')}
        </Link>
      </div>
    </div>
  );
};

export default NotFoundPage;
