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

import { Loader2, TerminalSquare } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';
import { useAppStore } from '@/store/appStore';
import { workTerminalUrl } from '@/utils/api/workTerminal';
import { cn } from '@/utils';

type TerminalStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';

interface WorkspaceTerminalProps {
  taskId: string;
  active: boolean;
  disabledReason?: string;
}

// The xterm canvas cannot read CSS variables, so the accent is resolved from
// the same custom property the rest of the UI uses when the terminal mounts.
const accentColor = (shade: number, alpha?: number): string => {
  const triplet = getComputedStyle(document.documentElement)
    .getPropertyValue(`--color-primary-${shade}`)
    .trim();
  if (!triplet) {
    return alpha === undefined ? '#4176e6' : `rgba(65, 118, 230, ${alpha})`;
  }
  const [r, g, b] = triplet.split(/\s+/);
  return alpha === undefined
    ? `rgb(${r}, ${g}, ${b})`
    : `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const lightTheme = () => ({
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#1f2328',
  selectionBackground: accentColor(500, 0.28),
});

const darkTheme = () => ({
  background: '#0f1115',
  foreground: '#e6e6e6',
  cursor: accentColor(400),
  selectionBackground: accentColor(500, 0.32),
});

export function WorkspaceTerminal({
  taskId,
  active,
  disabledReason,
}: WorkspaceTerminalProps) {
  const { t } = useTranslation();
  const isDark = useAppStore(state => state.theme.mode === 'dark');
  const mountRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<import('@xterm/xterm').Terminal | null>(null);
  const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
  const [status, setStatus] = useState<TerminalStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  const sendResize = useCallback(() => {
    const fit = fitRef.current;
    const terminal = terminalRef.current;
    const socket = socketRef.current;
    if (!fit || !terminal || !socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      fit.fit();
    } catch {
      return;
    }
    socket.send(
      JSON.stringify({
        type: 'resize',
        cols: terminal.cols,
        rows: terminal.rows,
      })
    );
  }, []);

  useEffect(() => {
    if (!active || disabledReason) return undefined;
    let disposed = false;
    let terminal: import('@xterm/xterm').Terminal | undefined;
    let socket: WebSocket | undefined;

    void (async () => {
      setStatus('connecting');
      setError(null);
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      await import('@xterm/xterm/css/xterm.css');
      if (disposed || !mountRef.current) return;

      terminal = new Terminal({
        allowProposedApi: true,
        convertEol: false,
        cursorBlink: true,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        fontSize: 12,
        scrollback: 5_000,
        theme: isDark ? darkTheme() : lightTheme(),
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(mountRef.current);
      terminalRef.current = terminal;
      fitRef.current = fit;
      try {
        fit.fit();
      } catch {
        // The pane may still be laying out; the resize observer refits.
      }

      let terminalUrl: string;
      try {
        terminalUrl = await workTerminalUrl(taskId);
      } catch (ticketError) {
        if (!disposed) {
          setStatus('error');
          setError(ticketError instanceof Error ? ticketError.message : null);
        }
        return;
      }
      if (disposed) return;
      socket = new WebSocket(terminalUrl);
      socket.binaryType = 'arraybuffer';
      socketRef.current = socket;
      const decoder = new TextDecoder();

      socket.onmessage = event => {
        if (typeof event.data !== 'string') {
          terminal?.write(decoder.decode(new Uint8Array(event.data)));
          return;
        }
        try {
          const message = JSON.parse(event.data) as {
            type?: string;
            message?: string;
          };
          if (message.type === 'ready') {
            setStatus('connected');
            sendResize();
            terminal?.focus();
            return;
          }
          if (message.type === 'error') {
            setStatus('error');
            setError(message.message || null);
            return;
          }
          if (message.type === 'exit') {
            setStatus('closed');
          }
        } catch {
          // Non-JSON text frames are not part of the protocol.
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        setStatus(current =>
          current === 'error' || current === 'closed' ? current : 'closed'
        );
      };
      socket.onerror = () => {
        if (disposed) return;
        setStatus('error');
      };

      terminal.onData(data => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'input', data }));
        }
      });
    })();

    return () => {
      disposed = true;
      socket?.close();
      socketRef.current = null;
      terminal?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [active, disabledReason, generation, isDark, sendResize, taskId]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !active) return undefined;
    const observer = new ResizeObserver(() => sendResize());
    observer.observe(mount);
    return () => observer.disconnect();
  }, [active, sendResize]);

  const reconnect = () => {
    socketRef.current?.close();
    setGeneration(current => current + 1);
  };

  const statusMessage =
    disabledReason ??
    (status === 'error'
      ? (error ??
        t('work.terminal.failed', {
          defaultValue: 'The terminal session could not start.',
        }))
      : status === 'closed'
        ? t('work.terminal.closed', {
            defaultValue: 'Terminal session ended.',
          })
        : null);

  return (
    <div
      data-testid='work-terminal-panel'
      data-status={disabledReason ? 'unavailable' : status}
      className='relative flex min-h-0 flex-1 flex-col bg-surface'
    >
      {!disabledReason && (
        <div
          ref={mountRef}
          data-testid='work-terminal-surface'
          dir='ltr'
          className={cn(
            'min-h-0 flex-1 overflow-hidden p-2 text-left',
            status !== 'connected' && 'opacity-60'
          )}
        />
      )}

      {status === 'connecting' && !disabledReason && (
        <div className='pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-xs text-ink-muted'>
          <Loader2 className='h-4 w-4 animate-spin' />
          {t('work.terminal.connecting', {
            defaultValue: 'Opening a shell in the sandbox…',
          })}
        </div>
      )}

      {statusMessage && (
        <div
          role={status === 'error' ? 'alert' : undefined}
          className='flex flex-col items-center gap-3 border-t border-line bg-surface-raised px-6 py-4 text-center'
        >
          <TerminalSquare className='h-6 w-6 text-ink-subtle' />
          <p
            dir='auto'
            data-testid='work-terminal-status'
            className='max-w-md text-xs leading-relaxed text-ink-muted'
          >
            {statusMessage}
          </p>
          {!disabledReason && (
            <Button
              size='sm'
              data-testid='work-terminal-reconnect-button'
              className='h-8 rounded-lg bg-primary-600 px-3 text-white hover:bg-primary-500'
              onClick={reconnect}
            >
              {t('work.terminal.reconnect', { defaultValue: 'Reconnect' })}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
