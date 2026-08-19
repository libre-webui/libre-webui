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

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  ShieldQuestion,
  Wrench,
  X,
} from 'lucide-react';
import { cn } from '@/utils';
import { Button } from '@/components/ui';
import type { ChatToolApprovalRequest, ChatToolCall } from '@/types';

const formatArguments = (value: string): string => {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
};

const StatusIcon: React.FC<{ status: ChatToolCall['status'] }> = ({
  status,
}) => {
  if (status === 'running' || status === 'awaiting_approval') {
    return <Loader2 className='h-3.5 w-3.5 animate-spin' />;
  }
  if (status === 'succeeded') {
    return <Check className='h-3.5 w-3.5 text-green-600 dark:text-green-400' />;
  }
  if (status === 'denied') {
    return <X className='h-3.5 w-3.5 text-amber-600 dark:text-amber-400' />;
  }
  return (
    <AlertTriangle className='h-3.5 w-3.5 text-red-500 dark:text-red-400' />
  );
};

const ToolCallCard: React.FC<{ call: ChatToolCall }> = ({ call }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const statusLabel = t(`tools.callStatus.${call.status}`);

  return (
    <div className='rounded-lg border border-gray-200 dark:border-dark-200 bg-gray-50 dark:bg-dark-50 text-sm'>
      <button
        type='button'
        onClick={() => setExpanded(value => !value)}
        className='flex w-full items-center gap-2 px-3 py-2 text-left'
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className='h-3.5 w-3.5 shrink-0 text-gray-400' />
        ) : (
          <ChevronRight className='h-3.5 w-3.5 shrink-0 text-gray-400' />
        )}
        <Wrench className='h-3.5 w-3.5 shrink-0 text-gray-500 dark:text-gray-400' />
        <span
          className='truncate font-medium text-gray-700 dark:text-gray-200'
          dir='ltr'
        >
          {call.name}
        </span>
        {call.serverName && (
          <span className='truncate text-xs text-gray-500 dark:text-gray-400'>
            {call.serverName}
          </span>
        )}
        <span
          className={cn(
            'ml-auto flex shrink-0 items-center gap-1 text-xs',
            call.status === 'succeeded'
              ? 'text-green-600 dark:text-green-400'
              : call.status === 'failed'
                ? 'text-red-500 dark:text-red-400'
                : call.status === 'denied'
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-gray-500 dark:text-gray-400'
          )}
        >
          <StatusIcon status={call.status} />
          {statusLabel}
        </span>
      </button>
      {expanded && (
        <div className='border-t border-gray-200 px-3 py-2 dark:border-dark-200'>
          <div className='text-xs font-medium text-gray-500 dark:text-gray-400'>
            {t('tools.arguments')}
          </div>
          <pre
            dir='ltr'
            className='mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white p-2 font-mono text-xs text-gray-700 dark:bg-dark-100 dark:text-gray-300'
          >
            {formatArguments(call.arguments)}
          </pre>
          {call.resultPreview !== undefined && (
            <>
              <div className='mt-2 text-xs font-medium text-gray-500 dark:text-gray-400'>
                {t('tools.result')}
              </div>
              <pre
                dir='ltr'
                className='mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white p-2 font-mono text-xs text-gray-700 dark:bg-dark-100 dark:text-gray-300'
              >
                {call.resultPreview}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export const ChatToolCallList: React.FC<{
  calls: ChatToolCall[];
  className?: string;
}> = ({ calls, className }) => {
  if (calls.length === 0) return null;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {calls.map(call => (
        <ToolCallCard key={call.id} call={call} />
      ))}
    </div>
  );
};

export const ChatToolApprovalCard: React.FC<{
  approval: ChatToolApprovalRequest;
  onDecide: (
    approvalId: string,
    approve: boolean,
    scope: 'once' | 'session' | 'always'
  ) => void;
  className?: string;
}> = ({ approval, onDecide, className }) => {
  const { t } = useTranslation();
  const [deciding, setDeciding] = useState(false);

  const decide = (approve: boolean, scope: 'once' | 'session' | 'always') => {
    setDeciding(true);
    onDecide(approval.approvalId, approve, scope);
  };

  return (
    <div
      role='alertdialog'
      aria-label={t('tools.approval.title')}
      className={cn(
        'rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/40',
        className
      )}
    >
      <div className='flex items-center gap-2 font-medium text-amber-800 dark:text-amber-200'>
        <ShieldQuestion className='h-4 w-4 shrink-0' />
        {t('tools.approval.title')}
      </div>
      <p className='mt-1 text-amber-800/90 dark:text-amber-100/80'>
        {t('tools.approval.description', {
          tool: approval.toolCall.name,
          server:
            approval.toolCall.serverName ?? t('tools.approval.builtinSource'),
        })}
      </p>
      <pre
        dir='ltr'
        className='mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-white/70 p-2 font-mono text-xs text-gray-700 dark:bg-dark-100 dark:text-gray-300'
      >
        {formatArguments(approval.toolCall.arguments)}
      </pre>
      <div className='mt-3 flex flex-wrap gap-2'>
        <Button
          size='sm'
          disabled={deciding}
          onClick={() => decide(true, 'once')}
        >
          {t('tools.approval.allowOnce')}
        </Button>
        <Button
          size='sm'
          variant='secondary'
          disabled={deciding}
          onClick={() => decide(true, 'session')}
        >
          {t('tools.approval.allowSession')}
        </Button>
        <Button
          size='sm'
          variant='secondary'
          disabled={deciding}
          onClick={() => decide(true, 'always')}
        >
          {t('tools.approval.allowAlways')}
        </Button>
        <Button
          size='sm'
          variant='ghost'
          disabled={deciding}
          onClick={() => decide(false, 'once')}
        >
          {t('tools.approval.deny')}
        </Button>
      </div>
    </div>
  );
};
