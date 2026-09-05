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
  Circle,
  GraduationCap,
  Hand,
  Loader2,
  MonitorPlay,
  MousePointerClick,
  RefreshCw,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  acquireWorkScreenControl,
  getWorkScreenAnchor,
  getWorkScreenControl,
  releaseWorkScreenControl,
  saveWorkScreenTeaching,
  startWorkComputer,
  workAudioUrl,
  workScreenUrl,
  type WorkScreenControlState,
  type WorkTeachEvent,
} from '@/utils/api/workScreen';
import {
  startWorkAudioPlayer,
  type WorkAudioPlayer,
} from '@/utils/workAudioPlayer';
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
  /**
   * 'mini' renders a compact view-only thumbnail (no toolbar, no control,
   * no teach, no audio) whose whole surface expands via onExpand. It is a
   * full extra viewer against the server's per-task viewer budget.
   */
  variant?: 'full' | 'mini';
  /** Invoked when the mini thumbnail is clicked to open the full Screen. */
  onExpand?: () => void;
}

type ScreenState = 'idle' | 'starting' | 'connected' | 'disconnected';
type ScreenMode = 'view' | 'control';
type TeachPhase = 'idle' | 'recording' | 'naming' | 'saving';

interface ScreenConnection {
  taskId: string;
  active: boolean;
  attempt: number;
  mode: ScreenMode;
  state: ScreenState;
  error: string | null;
}

const CONTROL_STATE_POLL_MS = 3_000;
/** Renew well inside the lease TTL (the server holds leases for 2 min). */
const CONTROL_RENEW_MS = 60_000;
/** A demonstration recording caps itself rather than growing unbounded. */
const TEACH_MAX_EVENTS = 5_000;

