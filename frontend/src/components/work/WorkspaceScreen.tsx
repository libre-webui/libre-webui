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

/**
 * Work Computer screen: a live, view-only window onto the task sandbox's
 * virtual desktop. Connecting first asks the server to start the GUI
 * session (idempotent), then attaches the noVNC client over a one-use
 * ticket WebSocket. Watching only in this phase — takeover comes later.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, MonitorPlay, RefreshCw } from 'lucide-react';
import { startWorkComputer, workScreenUrl } from '@/utils/api/workScreen';
import { logger } from '@/utils/logger';

// The RFB client instance surface this component actually uses.
interface RfbClient {
  viewOnly: boolean;
  scaleViewport: boolean;
  background: string;
  disconnect(): void;
  addEventListener(name: string, handler: () => void): void;
}

interface WorkspaceScreenProps {
  taskId: string;
  /** Only the visible tab connects; leaving the tab disconnects. */
  active: boolean;
}

type ScreenState = 'idle' | 'starting' | 'connected' | 'disconnected';

export function WorkspaceScreen({ taskId, active }: WorkspaceScreenProps) {
  const { t } = useTranslation();
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RfbClient | null>(null);
  const [state, setState] = useState<ScreenState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const disconnect = useCallback(() => {
    try {
      rfbRef.current?.disconnect();
    } catch {
      // Already closed.
    }
    rfbRef.current = null;
  }, []);

  useEffect(() => {
    if (!active) {
      disconnect();
      setState('idle');
      return;
    }
    let disposed = false;
    setState('starting');
    setError(null);
    (async () => {
      try {
        await startWorkComputer(taskId);
        const [{ default: RFB }, url] = await Promise.all([
          import('@novnc/novnc'),
          workScreenUrl(taskId),
        ]);
        if (disposed || !mountRef.current) return;
        const rfb = new RFB(mountRef.current, url, {
          shared: true,
        }) as unknown as RfbClient;
        rfb.viewOnly = true;
        rfb.scaleViewport = true;
        rfb.background = 'transparent';
        rfb.addEventListener('connect', () => {
          if (!disposed) setState('connected');
        });
        rfb.addEventListener('disconnect', () => {
          if (!disposed) setState('disconnected');
        });
        rfbRef.current = rfb;
      } catch (screenError) {
        logger.error('Work screen connection failed:', screenError);
        if (disposed) return;
        const apiError = screenError as {
          response?: { data?: { message?: string } };
        };
        setError(apiError.response?.data?.message ?? null);
        setState('disconnected');
      }
    })();
    return () => {
      disposed = true;
      disconnect();
    };
  }, [taskId, active, attempt, disconnect]);

  return (
    <div
      className='relative h-full min-h-[16rem] w-full overflow-hidden bg-black'
      data-testid='work-screen'
    >
      <div ref={mountRef} className='h-full w-full' />
      {state !== 'connected' && (
        <div className='absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center'>
          {state === 'starting' ? (
            <>
              <Loader2 size={20} className='animate-spin text-white/60' />
              <p className='text-sm text-white/70'>
                {t('work.screen.starting')}
              </p>
            </>
          ) : (
            <>
              <MonitorPlay size={22} className='text-white/40' />
              <p className='text-sm text-white/70'>
                {error ?? t('work.screen.disconnected')}
              </p>
              <button
                type='button'
                data-testid='work-screen-reconnect'
                onClick={() => setAttempt(value => value + 1)}
                className='flex items-center gap-2 rounded-lg border border-white/20 px-3 py-1.5 text-xs text-white/80 transition-colors hover:bg-white/10'
              >
                <RefreshCw size={12} />
                {t('work.screen.reconnect')}
              </button>
            </>
          )}
        </div>
      )}
      {state === 'connected' && (
        <div className='pointer-events-none absolute left-3 top-3 rounded-md bg-black/50 px-2 py-1 text-[10px] uppercase tracking-wide text-white/60 backdrop-blur'>
          {t('work.screen.viewOnly')}
        </div>
      )}
    </div>
  );
}
