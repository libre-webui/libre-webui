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
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  ChatMessage as ChatMessageType,
  ChatToolCall as ChatToolCallType,
} from '@/types';
import { ChatToolCallList } from '@/components/ChatToolCalls';
import { MessageContent } from '@/components/ui';
import { GenerationStats } from '@/components/GenerationStats';
import { ArtifactContainer } from '@/components/ArtifactContainer';
import { TTSButton } from '@/components/TTSButton';
import { formatTimestamp, cn, parseThinkingContent } from '@/utils';
import {
  formatThinkingDuration,
  peekThinkingDuration,
} from '@/utils/thinkingTimer';
import { parseArtifacts } from '@/utils/artifactParser';
import { chatApi, findTTSModel, resolveTTSModel, ttsApi } from '@/utils/api';
import toast from 'react-hot-toast';
import {
  Settings,
  Edit3,
  Save,
  X,
  ChevronDown,
  ChevronUp,
  Brain,
  History,
  RefreshCw,
  GitFork,
  Undo2,
  Copy,
  Check,
  ThumbsUp,
  ThumbsDown,
  User as UserIcon,
} from 'lucide-react';
import {
  COMPACTION_SUMMARY_PREFIX,
  isCompactionSummaryContent,
} from '@/utils/contextUsage';
import { LogoMark } from '@/components/LogoMark';
import { useAppStore } from '@/store/appStore';
import { useAuthStore } from '@/store/authStore';
import { useChatStore } from '@/store/chatStore';
import { createLogger } from '@/utils/logger';
import { evaluationsApi } from '@/utils/api/evaluationsApi';
import { triggerHapticFeedback } from '@/utils/haptics';
import {
  activateTTSPlaybackSession,
  batchTextForTTS,
  createTTSPlaybackSession,
  isTTSPlaybackAbort,
  isTTSPlaybackBlocked,
  type TTSPlaybackSession,
  type TTSPlaybackState,
  type TTSAudioUnlockState,
  unlockTTSAudioPlayback,
} from '@/utils/ttsBatching';

const FEEDBACK_TAGS = [
  'accuracy',
  'style',
  'incomplete',
  'harmful',
  'formatting',
] as const;

const logger = createLogger('components:chat-message');

interface ChatMessageProps {
  message: ChatMessageType;
  isStreaming?: boolean;
  className?: string;
  isLastAssistantMessage?: boolean;
  onRegenerate?: () => void;
  onEditResend?: (messageId: string, content: string) => void;
  onFork?: (messageId: string) => void;
}

interface ChatAvatarProps {
  role: 'assistant' | 'user';
  user?: { username?: string; avatar?: string | null } | null;
  personaAvatar?: string | null;
  modelAvatar?: string | null;
}

/** Message avatars matching the Work conversation: the Libre mark for the
 * assistant (or the persona's avatar) and the account avatar for the user. */
function ChatAvatar({
  role,
  user,
  personaAvatar,
  modelAvatar,
}: ChatAvatarProps) {
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);

  if (role === 'assistant') {
    // A persona's own picture wins; otherwise the administrator's picture for
    // the model that answered.
    const persona = (personaAvatar?.trim() || modelAvatar?.trim()) ?? '';
    const personaImage =
      persona.startsWith('data:') && persona !== failedAvatar ? persona : '';
    return (
      <div
        role='img'
        aria-label='Libre WebUI'
        data-testid='chat-assistant-avatar'
        className='mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-black/[0.07] bg-white text-gray-900 shadow-sm dark:border-white/[0.09] dark:bg-dark-200 dark:text-dark-950'
      >
        {personaImage ? (
          <img
            src={personaImage}
            alt=''
            className='h-full w-full object-cover'
            onError={() => setFailedAvatar(persona)}
          />
        ) : persona ? (
          <span aria-hidden='true' className='text-base leading-none'>
            {persona}
          </span>
        ) : (
          <LogoMark label={null} className='h-4 w-4' />
        )}
      </div>
    );
  }

  const label = user?.username || 'User';
  const avatar = user?.avatar?.trim() || '';
  const hasAvatar = Boolean(avatar) && avatar !== failedAvatar;

  return (
    <div
      role={hasAvatar ? undefined : 'img'}
      aria-label={hasAvatar ? undefined : label}
      data-testid='chat-user-avatar'
      className={cn(
        'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full',
        hasAvatar
          ? 'border border-black/[0.07] bg-white dark:border-white/[0.09] dark:bg-dark-200'
          : 'bg-gray-950 text-white dark:bg-white dark:text-gray-950'
      )}
      title={label}
    >
      {hasAvatar ? (
        <img
          src={avatar}
          alt={label}
          className='h-full w-full object-cover'
          onError={() => setFailedAvatar(avatar)}
        />
      ) : user?.username ? (
        <span
          aria-hidden='true'
          className='text-xs font-medium uppercase leading-none'
        >
          {user.username.charAt(0)}
        </span>
      ) : (
        <UserIcon aria-hidden='true' className='h-4 w-4' />
      )}
    </div>
  );
}