export function WorkspaceScreen({
  taskId,
  active,
  variant = 'full',
  onExpand,
}: WorkspaceScreenProps) {
  const { t } = useTranslation();
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RfbClient | null>(null);
  const [mode, setMode] = useState<ScreenMode>('view');
  const [attempt, setAttempt] = useState(0);
  const [connection, setConnection] = useState<ScreenConnection>(() => ({
    taskId,
    active,
    attempt,
    mode,
    state: active ? 'starting' : 'idle',
    error: null,
  }));
  // Connection status belongs to one exact lifecycle. Reset it during render
  // when that lifecycle changes so the next connection never paints stale
  // status from the previous task, activation, retry, or control mode.
  const connectionIsCurrent =
    connection.taskId === taskId &&
    connection.active === active &&
    connection.attempt === attempt &&
    connection.mode === mode;
  const currentConnection: ScreenConnection = connectionIsCurrent
    ? connection
    : {
        taskId,
        active,
        attempt,
        mode,
        state: active ? 'starting' : 'idle',
        error: null,
      };
  if (!connectionIsCurrent) setConnection(currentConnection);
  const { state, error } = currentConnection;
  const updateConnection = useCallback(
    (update: Partial<Pick<ScreenConnection, 'state' | 'error'>>) => {
      setConnection(current => {
        if (
          current.taskId !== taskId ||
          current.active !== active ||
          current.attempt !== attempt ||
          current.mode !== mode
        ) {
          return current;
        }
        return { ...current, ...update };
      });
    },
    [taskId, active, attempt, mode]
  );
  const [control, setControl] = useState<WorkScreenControlState>({
    agentWaiting: false,
  });
  const [takeoverSupported, setTakeoverSupported] = useState(false);
  const [teachPhase, setTeachPhase] = useState<TeachPhase>('idle');
  const [teachName, setTeachName] = useState('');
  const [teachSavedName, setTeachSavedName] = useState<string | null>(null);
  const teachEventsRef = useRef<WorkTeachEvent[]>([]);
  const teachStartRef = useRef(0);
  const teachScreenRef = useRef<{ width: number; height: number } | null>(null);
  const [audioOn, setAudioOn] = useState(false);
  const audioPlayerRef = useRef<WorkAudioPlayer | null>(null);
  // A stop also cancels any start whose awaited player does not exist yet.
  const audioGenerationRef = useRef(0);

  const stopAudio = useCallback(() => {
    audioGenerationRef.current += 1;
    const player = audioPlayerRef.current;
    audioPlayerRef.current = null;
    player?.stop();
    setAudioOn(false);
  }, []);

  const handleToggleAudio = useCallback(async () => {
    if (audioPlayerRef.current) {
      stopAudio();
      return;
    }
    const generation = audioGenerationRef.current + 1;
    audioGenerationRef.current = generation;
    try {
      const url = await workAudioUrl(taskId);
      if (audioGenerationRef.current !== generation) return;
      // Created inside the click handler so the AudioContext starts under a
      // user gesture, as browsers require.
      const player = await startWorkAudioPlayer(url, () => {
        if (audioGenerationRef.current !== generation) return;
        audioGenerationRef.current += 1;
        audioPlayerRef.current = null;
        setAudioOn(false);
      });
      if (audioGenerationRef.current !== generation) {
        player.stop();
        return;
      }
      audioPlayerRef.current = player;
      setAudioOn(true);
    } catch (audioError) {
      if (audioGenerationRef.current !== generation) return;
      logger.warn('Work screen audio failed to start:', audioError);
      stopAudio();
    }
  }, [taskId, stopAudio]);

  // Sound follows the picture: leaving the tab or losing the connection
  // stops playback.
  useEffect(() => {
    if (!active || state !== 'connected') return;
    return stopAudio;
  }, [active, state, stopAudio]);

  const disconnect = useCallback(() => {
    try {
      rfbRef.current?.disconnect();
    } catch {
      // Already closed.
    }
    rfbRef.current = null;
  }, []);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let renewTimer: ReturnType<typeof setInterval> | undefined;
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
          if (!disposed) updateConnection({ state: 'connected' });
        });
        rfb.addEventListener('disconnect', () => {
          if (!disposed) updateConnection({ state: 'disconnected' });
        });
        rfbRef.current = rfb;
      } catch (screenError) {
        logger.error('Work screen connection failed:', screenError);
        if (disposed) return;
        const apiError = screenError as {
          response?: { data?: { message?: string } };
        };
        updateConnection({
          error: apiError.response?.data?.message ?? null,
          state: 'disconnected',
        });
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
  }, [taskId, active, attempt, mode, disconnect, updateConnection]);

  // Who is driving, and is the agent asking for a human? Polled only while
  // the pane is open; the mini thumbnail has no control UI to feed.
  useEffect(() => {
    if (!active || variant === 'mini') return;
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
  }, [taskId, active, variant]);

  // Teach mode: observe the demonstration's pointer/key/wheel events at
  // remote-screen coordinates while the user drives. Listeners never
  // preventDefault — noVNC keeps receiving everything; this only records.
  useEffect(() => {
    if (
      teachPhase !== 'recording' ||
      state !== 'connected' ||
      mode !== 'control'
    ) {
      return;
    }
    const mount = mountRef.current;
    if (!mount) return;
    teachStartRef.current = performance.now();
    teachEventsRef.current = [];
    const remoteCoords = (clientX: number, clientY: number) => {
      const canvas = mount.querySelector('canvas');
      if (!canvas) return undefined;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return undefined;
      teachScreenRef.current = { width: canvas.width, height: canvas.height };
      const clamp = (value: number, max: number) =>
        Math.max(0, Math.min(max, Math.round(value)));
      return {
        x: clamp(
          ((clientX - rect.left) * canvas.width) / rect.width,
          canvas.width
        ),
        y: clamp(
          ((clientY - rect.top) * canvas.height) / rect.height,
          canvas.height
        ),
      };
    };
    const stamp = () => Math.round(performance.now() - teachStartRef.current);
    const record = (event: WorkTeachEvent) => {
      if (teachEventsRef.current.length < TEACH_MAX_EVENTS) {
        teachEventsRef.current.push(event);
      }
    };
    const onPointer = (kind: 'down' | 'up') => (event: PointerEvent) => {
      const at = remoteCoords(event.clientX, event.clientY);
      if (!at) return;
      const recorded: WorkTeachEvent = {
        t: stamp(),
        kind,
        ...at,
        button: event.button,
      };
      record(recorded);
      // Anchor probe: resolve what sits under this click so the playbook
      // can name targets, not just coordinates. Fire-and-forget — the
      // recorded object is enriched in place if the probe returns in time.
      if (kind === 'down') {
        getWorkScreenAnchor(taskId, at.x, at.y)
          .then(({ anchor, url }) => {
            if (anchor) recorded.anchor = anchor;
            if (url) recorded.url = url;
          })
          .catch(() => undefined);
      }
    };
    const onWheel = (event: WheelEvent) => {
      const at = remoteCoords(event.clientX, event.clientY);
      if (at) {
        record({
          t: stamp(),
          kind: 'wheel',
          ...at,
          dy: Math.sign(event.deltaY),
        });
      }
    };
    const onKey = (event: KeyboardEvent) => {
      record({
        t: stamp(),
        kind: 'key',
        key: event.key,
        ...(event.ctrlKey ? { ctrl: true } : {}),
        ...(event.altKey ? { alt: true } : {}),
        ...(event.metaKey ? { meta: true } : {}),
        ...(event.shiftKey ? { shift: true } : {}),
      });
    };
    const down = onPointer('down');
    const up = onPointer('up');
    mount.addEventListener('pointerdown', down, true);
    mount.addEventListener('pointerup', up, true);
    mount.addEventListener('wheel', onWheel, true);
    mount.addEventListener('keydown', onKey, true);
    return () => {
      mount.removeEventListener('pointerdown', down, true);
      mount.removeEventListener('pointerup', up, true);
      mount.removeEventListener('wheel', onWheel, true);
      mount.removeEventListener('keydown', onKey, true);
    };
  }, [teachPhase, state, mode, taskId]);

  const handleTakeOver = useCallback(() => {
    setMode('control');
  }, []);

  const handleHandBack = useCallback(() => {
    releaseWorkScreenControl(taskId).catch(() => undefined);
    setMode('view');
  }, [taskId]);

  const handleTeachStart = useCallback(() => {
    setTeachSavedName(null);
    setTeachPhase('recording');
    setMode('control');
  }, []);

  const handleTeachStop = useCallback(() => {
    // The demonstration is over; hand the screen back while naming.
    releaseWorkScreenControl(taskId).catch(() => undefined);
    setMode('view');
    setTeachPhase('naming');
  }, [taskId]);

  const handleTeachDiscard = useCallback(() => {
    teachEventsRef.current = [];
    setTeachName('');
    setTeachPhase('idle');
    if (mode === 'control') {
      releaseWorkScreenControl(taskId).catch(() => undefined);
      setMode('view');
    }
  }, [taskId, mode]);

  const handleTeachSave = useCallback(async () => {
    const name = teachName.trim();
    if (!name) return;
    setTeachPhase('saving');
    try {
      const saved = await saveWorkScreenTeaching(taskId, {
        name,
        events: teachEventsRef.current,
        ...(teachScreenRef.current
          ? {
              screenWidth: teachScreenRef.current.width,
              screenHeight: teachScreenRef.current.height,
            }
          : {}),
      });
      teachEventsRef.current = [];
      setTeachName('');
      setTeachPhase('idle');
      setTeachSavedName(saved.name);
      setTimeout(() => setTeachSavedName(null), 6_000);
    } catch (saveError) {
      logger.error('Saving the demonstration failed:', saveError);
      const apiError = saveError as {
        response?: { data?: { message?: string } };
      };
      updateConnection({
        error: apiError.response?.data?.message ?? null,
      });
      setTeachPhase('naming');
    }
  }, [taskId, teachName, updateConnection]);

  const driving = mode === 'control' && state === 'connected';
  const someoneElseDriving =
    control.holder !== undefined && !control.holder.you;
  const takeoverAllowed = control.takeoverEnabled !== false;
  const showTakeOver =
    takeoverSupported &&
    takeoverAllowed &&
    state === 'connected' &&
    mode === 'view' &&
    !someoneElseDriving;

  const recording = teachPhase === 'recording' && state === 'connected';
  const toolbarButton =
    'flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs text-ink transition-colors hover:bg-surface-subtle';

  if (variant === 'mini') {
    return (
      <div
        className='relative aspect-[8/5] w-full overflow-hidden rounded-xl border border-line bg-canvas'
        data-testid='work-screen-mini'
      >
        <div ref={mountRef} className='h-full w-full' />
        {state !== 'connected' && (
          <div className='pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-canvas px-4 text-center'>
            {state === 'starting' ? (
              <>
                <Loader2 size={16} className='animate-spin text-ink-muted' />
                <p className='text-xs text-ink'>{t('work.screen.starting')}</p>
              </>
            ) : (
              <>
                <MonitorPlay size={18} className='text-ink-muted' />
                <p className='text-xs text-ink'>
                  {error ?? t('work.screen.disconnected')}
                </p>
              </>
            )}
          </div>
        )}
        {/* The whole tile expands to the full Screen tab, where control,
            teach, audio, and reconnect live. */}
        <button
          type='button'
          data-testid='work-screen-mini-expand'
          onClick={onExpand}
          aria-label={t('work.agent.openScreen', {
            defaultValue: 'Open the full screen view',
          })}
          className='absolute inset-0 cursor-pointer bg-transparent transition-colors hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500/60'
        />
      </div>
    );
  }

  return (
    <div
      className='flex h-full min-h-[16rem] w-full flex-col'
      data-testid='work-screen'
    >
      {/* Controls live in their own toolbar, never on top of the remote
          screen's pixels. */}
      <div className='flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2'>
        <div
          className={`rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
            recording
              ? 'bg-red-500/15 text-red-500'
              : driving
                ? 'bg-emerald-500/15 text-emerald-500'
                : 'bg-surface-subtle text-ink-muted'
          }`}
          data-testid='work-screen-mode'
        >
          {recording
            ? t('work.screen.recording')
            : driving
              ? t('work.screen.youHaveControl')
              : someoneElseDriving
                ? t('work.screen.otherHasControl', {
                    name: control.holder?.username ?? '…',
                  })
                : t('work.screen.viewOnly')}
        </div>
        {teachSavedName && (
          <div className='rounded-md bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-500'>
            {t('work.screen.teachSaved', { name: teachSavedName })}
          </div>
        )}
        <div className='min-w-0 flex-1' />
        <button
          type='button'
          data-testid='work-screen-audio'
          onClick={() => void handleToggleAudio()}
          disabled={state !== 'connected'}
          aria-label={audioOn ? t('work.screen.mute') : t('work.screen.unmute')}
          className={`${toolbarButton} disabled:opacity-40 ${
            audioOn ? 'border-emerald-500/50 text-emerald-500' : ''
          }`}
        >
          {audioOn ? <Volume2 size={13} /> : <VolumeX size={13} />}
        </button>
        {showTakeOver && teachPhase === 'idle' && (
          <>
            <button
              type='button'
              data-testid='work-screen-take-over'
              onClick={handleTakeOver}
              className={toolbarButton}
            >
              <MousePointerClick size={13} />
              {t('work.screen.takeOver')}
            </button>
            <button
              type='button'
              data-testid='work-screen-teach'
              onClick={handleTeachStart}
              className={toolbarButton}
            >
              <GraduationCap size={13} />
              {t('work.screen.teach')}
            </button>
          </>
        )}
        {driving && teachPhase === 'idle' && (
          <button
            type='button'
            data-testid='work-screen-hand-back'
            onClick={handleHandBack}
            className={`${toolbarButton} border-emerald-500/50 text-emerald-500`}
          >
            <Hand size={13} />
            {t('work.screen.handBack')}
          </button>
        )}
        {driving && teachPhase === 'recording' && (
          <>
            <button
              type='button'
              data-testid='work-screen-teach-stop'
              onClick={handleTeachStop}
              className={`${toolbarButton} border-red-500/50 text-red-500`}
            >
              <Circle size={9} className='animate-pulse fill-current' />
              {t('work.screen.teachSave')}
            </button>
            <button
              type='button'
              onClick={handleTeachDiscard}
              className={toolbarButton}
            >
              {t('work.screen.teachDiscard')}
            </button>
          </>
        )}
      </div>

      <div
        className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-canvas ${
          recording
            ? 'ring-2 ring-inset ring-red-500'
            : driving
              ? 'ring-2 ring-inset ring-emerald-500'
              : ''
        }`}
      >
        {recording && (
          <div
            className='absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-2 bg-red-600/95 py-1 text-[11px] font-medium text-white'
            data-testid='work-screen-watching-banner'
          >
            <Circle size={8} className='animate-pulse fill-current' />
            {t('work.screen.watchingLearning')}
          </div>
        )}
        <div ref={mountRef} className='h-full w-full' />
        {state !== 'connected' && (
          <div className='absolute inset-0 flex flex-col items-center justify-center gap-3 bg-canvas px-6 text-center'>
            {state === 'starting' ? (
              <>
                <Loader2 size={20} className='animate-spin text-ink-muted' />
                <p className='text-sm text-ink'>{t('work.screen.starting')}</p>
              </>
            ) : (
              <>
                <MonitorPlay size={22} className='text-ink-muted' />
                <p className='text-sm text-ink'>
                  {error ?? t('work.screen.disconnected')}
                </p>
                <button
                  type='button'
                  data-testid='work-screen-reconnect'
                  onClick={() => setAttempt(value => value + 1)}
                  className='flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-xs text-ink transition-colors hover:bg-surface-subtle'
                >
                  <RefreshCw size={12} />
                  {t('work.screen.reconnect')}
                </button>
              </>
            )}
          </div>
        )}
        {(teachPhase === 'naming' || teachPhase === 'saving') && (
          <div className='absolute inset-0 z-20 flex items-center justify-center bg-black/60'>
            <div className='flex w-72 flex-col gap-3 rounded-xl border border-line bg-surface-raised p-4 shadow-xl'>
              <input
                autoFocus
                value={teachName}
                onChange={event => setTeachName(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') void handleTeachSave();
                }}
                placeholder={t('work.screen.teachNamePlaceholder')}
                data-testid='work-screen-teach-name'
                className='rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-subtle focus:border-line-strong'
              />
              <div className='flex justify-end gap-2'>
                <button
                  type='button'
                  onClick={handleTeachDiscard}
                  disabled={teachPhase === 'saving'}
                  className='rounded-lg px-3 py-1.5 text-xs text-ink-muted transition-colors hover:bg-surface-subtle'
                >
                  {t('work.screen.teachDiscard')}
                </button>
                <button
                  type='button'
                  data-testid='work-screen-teach-confirm'
                  onClick={() => void handleTeachSave()}
                  disabled={teachPhase === 'saving' || !teachName.trim()}
                  className='flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-emerald-500 disabled:opacity-50'
                >
                  {teachPhase === 'saving' && (
                    <Loader2 size={12} className='animate-spin' />
                  )}
                  {t('work.screen.teachSave')}
                </button>
              </div>
            </div>
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
            {takeoverSupported && takeoverAllowed && !someoneElseDriving && (
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
    </div>
  );
}
