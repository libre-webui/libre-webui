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

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  Bot,
  Compass,
  Hash,
  Loader2,
  Lock,
  MessageCircle,
  MessageSquareText,
  Paperclip,
  Pin,
  Plus,
  Send,
  Settings2,
  Users,
  X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import {
  Button,
  ModalShell,
  modalFieldClass,
  modalLabelClass,
} from '@/components/ui';
import { ChannelMessageItem } from '@/components/channels/ChannelMessageItem';
import { channelsApi } from '@/utils/api';
import { streamTeamEvents } from '@/utils/api/teamEventStream';
import { useAuthStore } from '@/store/authStore';
import { useChatStore } from '@/store/chatStore';
import { cn } from '@/utils';
import { createLogger } from '@/utils/logger';
import type { ChannelMember, ChannelMessage, ChannelSummary } from '@/types';

const logger = createLogger('pages:channels');

type SidePanel = 'members' | 'pins' | null;

const channelIcon = (channel: ChannelSummary) =>
  channel.type === 'dm' ? (
    <MessageCircle className='h-3.5 w-3.5 shrink-0' />
  ) : channel.type === 'private' ? (
    <Lock className='h-3.5 w-3.5 shrink-0' />
  ) : (
    <Hash className='h-3.5 w-3.5 shrink-0' />
  );

const channelLabel = (channel: ChannelSummary): string =>
  channel.type === 'dm' ? (channel.dmPeer?.username ?? '…') : channel.name;

