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

import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  Square,
  Image as ImageIcon,
  Settings,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Button, Textarea } from '@/components/ui';
import { ImageUpload } from './ImageUpload';
import { StructuredOutput } from './StructuredOutput';
import { useAppStore } from '@/store/appStore';
import { cn } from '@/utils';

interface ChatInputProps {
  onSendMessage: (
    message: string,
    images?: string[],
    format?: string | Record<string, unknown>
  ) => void;
  onStopGeneration: () => void;
  disabled?: boolean;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  onSendMessage,
  onStopGeneration,
  disabled = false,
}) => {
  const [message, setMessage] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [format, setFormat] = useState<string | Record<string, unknown> | null>(
    null
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { isGenerating } = useAppStore();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!message.trim() || isGenerating) return;

    onSendMessage(
      message.trim(),
      images.length > 0 ? images : undefined,
      format || undefined
    );
    setMessage('');
    setImages([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleStopGeneration = () => {
    onStopGeneration();
  };

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }
  }, [message]);

  const hasAdvancedFeatures = images.length > 0 || format !== null;
  return (
    <div className='border-t border-gray-100 dark:border-dark-200 bg-white dark:bg-dark-100'>
      {/* Advanced Features Panel */}
      {showAdvanced && (
        <div className='border-b border-gray-100 dark:border-dark-200 p-4 space-y-4'>
          <ImageUpload
            images={images}
            onImagesChange={setImages}
            maxImages={5}
          />
          <StructuredOutput format={format} onFormatChange={setFormat} />
        </div>
      )}

      {/* Main Input Area */}
      <div className='p-4 sm:p-6'>
        <form onSubmit={handleSubmit} className='flex gap-2 sm:gap-4'>
          <div className='flex-1'>
            <Textarea
              ref={textareaRef}
              value={message}
              onChange={e => setMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder='Type your message... (Enter to send, Shift+Enter for new line)'
              disabled={disabled}
              className={cn(
                'min-h-[44px] sm:min-h-[52px] max-h-[200px] resize-none bg-gray-50 dark:bg-dark-50 border-gray-200 dark:border-dark-300',
                'scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-dark-400',
                'focus:bg-white dark:focus:bg-dark-50'
              )}
              rows={1}
            />
          </div>

          <div className='flex flex-col justify-end gap-2'>
            {/* Advanced Features Toggle */}
            <Button
              type='button'
              variant='outline'
              size='sm'
              onClick={() => setShowAdvanced(!showAdvanced)}
              className={cn(
                'h-[32px] w-[32px] p-0 border-gray-200 dark:border-dark-300',
                hasAdvancedFeatures &&
                  'border-primary-500 bg-primary-50 dark:bg-primary-900/20',
                showAdvanced && 'bg-gray-100 dark:bg-dark-200'
              )}
              title='Advanced features'
            >
              {showAdvanced ? (
                <ChevronUp className='h-4 w-4' />
              ) : (
                <>
                  {hasAdvancedFeatures ? (
                    <div className='flex items-center'>
                      <ImageIcon className='h-3 w-3' />
                      <Settings className='h-3 w-3 -ml-1' />
                    </div>
                  ) : (
                    <ChevronDown className='h-4 w-4' />
                  )}
                </>
              )}
            </Button>

            {/* Send/Stop Button */}
            {isGenerating ? (
              <Button
                type='button'
                variant='outline'
                size='md'
                onClick={handleStopGeneration}
                className='h-[44px] w-[44px] sm:h-[52px] sm:w-[52px] p-0 border-gray-200 dark:border-dark-300 hover:border-gray-300 dark:hover:border-dark-400'
                title='Stop generation'
              >
                <Square className='h-4 w-4' />
              </Button>
            ) : (
              <Button
                type='submit'
                variant='primary'
                size='md'
                disabled={!message.trim() || disabled}
                className='h-[44px] w-[44px] sm:h-[52px] sm:w-[52px] p-0 shadow-md hover:shadow-lg disabled:shadow-sm'
                title='Send message'
              >
                <Send className='h-4 w-4' />
              </Button>
            )}
          </div>
        </form>

        <div className='mt-2 sm:mt-3 text-xs text-gray-500 dark:text-dark-600 text-center'>
          <a
            href='https://librewebui.org'
            target='_blank'
            rel='noopener noreferrer'
            className='underline hover:text-primary-600 dark:hover:text-primary-400 transition-colors'
          >
            Libre WebUI
          </a>{' '}
          • Press Enter to send, Shift+Enter for new line
          {hasAdvancedFeatures && (
            <span className='ml-2 text-primary-600 dark:text-primary-400'>
              •{' '}
              {images.length > 0 &&
                `${images.length} image${images.length > 1 ? 's' : ''}`}
              {images.length > 0 && format && ' • '}
              {format && 'Structured output'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
