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
  useRef,
  useEffect,
  useMemo,
  useCallback,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowUp,
  Square,
  Paperclip,
  Plus,
  Minus,
  ImageIcon,
  FileText,
  Globe,
  Braces,
  Loader2,
  Mic,
  AudioLines,
  BookOpen,
  Check,
} from 'lucide-react';
import { Button } from '@/components/ui';
import { unlockTTSAudioPlayback } from '@/utils/ttsBatching';
import { CodeAwareTextarea } from './CodeAwareTextarea';
import { MediaUpload } from './MediaUpload';
import { DocumentIndicator } from './DocumentIndicator';
import { StructuredOutput } from './StructuredOutput';
import { ModelSelector } from './ModelSelector';
import { ThinkingSelector } from './ThinkingSelector';
import { ContextMeter } from './ContextMeter';
import { useAppStore } from '@/store/appStore';
import { useChatStore } from '@/store/chatStore';
import PromptQueueList from '@/components/composer/PromptQueueList';
import ComposerCompareMenu from '@/components/composer/ComposerCompareMenu';
import {
  compareTargetsFromKeys,
  type CompareTarget,
} from '@/components/composer/compareTargets';
import { chatModelSelectionKey } from '@/utils/chatModelSelection';
import { X } from 'lucide-react';
import { applyPromptQueueToChatStore } from '@/utils/promptQueue';
import { UPLOAD_ACCEPT_ATTRIBUTE } from '@/utils/documentUploadTypes';
import {
  personaApi,
  chatApi,
  imageGenApi,
  documentsApi,
  ollamaApi,
  searchApi,
} from '@/utils/api';
import { useDictation } from '@/hooks/useDictation';
import {
  ComposerSuggestions,
  type ComposerSuggestionsHandle,
} from './composer/ComposerSuggestions';
import { ComposerToolsMenu } from './composer/ComposerToolsMenu';
import {
  DEFAULT_COMPOSER_TOOLS,
  composerToolsRequest,
  type ComposerToolsValue,
} from './composer/composerTools';
import { toast } from 'react-hot-toast';
import { cn } from '@/utils';
import { buildContextUsage, resolveContextBudget } from '@/utils/contextUsage';
import {
  Persona,
  KnowledgeCollection,
  ChatSession,
  GenerationOptions,
  ThinkingPreference,
} from '@/types';
import { createLogger } from '@/utils/logger';
import {
  chatModelOptionKey,
  isChatModelSelectionAvailable,
  chatModelSelectionFromKey,
  chatModelSelectionKeyForModels,
  withUnavailableChatModel,
} from '@/utils/chatModelSelection';

const logger = createLogger('components:chat-input');

// Below this measured composer width, secondary controls fold into the
// attach menu so the icon row never clips.
const COMPACT_COMPOSER_WIDTH = 560;

interface ChatInputProps {
  onSendMessage: (
    message: string,
    images?: string[],
    format?: string | Record<string, unknown>,
    webSearch?: boolean,
    tools?: boolean,
    toolSelection?: { builtinTools?: string[]; serverIds?: string[] },
    compareTargets?: CompareTarget[]
  ) => void;
  onStopGeneration: () => void;
  onCancelComparison?: (assistantMessageId: string) => void;
  onOpenVoiceMode?: () => void;
  disabled?: boolean;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  onSendMessage,
  onStopGeneration,
  onCancelComparison,
  onOpenVoiceMode,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const [message, setMessage] = useState('');
  const dictationBaseRef = useRef('');