const ChannelsPage: React.FC = () => {
  const { t } = useTranslation();
  const currentUser = useAuthStore(state => state.user);
  const models = useChatStore(state => state.models);
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [publicChannels, setPublicChannels] = useState<ChannelSummary[] | null>(
    null
  );
  const [browsing, setBrowsing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChannelMessage[] | null>(null);
  const [members, setMembers] = useState<ChannelMember[]>([]);
  const [pins, setPins] = useState<ChannelMessage[]>([]);
  const [sidePanel, setSidePanel] = useState<SidePanel>(null);
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<ChannelMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [mentionModel, setMentionModel] = useState('');
  const [sending, setSending] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState<{
    id: string;
    filename: string;
  } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [dmOpen, setDmOpen] = useState(false);
  const [inviteName, setInviteName] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const selectedChannel = useMemo(
    () => channels.find(channel => channel.id === selectedId) ?? null,
    [channels, selectedId]
  );
  // Reset conversation-scoped state during render when the selection moves,
  // so the effect below only synchronizes with the server.
  const [conversationFor, setConversationFor] = useState<string | null>(null);
  if (selectedId !== conversationFor) {
    setConversationFor(selectedId);
    setMessages(null);
    setThreadRootId(null);
    setSidePanel(null);
  }
  const isOwner = selectedChannel?.role === 'owner';

  const refreshChannels = useCallback(() => {
    channelsApi
      .listMine()
      .then(response => {
        if (response.success && response.data) setChannels(response.data);
      })
      .catch(error => logger.error('Failed to load channels:', error))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refreshChannels();
    const interval = window.setInterval(refreshChannels, 30_000);
    return () => window.clearInterval(interval);
  }, [refreshChannels]);

  // Deep links (`?channel=<id>`, used by notifications) select a channel.
  const requestedChannelId = searchParams.get('channel');
  if (requestedChannelId && selectedId !== requestedChannelId) {
    setSelectedId(requestedChannelId);
  }
  useEffect(() => {
    if (requestedChannelId) setSearchParams({}, { replace: true });
  }, [requestedChannelId, setSearchParams]);

  const timelineScopeRef = useRef<{
    channelId: string;
    requestId: number;
  } | null>(null);
  useLayoutEffect(() => {
    // Invalidate before paint: late responses must never appear under a
    // different channel header, including after switching away and back.
    timelineScopeRef.current = selectedId
      ? { channelId: selectedId, requestId: 0 }
      : null;
    return () => {
      timelineScopeRef.current = null;
    };
  }, [selectedId]);

  const loadTimeline = useCallback((channelId: string) => {
    const scope = timelineScopeRef.current;
    if (!scope || scope.channelId !== channelId) return;
    const requestId = ++scope.requestId;
    channelsApi
      .listMessages(channelId, { limit: 100 })
      .then(response => {
        if (
          timelineScopeRef.current !== scope ||
          scope.requestId !== requestId
        ) {
          return;
        }
        if (response.success && response.data) setMessages(response.data);
      })
      .catch(error => logger.error('Failed to load messages:', error));
  }, []);

  const threadRootRef = useRef<string | null>(null);
  useEffect(() => {
    threadRootRef.current = threadRootId;
  }, [threadRootId]);

  // Live events trigger authoritative re-reads: the SSE stream is a wake
  // signal, the REST timeline is the source of truth.
  const handleLiveEvent = useCallback(
    (channelId: string) => {
      loadTimeline(channelId);
      void channelsApi.markRead(channelId);
      const openThread = threadRootRef.current;
      if (openThread) {
        void channelsApi.thread(openThread).then(response => {
          if (response.success && response.data) {
            setThreadMessages(response.data);
          }
        });
      }
    },
    [loadTimeline]
  );

  // Selecting a channel loads its timeline and opens the live stream.
  useEffect(() => {
    if (!selectedId) return;
    loadTimeline(selectedId);
    void channelsApi.markRead(selectedId).then(refreshChannels);
    const abort = new AbortController();
    void streamTeamEvents({
      path: `/channels/${selectedId}/events`,
      signal: abort.signal,
      onEvent: () => handleLiveEvent(selectedId),
    });
    return () => abort.abort();
  }, [selectedId, loadTimeline, refreshChannels, handleLiveEvent]);

  // Keep the newest message in view.
  const messageCount = messages?.length ?? 0;
  useEffect(() => {
    const element = timelineRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messageCount, selectedId]);

  useEffect(() => {
    if (!selectedId || !sidePanel) return;
    if (sidePanel === 'members') {
      channelsApi.listMembers(selectedId).then(response => {
        if (response.success && response.data) setMembers(response.data);
      });
    } else {
      channelsApi.listPins(selectedId).then(response => {
        if (response.success && response.data) setPins(response.data);
      });
    }
  }, [selectedId, sidePanel]);

  useEffect(() => {
    if (!threadRootId) return;
    channelsApi.thread(threadRootId).then(response => {
      if (response.success && response.data) setThreadMessages(response.data);
    });
  }, [threadRootId]);

  const openBrowse = () => {
    setBrowsing(true);
    channelsApi.listPublic().then(response => {
      if (response.success && response.data) setPublicChannels(response.data);
    });
  };

  const handleSend = async (parentId?: string) => {
    if (!selectedId || sending) return;
    const content = draft.trim();
    if (!content && !pendingAttachment) return;
    setSending(true);
    try {
      const response = await channelsApi.postMessage(selectedId, {
        content,
        ...(parentId ? { parentId } : {}),
        ...(pendingAttachment ? { attachmentIds: [pendingAttachment.id] } : {}),
        ...(mentionModel ? { mentionModel } : {}),
      });
      if (response.success) {
        setDraft('');
        setPendingAttachment(null);
        setMentionModel('');
        loadTimeline(selectedId);
        if (parentId) {
          const thread = await channelsApi.thread(parentId);
          if (thread.success && thread.data) setThreadMessages(thread.data);
        }
      } else {
        toast.error(response.error || t('channels.sendFailed'));
      }
    } catch (error) {
      logger.error('Failed to send message:', error);
      toast.error(t('channels.sendFailed'));
    } finally {
      setSending(false);
    }
  };

  const handleUpload = async (file: File) => {
    if (!selectedId) return;
    try {
      const response = await channelsApi.uploadAttachment(selectedId, file);
      if (response.success && response.data) {
        setPendingAttachment({
          id: response.data.id,
          filename: response.data.filename,
        });
      } else {
        toast.error(response.error || t('channels.uploadFailed'));
      }
    } catch (error) {
      logger.error('Failed to upload attachment:', error);
      toast.error(t('channels.uploadFailed'));
    }
  };

  const handleInvite = async () => {
    if (!selectedId || !inviteName.trim()) return;
    const response = await channelsApi
      .addMember(selectedId, inviteName.trim())
      .catch(() => undefined);
    if (response?.success) {
      setInviteName('');
      const refreshed = await channelsApi.listMembers(selectedId);
      if (refreshed.success && refreshed.data) setMembers(refreshed.data);
      toast.success(t('channels.memberAdded'));
    } else {
      toast.error(t('channels.memberAddFailed'));
    }
  };

  const messageActions = {
    onReply: (message: ChannelMessage) => setThreadRootId(message.id),
    onEdit: async (message: ChannelMessage, content: string) => {
      const response = await channelsApi
        .editMessage(message.id, content)
        .catch(() => undefined);
      if (response?.success && selectedId) loadTimeline(selectedId);
    },
    onDelete: async (message: ChannelMessage) => {
      const response = await channelsApi
        .deleteMessage(message.id)
        .catch(() => undefined);
      if (response?.success && selectedId) loadTimeline(selectedId);
    },
    onPin: async (message: ChannelMessage) => {
      await channelsApi
        .setPinned(message.id, !message.pinnedAt)
        .catch(() => undefined);
      if (selectedId) loadTimeline(selectedId);
    },
    onReact: async (message: ChannelMessage, emoji: string, mine: boolean) => {
      if (mine) {
        await channelsApi
          .removeReaction(message.id, emoji)
          .catch(() => undefined);
      } else {
        await channelsApi.addReaction(message.id, emoji).catch(() => undefined);
      }
      if (selectedId) loadTimeline(selectedId);
    },
    onDownload: async (attachmentId: string, filename: string) => {
      try {
        const blob = await channelsApi.downloadAttachment(attachmentId);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        URL.revokeObjectURL(url);
      } catch (error) {
        logger.error('Failed to download attachment:', error);
      }
    },
  };

  const threadRoot = threadMessages[0];

  return (
    <div className='flex h-full min-h-0'>
      {/* Channel rail */}
      <aside
        className={cn(
          'flex w-64 shrink-0 flex-col border-r border-black/[0.06] dark:border-white/[0.06]',
          selectedId ? 'hidden md:flex' : 'flex'
        )}
        data-testid='channel-rail'
      >
        <div className='flex items-center gap-1 px-3 py-2.5'>
          <h1 className='min-w-0 flex-1 truncate text-sm font-semibold text-gray-900 dark:text-dark-900'>
            {t('channels.title')}
          </h1>
          <button
            type='button'
            onClick={openBrowse}
            title={t('channels.browsePublic')}
            className='rounded-md p-1.5 text-gray-500 hover:bg-black/[0.04] dark:text-dark-600 dark:hover:bg-white/[0.06]'
            data-testid='channels-browse'
          >
            <Compass className='h-4 w-4' />
          </button>
          <button
            type='button'
            onClick={() => setDmOpen(true)}
            title={t('channels.newDm')}
            className='rounded-md p-1.5 text-gray-500 hover:bg-black/[0.04] dark:text-dark-600 dark:hover:bg-white/[0.06]'
            data-testid='channels-new-dm'
          >
            <MessageCircle className='h-4 w-4' />
          </button>
          <button
            type='button'
            onClick={() => setCreateOpen(true)}
            title={t('channels.newChannel')}
            className='rounded-md p-1.5 text-gray-500 hover:bg-black/[0.04] dark:text-dark-600 dark:hover:bg-white/[0.06]'
            data-testid='channels-new'
          >
            <Plus className='h-4 w-4' />
          </button>
        </div>
        <div className='min-h-0 flex-1 overflow-y-auto px-2 pb-3 scrollbar-thin'>
          {loading ? (
            <Loader2 className='mx-auto mt-6 h-4 w-4 animate-spin text-gray-400' />
          ) : channels.length === 0 ? (
            <p className='px-2 pt-6 text-center text-xs text-gray-400 dark:text-dark-500'>
              {t('channels.empty')}
            </p>
          ) : (
            channels.map(channel => (
              <button
                key={channel.id}
                type='button'
                onClick={() => setSelectedId(channel.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]',
                  selectedId === channel.id
                    ? 'bg-black/[0.05] text-gray-900 dark:bg-white/[0.08] dark:text-dark-900'
                    : 'text-gray-600 hover:bg-black/[0.03] dark:text-dark-700 dark:hover:bg-white/[0.04]'
                )}
                data-testid='channel-item'
              >
                {channelIcon(channel)}
                <span className='min-w-0 flex-1 truncate'>
                  {channelLabel(channel)}
                </span>
                {(channel.unreadCount ?? 0) > 0 && (
                  <span
                    className='rounded-full bg-primary-500 px-1.5 text-[10px] font-semibold leading-4 text-white'
                    data-testid='channel-unread'
                  >
                    {channel.unreadCount}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Conversation */}
      <main className='flex min-w-0 flex-1 flex-col'>
        {!selectedChannel ? (
          <div className='flex flex-1 flex-col items-center justify-center gap-2 text-gray-400 dark:text-dark-500'>
            <MessageSquareText className='h-8 w-8' />
            <p className='text-sm'>{t('channels.selectPrompt')}</p>
          </div>
        ) : (
          <>
            <header className='flex items-center gap-2 border-b border-black/[0.06] px-4 py-2.5 dark:border-white/[0.06]'>
              <button
                type='button'
                onClick={() => setSelectedId(null)}
                className='rounded-md p-1 text-gray-500 hover:bg-black/[0.04] md:hidden dark:text-dark-600'
              >
                <ArrowLeft className='h-4 w-4' />
              </button>
              {channelIcon(selectedChannel)}
              <h2
                className='min-w-0 flex-1 truncate text-sm font-semibold text-gray-900 dark:text-dark-900'
                data-testid='channel-title'
              >
                {channelLabel(selectedChannel)}
              </h2>
              <button
                type='button'
                onClick={() =>
                  setSidePanel(sidePanel === 'pins' ? null : 'pins')
                }
                title={t('channels.pins')}
                className='rounded-md p-1.5 text-gray-500 hover:bg-black/[0.04] dark:text-dark-600 dark:hover:bg-white/[0.06]'
                data-testid='channel-pins-toggle'
              >
                <Pin className='h-4 w-4' />
              </button>
              <button
                type='button'
                onClick={() =>
                  setSidePanel(sidePanel === 'members' ? null : 'members')
                }
                title={t('channels.members')}
                className='rounded-md p-1.5 text-gray-500 hover:bg-black/[0.04] dark:text-dark-600 dark:hover:bg-white/[0.06]'
                data-testid='channel-members-toggle'
              >
                <Users className='h-4 w-4' />
              </button>
              {isOwner && selectedChannel.type !== 'dm' && (
                <button
                  type='button'
                  onClick={() => setShareOpen(true)}
                  title={t('channels.settings')}
                  className='rounded-md p-1.5 text-gray-500 hover:bg-black/[0.04] dark:text-dark-600 dark:hover:bg-white/[0.06]'
                  data-testid='channel-settings'
                >
                  <Settings2 className='h-4 w-4' />
                </button>
              )}
            </header>

            <div className='flex min-h-0 flex-1'>
              <div className='flex min-w-0 flex-1 flex-col'>
                <div
                  ref={timelineRef}
                  className='min-h-0 flex-1 space-y-1 overflow-y-auto px-4 py-3 scrollbar-thin'
                  data-testid='channel-timeline'
                >
                  {messages === null ? (
                    <Loader2 className='mx-auto mt-6 h-4 w-4 animate-spin text-gray-400' />
                  ) : messages.length === 0 ? (
                    <p className='pt-8 text-center text-xs text-gray-400 dark:text-dark-500'>
                      {t('channels.noMessages')}
                    </p>
                  ) : (
                    messages.map(message => (
                      <ChannelMessageItem
                        key={message.id}
                        message={message}
                        currentUserId={currentUser?.id}
                        canModerate={isOwner}
                        actions={messageActions}
                      />
                    ))
                  )}
                </div>

                <div className='border-t border-black/[0.06] p-3 dark:border-white/[0.06]'>
                  {pendingAttachment && (
                    <div className='mb-2 flex items-center gap-2 rounded-lg border border-black/[0.06] px-2.5 py-1.5 text-xs text-gray-600 dark:border-white/[0.08] dark:text-dark-700'>
                      <Paperclip className='h-3.5 w-3.5' />
                      <span className='min-w-0 flex-1 truncate'>
                        {pendingAttachment.filename}
                      </span>
                      <button
                        type='button'
                        onClick={() => setPendingAttachment(null)}
                        className='text-gray-400 hover:text-red-500'
                      >
                        <X className='h-3.5 w-3.5' />
                      </button>
                    </div>
                  )}
                  <div className='flex items-end gap-1.5'>
                    <input
                      ref={fileInputRef}
                      type='file'
                      className='hidden'
                      onChange={event => {
                        const file = event.target.files?.[0];
                        if (file) void handleUpload(file);
                        event.target.value = '';
                      }}
                    />
                    <button
                      type='button'
                      onClick={() => fileInputRef.current?.click()}
                      title={t('channels.attach')}
                      className='rounded-md p-2 text-gray-500 hover:bg-black/[0.04] dark:text-dark-600 dark:hover:bg-white/[0.06]'
                      data-testid='channel-attach'
                    >
                      <Paperclip className='h-4 w-4' />
                    </button>
                    <div className='flex items-center gap-1'>
                      <Bot
                        className={cn(
                          'h-4 w-4',
                          mentionModel
                            ? 'text-primary-500'
                            : 'text-gray-400 dark:text-dark-500'
                        )}
                      />
                      <select
                        value={mentionModel}
                        onChange={event => setMentionModel(event.target.value)}
                        className='max-w-[130px] rounded-md border border-black/[0.08] bg-transparent px-1 py-1 text-[11px] text-gray-600 focus:outline-none dark:border-white/[0.1] dark:bg-dark-100 dark:text-dark-700'
                        title={t('channels.askModel')}
                        data-testid='channel-mention-model'
                      >
                        <option value=''>{t('channels.noModel')}</option>
                        {models.map(model => (
                          <option key={model.name} value={model.name}>
                            {model.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <textarea
                      value={draft}
                      onChange={event => setDraft(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault();
                          void handleSend();
                        }
                      }}
                      rows={1}
                      placeholder={t('channels.composerPlaceholder')}
                      className='max-h-32 min-w-0 flex-1 resize-none rounded-xl border border-black/[0.08] bg-transparent px-3 py-2 text-[13px] text-gray-900 placeholder:text-gray-400 focus:border-primary-500/40 focus:outline-none dark:border-white/[0.1] dark:text-dark-900'
                      data-testid='channel-composer'
                    />
                    <Button
                      size='sm'
                      disabled={
                        sending || (!draft.trim() && !pendingAttachment)
                      }
                      onClick={() => void handleSend()}
                      data-testid='channel-send'
                    >
                      {sending ? (
                        <Loader2 className='h-4 w-4 animate-spin' />
                      ) : (
                        <Send className='h-4 w-4' />
                      )}
                    </Button>
                  </div>
                </div>
              </div>

              {/* Thread panel */}
              {threadRootId && (
                <aside
                  className='flex w-80 shrink-0 flex-col border-l border-black/[0.06] dark:border-white/[0.06]'
                  data-testid='channel-thread'
                >
                  <div className='flex items-center gap-2 border-b border-black/[0.06] px-3 py-2 dark:border-white/[0.06]'>
                    <span className='flex-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-dark-600'>
                      {t('channels.thread')}
                    </span>
                    <button
                      type='button'
                      onClick={() => setThreadRootId(null)}
                      className='rounded-md p-1 text-gray-400 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'
                    >
                      <X className='h-3.5 w-3.5' />
                    </button>
                  </div>
                  <div className='min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2 scrollbar-thin'>
                    {threadMessages.map(message => (
                      <ChannelMessageItem
                        key={message.id}
                        message={message}
                        currentUserId={currentUser?.id}
                        canModerate={isOwner}
                        actions={{ ...messageActions, onReply: undefined }}
                        compact
                      />
                    ))}
                  </div>
                  <div className='flex items-end gap-1.5 border-t border-black/[0.06] p-2 dark:border-white/[0.06]'>
                    <textarea
                      value={draft}
                      onChange={event => setDraft(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault();
                          if (threadRoot) void handleSend(threadRoot.id);
                        }
                      }}
                      rows={1}
                      placeholder={t('channels.replyPlaceholder')}
                      className='min-w-0 flex-1 resize-none rounded-lg border border-black/[0.08] bg-transparent px-2.5 py-1.5 text-[13px] text-gray-900 focus:outline-none dark:border-white/[0.1] dark:text-dark-900'
                      data-testid='channel-thread-composer'
                    />
                    <Button
                      size='sm'
                      disabled={sending || !draft.trim()}
                      onClick={() =>
                        threadRoot && void handleSend(threadRoot.id)
                      }
                    >
                      <Send className='h-3.5 w-3.5' />
                    </Button>
                  </div>
                </aside>
              )}

              {/* Members / pins panel */}
              {sidePanel && (
                <aside
                  className='flex w-72 shrink-0 flex-col border-l border-black/[0.06] dark:border-white/[0.06]'
                  data-testid={`channel-${sidePanel}-panel`}
                >
                  <div className='flex items-center gap-2 border-b border-black/[0.06] px-3 py-2 dark:border-white/[0.06]'>
                    <span className='flex-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-dark-600'>
                      {sidePanel === 'members'
                        ? t('channels.members')
                        : t('channels.pins')}
                    </span>
                    <button
                      type='button'
                      onClick={() => setSidePanel(null)}
                      className='rounded-md p-1 text-gray-400 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'
                    >
                      <X className='h-3.5 w-3.5' />
                    </button>
                  </div>
                  <div className='min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 py-2 scrollbar-thin'>
                    {sidePanel === 'members' ? (
                      <>
                        {isOwner && selectedChannel.type === 'private' && (
                          <div className='mb-2 flex gap-1.5'>
                            <input
                              type='text'
                              value={inviteName}
                              onChange={event =>
                                setInviteName(event.target.value)
                              }
                              onKeyDown={event => {
                                if (event.key === 'Enter') void handleInvite();
                              }}
                              placeholder={t('channels.invitePlaceholder')}
                              className='min-w-0 flex-1 rounded-lg border border-black/[0.08] bg-transparent px-2 py-1 text-xs focus:outline-none dark:border-white/[0.1] dark:text-dark-800'
                              data-testid='channel-invite-name'
                            />
                            <Button
                              size='sm'
                              disabled={!inviteName.trim()}
                              onClick={() => void handleInvite()}
                              data-testid='channel-invite-submit'
                            >
                              <Plus className='h-3.5 w-3.5' />
                            </Button>
                          </div>
                        )}
                        {members.map(member => (
                          <div
                            key={member.userId}
                            className='flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-gray-700 dark:text-dark-800'
                            data-testid='channel-member'
                          >
                            <span className='min-w-0 flex-1 truncate'>
                              {member.username}
                            </span>
                            <span className='text-[10px] uppercase text-gray-400 dark:text-dark-500'>
                              {member.role === 'owner'
                                ? t('channels.roleOwner')
                                : ''}
                            </span>
                            {isOwner &&
                              member.userId !== currentUser?.id &&
                              selectedChannel.type !== 'dm' && (
                                <button
                                  type='button'
                                  onClick={() =>
                                    void channelsApi
                                      .removeMember(
                                        selectedChannel.id,
                                        member.userId
                                      )
                                      .then(() =>
                                        setMembers(current =>
                                          current.filter(
                                            entry =>
                                              entry.userId !== member.userId
                                          )
                                        )
                                      )
                                  }
                                  className='rounded p-0.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'
                                  title={t('channels.removeMember')}
                                >
                                  <X className='h-3 w-3' />
                                </button>
                              )}
                          </div>
                        ))}
                        {!isOwner && selectedChannel.type !== 'dm' && (
                          <Button
                            size='sm'
                            variant='ghost'
                            className='mt-2 w-full text-red-500'
                            onClick={() =>
                              void channelsApi
                                .removeMember(
                                  selectedChannel.id,
                                  currentUser?.id ?? ''
                                )
                                .then(() => {
                                  setSelectedId(null);
                                  refreshChannels();
                                })
                            }
                            data-testid='channel-leave'
                          >
                            {t('channels.leave')}
                          </Button>
                        )}
                      </>
                    ) : pins.length === 0 ? (
                      <p className='pt-4 text-center text-xs text-gray-400 dark:text-dark-500'>
                        {t('channels.noPins')}
                      </p>
                    ) : (
                      pins.map(message => (
                        <ChannelMessageItem
                          key={message.id}
                          message={message}
                          currentUserId={currentUser?.id}
                          canModerate={isOwner}
                          actions={messageActions}
                          compact
                        />
                      ))
                    )}
                  </div>
                </aside>
              )}
            </div>
          </>
        )}
      </main>

      {/* Create channel */}
      {createOpen && (
        <CreateChannelModal
          onClose={() => setCreateOpen(false)}
          onCreated={channel => {
            setCreateOpen(false);
            refreshChannels();
            setSelectedId(channel.id);
          }}
        />
      )}
      {dmOpen && (
        <OpenDmModal
          onClose={() => setDmOpen(false)}
          onOpened={channel => {
            setDmOpen(false);
            refreshChannels();
            setSelectedId(channel.id);
          }}
        />
      )}
      {browsing && (
        <BrowseChannelsModal
          channels={publicChannels}
          onClose={() => setBrowsing(false)}
          onJoined={channelId => {
            setBrowsing(false);
            refreshChannels();
            setSelectedId(channelId);
          }}
        />
      )}
      {shareOpen && selectedChannel && (
        <ChannelSettingsModal
          channel={selectedChannel}
          onClose={() => setShareOpen(false)}
          onChanged={() => {
            setShareOpen(false);
            refreshChannels();
          }}
          onDeleted={() => {
            setShareOpen(false);
            setSelectedId(null);
            refreshChannels();
          }}
        />
      )}
    </div>
  );
};

const CreateChannelModal: React.FC<{
  onClose: () => void;
  onCreated: (channel: { id: string }) => void;
}> = ({ onClose, onCreated }) => {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [type, setType] = useState<'public' | 'private'>('public');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  return (
    <ModalShell
      titleId='create-channel-title'
      title={t('channels.newChannel')}
      onClose={onClose}
      testId='create-channel-modal'
      footer={
        <Button
          size='sm'
          disabled={saving || !name.trim()}
          onClick={() => {
            setSaving(true);
            channelsApi
              .create({
                type,
                name: name.trim(),
                ...(description.trim()
                  ? { description: description.trim() }
                  : {}),
              })
              .then(response => {
                if (response.success && response.data) {
                  onCreated(response.data);
                } else {
                  toast.error(response.error || t('channels.createFailed'));
                }
              })
              .catch(() => toast.error(t('channels.createFailed')))
              .finally(() => setSaving(false));
          }}
          data-testid='create-channel-submit'
        >
          {t('channels.create')}
        </Button>
      }
    >
      <div>
        <label className={modalLabelClass}>{t('channels.nameLabel')}</label>
        <input
          className={modalFieldClass}
          value={name}
          onChange={event => setName(event.target.value)}
          data-testid='create-channel-name'
        />
      </div>
      <div>
        <label className={modalLabelClass}>{t('channels.typeLabel')}</label>
        <select
          className={modalFieldClass}
          value={type}
          onChange={event =>
            setType(event.target.value as 'public' | 'private')
          }
          data-testid='create-channel-type'
        >
          <option value='public'>{t('channels.typePublic')}</option>
          <option value='private'>{t('channels.typePrivate')}</option>
        </select>
      </div>
      <div>
        <label className={modalLabelClass}>
          {t('channels.descriptionLabel')}
        </label>
        <textarea
          className={modalFieldClass}
          rows={2}
          value={description}
          onChange={event => setDescription(event.target.value)}
        />
      </div>
    </ModalShell>
  );
};

const OpenDmModal: React.FC<{
  onClose: () => void;
  onOpened: (channel: { id: string }) => void;
}> = ({ onClose, onOpened }) => {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [opening, setOpening] = useState(false);
  const open = () => {
    if (!username.trim()) return;
    setOpening(true);
    channelsApi
      .openDm(username.trim())
      .then(response => {
        if (response.success && response.data) {
          onOpened(response.data);
        } else {
          toast.error(response.error || t('channels.dmFailed'));
        }
      })
      .catch(() => toast.error(t('channels.dmFailed')))
      .finally(() => setOpening(false));
  };
  return (
    <ModalShell
      titleId='open-dm-title'
      title={t('channels.newDm')}
      subtitle={t('channels.dmHint')}
      onClose={onClose}
      testId='open-dm-modal'
      footer={
        <Button
          size='sm'
          disabled={opening || !username.trim()}
          onClick={open}
          data-testid='open-dm-submit'
        >
          {t('channels.openDm')}
        </Button>
      }
    >
      <input
        className={modalFieldClass}
        value={username}
        onChange={event => setUsername(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') open();
        }}
        placeholder={t('channels.dmPlaceholder')}
        data-testid='open-dm-username'
      />
    </ModalShell>
  );
};

const BrowseChannelsModal: React.FC<{
  channels: ChannelSummary[] | null;
  onClose: () => void;
  onJoined: (channelId: string) => void;
}> = ({ channels, onClose, onJoined }) => {
  const { t } = useTranslation();
  return (
    <ModalShell
      titleId='browse-channels-title'
      title={t('channels.browsePublic')}
      onClose={onClose}
      testId='browse-channels-modal'
    >
      {channels === null ? (
        <Loader2 className='mx-auto h-4 w-4 animate-spin text-gray-400' />
      ) : channels.length === 0 ? (
        <p className='text-center text-xs text-gray-400 dark:text-dark-500'>
          {t('channels.noPublic')}
        </p>
      ) : (
        channels.map(channel => (
          <div
            key={channel.id}
            className='flex items-center gap-2 rounded-lg border border-black/[0.06] px-3 py-2 dark:border-white/[0.08]'
            data-testid='browse-channel-item'
          >
            <Hash className='h-3.5 w-3.5 shrink-0 text-gray-400' />
            <span className='min-w-0 flex-1 truncate text-[13px] text-gray-800 dark:text-dark-800'>
              {channel.name}
            </span>
            {channel.isMember ? (
              <span className='text-[11px] text-gray-400'>
                {t('channels.joined')}
              </span>
            ) : (
              <Button
                size='sm'
                onClick={() =>
                  void channelsApi
                    .join(channel.id)
                    .then(() => onJoined(channel.id))
                }
                data-testid='browse-channel-join'
              >
                {t('channels.join')}
              </Button>
            )}
          </div>
        ))
      )}
    </ModalShell>
  );
};

const ChannelSettingsModal: React.FC<{
  channel: ChannelSummary;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}> = ({ channel, onClose, onChanged, onDeleted }) => {
  const { t } = useTranslation();
  const [name, setName] = useState(channel.name);
  const [description, setDescription] = useState(channel.description ?? '');
  const [saving, setSaving] = useState(false);
  return (
    <ModalShell
      titleId='channel-settings-title'
      title={t('channels.settings')}
      onClose={onClose}
      testId='channel-settings-modal'
      footer={
        <div className='flex w-full items-center justify-between'>
          <Button
            size='sm'
            variant='ghost'
            className='text-red-500'
            onClick={() =>
              void channelsApi.delete(channel.id).then(response => {
                if (response.success) onDeleted();
              })
            }
            data-testid='channel-delete'
          >
            {t('channels.delete')}
          </Button>
          <Button
            size='sm'
            disabled={saving || !name.trim()}
            onClick={() => {
              setSaving(true);
              channelsApi
                .update(channel.id, {
                  name: name.trim(),
                  description: description.trim(),
                })
                .then(response => {
                  if (response.success) onChanged();
                })
                .finally(() => setSaving(false));
            }}
            data-testid='channel-settings-save'
          >
            {t('channels.save')}
          </Button>
        </div>
      }
    >
      <div>
        <label className={modalLabelClass}>{t('channels.nameLabel')}</label>
        <input
          className={modalFieldClass}
          value={name}
          onChange={event => setName(event.target.value)}
        />
      </div>
      <div>
        <label className={modalLabelClass}>
          {t('channels.descriptionLabel')}
        </label>
        <textarea
          className={modalFieldClass}
          rows={2}
          value={description}
          onChange={event => setDescription(event.target.value)}
        />
      </div>
    </ModalShell>
  );
};

export default ChannelsPage;