export const ChatMessage: React.FC<ChatMessageProps> = ({
  message,
  isStreaming = false,
  className,
  isLastAssistantMessage = false,
  onRegenerate,
  onFork,
  onEditResend,
}) => {
  const { t, i18n } = useTranslation();
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  // A compaction summary is written by the app, not the user: it reads as
  // "what the model remembers" and is never editable — the edit path writes
  // to the user's system prompt, which this is not.
  const isCompactionSummary =
    isSystem && isCompactionSummaryContent(message.content);
  const systemDisplayContent = isCompactionSummary
    ? message.content.slice(COMPACTION_SUMMARY_PREFIX.length)
    : message.content;
  const { preferences } = useAppStore();
  const { user } = useAuthStore();
  const {
    setSystemMessage,
    getCurrentPersona,
    currentSession,
    rateMessage,
    modelMetadata,
  } = useChatStore();
  const currentPersona = getCurrentPersona();
  // What an administrator named this model and gave it for a picture. A
  // plugin model is keyed by `${pluginId}/${model}`, so fall back to matching
  // on the bare model name the message recorded.
  // A message only carries its model once it has been persisted, so a reply
  // still streaming falls back to the model the session is using.
  const answeringModel = message.model || currentSession?.model || '';
  const modelPresentation = answeringModel
    ? (modelMetadata[answeringModel] ??
      Object.entries(modelMetadata).find(
        ([key]) => key.slice(key.indexOf('/') + 1) === answeringModel
      )?.[1])
    : undefined;
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState(message.content);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSystemMessageExpanded, setIsSystemMessageExpanded] = useState(false);
  const [isThinkingExpanded, setIsThinkingExpanded] = useState(false);
  const [autoPlayState, setAutoPlayState] = useState<TTSPlaybackState>('idle');
  const [feedbackDetailsFor, setFeedbackDetailsFor] = useState<1 | -1 | null>(
    null
  );
  const [feedbackTags, setFeedbackTags] = useState<string[]>([]);
  const [feedbackComment, setFeedbackComment] = useState('');
  const [isCopied, setIsCopied] = useState(false);
  const autoPlaySessionRef = useRef<TTSPlaybackSession | null>(null);
  const autoPlayRunRef = useRef(0);
  const wasStreamingRef = useRef(isStreaming);
  const hasAutoPlayedRef = useRef(false);

  const handleCopyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      triggerHapticFeedback('success');
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      logger.error('Failed to copy message:', err);
    }
  };

  // Derive thinking content, parsed content, and artifacts from message content
  const { thinkingContent, thinkingStreaming, parsedContent, artifacts } =
    useMemo(() => {
      if (isUser || isSystem || (!message.content && !message.thinking)) {
        return {
          thinkingContent: null as string | null,
          thinkingStreaming: false,
          parsedContent: message.content,
          artifacts: message.artifacts || [],
        };
      }

      const thinkingParsed = message.thinking
        ? {
            thinking: message.thinking,
            content: message.content,
            thinkingComplete: Boolean(message.content) || !isStreaming,
          }
        : parseThinkingContent(message.content);
      const contentAfterThinking = thinkingParsed.content;
      const thinkingStreaming = isStreaming && !thinkingParsed.thinkingComplete;

      if (message.artifacts && message.artifacts.length > 0) {
        return {
          thinkingContent: thinkingParsed.thinking,
          thinkingStreaming,
          parsedContent: contentAfterThinking,
          artifacts: message.artifacts,
        };
      }

      if (!isStreaming) {
        const parsed = parseArtifacts(contentAfterThinking);
        return {
          thinkingContent: thinkingParsed.thinking,
          thinkingStreaming,
          parsedContent: parsed.content,
          artifacts: parsed.artifacts,
        };
      }

      return {
        thinkingContent: thinkingParsed.thinking,
        thinkingStreaming,
        parsedContent: contentAfterThinking,
        artifacts: [],
      };
    }, [
      message.content,
      message.thinking,
      message.artifacts,
      isUser,
      isSystem,
      isStreaming,
    ]);

  // Backend statistics carry the persisted duration; the live timer covers
  // the window between the thought closing and the stream completing.
  const thinkingDurationMs = thinkingStreaming
    ? undefined
    : (message.statistics?.thinking_duration_ms ??
      peekThinkingDuration(message.id));

  const startAutoPlayback = useCallback(
    async (audioUnlock?: Promise<TTSAudioUnlockState>) => {
      const runId = autoPlayRunRef.current + 1;
      autoPlayRunRef.current = runId;
      autoPlaySessionRef.current?.cancel();
      autoPlaySessionRef.current = null;
      setAutoPlayState('loading');

      try {
        if (audioUnlock) {
          const audioUnlockState = await audioUnlock;
          if (autoPlayRunRef.current !== runId) return;
          if (audioUnlockState === 'blocked') {
            setAutoPlayState('blocked');
            return;
          }
        }

        const modelsResponse = await ttsApi.getModels();
        if (autoPlayRunRef.current !== runId) return;
        const availableModels =
          modelsResponse.success && modelsResponse.data
            ? modelsResponse.data
            : [];
        const savedSettings = preferences.ttsSettings;
        const selectedModel = resolveTTSModel(
          availableModels,
          savedSettings?.model,
          savedSettings?.pluginId
        );
        const savedSelection = findTTSModel(
          availableModels,
          savedSettings?.model,
          savedSettings?.pluginId
        );

        const model = selectedModel?.model || savedSettings?.model || 'tts-1';
        const pluginId = selectedModel?.plugin || savedSettings?.pluginId;
        const voice = savedSelection
          ? savedSettings?.voice || selectedModel?.config?.default_voice
          : selectedModel?.config?.default_voice;
        const voiceProfileId = savedSelection
          ? savedSettings?.voiceProfileId || undefined
          : undefined;
        const providerMaxChars = Math.max(
          1,
          selectedModel?.config?.max_characters || 600
        );
        const maxChars = Math.min(providerMaxChars, 600);
        const shouldBatch =
          savedSettings?.streamSentences !== false ||
          parsedContent.length > maxChars;
        const batches = shouldBatch
          ? batchTextForTTS(parsedContent, {
              locale: i18n.language,
              maxChars,
              targetChars: Math.min(maxChars, 420),
              minChars: Math.min(maxChars, 80),
            })
          : [parsedContent.trim()];
        if (batches.length === 0) {
          setAutoPlayState('idle');
          return;
        }

        const session = createTTSPlaybackSession({
          concurrency: 3,
          initialBufferSize: Math.min(2, batches.length),
          generate: (input, { signal }) =>
            ttsApi.generate(
              {
                model,
                pluginId,
                input,
                voice: voiceProfileId ? undefined : voice || undefined,
                voiceProfileId,
                speed: savedSettings?.speed || 1.0,
                response_format: selectedModel?.config?.default_format,
              },
              { signal }
            ),
          onStateChange: state => {
            if (autoPlayRunRef.current === runId) setAutoPlayState(state);
          },
        });
        if (autoPlayRunRef.current !== runId) {
          session.cancel();
          return;
        }
        autoPlaySessionRef.current = session;
        const releaseExclusivePlayback = activateTTSPlaybackSession(session);
        try {
          await session.play(batches);
        } finally {
          releaseExclusivePlayback();
          if (autoPlaySessionRef.current === session) {
            autoPlaySessionRef.current = null;
          }
          if (
            autoPlayRunRef.current === runId &&
            (session.state === 'ended' || session.state === 'cancelled')
          ) {
            setAutoPlayState('idle');
          }
        }
      } catch (error) {
        if (autoPlayRunRef.current !== runId) return;
        if (isTTSPlaybackAbort(error)) {
          setAutoPlayState('idle');
        } else if (isTTSPlaybackBlocked(error)) {
          setAutoPlayState('blocked');
        } else {
          logger.error('Auto-play TTS failed:', error);
          setAutoPlayState('error');
        }
      }
    },
    [i18n.language, parsedContent, preferences.ttsSettings]
  );

  // Auto-play exactly once when the live assistant stream completes.
  useEffect(() => {
    const streamingJustCompleted = wasStreamingRef.current && !isStreaming;
    wasStreamingRef.current = isStreaming;

    if (
      streamingJustCompleted &&
      !hasAutoPlayedRef.current &&
      !isUser &&
      !isSystem &&
      parsedContent &&
      preferences.ttsSettings?.enabled &&
      preferences.ttsSettings.autoPlay
    ) {
      hasAutoPlayedRef.current = true;
      void startAutoPlayback();
    }
  }, [
    isStreaming,
    isUser,
    isSystem,
    parsedContent,
    preferences.ttsSettings?.autoPlay,
    preferences.ttsSettings?.enabled,
    startAutoPlayback,
  ]);

  // A session survives ordinary rerenders, but never outlives its message.
  useEffect(
    () => () => {
      autoPlayRunRef.current += 1;
      autoPlaySessionRef.current?.cancel();
      autoPlaySessionRef.current = null;
    },
    []
  );

  const retryAutoPlayback = () => {
    // Keep the resume call in this click stack, before starting async work.
    const audioUnlock = unlockTTSAudioPlayback();
    void startAutoPlayback(audioUnlock);
  };

  const stopAutoPlayback = () => {
    autoPlayRunRef.current += 1;
    autoPlaySessionRef.current?.cancel();
    autoPlaySessionRef.current = null;
    setAutoPlayState('idle');
  };

  // Determine display name for messages
  const getDisplayName = () => {
    if (isCompactionSummary) return t('chatMessage.conversationSummary');
    if (isSystem) return t('chatMessage.system');
    if (isUser) {
      if (preferences.showUsername && user?.username) {
        return user.username;
      }
      return t('chatMessage.you');
    }
    // For assistant messages, use persona name if available, otherwise model name
    if (currentPersona?.name) {
      return currentPersona.name;
    }
    return (
      modelPresentation?.label || answeringModel || t('chatMessage.assistant')
    );
  };

  const handleEditSystemMessage = () => {
    setIsEditing(true);
    setEditedContent(message.content);
  };

  const [restoringCompaction, setRestoringCompaction] = useState(false);
  const handleRestoreCompacted = async () => {
    if (!currentSession || restoringCompaction) return;
    setRestoringCompaction(true);
    try {
      const response = await chatApi.restoreCompaction(
        currentSession.id,
        message.id
      );
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Restore failed');
      }
      const updated = response.data;
      useChatStore.setState(state => ({
        sessions: state.sessions.map(session =>
          session.id === updated.id ? updated : session
        ),
        currentSession:
          state.currentSession?.id === updated.id
            ? updated
            : state.currentSession,
      }));
    } catch (error) {
      logger.error('Failed to restore compacted messages:', error);
      toast.error(t('chatMessage.restoreFailed'));
    } finally {
      setRestoringCompaction(false);
    }
  };

  const handleSaveSystemMessage = async () => {
    setIsSaving(true);
    try {
      setSystemMessage(editedContent);
      setIsEditing(false);
      logger.debug('✅ System message updated:', editedContent);
    } catch (error) {
      logger.error('Failed to save system message:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditedContent(message.content);
  };

  const handleSaveUserEdit = () => {
    const trimmed = editedContent.trim();
    setIsEditing(false);
    if (!trimmed) return;
    // Unchanged content still resends — the button promises a submit either
    // way, and silently doing nothing reads as a broken edit.
    onEditResend?.(message.id, trimmed);
  };

  const handleRate = (value: number) => {
    if (!currentSession) return;
    const cleared = message.rating === value;
    rateMessage(currentSession.id, message.id, cleared ? undefined : value);
    // Private sessions never persist feedback datasets.
    if (currentSession.isPrivate) return;
    if (cleared) {
      setFeedbackDetailsFor(null);
      void evaluationsApi.deleteFeedback(message.id).catch(() => undefined);
      return;
    }
    setFeedbackTags([]);
    setFeedbackComment('');
    setFeedbackDetailsFor(value === 1 ? 1 : -1);
    void evaluationsApi
      .upsertFeedback({
        sessionId: currentSession.id,
        messageId: message.id,
        rating: value === 1 ? 1 : -1,
      })
      .catch(() => undefined);
  };

  const submitFeedbackDetails = () => {
    if (!currentSession || feedbackDetailsFor === null) return;
    void evaluationsApi
      .upsertFeedback({
        sessionId: currentSession.id,
        messageId: message.id,
        rating: feedbackDetailsFor,
        tags: feedbackTags,
        ...(feedbackComment.trim() ? { comment: feedbackComment.trim() } : {}),
      })
      .catch(() => undefined);
    setFeedbackDetailsFor(null);
  };

  // Helper function to truncate system message for display
  const truncateSystemMessage = (content: string, maxLength: number = 100) => {
    if (content.length <= maxLength) return content;
    return content.substring(0, maxLength) + '...';
  };

  // Determine if system message should show expand/collapse button
  const shouldShowExpandButton = isSystem && systemDisplayContent.length > 100;

  return (
    <div
      className={cn(
        'group flex py-1.5 transition-colors sm:py-2',
        isUser ? 'justify-end' : 'justify-start',
        className
      )}
    >
      <div
        className={cn(
          'flex min-w-0 gap-2.5 sm:gap-3',
          isUser ? 'max-w-[85%] sm:max-w-[70%]' : 'w-full'
        )}
      >
        {!isUser && !isSystem && (
          <ChatAvatar
            role='assistant'
            personaAvatar={currentPersona?.avatar}
            modelAvatar={modelPresentation?.avatar}
          />
        )}
        {/* Content */}
        <div
          className={cn(
            'min-w-0 flex-1',
            isUser ? 'flex flex-col items-end' : isSystem ? 'py-1.5' : 'py-0.5'
          )}
        >
          {/* Header - assistant messages only; user meta lives in the action row */}
          {!isUser && !isSystem && (
            <div className='mb-1 flex items-center gap-2'>
              <span
                dir='auto'
                className='text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-700 rtl:tracking-normal dark:text-dark-700'
              >
                {getDisplayName()}
              </span>
              {message.model && currentPersona?.name && (
                <span
                  dir='ltr'
                  className='max-w-32 truncate rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500 dark:bg-dark-200 dark:text-dark-600 sm:max-w-48'
                  title={message.model}
                >
                  {message.model}
                </span>
              )}
              <span
                dir='auto'
                className='text-[10px] tabular-nums text-gray-400 dark:text-dark-500'
              >
                {formatTimestamp(message.timestamp, i18n.language)}
              </span>
            </div>
          )}

          <div
            className={cn(
              !isUser &&
                !isSystem &&
                'text-[0.9375rem] leading-[1.65] text-gray-800 dark:text-dark-800'
            )}
          >
            {/* Display images if present (for user messages) */}
            {message.images && message.images.length > 0 && (
              <div className='mb-1.5 grid max-w-lg grid-cols-2 gap-1.5 sm:grid-cols-3'>
                {message.images.map((image, index) => (
                  <div
                    key={index}
                    className='aspect-square overflow-hidden rounded-xl border border-black/[0.06] bg-gray-100 dark:border-white/[0.08] dark:bg-gray-800'
                  >
                    <img
                      src={image}
                      alt={`Uploaded image ${index + 1}`}
                      className='w-full h-full object-cover cursor-pointer hover:opacity-90 transition-opacity'
                      onClick={() => setLightboxImage(image)}
                    />
                  </div>
                ))}
              </div>
            )}

            {isUser ? (
              isEditing ? (
                <div className='w-full min-w-[min(28rem,80vw)] rounded-2xl border border-black/[0.08] bg-white p-2 shadow-sm dark:border-white/[0.08] dark:bg-dark-100'>
                  <textarea
                    dir='auto'
                    value={editedContent}
                    onChange={e => setEditedContent(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSaveUserEdit();
                      } else if (e.key === 'Escape') {
                        handleCancelEdit();
                      }
                    }}
                    autoFocus
                    className='min-h-[72px] w-full resize-y rounded-xl border-none bg-transparent p-2 text-[0.9375rem] leading-relaxed text-gray-900 focus:outline-none dark:text-dark-900'
                  />
                  <div className='flex items-center justify-end gap-1.5 px-1 pb-1'>
                    <button
                      onClick={handleCancelEdit}
                      className='rounded-lg px-2.5 py-1 text-xs text-gray-500 transition-colors hover:bg-gray-100 dark:text-dark-600 dark:hover:bg-dark-200'
                    >
                      {t('chatMessage.cancelEditing')}
                    </button>
                    <button
                      onClick={handleSaveUserEdit}
                      className='rounded-lg bg-gray-900 px-2.5 py-1 text-xs text-white transition-colors hover:bg-gray-700 dark:bg-dark-300 dark:hover:bg-dark-400'
                    >
                      {t('chatMessage.saveAndSubmit')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className='rounded-2xl rounded-ee-md border border-black/[0.06] bg-gray-900 px-3.5 py-2 text-white shadow-sm dark:border-white/[0.07] dark:bg-dark-300'>
                  <p
                    dir='auto'
                    className='whitespace-pre-wrap text-[0.9375rem] leading-relaxed'
                  >
                    {message.content}
                  </p>
                </div>
              )
            ) : isSystem ? (
              <div className='relative z-0 rounded-2xl border border-black/[0.06] bg-white/55 p-3 dark:border-white/[0.06] dark:bg-dark-200/45'>
                <div className='mb-2 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-500 dark:text-dark-500'>
                  <div className='flex items-center gap-1'>
                    {isCompactionSummary ? (
                      <History className='h-2.5 w-2.5 opacity-50' />
                    ) : (
                      <Settings className='h-2.5 w-2.5 opacity-50' />
                    )}
                    {isCompactionSummary
                      ? t('chatMessage.conversationSummary')
                      : t('chatMessage.system')}
                  </div>
                  <div className='flex items-center gap-1'>
                    {isCompactionSummary ? (
                      <button
                        onClick={() => void handleRestoreCompacted()}
                        disabled={restoringCompaction}
                        className='rounded-lg p-1.5 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-dark-300'
                        title={t('chatMessage.restoreCompacted')}
                      >
                        <Undo2 className='h-3 w-3 text-gray-600 dark:text-gray-400' />
                      </button>
                    ) : isEditing ? (
                      <>
                        <button
                          onClick={handleSaveSystemMessage}
                          disabled={isSaving}
                          className='rounded-lg p-1.5 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-dark-300'
                          title={t('chatMessage.saveChanges')}
                        >
                          <Save className='h-3 w-3 text-green-600 dark:text-green-400' />
                        </button>
                        <button
                          onClick={handleCancelEdit}
                          disabled={isSaving}
                          className='rounded-lg p-1.5 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-dark-300'
                          title={t('chatMessage.cancelEditing')}
                        >
                          <X className='h-3 w-3 text-red-600 dark:text-red-400' />
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={handleEditSystemMessage}
                        className='rounded-lg p-1.5 transition-colors hover:bg-gray-100 dark:hover:bg-dark-300'
                        title={t('chatMessage.editSystemMessage')}
                      >
                        <Edit3 className='h-3 w-3 text-gray-600 dark:text-gray-400' />
                      </button>
                    )}
                  </div>
                </div>
                {isEditing ? (
                  <textarea
                    dir='auto'
                    value={editedContent}
                    onChange={e => setEditedContent(e.target.value)}
                    className='min-h-[100px] w-full resize-none rounded-xl border border-black/[0.08] bg-white p-3 text-sm text-gray-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-white/[0.08] dark:bg-dark-100 dark:text-dark-900 dark:focus:ring-primary-400'
                    placeholder={t('chatMessage.systemMessagePlaceholder')}
                    disabled={isSaving}
                  />
                ) : (
                  <div>
                    <p
                      dir='auto'
                      className='whitespace-pre-wrap text-xs leading-relaxed text-gray-500 dark:text-dark-600'
                    >
                      {isSystemMessageExpanded
                        ? systemDisplayContent
                        : truncateSystemMessage(systemDisplayContent)}
                    </p>
                    {shouldShowExpandButton && (
                      <button
                        onClick={() =>
                          setIsSystemMessageExpanded(!isSystemMessageExpanded)
                        }
                        className='mt-2 flex items-center gap-1 text-xs text-gray-400 transition-colors hover:text-gray-900 dark:text-dark-500 dark:hover:text-dark-900'
                      >
                        {isSystemMessageExpanded ? (
                          <>
                            <ChevronUp className='h-3 w-3' />
                            {t('chatMessage.showLess')}
                          </>
                        ) : (
                          <>
                            <ChevronDown className='h-3 w-3' />
                            {t('chatMessage.showMore')}
                          </>
                        )}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className='relative'>
                {/* Collapsible Thinking/CoT Section */}
                {(thinkingContent || thinkingStreaming) && (
                  <div className='mb-3 border-s border-gray-200 ps-3 dark:border-dark-300'>
                    <button
                      onClick={() => setIsThinkingExpanded(!isThinkingExpanded)}
                      className='flex items-center gap-1.5 text-xs text-gray-500 transition-colors hover:text-gray-900 dark:text-dark-600 dark:hover:text-dark-900'
                    >
                      <Brain
                        className={cn(
                          'h-3.5 w-3.5',
                          thinkingStreaming &&
                            'animate-pulse-subtle motion-reduce:animate-none'
                        )}
                      />
                      {thinkingStreaming ? (
                        <span className='animate-shimmer bg-gradient-to-r from-gray-400 via-gray-900 to-gray-400 bg-[length:200%_100%] bg-clip-text font-medium text-transparent motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-gray-500 dark:from-dark-500 dark:via-dark-900 dark:to-dark-500 motion-reduce:dark:text-dark-600'>
                          {t('chatMessage.thinking')}…
                        </span>
                      ) : (
                        <span className='font-medium'>
                          {thinkingDurationMs !== undefined
                            ? t('chatMessage.thoughtFor', {
                                duration:
                                  formatThinkingDuration(thinkingDurationMs),
                              })
                            : t('chatMessage.thinking')}
                        </span>
                      )}
                      {isThinkingExpanded ? (
                        <ChevronUp className='h-3.5 w-3.5' />
                      ) : (
                        <ChevronDown className='h-3.5 w-3.5' />
                      )}
                    </button>
                    {isThinkingExpanded && thinkingContent && (
                      <div
                        dir='auto'
                        className='mt-2 rounded-xl bg-gray-100/60 p-2.5 text-[13px] leading-relaxed text-gray-600 dark:bg-dark-200/60 dark:text-dark-700'
                      >
                        {/* Full markdown so fenced code inside the chain of
                            thought gets the same treatment as message code. */}
                        <MessageContent
                          content={thinkingContent}
                          isStreaming={thinkingStreaming}
                          className='text-[13px] text-gray-600 dark:text-dark-700'
                        />
                      </div>
                    )}
                  </div>
                )}
                <MessageContent
                  content={parsedContent}
                  isStreaming={isStreaming}
                />
              </div>
            )}

            {/* Render artifacts for assistant messages */}
            {!isUser && !isSystem && artifacts.length > 0 && (
              <div className='mt-3'>
                <ArtifactContainer artifacts={artifacts} />
              </div>
            )}

            {/* Tool calls this turn executed through the native tool loop */}
            {!isUser &&
              !isSystem &&
              Array.isArray(message.providerMetadata?.toolCalls) &&
              (message.providerMetadata.toolCalls as ChatToolCallType[])
                .length > 0 && (
                <ChatToolCallList
                  calls={
                    message.providerMetadata.toolCalls as ChatToolCallType[]
                  }
                  className='mt-2.5'
                />
              )}

            {/* Web search sources the reply drew on */}
            {!isUser &&
              !isSystem &&
              Array.isArray(message.providerMetadata?.webSearchSources) &&
              (
                message.providerMetadata.webSearchSources as Array<{
                  title?: string;
                  url?: string;
                }>
              ).length > 0 && (
                <div className='mt-2.5 flex flex-wrap items-center gap-1.5'>
                  <span className='text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400 dark:text-dark-500 rtl:tracking-normal'>
                    {t('chat.message.sources', 'Sources')}
                  </span>
                  {(
                    message.providerMetadata.webSearchSources as Array<{
                      title?: string;
                      url?: string;
                    }>
                  ).map((source, index) =>
                    typeof source?.url === 'string' ? (
                      <a
                        key={`${source.url}-${index}`}
                        href={source.url}
                        target='_blank'
                        rel='noopener noreferrer'
                        dir='ltr'
                        className='inline-flex max-w-[220px] items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] text-gray-600 transition-colors hover:border-primary-300 hover:text-primary-600 dark:border-dark-300 dark:bg-dark-200 dark:text-dark-700 dark:hover:text-primary-400'
                        title={source.title || source.url}
                      >
                        <span className='tabular-nums'>{index + 1}</span>
                        <span className='truncate'>
                          {(() => {
                            try {
                              return new URL(source.url).hostname.replace(
                                /^www\./,
                                ''
                              );
                            } catch {
                              return source.url;
                            }
                          })()}
                        </span>
                      </a>
                    ) : null
                  )}
                </div>
              )}

            {/* Display generation statistics for assistant messages */}
            {!isUser && !isSystem && message.statistics && (
              <div className='mt-2'>
                <GenerationStats statistics={message.statistics} />
              </div>
            )}

            {/* Quiet action row - revealed on hover/focus on desktop */}
            {!isSystem && !isStreaming && (
              <div
                className={cn(
                  'flex items-center gap-0.5 text-gray-400 dark:text-dark-500',
                  'sm:transition-opacity sm:duration-150 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100',
                  !isUser &&
                    [
                      'loading',
                      'generating',
                      'buffering',
                      'blocked',
                      'playing',
                    ].includes(autoPlayState)
                    ? 'sm:opacity-100'
                    : 'sm:opacity-0',
                  isUser ? 'mt-1 justify-end' : 'mt-1'
                )}
              >
                {isUser && (
                  <span
                    dir='auto'
                    className='me-1 text-[10px] tabular-nums'
                    title={formatTimestamp(message.timestamp, i18n.language)}
                  >
                    {getDisplayName()} ·{' '}
                    {formatTimestamp(message.timestamp, i18n.language)}
                  </span>
                )}
                {!isUser && parsedContent && (
                  <TTSButton
                    text={parsedContent}
                    size='sm'
                    externalPlaybackState={autoPlayState}
                    onStopExternal={stopAutoPlayback}
                    onRetryExternal={retryAutoPlayback}
                    className={cn(
                      'transition-colors',
                      autoPlayState === 'playing' &&
                        'bg-primary-50 text-primary-600 dark:bg-primary-900/20 dark:text-primary-400'
                    )}
                  />
                )}
                {isUser && onEditResend && !isEditing && (
                  <button
                    onClick={() => {
                      setEditedContent(message.content);
                      setIsEditing(true);
                    }}
                    className='flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-dark-200 dark:hover:text-dark-800'
                    title={t('chatMessage.edit')}
                  >
                    <Edit3 className='h-3.5 w-3.5' />
                  </button>
                )}
                <button
                  onClick={handleCopyMessage}
                  className='flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-dark-200 dark:hover:text-dark-800'
                  title={
                    isCopied
                      ? t('chatMessage.copied')
                      : t('chatMessage.copyMessage')
                  }
                >
                  {isCopied ? (
                    <Check className='h-3.5 w-3.5 text-green-500' />
                  ) : (
                    <Copy className='h-3.5 w-3.5' />
                  )}
                </button>
                {!isUser && (
                  <>
                    <button
                      onClick={() => handleRate(1)}
                      className={cn(
                        'flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-dark-200 dark:hover:text-dark-800',
                        message.rating === 1 &&
                          'text-primary-600 dark:text-primary-400'
                      )}
                      title={t('chatMessage.goodResponse')}
                      aria-pressed={message.rating === 1}
                    >
                      <ThumbsUp
                        className='h-3.5 w-3.5'
                        fill={message.rating === 1 ? 'currentColor' : 'none'}
                      />
                    </button>
                    <button
                      onClick={() => handleRate(-1)}
                      className={cn(
                        'flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-dark-200 dark:hover:text-dark-800',
                        message.rating === -1 &&
                          'text-red-500 dark:text-red-400'
                      )}
                      title={t('chatMessage.badResponse')}
                      aria-pressed={message.rating === -1}
                    >
                      <ThumbsDown
                        className='h-3.5 w-3.5'
                        fill={message.rating === -1 ? 'currentColor' : 'none'}
                      />
                    </button>
                    {feedbackDetailsFor !== null && (
                      <div
                        className='ml-1 flex flex-wrap items-center gap-1 rounded-lg border border-gray-200 bg-white px-2 py-1 dark:border-dark-300 dark:bg-dark-100'
                        data-testid='feedback-details'
                      >
                        {FEEDBACK_TAGS.map(tag => (
                          <button
                            key={tag}
                            type='button'
                            onClick={() =>
                              setFeedbackTags(current =>
                                current.includes(tag)
                                  ? current.filter(item => item !== tag)
                                  : [...current, tag]
                              )
                            }
                            className={cn(
                              'rounded-full border px-2 py-0.5 text-[10px]',
                              feedbackTags.includes(tag)
                                ? 'border-primary-500 bg-primary-50 text-primary-700 dark:bg-primary-950/40 dark:text-primary-300'
                                : 'border-gray-300 text-gray-500 dark:border-dark-300'
                            )}
                            aria-pressed={feedbackTags.includes(tag)}
                          >
                            {t(`chatMessage.feedbackTags.${tag}`)}
                          </button>
                        ))}
                        <input
                          value={feedbackComment}
                          onChange={event =>
                            setFeedbackComment(event.target.value)
                          }
                          placeholder={t('chatMessage.feedbackComment')}
                          className='w-32 rounded border border-gray-300 px-1.5 py-0.5 text-[10px] dark:border-dark-300 dark:bg-dark-50'
                          maxLength={2000}
                        />
                        <button
                          type='button'
                          onClick={submitFeedbackDetails}
                          className='rounded bg-gray-900 px-2 py-0.5 text-[10px] text-white dark:bg-white dark:text-gray-900'
                        >
                          {t('common.save')}
                        </button>
                        <button
                          type='button'
                          onClick={() => setFeedbackDetailsFor(null)}
                          aria-label={t('common.close')}
                          className='rounded p-0.5 text-gray-400 hover:text-gray-600'
                        >
                          <X className='h-3 w-3' />
                        </button>
                      </div>
                    )}
                  </>
                )}
                {!isUser && isLastAssistantMessage && onRegenerate && (
                  <button
                    onClick={onRegenerate}
                    className='flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-dark-200 dark:hover:text-dark-800'
                    title={t('chatMessage.regenerateResponse')}
                  >
                    <RefreshCw className='h-3.5 w-3.5' />
                  </button>
                )}
                {onFork && (
                  <button
                    onClick={() => onFork(message.id)}
                    className='flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-dark-200 dark:hover:text-dark-800'
                    title={t('chat.fork.action')}
                    data-testid='fork-from-message'
                  >
                    <GitFork className='h-3.5 w-3.5' />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        {isUser && <ChatAvatar role='user' user={user ?? null} />}
      </div>

      {/* Image Lightbox Modal - rendered via portal to escape stacking context */}
      {lightboxImage &&
        createPortal(
          <div
            role='dialog'
            aria-modal='true'
            aria-label={t('chatMessage.fullSizeImage')}
            className='fixed inset-0 z-[9999] flex items-center justify-center bg-black/85 p-6 backdrop-blur-md'
            onClick={() => setLightboxImage(null)}
          >
            <button
              className='absolute end-6 top-6 rounded-full border border-white/15 bg-white/10 p-3 text-white transition-colors hover:bg-white/20'
              onClick={e => {
                e.stopPropagation();
                setLightboxImage(null);
              }}
            >
              <X className='h-7 w-7' />
            </button>
            <img
              src={lightboxImage}
              alt={t('chatMessage.fullSizeImage')}
              className='max-h-[90vh] max-w-[90vw] rounded-2xl object-contain shadow-2xl'
              onClick={e => e.stopPropagation()}
            />
          </div>,
          document.body
        )}
    </div>
  );
};