  const [images, setImages] = useState<string[]>([]);
  const [format, setFormat] = useState<string | Record<string, unknown> | null>(
    null
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  // Web search runs server-side through the admin-configured engine; the
  // toggle appears only when an administrator has enabled it.
  const [webSearchAvailable, setWebSearchAvailable] = useState(false);
  const [webSearchActive, setWebSearchActive] = useState(false);
  const [compareKeys, setCompareKeys] = useState<string[]>([]);
  const pendingComparisons = useChatStore(state => state.pendingComparisons);
  // Native tool calls: the picker manages catalog availability itself.
  // Private sessions never offer tools.
  const [composerTools, setComposerTools] = useState<ComposerToolsValue>(
    DEFAULT_COMPOSER_TOOLS
  );
  const isPrivateSession = useChatStore(
    state => state.currentSession?.isPrivate === true
  );

  useEffect(() => {
    let cancelled = false;
    searchApi
      .getConfig()
      .then(response => {
        if (!cancelled && response.success && response.data) {
          setWebSearchAvailable(response.data.allowed);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const [webpageUrl, setWebpageUrl] = useState<string | null>(null);
  const [knowledgeMenuOpen, setKnowledgeMenuOpen] = useState(false);
  const [collections, setCollections] = useState<KnowledgeCollection[]>([]);
  const [attachingWebpage, setAttachingWebpage] = useState(false);
  const [uploadingDocument, setUploadingDocument] = useState(false);
  const [currentPersona, setCurrentPersona] = useState<Persona | null>(null);
  const [hasImageGenPlugins, setHasImageGenPlugins] = useState(false);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  // With the artifact panel splitting the screen, the composer can sit in a
  // narrow column while the viewport is wide, so viewport breakpoints say
  // nothing about the room it actually has. Measure the composer itself and
  // fold secondary controls into the attach menu when it gets tight.
  const composerRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const node = composerRef.current;
    if (!node) return undefined;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? node.clientWidth;
      setCompact(width < COMPACT_COMPOSER_WIDTH);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const { isGenerating, setBackgroundImage } = useAppStore();
  const globalGenerationOptions = useAppStore(
    state => state.preferences.generationOptions
  );
  const imageGenerationEnabled = useAppStore(
    state => state.preferences.imageGenSettings?.enabled === true
  );
  const showImageGeneration = imageGenerationEnabled && hasImageGenPlugins;
  const { currentSession, models } = useChatStore();
  const pinnedModelOptions = useAppStore(state =>
    currentSession?.model
      ? state.preferences.modelGenerationOptions?.[currentSession.model]
      : undefined
  );
  const currentSessionId = currentSession?.id;
  // Comparison model picks are per chat: reset during render when the
  // session changes (React's adjust-state-on-prop-change pattern).
  const [compareSessionId, setCompareSessionId] = useState(currentSessionId);
  if (compareSessionId !== currentSessionId) {
    setCompareSessionId(currentSessionId);
    setCompareKeys([]);
  }
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestionsRef = useRef<ComposerSuggestionsHandle>(null);
  const sessionSelection = useMemo(
    () => ({
      model: currentSession?.personaId
        ? `persona:${currentSession.personaId}`
        : currentSession?.model || '',
      providerType: currentSession?.providerType,
      providerId: currentSession?.providerId,
    }),
    [
      currentSession?.model,
      currentSession?.personaId,
      currentSession?.providerId,
      currentSession?.providerType,
    ]
  );
  const selectorModels = useMemo(
    () => withUnavailableChatModel(models, sessionSelection),
    [models, sessionSelection]
  );
  const sessionModelKey = sessionSelection.model
    ? chatModelSelectionKeyForModels(selectorModels, sessionSelection)
    : '';
  const sessionModelAvailable = isChatModelSelectionAvailable(
    models,
    sessionSelection
  );

  // Check if image generation plugins are available
  useEffect(() => {
    let cancelled = false;

    const checkImageGenPlugins = async () => {
      try {
        const response = await imageGenApi.getPlugins();
        if (cancelled) return;
        setHasImageGenPlugins(
          !!(response.success && response.data && response.data.length > 0)
        );
      } catch {
        if (cancelled) return;
        setHasImageGenPlugins(false);
      }
    };

    if (imageGenerationEnabled) {
      void checkImageGenPlugins();
    }

    return () => {
      cancelled = true;
    };
  }, [imageGenerationEnabled]);

  // Close the attach menu on outside clicks.
  useEffect(() => {
    if (!attachMenuOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (
        attachMenuRef.current &&
        !attachMenuRef.current.contains(event.target as Node)
      ) {
        setAttachMenuOpen(false);
        setWebpageUrl(null);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [attachMenuOpen]);

  const closeAttachMenu = () => {
    setAttachMenuOpen(false);
    setWebpageUrl(null);
    setKnowledgeMenuOpen(false);
  };

  // Load collections lazily when the knowledge submenu opens.
  useEffect(() => {
    if (!knowledgeMenuOpen) return;
    let cancelled = false;
    documentsApi
      .getCollections()
      .then(response => {
        if (!cancelled && response.success && response.data) {
          setCollections(response.data);
        }
      })
      .catch(() => {
        // The submenu simply stays empty on failure.
      });
    return () => {
      cancelled = true;
    };
  }, [knowledgeMenuOpen]);

  // Thinking is a property of the conversation, not of one message: it is kept
  // on the session so a reload, a regenerate, and the chat controls panel all
  // agree about it. What "default" resolves to — the pinned or global setting
  // — travels along so the button reflects what the next reply actually does.
  const activeThinking = currentSession?.settings?.generationOptions?.think;
  const inheritedThinking =
    pinnedModelOptions?.think ?? globalGenerationOptions?.think ?? null;

  const activeModelEntry = useMemo(
    () => models.find(model => model.name === currentSession?.model),
    [models, currentSession?.model]
  );
  // Asking a model that cannot reason to reason is an error from Ollama, so
  // the toggle only appears where thinking means something. Models reached
  // through a plugin answer for themselves; Ollama says what it supports, and
  // where it says nothing the toggle is offered rather than hidden. The answer
  // is stored with the model it was read for, so switching models never shows
  // the previous model's answer.
  const [modelDefaults, setModelDefaults] = useState<{
    model: string;
    supportsThinking?: boolean;
    options: Partial<GenerationOptions>;
    trainedContextLength?: number;
    contextCapped?: boolean;
  } | null>(null);

  useEffect(() => {
    const model = currentSession?.model;
    // Only a model resolved as a local Ollama model is worth asking Ollama
    // about: while the list is loading, and for agents, personas, and plugin
    // models, the lookup would 404 against a name Ollama has never heard of.
    if (
      !model ||
      models.length === 0 ||
      !activeModelEntry ||
      activeModelEntry.isPlugin ||
      activeModelEntry.isAgent
    ) {
      return;
    }

    let cancelled = false;
    void ollamaApi
      .getModelDefaults(model)
      .then(response => {
        if (cancelled || !response.success || !response.data) return;
        setModelDefaults({
          model,
          supportsThinking: response.data.supportsThinking,
          options: response.data.options ?? {},
          trainedContextLength: response.data.trainedContextLength,
          contextCapped: response.data.contextCapped,
        });
      })
      .catch(() => {
        // A model that cannot be inspected keeps the toggle available.
      });

    return () => {
      cancelled = true;
    };
  }, [activeModelEntry, currentSession?.model, models.length]);

  const activeModelDefaults =
    modelDefaults?.model === currentSession?.model ? modelDefaults : null;
  const ollamaThinkingSupported = activeModelDefaults?.supportsThinking;

  const thinkingAvailable = Boolean(
    currentSession &&
    !activeModelEntry?.isAgent &&
    (activeModelEntry?.isPlugin
      ? activeModelEntry.reasoningSupport !== false
      : ollamaThinkingSupported !== false)
  );

  // How full the model's context is. The window comes from the same settings
  // the request runs with, so the meter measures against what will actually
  // be sent rather than against a default nobody uses.
  const contextBudget = resolveContextBudget({
    model: activeModelEntry,
    sessionOptions: currentSession?.settings?.generationOptions,
    pinnedOptions: pinnedModelOptions,
    modelDefaults: activeModelDefaults?.options,
    globalOptions: globalGenerationOptions,
  });
  const contextWindowMessages = useChatStore(
    state => state.contextWindowMessages
  );
  const contextUsage = useMemo(
    () =>
      buildContextUsage({
        messages: currentSession?.messages ?? [],
        budget: contextBudget,
        systemPrompt: currentPersona?.parameters?.system_prompt,
        windowMessages: contextWindowMessages,
      }),
    [
      contextBudget,
      contextWindowMessages,
      currentPersona,
      currentSession?.messages,
    ]
  );

  const applyThinking = async (think: ThinkingPreference | null) => {
    if (!currentSession) return;

    const generationOptions = {
      ...(currentSession.settings?.generationOptions ?? {}),
    };
    // "Model default" is the absence of a setting, so it is removed rather
    // than stored.
    if (think === null) delete generationOptions.think;
    else generationOptions.think = think;

    const settings = {
      ...currentSession.settings,
      generationOptions,
    };

    useChatStore.setState(state => ({
      currentSession:
        state.currentSession?.id === currentSession.id
          ? { ...state.currentSession, settings }
          : state.currentSession,
      sessions: state.sessions.map(session =>
        session.id === currentSession.id ? { ...session, settings } : session
      ),
    }));

    if (currentSession.isPrivate) return;
    try {
      await chatApi.updateSession(currentSession.id, {
        settings,
      } as Partial<ChatSession>);
    } catch (error) {
      logger.error('Failed to update the thinking setting:', error);
    }
  };

  const attachedCollectionIds =
    currentSession?.settings?.knowledgeCollectionIds ?? [];

  const toggleCollection = async (collectionId: string) => {
    if (!currentSession) return;
    const next = attachedCollectionIds.includes(collectionId)
      ? attachedCollectionIds.filter(id => id !== collectionId)
      : [...attachedCollectionIds, collectionId];
    const settings = {
      ...currentSession.settings,
      knowledgeCollectionIds: next.length > 0 ? next : undefined,
    };

    // Optimistic local update; persisted below for non-private sessions.
    useChatStore.setState(state => ({
      currentSession:
        state.currentSession?.id === currentSession.id
          ? { ...state.currentSession, settings }
          : state.currentSession,
      sessions: state.sessions.map(session =>
        session.id === currentSession.id ? { ...session, settings } : session
      ),
    }));

    if (currentSession.isPrivate) return;
    try {
      await chatApi.updateSession(currentSession.id, {
        settings,
      } as Partial<ChatSession>);
    } catch (error) {
      logger.error('Failed to update knowledge collections:', error);
      toast.error(t('chat.input.menu.attachFailed'));
    }
  };

  const dictation = useDictation({
    onStart: () => {
      dictationBaseRef.current = message;
    },
    onText: text => {
      const base = dictationBaseRef.current;
      setMessage(base ? `${base} ${text}` : text);
    },
    ownerKey: currentSessionId,
  });
  const speechStarting = dictation.phase === 'starting';
  const listening = dictation.phase === 'recording';
  const transcribing = dictation.phase === 'transcribing';
  const speechSupported = dictation.supported;
  const providerSttModel = dictation.providerModel;
  const providerSpeechSources = dictation.sources.filter(
    source => source.kind === 'provider'
  );

  const handleDocumentSelected = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    closeAttachMenu();
    setUploadingDocument(true);
    try {
      const response = await documentsApi.uploadDocument(
        file,
        currentSession?.id
      );
      if (response.success) {
        toast.success(t('chat.input.menu.documentAttached'));
        window.dispatchEvent(new Event('libre:documents-updated'));
      } else {
        toast.error(response.error || t('chat.input.menu.attachFailed'));
      }
    } catch (error) {
      logger.error('Document upload failed:', error);
      toast.error(t('chat.input.menu.attachFailed'));
    } finally {
      setUploadingDocument(false);
    }
  };

  const handleAttachWebpage = async () => {
    const url = webpageUrl?.trim();
    if (!url || attachingWebpage) return;
    setAttachingWebpage(true);
    try {
      const response = await documentsApi.fetchWebpage(url, currentSession?.id);
      if (response.success) {
        toast.success(t('chat.input.menu.webpageAttached'));
        window.dispatchEvent(new Event('libre:documents-updated'));
        closeAttachMenu();
      } else {
        toast.error(response.error || t('chat.input.menu.attachFailed'));
      }
    } catch (error) {
      const message =
        (error as { response?: { data?: { error?: string } } })?.response?.data
          ?.error || t('chat.input.menu.attachFailed');
      logger.error('Webpage attach failed:', error);
      toast.error(message);
    } finally {
      setAttachingWebpage(false);
    }
  };

  const enqueueWhileGenerating = async (content: string) => {
    if (!currentSessionId || isPrivateSession) return;
    try {
      const response = await chatApi.enqueuePrompt(currentSessionId, content);
      if (response.success && response.data) {
        applyPromptQueueToChatStore(currentSessionId, response.data.queue);
        setMessage('');
      } else {
        toast.error(response.error || t('chat.queue.enqueueFailed'));
      }
    } catch (error) {
      const detail =
        (error as { response?: { data?: { error?: string } } })?.response?.data
          ?.error || t('chat.queue.enqueueFailed');
      logger.error('Failed to queue the prompt:', error);
      toast.error(detail);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!message.trim()) return;
    if (isGenerating) {
      // A second prompt during generation queues instead of being dropped.
      if (images.length === 0 && !isPrivateSession && currentSessionId) {
        void enqueueWhileGenerating(message.trim());
      }
      return;
    }
    if (!sessionModelAvailable) {
      toast.error(t('chat.model.selectBeforeSending'));
      return;
    }

    const toolsRequest = isPrivateSession
      ? {}
      : composerToolsRequest(composerTools);
    const compareTargets = isPrivateSession
      ? []
      : compareTargetsFromKeys(models, compareKeys);
    onSendMessage(
      message.trim(),
      images.length > 0 ? images : undefined,
      format || undefined,
      webSearchAvailable && webSearchActive ? true : undefined,
      toolsRequest.tools,
      toolsRequest.toolSelection,
      compareTargets.length > 0 ? compareTargets : undefined
    );
    setMessage('');
    setImages([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (suggestionsRef.current?.handleKeyDown(e)) return;
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
      // An empty box keeps its natural height: Chromium counts the wrapped
      // placeholder in scrollHeight, which would grow the bar on narrow
      // screens before anything has been typed.
      textarea.style.height = message
        ? `${Math.min(textarea.scrollHeight, 200)}px`
        : '';
    }
  }, [message]);

  // Load current persona when session changes
  useEffect(() => {
    const loadCurrentPersona = async () => {
      if (currentSession?.personaId) {
        try {
          const response = await personaApi.getPersona(
            currentSession.personaId
          );
          if (response.success && response.data) {
            setCurrentPersona(response.data);
          } else {
            logger.warn(
              `Persona ${currentSession.personaId} not found, clearing reference`
            );
            setCurrentPersona(null);
            // Clear the personaId from the session to prevent repeated requests
            const { setCurrentSession } = useChatStore.getState();
            setCurrentSession({
              ...currentSession,
              personaId: undefined,
            });
          }
        } catch (error) {
          logger.error('Failed to load current persona:', error);
          setCurrentPersona(null);
          // Clear the personaId from the session to prevent repeated requests
          if (currentSession) {
            const { setCurrentSession } = useChatStore.getState();
            setCurrentSession({
              ...currentSession,
              personaId: undefined,
            });
          }
        }
      } else {
        setCurrentPersona(null);
      }
    };

    loadCurrentPersona();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSession?.personaId]);

  const handleModelOrPersonaChange = async (
    event: React.ChangeEvent<HTMLSelectElement>
  ) => {
    const selection = chatModelSelectionFromKey(
      selectorModels,
      event.target.value
    );
    if (!selection) return;
    if (!currentSession) return;

    try {
      // Check if the selected value is a persona
      if (selection.model.startsWith('persona:')) {
        const personaId = selection.model.slice('persona:'.length);

        // Get persona details to use its model
        const personaResponse = await personaApi.getPersona(personaId);
        if (!personaResponse.success || !personaResponse.data) {
          toast.error(t('chat.persona.loadFailed'));
          return;
        }

        const persona = personaResponse.data;

        // Update session with persona and its model
        const response = await chatApi.updateSession(currentSession.id, {
          personaId: personaId,
          model: selection.model, // Keep the persona model string (persona:xxx)
          providerType: 'ollama',
          providerId: null,
        });

        if (response.success && response.data) {
          // Update both currentSession and the sessions array
          const { sessions } = useChatStore.getState();
          const updatedSessions = sessions.map(s =>
            s.id === currentSession.id ? response.data! : s
          );
          useChatStore.setState({
            sessions: updatedSessions,
            currentSession: response.data,
          });

          // Apply persona background if it has one
          if (persona.background) {
            setBackgroundImage(persona.background);
          }

          toast.success(t('chat.persona.applied'));
        }
      } else {
        // It's a regular model - update the model and clear persona
        const response = await chatApi.updateSession(currentSession.id, {
          model: selection.model,
          providerType: selection.providerType,
          providerId:
            selection.providerType === 'plugin' ||
            selection.providerType === 'agent'
              ? selection.providerId || null
              : null,
          personaId: null,
        });

        if (response.success && response.data) {
          // Update both currentSession and the sessions array
          const { sessions } = useChatStore.getState();
          const updatedSessions = sessions.map(s =>
            s.id === currentSession.id ? response.data! : s
          );
          useChatStore.setState({
            sessions: updatedSessions,
            currentSession: response.data,
          });

          setBackgroundImage(null);
          toast.success(t('chat.model.updated'));
        }
      }
    } catch (error) {
      logger.error('Failed to update session:', error);
      toast.error(t('chat.toasts.updateFailed'));
    }
  };

  const hasAdvancedFeatures = images.length > 0 || format !== null;
  return (
    <div className='pointer-events-none'>
      {/* Centered container matching chat messages width */}
      <div
        ref={composerRef}
        className='pointer-events-auto mx-auto w-full max-w-3xl px-4 sm:px-6 md:px-8'
      >
        {/* Advanced Features Panel */}
        {showAdvanced && (
          <div className='mb-2 animate-slide-up rounded-2xl border border-black/[0.07] bg-surface/90 p-4 shadow-[0_12px_40px_rgba(15,23,42,0.08)] backdrop-blur-xl dark:border-white/[0.08] dark:bg-dark-200/90'>
            <MediaUpload
              images={images}
              onImagesChange={setImages}
              maxImages={5}
              sessionId={currentSession?.id}
              disabled={disabled}
            />
            <StructuredOutput format={format} onFormatChange={setFormat} />
          </div>
        )}

        {/* Main Input Area - Unified Input Bar */}
        <div className='pb-2.5 pt-1.5 sm:pb-3'>
          {currentSessionId &&
            !isPrivateSession &&
            (currentSession?.settings?.promptQueue?.length ?? 0) > 0 && (
              <PromptQueueList
                sessionId={currentSessionId}
                queue={currentSession!.settings!.promptQueue!}
              />
            )}
          {currentSessionId &&
            pendingComparisons.some(
              entry => entry.sessionId === currentSessionId
            ) && (
              <div
                className='mx-auto mb-1.5 flex w-full max-w-3xl flex-wrap gap-1.5 px-1'
                data-testid='pending-comparisons'
              >
                {pendingComparisons
                  .filter(entry => entry.sessionId === currentSessionId)
                  .map(entry => (
                    <span
                      key={entry.assistantMessageId}
                      className='flex items-center gap-1.5 rounded-full border border-black/[0.07] bg-surface/70 px-2.5 py-1 text-[12px] text-gray-600 dark:border-white/[0.08] dark:bg-dark-200/70 dark:text-dark-700'
                      data-testid='pending-comparison'
                    >
                      <Loader2 className='h-3 w-3 animate-spin' />
                      <span dir='ltr' className='max-w-[160px] truncate'>
                        {entry.model}
                      </span>
                      {onCancelComparison && (
                        <button
                          type='button'
                          onClick={() =>
                            onCancelComparison(entry.assistantMessageId)
                          }
                          className='rounded-full p-0.5 text-gray-400 hover:text-red-500'
                          aria-label={t('common.cancel')}
                        >
                          <X className='h-3 w-3' />
                        </button>
                      )}
                    </span>
                  ))}
              </div>
            )}
          <form onSubmit={handleSubmit}>
            {/* Unified Input Container: text row above, controls row below. */}
            <div
              className={cn(
                'relative rounded-[24px] border p-2.5 transition-[border-color,box-shadow,background-color] duration-200',
                'bg-surface dark:bg-surface-subtle',
                'border-black/[0.08] dark:border-white/[0.09]',
                'shadow-lv2 focus-within:shadow-lv3'
              )}
            >
              {/* Text Input Area */}
              <ComposerSuggestions
                ref={suggestionsRef}
                message={message}
                disabled={disabled}
                onApply={next => {
                  setMessage(next);
                  textareaRef.current?.focus();
                }}
              />
              <CodeAwareTextarea
                ref={textareaRef}
                value={message}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                  setMessage(e.target.value)
                }
                onKeyDown={handleKeyDown}
                placeholder={t('chat.input.placeholder')}
                disabled={disabled}
                className='!m-0 block w-full min-h-9 max-h-[160px] resize-none !rounded-none !border-0 !bg-transparent !px-2 !pt-1.5 !pb-2 !shadow-none scrollbar-thin scrollbar-thumb-gray-300 placeholder:text-ink-subtle focus:!border-0 focus:!bg-transparent focus:!shadow-none focus:!ring-0 dark:scrollbar-thumb-dark-400 text-[0.9375rem] leading-relaxed touch-manipulation'
                rows={1}
              />

              <div className='flex items-center gap-1.5'>
                {/* Attach menu - Integrated Left */}
                <div ref={attachMenuRef} className='relative flex-shrink-0'>
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    onClick={() => {
                      if (showAdvanced) {
                        setShowAdvanced(false);
                        return;
                      }
                      setAttachMenuOpen(open => !open);
                      setWebpageUrl(null);
                    }}
                    className={cn(
                      'h-9 w-9 !p-0 rounded-full flex-shrink-0',
                      'bg-surface-subtle text-ink-muted hover:bg-hover-solid hover:text-ink dark:bg-surface-raised dark:hover:bg-surface-overlay',
                      'transition-colors duration-150 touch-manipulation',
                      hasAdvancedFeatures &&
                        'text-primary-600 dark:text-primary-400',
                      (showAdvanced || attachMenuOpen) &&
                        'bg-hover-solid text-ink'
                    )}
                    title={t('chat.input.attachments')}
                  >
                    {uploadingDocument || attachingWebpage ? (
                      <Loader2 className='h-4 w-4 animate-spin' />
                    ) : hasAdvancedFeatures ? (
                      <div className='relative flex items-center justify-center'>
                        <Paperclip className='h-4 w-4' />
                        <div className='absolute -top-0.5 -end-0.5 h-2 w-2 bg-primary-500 dark:bg-primary-400 rounded-full ring-2 ring-white dark:ring-dark-50' />
                      </div>
                    ) : showAdvanced ? (
                      <Minus className='h-4 w-4' />
                    ) : (
                      <Plus className='h-4 w-4' />
                    )}
                  </Button>

                  {attachMenuOpen && (
                    <div className='absolute bottom-full start-0 z-30 mb-2 w-64 rounded-2xl border border-black/[0.08] bg-surface/95 p-1.5 shadow-[0_16px_48px_rgba(15,23,42,0.16)] backdrop-blur-xl animate-scale-in dark:border-white/[0.09] dark:bg-dark-100/95'>
                      {knowledgeMenuOpen ? (
                        <div className='p-1'>
                          <p className='mb-1 px-1.5 text-[11px] font-medium text-gray-500 dark:text-dark-600'>
                            {t('chat.input.menu.attachKnowledge')}
                          </p>
                          {collections.length === 0 ? (
                            <p className='px-1.5 pb-1 text-[12px] text-gray-400 dark:text-dark-500'>
                              {t('chat.input.menu.noCollections')}
                            </p>
                          ) : (
                            collections.map(collection => {
                              const attached = attachedCollectionIds.includes(
                                collection.id
                              );
                              return (
                                <button
                                  key={collection.id}
                                  type='button'
                                  onClick={() =>
                                    void toggleCollection(collection.id)
                                  }
                                  className={cn(
                                    'flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-start text-[13px] text-gray-700 hover:bg-gray-100 dark:text-dark-800 dark:hover:bg-dark-200',
                                    attached &&
                                      'text-primary-600 dark:text-primary-400'
                                  )}
                                  aria-pressed={attached}
                                >
                                  <span className='flex min-w-0 items-center gap-2'>
                                    <BookOpen className='h-4 w-4 shrink-0' />
                                    <span className='truncate'>
                                      {collection.name}
                                    </span>
                                  </span>
                                  {attached && (
                                    <Check className='h-3.5 w-3.5 shrink-0' />
                                  )}
                                </button>
                              );
                            })
                          )}
                          <button
                            type='button'
                            onClick={() => setKnowledgeMenuOpen(false)}
                            className='mt-1 w-full rounded-lg border-t border-gray-100 px-2.5 py-1.5 text-start text-xs text-gray-500 hover:bg-gray-100 dark:border-dark-300 dark:text-dark-600 dark:hover:bg-dark-200'
                          >
                            {t('common.back')}
                          </button>
                        </div>
                      ) : webpageUrl !== null ? (
                        <div className='p-1.5'>
                          <label className='mb-1.5 block text-[11px] font-medium text-gray-500 dark:text-dark-600'>
                            {t('chat.input.menu.attachWebpage')}
                          </label>
                          <input
                            type='url'
                            value={webpageUrl}
                            onChange={event =>
                              setWebpageUrl(event.target.value)
                            }
                            onKeyDown={event => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                void handleAttachWebpage();
                              } else if (event.key === 'Escape') {
                                setWebpageUrl(null);
                              }
                            }}
                            placeholder='https://…'
                            autoFocus
                            dir='ltr'
                            className='w-full rounded-lg border border-black/[0.08] bg-white px-2.5 py-1.5 text-[13px] text-gray-900 placeholder:text-gray-400 focus:border-primary-500/40 focus:outline-none dark:border-white/[0.08] dark:bg-dark-50 dark:text-dark-900'
                          />
                          <div className='mt-2 flex justify-end gap-1.5'>
                            <button
                              type='button'
                              onClick={() => setWebpageUrl(null)}
                              className='rounded-lg px-2.5 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:text-dark-600 dark:hover:bg-dark-200'
                            >
                              {t('common.cancel')}
                            </button>
                            <button
                              type='button'
                              onClick={() => void handleAttachWebpage()}
                              disabled={!webpageUrl.trim() || attachingWebpage}
                              className='rounded-lg bg-gray-900 px-2.5 py-1 text-xs text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-dark-300 dark:hover:bg-dark-400'
                            >
                              {attachingWebpage ? (
                                <Loader2 className='h-3.5 w-3.5 animate-spin' />
                              ) : (
                                t('chat.input.menu.attach')
                              )}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <button
                            type='button'
                            onClick={() => {
                              setShowAdvanced(true);
                              closeAttachMenu();
                            }}
                            className='flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-start text-[13px] text-gray-700 hover:bg-gray-100 dark:text-dark-800 dark:hover:bg-dark-200'
                          >
                            <ImageIcon className='h-4 w-4 text-gray-500 dark:text-dark-600' />
                            {t('chat.input.menu.uploadImages')}
                          </button>
                          <button
                            type='button'
                            onClick={() => documentInputRef.current?.click()}
                            className='flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-start text-[13px] text-gray-700 hover:bg-gray-100 dark:text-dark-800 dark:hover:bg-dark-200'
                          >
                            <FileText className='h-4 w-4 text-gray-500 dark:text-dark-600' />
                            {t('chat.input.menu.attachDocument')}
                          </button>
                          <button
                            type='button'
                            onClick={() => setWebpageUrl('')}
                            className='flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-start text-[13px] text-gray-700 hover:bg-gray-100 dark:text-dark-800 dark:hover:bg-dark-200'
                          >
                            <Globe className='h-4 w-4 text-gray-500 dark:text-dark-600' />
                            {t('chat.input.menu.attachWebpage')}
                          </button>
                          <button
                            type='button'
                            onClick={() => setKnowledgeMenuOpen(true)}
                            className='flex w-full items-center justify-between gap-2.5 rounded-xl px-2.5 py-2 text-start text-[13px] text-gray-700 hover:bg-gray-100 dark:text-dark-800 dark:hover:bg-dark-200'
                          >
                            <span className='flex items-center gap-2.5'>
                              <BookOpen className='h-4 w-4 text-gray-500 dark:text-dark-600' />
                              {t('chat.input.menu.attachKnowledge')}
                            </span>
                            {attachedCollectionIds.length > 0 && (
                              <span className='rounded-full bg-primary-50 px-1.5 text-[10px] font-medium tabular-nums text-primary-600 dark:bg-primary-900/20 dark:text-primary-400'>
                                {attachedCollectionIds.length}
                              </span>
                            )}
                          </button>
                          <button
                            type='button'
                            onClick={() => {
                              setShowAdvanced(true);
                              closeAttachMenu();
                            }}
                            className='flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-start text-[13px] text-gray-700 hover:bg-gray-100 dark:text-dark-800 dark:hover:bg-dark-200'
                          >
                            <Braces className='h-4 w-4 text-gray-500 dark:text-dark-600' />
                            {t('chat.input.menu.structuredOutput')}
                          </button>

                          {/* Controls folded out of the narrow icon row */}
                          {compact && webSearchAvailable && (
                            <button
                              type='button'
                              onClick={() => {
                                setWebSearchActive(active => !active);
                                closeAttachMenu();
                              }}
                              className={cn(
                                'flex w-full items-center justify-between gap-2.5 rounded-xl px-2.5 py-2 text-start text-[13px] text-gray-700 hover:bg-gray-100 dark:text-dark-800 dark:hover:bg-dark-200',
                                webSearchActive &&
                                  'text-primary-600 dark:text-primary-400'
                              )}
                              aria-pressed={webSearchActive}
                            >
                              <span className='flex items-center gap-2.5'>
                                <Globe className='h-4 w-4 text-gray-500 dark:text-dark-600' />
                                {webSearchActive
                                  ? t('chat.input.webSearchOn')
                                  : t('chat.input.webSearchOff')}
                              </span>
                              {webSearchActive && (
                                <Check className='h-3.5 w-3.5 shrink-0' />
                              )}
                            </button>
                          )}
                          {compact && speechSupported && onOpenVoiceMode && (
                            <button
                              type='button'
                              onClick={() => {
                                void unlockTTSAudioPlayback();
                                onOpenVoiceMode();
                                closeAttachMenu();
                              }}
                              className='flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-start text-[13px] text-gray-700 hover:bg-gray-100 dark:text-dark-800 dark:hover:bg-dark-200'
                            >
                              <AudioLines className='h-4 w-4 text-gray-500 dark:text-dark-600' />
                              {t('voiceMode.open')}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  <input
                    ref={documentInputRef}
                    type='file'
                    accept={UPLOAD_ACCEPT_ATTRIBUTE}
                    className='hidden'
                    onChange={event => void handleDocumentSelected(event)}
                  />
                </div>

                {/* Integrated Controls Row — icons grouped on the left in the
                  same order as the new-chat composer; model + send stay right. */}
                <div className='flex min-w-0 flex-1 flex-wrap items-center gap-1 sm:gap-1.5'>
                  {/* Thinking level */}
                  {thinkingAvailable && (
                    <ThinkingSelector
                      value={activeThinking}
                      inheritedValue={inheritedThinking}
                      onChange={think => void applyThinking(think)}
                    />
                  )}

                  {/* Web search toggle */}
                  {webSearchAvailable && !compact && (
                    <Button
                      type='button'
                      variant='ghost'
                      size='sm'
                      onClick={() => setWebSearchActive(active => !active)}
                      className={cn(
                        'h-9 w-9 sm:h-10 sm:w-10 p-0 rounded-full flex-shrink-0 flex items-center justify-center',
                        'text-gray-500 dark:text-dark-600 hover:bg-gray-100 dark:hover:bg-dark-300',
                        'transition-colors duration-150 touch-manipulation',
                        webSearchActive &&
                          'bg-primary-50 text-primary-600 dark:bg-primary-900/25 dark:text-primary-400'
                      )}
                      title={
                        webSearchActive
                          ? t('chat.input.webSearchOn')
                          : t('chat.input.webSearchOff')
                      }
                      aria-pressed={webSearchActive}
                    >
                      <Globe className='h-4 w-4' />
                    </Button>
                  )}

                  {/* Native tool-call picker */}
                  {!isPrivateSession && (
                    <ComposerToolsMenu
                      value={composerTools}
                      onChange={setComposerTools}
                    />
                  )}

                  {/* Multi-model comparison picker */}
                  {!isPrivateSession && currentSession && !compact && (
                    <ComposerCompareMenu
                      models={models}
                      currentModelKey={chatModelSelectionKey({
                        model: currentSession.personaId
                          ? `persona:${currentSession.personaId}`
                          : currentSession.model,
                        providerType: currentSession.providerType ?? null,
                        providerId: currentSession.providerId ?? null,
                      })}
                      selectedKeys={compareKeys}
                      onChange={setCompareKeys}
                      disabled={disabled}
                    />
                  )}

                  {/* Voice input. Selecting a provider makes the audio transfer
                    explicit before the user starts recording. */}
                  {providerSpeechSources.length > 0 && !compact && (
                    <select
                      value={dictation.activeSourceKey}
                      onChange={event =>
                        dictation.setSourceKey(event.target.value)
                      }
                      disabled={speechStarting || listening || transcribing}
                      aria-label={t('chat.input.transcriptionSource')}
                      title={
                        providerSttModel
                          ? t('chat.input.providerTranscriptionDisclosure', {
                              provider: providerSttModel.plugin,
                            })
                          : t('chat.input.transcriptionSource')
                      }
                      className='h-8 max-w-32 rounded-lg border border-black/[0.08] bg-transparent px-1.5 text-[11px] text-gray-500 outline-none focus:border-primary-500/40 dark:border-white/[0.09] dark:text-dark-600'
                    >
                      {dictation.sources.map(source =>
                        source.kind === 'browser' ? (
                          <option key={source.key} value={source.key}>
                            {t('chat.input.browserSpeech')}
                          </option>
                        ) : (
                          <option key={source.key} value={source.key}>
                            {source.model?.plugin} · {source.model?.model}
                          </option>
                        )
                      )}
                    </select>
                  )}
                  {speechSupported && (
                    <Button
                      type='button'
                      variant='ghost'
                      size='sm'
                      onClick={() => void dictation.toggle()}
                      className={cn(
                        'h-9 w-9 sm:h-10 sm:w-10 p-0 rounded-full flex-shrink-0 flex items-center justify-center',
                        'text-gray-500 dark:text-dark-600 hover:bg-gray-100 dark:hover:bg-dark-300',
                        'transition-colors duration-150 touch-manipulation',
                        (speechStarting || listening || transcribing) &&
                          'bg-red-50 text-red-500 animate-pulse dark:bg-red-900/20 dark:text-red-400'
                      )}
                      title={
                        transcribing
                          ? t('common.cancel')
                          : speechStarting
                            ? t('common.cancel')
                            : listening
                              ? t('chat.input.voiceStop')
                              : providerSttModel
                                ? t(
                                    'chat.input.providerTranscriptionDisclosure',
                                    {
                                      provider: providerSttModel.plugin,
                                    }
                                  )
                                : t('chat.input.voiceInput')
                      }
                      aria-pressed={speechStarting || listening || transcribing}
                    >
                      {speechStarting ? (
                        <Loader2 className='h-4 w-4 animate-spin' />
                      ) : transcribing ? (
                        <Square className='h-4 w-4' />
                      ) : (
                        <Mic className='h-4 w-4' />
                      )}
                    </Button>
                  )}
                  {speechSupported && onOpenVoiceMode && !compact && (
                    <Button
                      type='button'
                      variant='ghost'
                      size='sm'
                      onClick={() => {
                        // Prime audio playback inside this gesture so the
                        // spoken replies are not blocked by autoplay policy.
                        void unlockTTSAudioPlayback();
                        onOpenVoiceMode();
                      }}
                      className={cn(
                        'h-9 w-9 sm:h-10 sm:w-10 p-0 rounded-full flex-shrink-0 flex items-center justify-center',
                        'text-gray-500 dark:text-dark-600 hover:bg-gray-100 dark:hover:bg-dark-300',
                        'transition-colors duration-150 touch-manipulation'
                      )}
                      title={t('voiceMode.open')}
                      aria-label={t('voiceMode.open')}
                      data-testid='voice-mode-open'
                    >
                      <AudioLines className='h-4 w-4' />
                    </Button>
                  )}

                  {currentSession && (
                    <ContextMeter
                      usage={contextUsage}
                      trainedBudget={
                        activeModelDefaults?.contextCapped
                          ? activeModelDefaults.trainedContextLength
                          : undefined
                      }
                    />
                  )}

                  <div className='min-w-0 flex-1' />

                  {/* Model Selector - Integrated */}
                  {currentSession && selectorModels.length > 0 && (
                    <div className='hidden sm:block'>
                      <ModelSelector
                        models={selectorModels}
                        selectedModel={sessionModelKey}
                        onModelChange={handleModelOrPersonaChange}
                        getModelValue={chatModelOptionKey}
                        currentPersona={currentPersona}
                        className='min-w-[150px] max-w-[230px]'
                        compact
                        showImageGen={showImageGeneration}
                      />
                    </div>
                  )}

                  {/* Send/Stop Button - Integrated Right */}
                  {isGenerating ? (
                    <Button
                      type='button'
                      variant='ghost'
                      size='sm'
                      onClick={handleStopGeneration}
                      className={cn(
                        'h-9 w-9 sm:h-10 sm:w-10 p-0 rounded-full flex-shrink-0 flex items-center justify-center',
                        'bg-red-50 dark:bg-red-900/20',
                        'text-red-500 dark:text-red-400',
                        'hover:bg-red-100 dark:hover:bg-red-900/30',
                        'transition-colors duration-150 touch-manipulation'
                      )}
                      title={t('chat.input.stopGeneration')}
                    >
                      <Square className='h-4 w-4' />
                    </Button>
                  ) : (
                    <Button
                      type='submit'
                      variant='ghost'
                      size='sm'
                      disabled={
                        !message.trim() || disabled || !sessionModelAvailable
                      }
                      className={cn(
                        'h-9 w-9 p-0 rounded-full flex-shrink-0 flex items-center justify-center',
                        'bg-primary-500 text-white hover:bg-primary-400',
                        'disabled:cursor-not-allowed disabled:bg-primary-300/50 disabled:text-white/80 dark:disabled:bg-primary-800/60 dark:disabled:text-white/40 disabled:hover:bg-primary-300/50 dark:disabled:hover:bg-primary-800/60',
                        'transition-colors duration-150 touch-manipulation'
                      )}
                      title={t('chat.input.sendMessage')}
                    >
                      <ArrowUp className='h-4 w-4' />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </form>

          {providerSttModel && (
            <p
              role='note'
              className='mt-1.5 text-center text-[10px] leading-relaxed text-amber-700 dark:text-amber-300'
            >
              {t('chat.input.providerTranscriptionDisclosure', {
                provider: providerSttModel.plugin,
              })}
            </p>
          )}

          {/* Mobile-only Model Selector */}
          {currentSession && selectorModels.length > 0 && (
            <div className='mt-3 sm:hidden'>
              <ModelSelector
                models={selectorModels}
                selectedModel={sessionModelKey}
                onModelChange={handleModelOrPersonaChange}
                getModelValue={chatModelOptionKey}
                currentPersona={currentPersona}
                className='w-full'
                compact
                showImageGen={showImageGeneration}
              />
            </div>
          )}

          <div className='mt-1.5 flex min-h-4 items-center justify-center gap-2 text-[10px] text-gray-400 dark:text-dark-500'>
            <DocumentIndicator sessionId={currentSession?.id} />
            <div className='text-center leading-relaxed'>
              <span>{t('chat.footer.disclaimer')}</span>
              {hasAdvancedFeatures && (
                <span className='ms-2 text-primary-600 dark:text-primary-400'>
                  •{' '}
                  {images.length > 0 &&
                    t('chat.footer.images', { count: images.length })}
                  {images.length > 0 && format && ' • '}
                  {format && t('chat.footer.structuredOutput')}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
