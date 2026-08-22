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
 * Work Computer screen: a live window onto the task sandbox's virtual
 * desktop. Connecting first asks the server to start the GUI session
 * (idempotent), then attaches the noVNC client over a one-use ticket
 * WebSocket. Watching uses the session's view-only VNC password; "Take
 * over" acquires the control lease and reconnects with the full-control
 * password so the user can sign in or clear a CAPTCHA themselves, then
 * hands the screen back with "I'm done".
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Hand,
  Loader2,
  MonitorPlay,
  MousePointerClick,
  RefreshCw,
} from 'lucide-react';
import {
  acquireWorkScreenControl,
  getWorkScreenControl,
  releaseWorkScreenControl,
  startWorkComputer,
  workScreenUrl,
  type WorkScreenControlState,
} from '@/utils/api/workScreen';
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
type ScreenMode = 'view' | 'control';

const CONTROL_STATE_POLL_MS = 3_000;
/** Renew well inside the lease TTL (the server holds leases for 2 min). */
const CONTROL_RENEW_MS = 60_000;

export function WorkspaceScreen({ taskId, active }: WorkspaceScreenProps) {
  const { t } = useTranslation();
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RfbClient | null>(null);
  const [state, setState] = useState<ScreenState>('idle');
  const [mode, setMode] = useState<ScreenMode>('view');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [control, setControl] = useState<WorkScreenControlState>({
    agentWaiting: false,
  });
  const [takeoverSupported, setTakeoverSupported] = useState(false);

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
    let renewTimer: ReturnType<typeof setInterval> | undefined;
    setState('starting');
    setError(null);
    (async () => {
      try {
        const session = await startWorkComputer(taskId);
        if (!disposed) setTakeoverSupported(Boolean(session.viewOnlyPassword));
        let password = session.viewOnlyPassword;
        if (mode === 'control') {
          const grant = await acquireWorkScreenControl(taskId);
          password = grant.controlPassword;
          renewTimer = setInterval(() => {
            acquireWorkScreenControl(taskId).catch(renewError => {
              logger.warn('Screen control renewal failed:', renewError);
              if (!disposed) setMode('view');
            });
          }, CONTROL_RENEW_MS);
        }
        const [{ default: RFB }, url] = await Promise.all([
          import('@novnc/novnc'),
          workScreenUrl(taskId),
        ]);
        if (disposed || !mountRef.current) return;
        const rfb = new RFB(mountRef.current, url, {
          shared: true,
          ...(password ? { credentials: { password } } : {}),
        }) as unknown as RfbClient;
        rfb.viewOnly = mode !== 'control';
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
        if (mode === 'control') setMode('view');
      }
    })();
    return () => {
      disposed = true;
      if (renewTimer) clearInterval(renewTimer);
      disconnect();
      if (mode === 'control') {
        // Hand the screen back when the driver navigates away; the lease
        // TTL is the backstop when this best-effort call cannot land.
        releaseWorkScreenControl(taskId).catch(() => undefined);
      }
    };
  }, [taskId, active, attempt, mode, disconnect]);

  // Who is driving, and is the agent asking for a human? Polled only while
  // the pane is open.
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const poll = async () => {
      try {
        const next = await getWorkScreenControl(taskId);
        if (!disposed) setControl(next);
      } catch {
        // Transient; keep the last known state.
      }
    };
    void poll();
    const timer = setInterval(poll, CONTROL_STATE_POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [taskId, active]);

  const handleTakeOver = useCallback(() => {
    setError(null);
    setMode('control');
  }, []);

  const handleHandBack = useCallback(() => {
    releaseWorkScreenControl(taskId).catch(() => undefined);
    setMode('view');
  }, [taskId]);

  const driving = mode === 'control' && state === 'connected';
  const someoneElseDriving =
    control.holder !== undefined && !control.holder.you;
  const showTakeOver =
    takeoverSupported &&
    state === 'connected' &&
    mode === 'view' &&
    !someoneElseDriving;

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
        <div className='absolute left-3 top-3 flex items-center gap-2'>
          <div
            className={`pointer-events-none rounded-md px-2 py-1 text-[10px] uppercase tracking-wide backdrop-blur ${
              driving
                ? 'bg-emerald-500/80 text-white'
                : 'bg-black/50 text-white/60'
            }`}
            data-testid='work-screen-mode'
          >
            {driving
              ? t('work.screen.youHaveControl')
              : someoneElseDriving
                ? t('work.screen.otherHasControl', {
                    name: control.holder?.username ?? '…',
                  })
                : t('work.screen.viewOnly')}
          </div>
          {showTakeOver && (
            <button
              type='button'
              data-testid='work-screen-take-over'
              onClick={handleTakeOver}
              className='flex items-center gap-1.5 rounded-md bg-white/10 px-2 py-1 text-[11px] text-white/90 backdrop-blur transition-colors hover:bg-white/20'
            >
              <MousePointerClick size={12} />
              {t('work.screen.takeOver')}
            </button>
          )}
          {driving && (
            <button
              type='button'
              data-testid='work-screen-hand-back'
              onClick={handleHandBack}
              className='flex items-center gap-1.5 rounded-md bg-white/15 px-2 py-1 text-[11px] text-white backdrop-blur transition-colors hover:bg-white/25'
            >
              <Hand size={12} />
              {t('work.screen.handBack')}
            </button>
          )}
        </div>
      )}
      {control.agentWaiting && !driving && state === 'connected' && (
        <div
          className='absolute bottom-3 left-1/2 flex max-w-[90%] -translate-x-1/2 items-center gap-3 rounded-lg bg-amber-500/90 px-3 py-2 text-xs text-black shadow-lg backdrop-blur'
          data-testid='work-screen-agent-waiting'
        >
          <span className='font-medium'>{t('work.screen.agentWaiting')}</span>
          {control.agentWaitingReason && (
            <span className='truncate opacity-80'>
              {control.agentWaitingReason}
            </span>
          )}
          {takeoverSupported && !someoneElseDriving && (
            <button
              type='button'
              onClick={handleTakeOver}
              className='shrink-0 rounded-md bg-black/80 px-2 py-1 text-[11px] text-white transition-colors hover:bg-black'
            >
              {t('work.screen.takeOver')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
