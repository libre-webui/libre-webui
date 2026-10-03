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
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  MessageSquareText,
  Paperclip,
  Pencil,
  Pin,
  SmilePlus,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { confirmAction } from '@/components/ui/confirmStore';
import { cn, formatTimestamp } from '@/utils';
import type { ChannelMessage, ChatToolCall } from '@/types';

const QUICK_EMOJI = ['👍', '🎉', '❤️', '😄', '👀', '🚀'];

const TOOL_RESULT_PREVIEW_CHARS = 180;

/**
 * Compact record of the tools a channel model reply ran. Channels have no
 * live approval prompt, so a side-effecting call arrives already denied;
 * the hint says why rather than leaving it looking like a failure.
 */
const ChannelToolCalls: React.FC<{ calls: ChatToolCall[] }> = ({ calls }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const denied = calls.some(call => call.status === 'denied');

  return (
    <div className='mt-1' data-testid='channel-tool-calls'>
      <button
        type='button'
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        className='flex items-center gap-1 text-[11px] font-medium text-gray-500 hover:text-gray-700 dark:text-dark-600 dark:hover:text-dark-800'
        data-testid='channel-tool-calls-toggle'
      >
        {open ? (
          <ChevronDown className='h-3 w-3' />
        ) : (
          <ChevronRight className='h-3 w-3' />
        )}
        <Wrench className='h-3 w-3' />
        {t('channels.toolCalls.summary', { total: calls.length })}
      </button>
      {open && (
        <div className='mt-1 space-y-1'>
          {calls.map(call => (
            <div
              key={call.id}
              className='rounded-lg border border-black/6 px-2 py-1 dark:border-white/8'
              data-testid='channel-tool-call'
            >
              <div className='flex items-baseline gap-1.5'>
                <span
                  dir='ltr'
                  className='min-w-0 truncate text-[11px] font-medium text-gray-700 dark:text-dark-800'
                >
                  {call.name}
                </span>
                <span
                  className={cn(
                    'shrink-0 text-[10px]',
                    call.status === 'succeeded'
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : call.status === 'denied'
                        ? 'text-amber-600 dark:text-amber-400'
                        : call.status === 'failed'
                          ? 'text-red-500'
                          : 'text-gray-400 dark:text-dark-500'
                  )}
                >
                  {t(`tools.callStatus.${call.status}`)}
                </span>
              </div>
              {call.resultPreview && (
                <p
                  dir='ltr'
                  className='mt-0.5 whitespace-pre-wrap wrap-break-word font-mono text-[10px] leading-snug text-gray-500 dark:text-dark-600'
                >
                  {call.resultPreview.slice(0, TOOL_RESULT_PREVIEW_CHARS)}
                </p>
              )}
            </div>
          ))}
          {denied && (
            <p className='text-[10px] text-gray-400 dark:text-dark-500'>
              {t('channels.toolCalls.deniedHint')}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export interface ChannelMessageActions {
  onReply?: ((message: ChannelMessage) => void) | undefined;
  onEdit: (message: ChannelMessage, content: string) => void | Promise<void>;
  onDelete: (message: ChannelMessage) => void | Promise<void>;
  onPin: (message: ChannelMessage) => void | Promise<void>;
  onReact: (
    message: ChannelMessage,
    emoji: string,
    mine: boolean
  ) => void | Promise<void>;
  onDownload: (attachmentId: string, filename: string) => void | Promise<void>;
}

interface ChannelMessageItemProps {
  message: ChannelMessage;
  currentUserId: string | undefined;
  canModerate: boolean;
  actions: ChannelMessageActions;
  compact?: boolean;
}

export const ChannelMessageItem: React.FC<ChannelMessageItemProps> = ({
  message,
  currentUserId,
  canModerate,
  actions,
  compact = false,
}) => {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(message.content);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const isModel = message.authorKind === 'model';
  const isOwn =
    !isModel && message.author?.userId === currentUserId && !message.deleted;

  const authorLabel = isModel
    ? (message.model ?? t('channels.modelAuthor'))
    : (message.author?.username ?? t('channels.unknownAuthor'));

  return (
    <div
      className={cn(
        'group relative rounded-xl px-2.5 py-1.5 hover:bg-black/2.5 dark:hover:bg-white/3',
        compact && 'px-2 py-1'
      )}
      data-testid='channel-message'
    >
      <div className='flex items-baseline gap-2'>
        {isModel && (
          <Bot className='h-3.5 w-3.5 shrink-0 self-center text-primary-500' />
        )}
        <span
          className={cn(
            'shrink-0 text-[13px] font-semibold',
            isModel
              ? 'text-primary-600 dark:text-primary-400'
              : 'text-gray-900 dark:text-dark-900'
          )}
        >
          {authorLabel}
        </span>
        <span className='shrink-0 text-[11px] text-gray-400 dark:text-dark-500'>
          {formatTimestamp(message.createdAt, i18n.language)}
        </span>
        {message.editedAt && !message.deleted && (
          <span className='shrink-0 text-[10px] text-gray-400 dark:text-dark-500'>
            {t('channels.edited')}
          </span>
        )}
        {message.pinnedAt && (
          <Pin
            role='img'
            aria-label={t('channels.pins')}
            className='h-3 w-3 shrink-0 text-amber-500'
          />
        )}
      </div>

      {message.deleted ? (
        <p className='text-[13px] italic text-gray-400 dark:text-dark-500'>
          {t('channels.deletedMessage')}
        </p>
      ) : editing ? (
        <div className='mt-1 flex items-end gap-1.5'>
          <textarea
            value={editDraft}
            onChange={event => setEditDraft(event.target.value)}
            rows={2}
            aria-label={t('channels.edit')}
            className='min-w-0 flex-1 resize-none rounded-lg border border-black/8 bg-transparent px-2 py-1 text-[13px] focus:border-primary-500 focus:outline-hidden focus:ring-2 focus:ring-primary-500/30 dark:border-white/10 dark:text-dark-900'
            data-testid='channel-message-edit'
          />
          <button
            type='button'
            onClick={() => {
              void actions.onEdit(message, editDraft);
              setEditing(false);
            }}
            aria-label={t('channels.confirmEdit')}
            title={t('channels.confirmEdit')}
            className='rounded-md p-1.5 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'
          >
            <Check className='h-3.5 w-3.5' />
          </button>
          <button
            type='button'
            onClick={() => setEditing(false)}
            aria-label={t('channels.cancelEdit')}
            title={t('channels.cancelEdit')}
            className='rounded-md p-1.5 text-gray-400 hover:bg-black/4 dark:hover:bg-white/6'
          >
            <X className='h-3.5 w-3.5' />
          </button>
        </div>
      ) : (
        <>
          {message.pending ? (
            <p className='flex items-center gap-1.5 text-[13px] text-gray-400 dark:text-dark-500'>
              <Loader2 className='h-3.5 w-3.5 animate-spin' />
              {t('channels.modelThinking')}
            </p>
          ) : message.error ? (
            <p className='text-[13px] text-red-500'>{message.error}</p>
          ) : (
            <p className='whitespace-pre-wrap wrap-break-word text-[13px] leading-relaxed text-gray-800 dark:text-dark-800'>
              {message.content}
            </p>
          )}
          {isModel && (message.toolCalls?.length ?? 0) > 0 && (
            <ChannelToolCalls calls={message.toolCalls!} />
          )}
          {(message.attachments?.length ?? 0) > 0 && (
            <div className='mt-1 space-y-1'>
              {message.attachments!.map(attachment => (
                <button
                  key={attachment.id}
                  type='button'
                  onClick={() =>
                    void actions.onDownload(attachment.id, attachment.filename)
                  }
                  className='flex items-center gap-1.5 rounded-lg border border-black/6 px-2 py-1 text-[12px] text-gray-600 hover:bg-black/3 dark:border-white/8 dark:text-dark-700 dark:hover:bg-white/4'
                  data-testid='channel-attachment'
                >
                  <Paperclip className='h-3 w-3' />
                  <span className='min-w-0 truncate'>
                    {attachment.filename}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {(message.reactions?.length ?? 0) > 0 && (
        <div className='mt-1 flex flex-wrap gap-1'>
          {message.reactions!.map(reaction => (
            <button
              key={reaction.emoji}
              type='button'
              aria-pressed={reaction.mine}
              onClick={() =>
                void actions.onReact(message, reaction.emoji, reaction.mine)
              }
              className={cn(
                'rounded-full border px-1.5 py-0.5 text-[11px]',
                reaction.mine
                  ? 'border-primary-400/50 bg-primary-500/10 text-primary-600 dark:text-primary-400'
                  : 'border-black/8 text-gray-600 hover:bg-black/3 dark:border-white/10 dark:text-dark-700'
              )}
              data-testid='channel-reaction'
            >
              {reaction.emoji} {reaction.count}
            </button>
          ))}
        </div>
      )}

      {!compact && (message.replyCount ?? 0) > 0 && actions.onReply && (
        <button
          type='button'
          onClick={() => actions.onReply!(message)}
          className='mt-1 flex items-center gap-1 text-[11px] font-medium text-primary-600 hover:underline dark:text-primary-400'
          data-testid='channel-reply-count'
        >
          <MessageSquareText className='h-3 w-3' />
          {t('channels.replyCount', { total: message.replyCount })}
        </button>
      )}

      {/* Hover actions */}
      {!message.deleted && !editing && (
        <div className='absolute -top-2.5 inset-e-2 hidden items-center gap-0.5 rounded-lg border border-black/8 bg-white px-1 py-0.5 shadow-xs group-focus-within:flex group-hover:flex [@media(hover:none)]:flex dark:border-white/10 dark:bg-dark-50'>
          <div className='relative'>
            <button
              type='button'
              onClick={() => setEmojiOpen(open => !open)}
              className='rounded-sm p-1 text-gray-400 hover:text-gray-700 dark:hover:text-dark-800'
              title={t('channels.react')}
              aria-label={t('channels.react')}
              aria-haspopup='true'
              aria-expanded={emojiOpen}
              data-testid='channel-react'
            >
              <SmilePlus className='h-3.5 w-3.5' />
            </button>
            {emojiOpen && (
              <div className='absolute inset-e-0 top-6 z-10 flex gap-0.5 rounded-lg border border-black/8 bg-white p-1 shadow-md dark:border-white/10 dark:bg-dark-50'>
                {QUICK_EMOJI.map(emoji => (
                  <button
                    key={emoji}
                    type='button'
                    onClick={() => {
                      const mine = Boolean(
                        message.reactions?.find(
                          reaction => reaction.emoji === emoji
                        )?.mine
                      );
                      void actions.onReact(message, emoji, mine);
                      setEmojiOpen(false);
                    }}
                    aria-label={t('channels.reactWith', { emoji })}
                    className='rounded-sm p-0.5 text-sm hover:bg-black/5 dark:hover:bg-white/8'
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
          {actions.onReply && !message.parentId && (
            <button
              type='button'
              onClick={() => actions.onReply!(message)}
              className='rounded-sm p-1 text-gray-400 hover:text-gray-700 dark:hover:text-dark-800'
              title={t('channels.reply')}
              aria-label={t('channels.reply')}
              data-testid='channel-reply'
            >
              <MessageSquareText className='h-3.5 w-3.5' />
            </button>
          )}
          <button
            type='button'
            onClick={() => void actions.onPin(message)}
            className='rounded-sm p-1 text-gray-400 hover:text-amber-500'
            title={message.pinnedAt ? t('channels.unpin') : t('channels.pin')}
            aria-label={
              message.pinnedAt ? t('channels.unpin') : t('channels.pin')
            }
            data-testid='channel-pin'
          >
            <Pin className='h-3.5 w-3.5' />
          </button>
          {isOwn && (
            <button
              type='button'
              onClick={() => {
                setEditDraft(message.content);
                setEditing(true);
              }}
              className='rounded-sm p-1 text-gray-400 hover:text-gray-700 dark:hover:text-dark-800'
              title={t('channels.edit')}
              aria-label={t('channels.edit')}
              data-testid='channel-edit'
            >
              <Pencil className='h-3.5 w-3.5' />
            </button>
          )}
          {(isOwn || canModerate) && (
            <button
              type='button'
              onClick={async () => {
                const confirmed = await confirmAction({
                  title: t('channels.deleteMessageConfirmTitle'),
                  description: t('channels.deleteMessageConfirmDescription'),
                  destructive: true,
                });
                if (confirmed) await actions.onDelete(message);
              }}
              className='rounded-sm p-1 text-gray-400 hover:text-red-500'
              title={t('channels.deleteMessage')}
              aria-label={t('channels.deleteMessage')}
              data-testid='channel-delete-message'
            >
              <Trash2 className='h-3.5 w-3.5' />
            </button>
          )}
        </div>
      )}
    </div>
  );
};
