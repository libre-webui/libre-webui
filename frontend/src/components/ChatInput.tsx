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

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Send,
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
  BookOpen,
  Check,
} from 'lucide-react';
import { Button } from '@/components/ui';
import { CodeAwareTextarea } from './CodeAwareTextarea';
import { MediaUpload } from './MediaUpload';
import { DocumentIndicator } from './DocumentIndicator';
import { StructuredOutput } from './StructuredOutput';
import { ModelSelector } from './ModelSelector';
import { useAppStore } from '@/store/appStore';
import { useChatStore } from '@/store/chatStore';
import { personaApi, chatApi, imageGenApi, documentsApi } from '@/utils/api';
import { toast } from 'react-hot-toast';
import { cn } from '@/utils';
import { Persona, KnowledgeCollection, ChatSession } from '@/types';
import { createLogger } from '@/utils/logger';
import {
  chatModelOptionKey,
  isChatModelSelectionAvailable,
  chatModelSelectionFromKey,
  chatModelSelectionKeyForModels,
  withUnavailableChatModel,
} from '@/utils/chatModelSelection';

const logger = createLogger('components:chat-input');

// Minimal typings for the vendor-prefixed Web Speech API.
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((event: {
        results: ArrayLike<ArrayLike<{ transcript: string }>>;
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

const getSpeechRecognition = (): SpeechRecognitionConstructor | undefined => {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition;
};

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
  const { t, i18n } = useTranslation();
  const [message, setMessage] = useState('');
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const dictationBaseRef = useRef('');
  const speechSupported = useMemo(() => Boolean(getSpeechRecognition()), []);
  const [images, setImages] = useState<string[]>([]);
  const [format, setFormat] = useState<string | Record<string, unknown> | null>(
    null
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [webpageUrl, setWebpageUrl] = useState<string | null>(null);
  const [knowledgeMenuOpen, setKnowledgeMenuOpen] = useState(false);
  const [collections, setCollections] = useState<KnowledgeCollection[]>([]);
  const [attachingWebpage, setAttachingWebpage] = useState(false);
  const [uploadingDocument, setUploadingDocument] = useState(false);
  const [currentPersona, setCurrentPersona] = useState<Persona | null>(null);
  const [hasImageGenPlugins, setHasImageGenPlugins] = useState(false);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const { isGenerating, setBackgroundImage } = useAppStore();
  const imageGenerationEnabled = useAppStore(
    state => state.preferences.imageGenSettings?.enabled === true
  );
  const showImageGeneration = imageGenerationEnabled && hasImageGenPlugins;
  const { currentSession, models } = useChatStore();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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

  // Stop dictation when unmounting.
  useEffect(
    () => () => {
      recognitionRef.current?.stop();
    },
    []
  );

  const toggleDictation = () => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const SpeechRecognitionCtor = getSpeechRecognition();
    if (!SpeechRecognitionCtor) return;

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = i18n.language;
    recognition.continuous = true;
    recognition.interimResults = true;
    dictationBaseRef.current = message;
    recognition.onresult = event => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0]?.transcript ?? '';
      }
      const base = dictationBaseRef.current;
      setMessage(base ? `${base} ${transcript.trim()}` : transcript.trim());
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
    };
    recognition.onerror = () => {
      recognitionRef.current = null;
      setListening(false);
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch (error) {
      logger.error('Failed to start dictation:', error);
      recognitionRef.current = null;
    }
  };

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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!message.trim() || isGenerating) return;
    if (!sessionModelAvailable) {
      toast.error('Select an available model before sending');
      return;
    }

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
          toast.error('Failed to load persona details');
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
      toast.error('Failed to update session');
    }
  };

  const hasAdvancedFeatures = images.length > 0 || format !== null;
  return (
    <div className='pointer-events-none'>
      {/* Centered container matching chat messages width */}
      <div className='pointer-events-auto mx-auto w-full max-w-3xl px-4 sm:px-6 md:px-8'>
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
          <form onSubmit={handleSubmit}>
            {/* Unified Input Container */}
            <div
              className={cn(
                'flex items-end gap-2 rounded-[1.35rem] border p-2 transition-[border-color,box-shadow,background-color] duration-200',
                'bg-surface/[0.92] dark:bg-dark-200/[0.92] backdrop-blur-xl',
                'border-black/[0.08] dark:border-white/[0.09]',
                'shadow-[0_1px_2px_rgba(0,0,0,0.03),0_14px_42px_rgba(15,23,42,0.08)]',
                'focus-within:border-primary-500/35 focus-within:shadow-[0_1px_2px_rgba(0,0,0,0.03),0_18px_52px_rgba(15,23,42,0.11)]'
              )}
            >
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
                    'h-9 w-9 sm:h-10 sm:w-10 !p-0 rounded-full flex-shrink-0',
                    'text-gray-500 dark:text-dark-600 hover:bg-gray-100 dark:hover:bg-dark-300',
                    'transition-colors duration-150 touch-manipulation',
                    hasAdvancedFeatures &&
                      'text-primary-600 dark:text-primary-400',
                    (showAdvanced || attachMenuOpen) &&
                      'bg-gray-100 dark:bg-dark-300'
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
                          onChange={event => setWebpageUrl(event.target.value)}
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
                      </>
                    )}
                  </div>
                )}

                <input
                  ref={documentInputRef}
                  type='file'
                  accept='.pdf,.txt,application/pdf,text/plain'
                  className='hidden'
                  onChange={event => void handleDocumentSelected(event)}
                />
              </div>

              {/* Text Input Area */}
              <div className='flex-1 min-w-0'>
                <CodeAwareTextarea
                  ref={textareaRef}
                  value={message}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                    setMessage(e.target.value)
                  }
                  onKeyDown={handleKeyDown}
                  placeholder={t('chat.input.placeholder')}
                  disabled={disabled}
                  className='!m-0 block min-h-9 max-h-[160px] resize-none !rounded-none !border-0 !bg-transparent !px-1.5 !py-1.5 sm:!min-h-10 sm:!py-2 max-[768px]:!min-h-11 max-[768px]:!py-[10.5px] !shadow-none scrollbar-thin scrollbar-thumb-gray-300 placeholder:text-gray-400 focus:!border-0 focus:!bg-transparent focus:!shadow-none focus:!ring-0 dark:scrollbar-thumb-dark-400 dark:placeholder:text-dark-500 text-[0.9375rem] leading-relaxed touch-manipulation'
                  rows={1}
                />
              </div>

              {/* Integrated Controls Row */}
              <div className='flex flex-shrink-0 items-center gap-1 sm:gap-2'>
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

                {/* Voice input */}
                {speechSupported && (
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    onClick={toggleDictation}
                    className={cn(
                      'h-9 w-9 sm:h-10 sm:w-10 p-0 rounded-full flex-shrink-0 flex items-center justify-center',
                      'text-gray-500 dark:text-dark-600 hover:bg-gray-100 dark:hover:bg-dark-300',
                      'transition-colors duration-150 touch-manipulation',
                      listening &&
                        'bg-red-50 text-red-500 animate-pulse dark:bg-red-900/20 dark:text-red-400'
                    )}
                    title={
                      listening
                        ? t('chat.input.voiceStop')
                        : t('chat.input.voiceInput')
                    }
                    aria-pressed={listening}
                  >
                    <Mic className='h-4 w-4' />
                  </Button>
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
                      'h-9 w-9 sm:h-10 sm:w-10 p-0 rounded-full flex-shrink-0 flex items-center justify-center',
                      'bg-gray-100 text-gray-400 dark:bg-dark-300 dark:text-dark-500',
                      'disabled:cursor-not-allowed disabled:opacity-70',
                      'transition-colors duration-150 touch-manipulation',
                      message.trim() &&
                        !disabled &&
                        sessionModelAvailable && [
                          'bg-gray-950 text-white hover:bg-gray-800',
                          'dark:bg-white dark:text-gray-950 dark:hover:bg-gray-100',
                          'shadow-sm',
                        ]
                    )}
                    title={t('chat.input.sendMessage')}
                  >
                    <Send className='h-4 w-4' />
                  </Button>
                )}
              </div>
            </div>
          </form>

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
