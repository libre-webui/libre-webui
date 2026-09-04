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
import { useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Boxes, HardDrive, ShieldCheck } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { LoginForm } from '@/components/LoginForm';
import { SignupForm } from '@/components/SignupForm';
import { Logo } from '@/components/Logo';
import { LogoMark } from '@/components/LogoMark';
import { ThemeToggle } from '@/components/ThemeToggle';
import { CelestialSky } from '@/components/CelestialSky';
import { resolveAppVersion } from '@/utils/appVersion';

export const LoginPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated, requiresAuth, systemInfo } = useAuthStore();
  const [isSignupMode, setIsSignupMode] = useState(false);
  const authRequired = requiresAuth();
  const signupEnabled = systemInfo?.signupEnabled ?? true;
  const oauthApprovalPending =
    new URLSearchParams(location.search).get('approval') === 'pending';

  useEffect(() => {
    // If already authenticated or auth is disabled, redirect to home.
    if (isAuthenticated || !authRequired) {
      navigate('/');
    }
  }, [authRequired, isAuthenticated, navigate]);

  if (isAuthenticated || !authRequired) {
    return null;
  }

  const highlights = [
    {
      icon: ShieldCheck,
      title: t('auth.highlights.local.title', 'Local first'),
      body: t(
        'auth.highlights.local.body',
        'Your conversations and files stay on the machine you run this on.'
      ),
    },
    {
      icon: Boxes,
      title: t('auth.highlights.providers.title', 'Any provider'),
      body: t(
        'auth.highlights.providers.body',
        'Local models through Ollama, plus the remote providers you choose to add.'
      ),
    },
    {
      icon: HardDrive,
      title: t('auth.highlights.work.title', 'Isolated Work'),
      body: t(
        'auth.highlights.work.body',
        'Give a model a sandboxed workspace with files, a terminal, and a preview.'
      ),
    },
  ];

  const version = resolveAppVersion(systemInfo?.version);

  return (
    <div
      className='relative min-h-screen overflow-y-auto bg-canvas text-ink'
      data-celestial-canvas=''
    >
      <CelestialSky />
      <header className='absolute inset-x-0 top-0 z-20 flex h-14 items-center justify-between px-5 sm:px-8'>
        <div className='flex items-center gap-2 text-ink lg:invisible'>
          <LogoMark size='sm' label={null} />
          <Logo size='sm' />
        </div>
        <ThemeToggle />
      </header>

      <main className='relative z-10 grid min-h-screen lg:grid-cols-2'>
        <section
          className='relative hidden flex-col justify-between border-e border-line bg-surface px-10 py-12 lg:flex xl:px-16'
          data-celestial-surface=''
        >
          <div className='relative z-10 flex items-center gap-3.5 text-ink'>
            <LogoMark size='lg' label={null} />
            <Logo size='lg' />
          </div>

          <div className='relative z-10 max-w-lg'>
            <p className='text-[2.6rem] font-light leading-[1.05] tracking-[-0.04em] text-ink xl:text-5xl'>
              {t('auth.tagline', 'Your AI stack should answer to you.')}
            </p>

            <ul className='mt-10 space-y-5'>
              {highlights.map(item => (
                <li key={item.title} className='flex gap-3'>
                  <item.icon
                    aria-hidden='true'
                    className='mt-0.5 h-4 w-4 shrink-0 text-ink-subtle'
                  />
                  <div className='min-w-0'>
                    <p className='text-[13px] font-medium text-ink'>
                      {item.title}
                    </p>
                    <p className='mt-0.5 text-[13px] leading-relaxed text-ink-muted'>
                      {item.body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className='relative z-10 space-y-1 font-mono text-[11px] text-ink-subtle'>
            <p>
              <a
                href='https://librewebui.org'
                target='_blank'
                rel='noopener noreferrer'
                className='transition-colors hover:text-ink'
              >
                librewebui.org
              </a>
              {' · '}
              <a
                href='https://docs.librewebui.org'
                target='_blank'
                rel='noopener noreferrer'
                className='transition-colors hover:text-ink'
              >
                docs.librewebui.org
              </a>
            </p>
            <p data-testid='app-version'>
              {version ? `v${version}` : ''}
              {version ? ' · ' : ''}
              {t('auth.selfHosted', 'Self-hosted · Apache 2.0')}
              {' · '}
              <a
                href='https://kroonen.ai'
                target='_blank'
                rel='noopener noreferrer'
                className='transition-colors hover:text-ink'
              >
                kroonen.ai
              </a>
            </p>
          </div>
        </section>

        <section className='flex items-center justify-center px-5 pb-12 pt-24 sm:px-8 lg:px-12 lg:py-12'>
          <div className='w-full max-w-sm'>
            {isSignupMode && signupEnabled ? (
              <SignupForm
                bare
                onBackToLogin={() => setIsSignupMode(false)}
                onSignup={() => setIsSignupMode(false)}
              />
            ) : (
              <LoginForm
                bare
                initialApprovalPending={oauthApprovalPending}
                onShowSignup={
                  signupEnabled ? () => setIsSignupMode(true) : undefined
                }
              />
            )}
          </div>
        </section>
      </main>
    </div>
  );
};
