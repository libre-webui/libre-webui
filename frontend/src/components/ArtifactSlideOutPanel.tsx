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

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Code,
  FileText,
  Globe,
  X,
  Copy,
  Check,
  AlertTriangle,
  Download,
  ExternalLink,
  Eye,
  Code2,
  GripVertical,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { OptimizedSyntaxHighlighter } from '@/components/OptimizedSyntaxHighlighter';
import { useAppStore } from '@/store/appStore';
import { cn } from '@/utils';

// Min/max panel widths
const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH_RATIO = 0.9; // 90% of screen width
const DEFAULT_PANEL_WIDTH = 600;

export const ArtifactSlideOutPanel: React.FC = () => {
  const {
    artifactPanelOpen,
    artifactPanelArtifact,
    closeArtifactPanel,
    theme,
  } = useAppStore();
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview');
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const prevArtifactIdRef = useRef<string | null>(null);
  const resizeStartXRef = useRef(0);
  const resizeStartWidthRef = useRef(0);

  // Reset view mode when artifact changes (using ref pattern to avoid effect setState)
  const currentArtifactId = artifactPanelArtifact?.id ?? null;
  if (currentArtifactId !== prevArtifactIdRef.current) {
    prevArtifactIdRef.current = currentArtifactId;
    if (viewMode !== 'preview') {
      setViewMode('preview');
    }
  }

  // Handle resize
  const handleResizeStart = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault();
      setIsResizing(true);
      resizeStartWidthRef.current = panelWidth;
      resizeStartXRef.current =
        'touches' in e ? e.touches[0].clientX : e.clientX;
    },
    [panelWidth]
  );

  const handleResizeMove = useCallback(
    (e: MouseEvent | TouchEvent) => {
      if (!isResizing) return;

      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const deltaX = resizeStartXRef.current - clientX;
      const maxWidth = window.innerWidth * MAX_PANEL_WIDTH_RATIO;
      const newWidth = Math.min(
        maxWidth,
        Math.max(MIN_PANEL_WIDTH, resizeStartWidthRef.current + deltaX)
      );
      setPanelWidth(newWidth);
    },
    [isResizing]
  );

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
  }, []);

  // Resize event listeners
  useEffect(() => {
    if (isResizing) {
      window.addEventListener('mousemove', handleResizeMove);
      window.addEventListener('mouseup', handleResizeEnd);
      window.addEventListener('touchmove', handleResizeMove);
      window.addEventListener('touchend', handleResizeEnd);
      // Prevent text selection during resize
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
    }

    return () => {
      window.removeEventListener('mousemove', handleResizeMove);
      window.removeEventListener('mouseup', handleResizeEnd);
      window.removeEventListener('touchmove', handleResizeMove);
      window.removeEventListener('touchend', handleResizeEnd);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isResizing, handleResizeMove, handleResizeEnd]);

  // Handle window resize to ensure panel doesn't exceed max width
  useEffect(() => {
    const handleWindowResize = () => {
      const maxWidth = window.innerWidth * MAX_PANEL_WIDTH_RATIO;
      if (panelWidth > maxWidth) {
        setPanelWidth(maxWidth);
      }
    };

    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [panelWidth]);

  // Handle escape key to close panel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && artifactPanelOpen) {
        closeArtifactPanel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [artifactPanelOpen, closeArtifactPanel]);

  // Handle click outside to close panel (but not on resize handle)
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (isResizing) return; // Don't close while resizing

      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        artifactPanelOpen
      ) {
        closeArtifactPanel();
      }
    };
    // Add small delay to avoid closing immediately on open
    const timer = setTimeout(() => {
      window.addEventListener('mousedown', handleClickOutside);
    }, 100);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousedown', handleClickOutside);
    };
  }, [artifactPanelOpen, closeArtifactPanel, isResizing]);

  if (!artifactPanelArtifact) return null;

  const artifact = artifactPanelArtifact;

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_err) {
      console.error('Failed to copy:', _err);
    }
  };

  const downloadArtifact = () => {
    const blob = new Blob([artifact.content], {
      type: getContentType(artifact.type),
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${artifact.title}.${getFileExtension(artifact.type)}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const getContentType = (type: string) => {
    switch (type) {
      case 'html':
        return 'text/html';
      case 'react':
        return 'text/javascript';
      case 'svg':
        return 'image/svg+xml';
      case 'css':
        return 'text/css';
      case 'json':
        return 'application/json';
      default:
        return 'text/plain';
    }
  };

  const getFileExtension = (type: string) => {
    switch (type) {
      case 'html':
        return 'html';
      case 'react':
        return 'jsx';
      case 'svg':
        return 'svg';
      case 'css':
        return 'css';
      case 'json':
        return 'json';
      default:
        return 'txt';
    }
  };

  const getIcon = () => {
    switch (artifact.type) {
      case 'html':
        return <Globe className='h-5 w-5' />;
      case 'react':
        return <Code className='h-5 w-5' />;
      case 'svg':
        return <FileText className='h-5 w-5' />;
      case 'code':
        return <Code className='h-5 w-5' />;
      default:
        return <FileText className='h-5 w-5' />;
    }
  };

  const renderHtml = () => {
    const htmlContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <base target="_blank">
          <title>${artifact.title}</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              margin: 0;
              padding: 16px;
              background: white;
              color: #333;
            }
            * { box-sizing: border-box; }
          </style>
        </head>
        <body>
          ${artifact.content}
        </body>
      </html>
    `;

    return (
      <iframe
        ref={iframeRef}
        srcDoc={htmlContent}
        className='w-full h-full border-0 rounded-lg bg-white'
        sandbox='allow-scripts allow-same-origin'
        title={artifact.title}
      />
    );
  };

  const renderSvg = () => {
    try {
      return (
        <div
          className='w-full h-full flex items-center justify-center bg-gray-50 dark:bg-dark-100 ophelia:bg-[#0a0a0a] rounded-lg overflow-auto p-4'
          dangerouslySetInnerHTML={{ __html: artifact.content }}
        />
      );
    } catch (_err) {
      return (
        <div className='w-full h-full flex items-center justify-center bg-gray-50 dark:bg-dark-100 ophelia:bg-[#0a0a0a] rounded-lg'>
          <div className='text-center'>
            <AlertTriangle className='h-8 w-8 text-red-500 mx-auto mb-2' />
            <p className='text-sm text-gray-600 dark:text-gray-400 ophelia:text-[#a3a3a3]'>
              Invalid SVG content
            </p>
          </div>
        </div>
      );
    }
  };

  const renderCode = () => {
    const getLanguage = () => {
      if (artifact.language) {
        return artifact.language;
      }
      switch (artifact.type) {
        case 'html':
          return 'html';
        case 'react':
          return 'jsx';
        case 'svg':
          return 'xml';
        case 'json':
          return 'json';
        default:
          return 'text';
      }
    };

    return (
      <div className='h-full overflow-auto'>
        <OptimizedSyntaxHighlighter
          language={getLanguage()}
          isDark={theme.mode === 'dark' || theme.mode === 'ophelia'}
          className='!m-0 !rounded-lg !h-full'
        >
          {artifact.content}
        </OptimizedSyntaxHighlighter>
      </div>
    );
  };

  const renderJson = () => {
    try {
      const parsedJson = JSON.parse(artifact.content);
      const formattedJson = JSON.stringify(parsedJson, null, 2);

      return (
        <div className='h-full overflow-auto'>
          <OptimizedSyntaxHighlighter
            language='json'
            isDark={theme.mode === 'dark' || theme.mode === 'ophelia'}
            className='!m-0 !rounded-lg !h-full'
          >
            {formattedJson}
          </OptimizedSyntaxHighlighter>
        </div>
      );
    } catch (_err) {
      return (
        <div className='w-full h-full flex items-center justify-center bg-gray-50 dark:bg-dark-100 ophelia:bg-[#0a0a0a] rounded-lg'>
          <div className='text-center'>
            <AlertTriangle className='h-8 w-8 text-red-500 mx-auto mb-2' />
            <p className='text-sm text-gray-600 dark:text-gray-400 ophelia:text-[#a3a3a3]'>
              Invalid JSON content
            </p>
          </div>
        </div>
      );
    }
  };

  const renderContent = () => {
    if (viewMode === 'code') {
      return renderCode();
    }

    switch (artifact.type) {
      case 'html':
        return renderHtml();
      case 'svg':
        return renderSvg();
      case 'json':
        return renderJson();
      case 'code':
      case 'text':
      default:
        return renderCode();
    }
  };

  const shouldShowViewToggle = () => {
    return (
      artifact.type === 'html' ||
      artifact.type === 'svg' ||
      artifact.type === 'react'
    );
  };

  // On mobile, use full width
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
  const effectiveWidth = isMobile ? '100%' : `${panelWidth}px`;

  const panel = (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 bg-black/30 dark:bg-black/50 ophelia:bg-black/60 z-40 transition-opacity duration-300',
          artifactPanelOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        )}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        style={{ width: effectiveWidth }}
        className={cn(
          'fixed top-0 right-0 h-full z-50',
          'bg-white dark:bg-dark-25 ophelia:bg-[#050505]',
          'shadow-2xl border-l border-gray-200 dark:border-dark-200 ophelia:border-[#1a1a1a]',
          'flex flex-col',
          'transform transition-transform duration-300 ease-out',
          artifactPanelOpen ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        {/* Resize Handle - only show on non-mobile */}
        {!isMobile && (
          <div
            onMouseDown={handleResizeStart}
            onTouchStart={handleResizeStart}
            className={cn(
              'absolute left-0 top-0 bottom-0 w-4 -ml-2 cursor-col-resize z-10',
              'flex items-center justify-center',
              'group'
            )}
          >
            {/* Visual handle */}
            <div
              className={cn(
                'w-1 h-16 rounded-full transition-all duration-200',
                'bg-gray-300 dark:bg-dark-300 ophelia:bg-[#262626]',
                'group-hover:bg-primary-500 group-hover:h-24',
                isResizing && 'bg-primary-500 h-24'
              )}
            />
            {/* Grip icon on hover */}
            <div
              className={cn(
                'absolute left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity',
                'text-gray-400 dark:text-dark-500 ophelia:text-[#525252]',
                isResizing && 'opacity-100'
              )}
            >
              <GripVertical className='h-4 w-4' />
            </div>
          </div>
        )}

        {/* Header */}
        <div className='flex items-center justify-between p-4 border-b border-gray-200 dark:border-dark-200 ophelia:border-[#1a1a1a]'>
          <div className='flex items-center gap-3 min-w-0 flex-1'>
            <div className='text-gray-600 dark:text-gray-400 ophelia:text-[#a3a3a3] flex-shrink-0'>
              {getIcon()}
            </div>
            <h2 className='font-semibold text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa] truncate'>
              {artifact.title}
            </h2>
            <span className='text-xs bg-primary-50 dark:bg-primary-900/20 ophelia:bg-[rgba(147,51,234,0.2)] text-primary-700 dark:text-primary-300 ophelia:text-[#c084fc] px-2 py-1 rounded-full font-medium flex-shrink-0'>
              {artifact.type.toUpperCase()}
            </span>
          </div>

          <Button
            variant='ghost'
            size='sm'
            onClick={closeArtifactPanel}
            className='h-8 w-8 p-0 hover:bg-gray-100 dark:hover:bg-dark-200 ophelia:hover:bg-[#121212] flex-shrink-0'
            title='Close panel (Esc)'
          >
            <X className='h-5 w-5' />
          </Button>
        </div>

        {/* Toolbar */}
        <div className='flex items-center justify-between px-4 py-2 border-b border-gray-100 dark:border-dark-200 ophelia:border-[#1a1a1a] bg-gray-50 dark:bg-dark-100/50 ophelia:bg-[#0a0a0a]'>
          <div className='flex items-center gap-1'>
            {shouldShowViewToggle() && (
              <>
                <Button
                  variant={viewMode === 'preview' ? 'primary' : 'ghost'}
                  size='sm'
                  onClick={() => setViewMode('preview')}
                  className='h-8 px-3 text-xs'
                  title='Preview mode'
                >
                  <Eye className='h-3.5 w-3.5 mr-1.5' />
                  Preview
                </Button>
                <Button
                  variant={viewMode === 'code' ? 'primary' : 'ghost'}
                  size='sm'
                  onClick={() => setViewMode('code')}
                  className='h-8 px-3 text-xs'
                  title='Code mode'
                >
                  <Code2 className='h-3.5 w-3.5 mr-1.5' />
                  Code
                </Button>
              </>
            )}
          </div>

          <div className='flex items-center gap-1'>
            <Button
              variant='ghost'
              size='sm'
              onClick={() => copyToClipboard(artifact.content)}
              className='h-8 px-3 text-xs hover:bg-gray-100 dark:hover:bg-dark-200 ophelia:hover:bg-[#121212]'
              title='Copy content'
            >
              {copied ? (
                <>
                  <Check className='h-3.5 w-3.5 mr-1.5 text-green-500' />
                  Copied
                </>
              ) : (
                <>
                  <Copy className='h-3.5 w-3.5 mr-1.5' />
                  Copy
                </>
              )}
            </Button>

            <Button
              variant='ghost'
              size='sm'
              onClick={downloadArtifact}
              className='h-8 px-3 text-xs hover:bg-gray-100 dark:hover:bg-dark-200 ophelia:hover:bg-[#121212]'
              title='Download'
            >
              <Download className='h-3.5 w-3.5 mr-1.5' />
              Download
            </Button>

            {(artifact.type === 'html' || artifact.type === 'react') && (
              <Button
                variant='ghost'
                size='sm'
                onClick={() => {
                  const newWindow = window.open('', '_blank');
                  if (newWindow) {
                    newWindow.document.write(artifact.content);
                    newWindow.document.close();
                  }
                }}
                className='h-8 px-3 text-xs hover:bg-gray-100 dark:hover:bg-dark-200 ophelia:hover:bg-[#121212]'
                title='Open in new window'
              >
                <ExternalLink className='h-3.5 w-3.5 mr-1.5' />
                Open
              </Button>
            )}
          </div>
        </div>

        {/* Description */}
        {artifact.description && (
          <div className='px-4 py-3 border-b border-gray-100 dark:border-dark-200 ophelia:border-[#1a1a1a]'>
            <p className='text-sm text-gray-600 dark:text-gray-400 ophelia:text-[#a3a3a3]'>
              {artifact.description}
            </p>
          </div>
        )}

        {/* Content */}
        <div className='flex-1 p-4 overflow-hidden'>{renderContent()}</div>

        {/* Footer */}
        <div className='px-4 py-2 border-t border-gray-100 dark:border-dark-200 ophelia:border-[#1a1a1a] bg-gray-50 dark:bg-dark-100/50 ophelia:bg-[#0a0a0a]'>
          <div className='flex items-center justify-between'>
            <div className='text-xs text-gray-500 dark:text-gray-400 ophelia:text-[#737373]'>
              Created: {new Date(artifact.createdAt).toLocaleString()}
            </div>
            {!isMobile && (
              <div className='text-xs text-gray-400 dark:text-dark-500 ophelia:text-[#525252]'>
                Drag edge to resize
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );

  return createPortal(panel, document.body);
};
