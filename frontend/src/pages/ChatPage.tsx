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
  useState,
  useRef,
  useMemo,
} from 'react';
import { createPortal } from 'react-dom';
import { useParams, useNavigate, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  ArrowUp,
  GripVertical,
  Plus,
  Paperclip,
  Minus,
  Ghost,
  Globe,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { ChatMessages } from '@/components/ChatMessages';
import { ChatInput } from '@/components/ChatInput';
import { ChatControlsPanel } from '@/components/ChatControlsPanel';
import { ChatSourcesPanel } from '@/components/ChatSourcesPanel';
import { CodeAwareTextarea } from '@/components/CodeAwareTextarea';
import { LogoMark } from '@/components/LogoMark';
import { ModelSelector } from '@/components/ModelSelector';
import { PersonaIndicator } from '@/components/PersonaIndicator';
import { Button } from '@/components/ui';
import { ImageUpload } from '@/components/ImageUpload';
import { useChatStore } from '@/store/chatStore';
import { useAuthStore } from '@/store/authStore';
import { useAppStore } from '@/store/appStore';
import { useChat } from '@/hooks/useChat';
import { chatApi, documentsApi, imageGenApi, searchApi } from '@/utils/api';
import { cn, generateId } from '@/utils';
import type { ChatSession } from '@/types';
import { createLogger } from '@/utils/logger';
import { triggerHapticFeedback } from '@/utils/haptics';
import { isRTL } from '@/i18n';
import {
  chatModelOptionKey,
  chatModelSelectionFromKey,
  chatModelSelectionFromModel,
  chatModelSelectionKeyForModels,
  isChatModelSelectionAvailable,
  withUnavailableChatModel,
} from '@/utils/chatModelSelection';
import toast from 'react-hot-toast';
import {
  getWelcomePromptId,
  getWelcomePromptIndex,
  WELCOME_PROMPT_CHANGE_EVENT,
  type WelcomePromptId,
} from '@/utils/welcomePrompts';

const logger = createLogger('pages:chat-page');

// Floating chat overlay geometry
const CHAT_OVERLAY_WIDTH = 380;
const CHAT_OVERLAY_HEIGHT = 480;
const CHAT_OVERLAY_MARGIN = 16;

interface WelcomePrompt {
  id: WelcomePromptId;
  title: string;
  subtitle: string;
}

const getTimeWelcomePrompt = (
  username?: string,
  t?: (key: string) => string,
  rtl = false
): WelcomePrompt => {
  const hour = new Date().getHours();
  const name = username ? `${rtl ? '،' : ','} \u2068${username}\u2069` : '';

  if (hour >= 5 && hour < 12) {
    const greetingText = t ? t('chat.greeting.morning') : 'Good morning';
    return {
      id: 'time',
      title: `${greetingText}${name}`,
      subtitle: t ? t('chat.welcome.helpToday') : 'What can I help with today?',
    };
  } else if (hour >= 12 && hour < 17) {
    const greetingText = t ? t('chat.greeting.afternoon') : 'Good afternoon';
    return {
      id: 'time',
      title: `${greetingText}${name}`,
      subtitle: t ? t('chat.welcome.helpToday') : 'What can I help with today?',
    };
  } else if (hour >= 17 && hour < 21) {
    const greetingText = t ? t('chat.greeting.evening') : 'Good evening';
    return {
      id: 'time',
      title: `${greetingText}${name}`,
      subtitle: t
        ? t('chat.welcome.helpTonight')
        : 'What can I help with tonight?',
    };
  } else {
    const greetingText = t ? t('chat.greeting.night') : 'Good night';
    return {
      id: 'time',
      title: `${greetingText}${name}`,
      subtitle: t
        ? t('chat.welcome.helpTonight')
        : 'What can I help with tonight?',
    };
  }
};

const getWelcomePrompt = (
  index: number,
  username?: string,
  t?: (key: string) => string,
  rtl = false
): WelcomePrompt => {
  const id = getWelcomePromptId(index);

  if (id === 'time') {
    return getTimeWelcomePrompt(username, t, rtl);
  }

  return {
    id,
    title: t ? t(`chat.welcome.variety.${id}.title`) : 'What should we make?',
    subtitle: t
      ? t(`chat.welcome.variety.${id}.subtitle`)
      : 'Start with a thought, a sketch, or a stubborn problem.',
  };
};

export const ChatPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    currentSession,
    sessions,
    models,
    selectedModel,
    selectedProviderType,
    selectedProviderId,
    setSelectedModel,
    createSession,
    setCurrentSession,
    loadSessions,
    getCurrentPersona,
  } = useChatStore();
  const { user } = useAuthStore();
  const imageGenerationEnabled = useAppStore(
    state => state.preferences.imageGenSettings?.enabled === true
  );
  const {
    sendMessage,
    stopGeneration,
    regenerateLastMessage,
    editAndResendMessage,
    selectBranch,
    isStreaming,
    streamingMessage,
    streamingThinking,
    streamingMessageId,
    toolActivities,
  } = useChat(currentSession?.id || '');
  const currentPersona = getCurrentPersona();
  const selectedModelState = useMemo(
    () => ({
      model: selectedModel,
      providerType: selectedProviderType,
      providerId: selectedProviderId,
    }),
    [selectedModel, selectedProviderId, selectedProviderType]
  );
  const welcomeModels = useMemo(
    () => withUnavailableChatModel(models, selectedModelState),
    [models, selectedModelState]
  );
  const selectedModelKey = selectedModel
    ? chatModelSelectionKeyForModels(welcomeModels, selectedModelState)
    : '';
  const selectedModelAvailable = isChatModelSelectionAvailable(
    models,
    selectedModelState
  );
  const incognitoRequested =
    new URLSearchParams(location.search).get('incognito') === '1';

  const [welcomePromptIndex, setWelcomePromptIndex] = useState(
    getWelcomePromptIndex
  );
  // Keyed by session so switching chats naturally hides stale suggestions.
  const [followUps, setFollowUps] = useState<{
    sessionId: string;
    suggestions: string[];
  } | null>(null);
  const [controlsOpen, setControlsOpen] = useState(false);
  const followUpsEnabled = useAppStore(
    state => state.preferences.showFollowUpSuggestions !== false
  );
  const lastFollowUpFetchRef = useRef<string | null>(null);
  const wasStreamingRef = useRef(false);

  // Fetch follow-up suggestions when a response finishes streaming.
  useEffect(() => {
    const sessionId = currentSession?.id;
    const streamingJustEnded = wasStreamingRef.current && !isStreaming;
    wasStreamingRef.current = isStreaming;

    if (!sessionId || isStreaming) return;
    if (!followUpsEnabled || currentSession?.isPrivate) return;
    if (!streamingJustEnded) return;

    const lastMessage =
      currentSession.messages[currentSession.messages.length - 1];
    if (
      !lastMessage ||
      lastMessage.role !== 'assistant' ||
      !lastMessage.content.trim()
    ) {
      return;
    }
    if (lastFollowUpFetchRef.current === lastMessage.id) return;
    lastFollowUpFetchRef.current = lastMessage.id;

    let cancelled = false;
    chatApi
      .generateFollowUps(sessionId)
      .then(response => {
        if (cancelled || !response.success) return;
        // Ignore stale results if the user already moved on.
        const state = useChatStore.getState();
        if (state.currentSession?.id !== sessionId) return;
        setFollowUps({
          sessionId,
          suggestions: response.data?.suggestions ?? [],
        });
      })
      .catch(() => {
        // Suggestions are decorative; failures stay silent.
      });
    return () => {
      cancelled = true;
    };
  }, [isStreaming, currentSession, followUpsEnabled]);

  const followUpSuggestions =
    followUps && followUps.sessionId === currentSession?.id
      ? followUps.suggestions
      : [];

  const welcomePrompt = useMemo(
    () =>
      getWelcomePrompt(
        welcomePromptIndex,
        user?.username,
        t,
        isRTL(i18n.language)
      ),
    [i18n.language, t, user?.username, welcomePromptIndex]
  );

  // Welcome screen state
  const [welcomeMessage, setWelcomeMessage] = useState('');
  const [welcomeImages, setWelcomeImages] = useState<string[]>([]);
  // Web search from the very first message: same permission-driven toggle
  // as the in-session composer.
  const [welcomeWebSearchAllowed, setWelcomeWebSearchAllowed] = useState(false);
  const [welcomeWebSearch, setWelcomeWebSearch] = useState(false);
  const [welcomeUploadingDocument, setWelcomeUploadingDocument] =
    useState(false);
  const welcomeDocumentInputRef = useRef<HTMLInputElement>(null);

  // Documents attached before the first message are user-scoped; retrieval
  // picks them up for the session created on send.
  const handleWelcomeDocumentSelected = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setWelcomeUploadingDocument(true);
    try {
      const response = await documentsApi.uploadDocument(file);
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
      setWelcomeUploadingDocument(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    searchApi
      .getConfig()
      .then(response => {
        if (!cancelled && response.success && response.data) {
          setWelcomeWebSearchAllowed(response.data.allowed);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const [showWelcomeAdvanced, setShowWelcomeAdvanced] = useState(false);
  const welcomeTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const handleWelcomePromptChange = () => {
      setWelcomePromptIndex(getWelcomePromptIndex());
    };

    window.addEventListener(
      WELCOME_PROMPT_CHANGE_EVENT,
      handleWelcomePromptChange
    );
    return () =>
      window.removeEventListener(
        WELCOME_PROMPT_CHANGE_EVENT,
        handleWelcomePromptChange
      );
  }, []);

  // Image generation state
  const [hasImageGenPlugins, setHasImageGenPlugins] = useState(false);
  const showImageGeneration = imageGenerationEnabled && hasImageGenPlugins;

  const startPrivateSession = useCallback(
    (notifyWhenUnavailable = true) => {
      const privateSelection = selectedModel
        ? selectedModelState
        : models[0]
          ? chatModelSelectionFromModel(models[0])
          : null;
      if (
        !privateSelection ||
        !isChatModelSelectionAvailable(models, privateSelection)
      ) {
        if (notifyWhenUnavailable) {
          toast.error(t('chat.model.selectBeforePrivateChat'));
        }
        return false;
      }

      const now = Date.now();
      setCurrentSession({
        id: `private-${now}`,
        title: t('chat.session.incognito', 'Incognito Chat'),
        model: privateSelection.model,
        providerType: privateSelection.providerType,
        providerId: privateSelection.providerId,
        messages: [],
        createdAt: now,
        updatedAt: now,
        isPrivate: true,
      });
      return true;
    },
    [models, selectedModel, selectedModelState, setCurrentSession, t]
  );

  // Load sessions on mount
  useEffect(() => {
    if (sessions.length === 0) {
      loadSessions();
    }
  }, [loadSessions, sessions.length]); // Include both dependencies

  useEffect(() => {
    if (!incognitoRequested || currentSession?.isPrivate) return;
    startPrivateSession(false);
  }, [currentSession?.isPrivate, incognitoRequested, startPrivateSession]);

  // Check for available image generation plugins
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

  // Handle URL session parameter
  useEffect(() => {
    const handleSessionFromUrl = () => {
      // Check if we should force welcome screen (from sidebar click)
      const forceWelcome = sessionStorage.getItem('forceWelcomeScreen');
      if (forceWelcome) {
        sessionStorage.removeItem('forceWelcomeScreen');
        return; // Don't load any session, show welcome screen
      }

      // Keep an incognito session on the unsaved /chat route, but allow an
      // explicit saved-session URL to leave incognito mode.
      if (currentSession?.isPrivate && !sessionId) {
        return;
      }

      // Only proceed if sessions are loaded
      if (sessions.length === 0) {
        return; // Sessions not loaded yet, wait for them
      }

      if (sessionId) {
        // Find the session in the loaded sessions
        const foundSession = sessions.find(s => s.id === sessionId);
        if (foundSession && foundSession.id !== currentSession?.id) {
          setCurrentSession(foundSession);
        } else if (!foundSession) {
          // Session not found for this user, redirect to most recent session or root
          logger.warn(
            `Session ${sessionId} not found for current user, redirecting...`
          );
          if (sessions.length > 0) {
            navigate(`/c/${sessions[0].id}`, { replace: true });
          } else {
            navigate('/', { replace: true });
          }
        }
      } else if (
        !sessionId &&
        sessions.length > 0 &&
        location.pathname === '/'
      ) {
        // No sessionId in URL but we have sessions, redirect to the most recent session
        // Only redirect from root path (/), not from /chat (which should show welcome screen)
        navigate(`/c/${sessions[0].id}`, { replace: true });
      }
    };

    handleSessionFromUrl();
  }, [
    sessionId,
    sessions,
    setCurrentSession,
    navigate,
    currentSession?.id,
    currentSession?.isPrivate,
    location.pathname,
  ]);

  // Note: Persona backgrounds are handled locally in this component's JSX
  // and should NOT set the global backgroundImage state, which is for user-configured
  // backgrounds in settings. Persona backgrounds only apply to the current chat view.

  // Check for pending message from welcome screen and send it
  useEffect(() => {
    if (currentSession?.id) {
      const pendingMessageStr = sessionStorage.getItem('pendingMessage');
      if (pendingMessageStr) {
        sessionStorage.removeItem('pendingMessage');
        try {
          const pendingMessage = JSON.parse(pendingMessageStr) as {
            content: string;
            images?: string[];
            webSearch?: boolean;
          };
          // Small delay to ensure WebSocket handlers are set up
          setTimeout(() => {
            sendMessage(
              pendingMessage.content,
              pendingMessage.images,
              undefined,
              pendingMessage.webSearch === true
            );
          }, 100);
        } catch (e) {
          logger.error('Failed to parse pending message:', e);
        }
      }
    }
  }, [currentSession?.id, sendMessage]);

  // Auto-resize welcome textarea
  useEffect(() => {
    const textarea = welcomeTextareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      // An empty box keeps its natural height: Chromium counts the wrapped
      // placeholder in scrollHeight, which would grow the bar on narrow
      // screens before anything has been typed.
      textarea.style.height = welcomeMessage
        ? `${Math.min(textarea.scrollHeight, 200)}px`
        : '';
    }
  }, [welcomeMessage]);

  const _handleCreateSession = async () => {
    if (selectedModel) {
      const newSession = await createSession(
        selectedModel,
        undefined,
        selectedModel.startsWith('persona:')
          ? selectedModel.slice('persona:'.length)
          : undefined,
        selectedProviderType,
        selectedProviderId
      );
      if (newSession) {
        navigate(`/c/${newSession.id}`, { replace: true });
      }
    }
  };

  // Handle welcome screen message submission
  const handleWelcomeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!welcomeMessage.trim() || !selectedModel) return;
    if (!selectedModelAvailable) {
      toast.error(t('chat.model.selectBeforeSending'));
      return;
    }

    triggerHapticFeedback('impact');

    // Store the pending message in sessionStorage before creating session
    // This allows the new session page to pick it up and send it
    const pendingMessage = {
      content: welcomeMessage.trim(),
      images: welcomeImages.length > 0 ? welcomeImages : undefined,
      webSearch: welcomeWebSearchAllowed && welcomeWebSearch ? true : undefined,
    };
    sessionStorage.setItem('pendingMessage', JSON.stringify(pendingMessage));

    // Clear local state
    setWelcomeMessage('');
    setWelcomeImages([]);
    setWelcomeWebSearch(false);

    // Create a new session and navigate to it
    const newSession = await createSession(
      selectedModel,
      undefined,
      selectedModel.startsWith('persona:')
        ? selectedModel.slice('persona:'.length)
        : undefined,
      selectedProviderType,
      selectedProviderId
    );
    if (newSession) {
      // Carry the settings chosen before the session existed onto it.
      await applyDraftSessionSettings(newSession);
      navigate(`/c/${newSession.id}`, { replace: true });
    }
  };

  /**
   * Moves the welcome screen's draft settings onto a newly created session:
   * its system prompt as the leading message, its sampling as session
   * overrides. Cleared afterwards so the next new chat starts fresh.
   */
  const applyDraftSessionSettings = useCallback(
    async (session: ChatSession) => {
      const draft = useChatStore.getState().draftSessionSettings;
      const prompt = draft.systemPrompt?.trim();
      const options = draft.generationOptions;

      if (!prompt && !options) return;

      const messages = prompt
        ? [
            {
              id: generateId(),
              role: 'system' as const,
              content: prompt,
              timestamp: Date.now(),
            },
            ...session.messages.filter(message => message.role !== 'system'),
          ]
        : session.messages;

      try {
        const response = await chatApi.updateSession(session.id, {
          messages,
          settings: options ? { generationOptions: options } : undefined,
        } as Partial<ChatSession>);

        if (response.success && response.data) {
          const updated = response.data;
          useChatStore.setState(state => ({
            sessions: state.sessions.map(item =>
              item.id === updated.id ? updated : item
            ),
            currentSession:
              state.currentSession?.id === updated.id
                ? updated
                : state.currentSession,
          }));
        }
      } catch (error) {
        logger.error('Failed to apply chat settings to the new session', error);
      } finally {
        useChatStore.getState().setDraftSessionSettings({});
      }
    },
    []
  );

  const handleWelcomeKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleWelcomeSubmit(e);
    }
  };

  const handleModelChange = async (
    event: React.ChangeEvent<HTMLSelectElement>
  ) => {
    const selection = chatModelSelectionFromKey(
      welcomeModels,
      event.target.value
    );
    if (!selection) return;
    setSelectedModel(
      selection.model,
      selection.providerType,
      selection.providerId
    );
    // Don't auto-create session on model change, let user click "New Chat"
  };

  const handleSendMessage = (
    message: string,
    images?: string[],
    format?: string | Record<string, unknown>,
    webSearch?: boolean
  ) => {
    if (!currentSession) return;
    triggerHapticFeedback('impact');
    setFollowUps(null);
    sendMessage(message, images, format, webSearch);
  };

  // --- Floating chat overlay -----------------------------------------------
  // Rendered from this page so it reuses the useChat instance above; a second
  // hook instance would silently steal the WebSocket message handlers.
  const chatOverlayOpen = useAppStore(state => state.chatOverlayOpen);
  const setChatOverlayOpen = useAppStore(state => state.setChatOverlayOpen);
  const [overlayPosition, setOverlayPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [overlayDragging, setOverlayDragging] = useState(false);
  const overlayPointerIdRef = useRef<number | null>(null);
  const overlayFrameRef = useRef<number | null>(null);
  const overlayPendingRef = useRef({ x: 0, y: 0 });
  const overlayDragStartRef = useRef({ pointerX: 0, pointerY: 0, x: 0, y: 0 });

  const effectiveOverlayPosition = overlayPosition ?? {
    x: CHAT_OVERLAY_MARGIN,
    y: Math.max(
      CHAT_OVERLAY_MARGIN,
      window.innerHeight - CHAT_OVERLAY_HEIGHT - CHAT_OVERLAY_MARGIN
    ),
  };

  const clampOverlayPosition = useCallback((x: number, y: number) => {
    const maxX = window.innerWidth - CHAT_OVERLAY_WIDTH - 8;
    const maxY = window.innerHeight - 56;
    return {
      x: Math.min(Math.max(x, 8), Math.max(8, maxX)),
      y: Math.min(Math.max(y, 8), Math.max(8, maxY)),
    };
  }, []);

  const scheduleOverlayPosition = useCallback(
    (position: { x: number; y: number }) => {
      overlayPendingRef.current = position;
      if (overlayFrameRef.current !== null) return;
      overlayFrameRef.current = window.requestAnimationFrame(() => {
        overlayFrameRef.current = null;
        setOverlayPosition(overlayPendingRef.current);
      });
    },
    []
  );

  const handleOverlayDragEnd = useCallback(() => {
    overlayPointerIdRef.current = null;
    setOverlayDragging(false);
    if (overlayFrameRef.current !== null) {
      window.cancelAnimationFrame(overlayFrameRef.current);
      overlayFrameRef.current = null;
      setOverlayPosition(overlayPendingRef.current);
    }
  }, []);

  const handleOverlayDragMove = useCallback(
    (e: PointerEvent) => {
      if (
        overlayPointerIdRef.current === null ||
        e.pointerId !== overlayPointerIdRef.current
      ) {
        return;
      }
      e.preventDefault();
      const start = overlayDragStartRef.current;
      scheduleOverlayPosition(
        clampOverlayPosition(
          start.x + e.clientX - start.pointerX,
          start.y + e.clientY - start.pointerY
        )
      );
    },
    [clampOverlayPosition, scheduleOverlayPosition]
  );

  const handleOverlayDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const position = effectiveOverlayPosition;
    overlayPointerIdRef.current = e.pointerId;
    overlayDragStartRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      x: position.x,
      y: position.y,
    };
    overlayPendingRef.current = position;
    e.currentTarget.setPointerCapture(e.pointerId);
    setOverlayDragging(true);
  };

  useEffect(() => {
    if (!overlayDragging) return undefined;

    const handlePointerEnd = (e: PointerEvent) => {
      if (
        overlayPointerIdRef.current === null ||
        e.pointerId === overlayPointerIdRef.current
      ) {
        handleOverlayDragEnd();
      }
    };

    window.addEventListener('pointermove', handleOverlayDragMove, {
      passive: false,
    });
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
    window.addEventListener('blur', handleOverlayDragEnd);
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('pointermove', handleOverlayDragMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
      window.removeEventListener('blur', handleOverlayDragEnd);
      document.body.style.userSelect = '';
    };
  }, [overlayDragging, handleOverlayDragMove, handleOverlayDragEnd]);

  if (!currentSession) {
    const hasAdvancedFeatures = welcomeImages.length > 0;

    return (
      <div className='flex h-full min-h-0 flex-1'>
        <div className='relative h-full min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-20 sm:px-8 sm:py-24'>
          <div
            aria-hidden='true'
            className='pointer-events-none absolute inset-0'
          >
            <div className='absolute left-[12%] top-[18%] h-56 w-56 rounded-full bg-primary-500/[0.035] blur-3xl dark:bg-primary-400/[0.04]' />
            <div className='absolute bottom-[16%] right-[10%] h-72 w-72 rounded-full bg-gray-900/[0.025] blur-3xl dark:bg-white/[0.025]' />
            <div className='absolute left-1/2 top-0 h-16 w-px bg-gray-300/60 dark:bg-white/10' />
          </div>

          {/* Chat controls, on the outer side of the private mode button */}
          <button
            onClick={() => setControlsOpen(open => !open)}
            className={cn(
              'absolute end-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-black/[0.07] bg-surface/65 text-gray-500 backdrop-blur-md transition-colors duration-150 hover:bg-surface-raised hover:text-gray-950 dark:border-white/[0.08] dark:bg-dark-200/65 dark:text-dark-600 dark:hover:bg-dark-200 dark:hover:text-dark-950 sm:end-6 sm:top-6',
              controlsOpen && 'text-primary-600 dark:text-primary-400'
            )}
            title={t('chat.controls.title')}
            aria-expanded={controlsOpen}
          >
            <SlidersHorizontal className='h-4 w-4' />
          </button>

          {/* Private Mode Button - Top Right Corner */}
          <button
            onClick={() => startPrivateSession()}
            disabled={
              (!selectedModel && models.length === 0) ||
              (Boolean(selectedModel) && !selectedModelAvailable)
            }
            className='absolute end-[3.75rem] top-4 z-10 flex items-center gap-2 rounded-full border border-black/[0.07] bg-surface/65 px-3 py-2 text-xs font-medium text-gray-500 backdrop-blur-md transition-colors duration-150 hover:bg-surface-raised hover:text-gray-950 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.08] dark:bg-dark-200/65 dark:text-dark-600 dark:hover:bg-dark-200 dark:hover:text-dark-950 sm:end-[4.25rem] sm:top-6'
            title={t('chat.session.privateTooltip')}
          >
            <Ghost className='h-3.5 w-3.5' />
            <span>{t('chat.session.incognito', 'Incognito Chat')}</span>
          </button>

          <div className='relative z-[1] mx-auto flex min-h-full w-full max-w-3xl flex-col items-center justify-center'>
            <div
              key={welcomePrompt.id}
              className='mb-8 flex flex-col items-center text-center animate-fade-in sm:mb-10'
              aria-live='polite'
            >
              <div className='mb-3 flex items-center justify-center gap-3'>
                <LogoMark
                  size='sm'
                  label={null}
                  className='h-9 w-9 shrink-0 p-0 text-ink'
                />
                <h1 className='max-w-3xl text-balance text-[clamp(1.75rem,3.5vw,2.35rem)] font-medium leading-tight tracking-[-0.02em] text-ink rtl:tracking-normal'>
                  {welcomePrompt.title}
                </h1>
              </div>
              <p className='max-w-xl text-balance text-[15px] leading-relaxed text-ink-subtle'>
                {welcomePrompt.subtitle}
              </p>
            </div>

            {welcomeModels.length > 0 ? (
              <div className='w-full'>
                {/* Advanced Features Panel */}
                {showWelcomeAdvanced && (
                  <div className='mb-3 animate-slide-up rounded-2xl border border-black/[0.07] bg-surface/80 p-4 shadow-sm backdrop-blur-xl dark:border-white/[0.08] dark:bg-dark-200/80'>
                    <ImageUpload
                      images={welcomeImages}
                      onImagesChange={setWelcomeImages}
                      maxImages={5}
                    />
                    <div className='mt-3 flex items-center justify-between gap-3 border-t border-black/[0.06] pt-3 dark:border-white/[0.07]'>
                      <span className='text-xs text-gray-500 dark:text-dark-500'>
                        {t('chat.input.menu.attachDocument')}
                      </span>
                      <Button
                        type='button'
                        size='sm'
                        variant='outline'
                        disabled={welcomeUploadingDocument}
                        onClick={() => welcomeDocumentInputRef.current?.click()}
                        className='shrink-0 whitespace-nowrap'
                      >
                        <Paperclip className='h-3.5 w-3.5' />
                        <span className='ms-1.5'>
                          {welcomeUploadingDocument
                            ? t('documents.uploading')
                            : t('chat.input.menu.attach')}
                        </span>
                      </Button>
                      <input
                        ref={welcomeDocumentInputRef}
                        type='file'
                        accept='.pdf,.txt'
                        className='hidden'
                        onChange={event =>
                          void handleWelcomeDocumentSelected(event)
                        }
                      />
                    </div>
                  </div>
                )}

                {/* Floating composer card: text row on top, controls below. */}
                <form onSubmit={handleWelcomeSubmit}>
                  <div
                    className={cn(
                      'rounded-[24px] border p-2.5 transition-[border-color,box-shadow,background-color] duration-200',
                      'border-black/[0.08] bg-surface dark:border-white/[0.09] dark:bg-surface-subtle',
                      'shadow-lv2 focus-within:shadow-lv3'
                    )}
                  >
                    {/* Text Input */}
                    <CodeAwareTextarea
                      ref={welcomeTextareaRef}
                      value={welcomeMessage}
                      onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                        setWelcomeMessage(e.target.value)
                      }
                      onKeyDown={handleWelcomeKeyDown}
                      placeholder={t('chat.input.messagePlaceholder')}
                      className='!m-0 block w-full min-h-9 max-h-[160px] resize-none !rounded-none !border-0 !bg-transparent !px-2 !pt-1.5 !pb-2 !shadow-none scrollbar-thin scrollbar-thumb-gray-300 placeholder:text-ink-subtle focus:!border-0 focus:!bg-transparent focus:!shadow-none focus:!ring-0 dark:scrollbar-thumb-dark-400 text-[0.9375rem] leading-relaxed touch-manipulation'
                      rows={1}
                    />

                    {/* Controls row */}
                    <div className='flex items-center gap-1.5'>
                      <Button
                        type='button'
                        variant='ghost'
                        size='sm'
                        onClick={() =>
                          setShowWelcomeAdvanced(!showWelcomeAdvanced)
                        }
                        className={cn(
                          'h-9 w-9 !p-0 rounded-full flex-shrink-0',
                          'bg-surface-subtle text-ink-muted hover:bg-hover-solid hover:text-ink dark:bg-surface-raised dark:hover:bg-surface-overlay transition-colors touch-manipulation',
                          hasAdvancedFeatures &&
                            'text-primary-600 dark:text-primary-400',
                          showWelcomeAdvanced && 'bg-hover-solid text-ink'
                        )}
                        title={t('chat.input.attachImages')}
                      >
                        {hasAdvancedFeatures ? (
                          <div className='relative flex items-center justify-center'>
                            <Paperclip className='h-4 w-4' />
                            <div className='absolute -top-0.5 -end-0.5 h-1.5 w-1.5 bg-primary-500 rounded-full' />
                          </div>
                        ) : showWelcomeAdvanced ? (
                          <Minus className='h-4 w-4' />
                        ) : (
                          <Plus className='h-4 w-4' />
                        )}
                      </Button>

                      {welcomeWebSearchAllowed && (
                        <Button
                          type='button'
                          variant='ghost'
                          size='sm'
                          onClick={() => setWelcomeWebSearch(active => !active)}
                          className={cn(
                            'h-9 w-9 p-0 rounded-full flex-shrink-0 flex items-center justify-center',
                            'text-ink-muted hover:bg-interactive-hover hover:text-ink',
                            'transition-colors duration-150 touch-manipulation',
                            welcomeWebSearch &&
                              'bg-primary-50 text-primary-600 dark:bg-primary-900/25 dark:text-primary-400'
                          )}
                          title={
                            welcomeWebSearch
                              ? t('chat.input.webSearchOn')
                              : t('chat.input.webSearchOff')
                          }
                          aria-pressed={welcomeWebSearch}
                        >
                          <Globe className='h-4 w-4' />
                        </Button>
                      )}

                      <div className='min-w-0 flex-1' />

                      {/* Model selector pill */}
                      <div className='hidden sm:block'>
                        <ModelSelector
                          models={welcomeModels}
                          selectedModel={selectedModelKey}
                          onModelChange={handleModelChange}
                          getModelValue={chatModelOptionKey}
                          className='min-w-[140px] max-w-[210px]'
                          compact
                          showImageGen={showImageGeneration}
                        />
                      </div>

                      {/* Send: circular accent button */}
                      <Button
                        type='submit'
                        variant='ghost'
                        size='sm'
                        disabled={
                          !welcomeMessage.trim() ||
                          !selectedModel ||
                          !selectedModelAvailable
                        }
                        className={cn(
                          'h-9 w-9 p-0 rounded-full flex-shrink-0 flex items-center justify-center',
                          'bg-primary-500 text-white hover:bg-primary-400',
                          'disabled:bg-primary-300/50 disabled:text-white/80 dark:disabled:bg-primary-800/60 dark:disabled:text-white/40 disabled:hover:bg-primary-300/50 dark:disabled:hover:bg-primary-800/60',
                          'transition-colors duration-150 touch-manipulation'
                        )}
                        title={t('chat.input.sendMessage')}
                      >
                        <ArrowUp className='h-4 w-4' />
                      </Button>
                    </div>
                  </div>
                </form>

                {/* Mobile model selector */}
                <div className='sm:hidden mt-4'>
                  <ModelSelector
                    models={welcomeModels}
                    selectedModel={selectedModelKey}
                    onModelChange={handleModelChange}
                    getModelValue={chatModelOptionKey}
                    className='w-full'
                    compact
                    showImageGen={showImageGeneration}
                  />
                </div>

                <p className='mt-4 text-center text-[10px] leading-relaxed text-gray-400 dark:text-dark-500'>
                  {t('chat.footer.disclaimer')}
                </p>
              </div>
            ) : (
              <div className='w-full max-w-lg'>
                <div className='rounded-2xl border border-black/[0.07] bg-surface/70 p-6 backdrop-blur-xl dark:border-white/[0.08] dark:bg-dark-200/70'>
                  <p className='mb-4 text-sm leading-relaxed text-gray-600 dark:text-dark-700'>
                    {t('chat.model.noModelsDescription')}
                  </p>
                  <code className='block rounded-xl bg-gray-100 p-3 font-mono text-xs text-gray-800 dark:bg-dark-300 dark:text-dark-700'>
                    {t('chat.model.pullCommand')}
                  </code>
                </div>
              </div>
            )}
          </div>
        </div>

        <ChatControlsPanel
          draftModel={selectedModel}
          open={controlsOpen}
          onClose={() => setControlsOpen(false)}
        />
      </div>
    );
  }

  return (
    <div
      className='relative flex h-full flex-col'
      style={
        currentPersona?.background
          ? {
              backgroundImage: `url(${currentPersona.background})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              backgroundRepeat: 'no-repeat',
            }
          : undefined
      }
    >
      {/* Background overlay for better readability when persona background is active */}
      {currentPersona?.background && (
        <div className='absolute inset-0 bg-gray-50/[0.88] backdrop-blur-sm dark:bg-dark-100/[0.88]' />
      )}

      <div className='relative z-10 flex h-full flex-col'>
        {/* Private mode indicator */}
        {currentSession?.isPrivate && (
          <div className='flex-shrink-0 border-b border-black/[0.05] bg-surface/55 px-4 py-2 backdrop-blur-xl dark:border-white/[0.06] dark:bg-dark-100/55'>
            <div className='flex items-center justify-center gap-2 text-gray-500 dark:text-dark-600'>
              <Ghost className='h-3.5 w-3.5' />
              <span className='text-xs font-medium'>
                {t('chat.session.privateMode')}
              </span>
              <span className='hidden text-[11px] text-gray-400 dark:text-dark-500 sm:inline'>
                — {t('chat.session.privateDescription')}
              </span>
            </div>
          </div>
        )}
        {/* Persona indicator header */}
        {currentPersona && !currentSession?.isPrivate && (
          <div className='flex-shrink-0 border-b border-black/[0.05] bg-surface/55 px-4 py-2 backdrop-blur-xl dark:border-white/[0.06] dark:bg-dark-100/55'>
            <PersonaIndicator
              persona={currentPersona}
              onClear={() => {
                if (!currentSession) return;
                void chatApi
                  .updateSession(currentSession.id, {
                    model: currentPersona.model,
                    providerType: 'ollama',
                    providerId: null,
                    personaId: null,
                  })
                  .then(response => {
                    if (!response.success || !response.data) {
                      throw new Error(
                        response.error || 'Failed to remove persona'
                      );
                    }
                    useChatStore.setState(state => ({
                      sessions: state.sessions.map(session =>
                        session.id === currentSession.id
                          ? response.data!
                          : session
                      ),
                      currentSession: response.data!,
                    }));
                  })
                  .catch(error => {
                    logger.error('Failed to remove persona:', error);
                    toast.error(t('chat.persona.removeFailed'));
                  });
              }}
            />
          </div>
        )}
        <div className='flex min-h-0 flex-1'>
          <div className='relative flex min-w-0 flex-1 flex-col'>
            <button
              onClick={() => setControlsOpen(open => !open)}
              className={cn(
                'absolute end-3 top-3 z-20 flex h-8 w-8 items-center justify-center rounded-full border border-black/[0.07] bg-surface/65 text-gray-500 backdrop-blur-md transition-colors duration-150 hover:bg-surface-raised hover:text-gray-950 dark:border-white/[0.08] dark:bg-dark-200/65 dark:text-dark-600 dark:hover:bg-dark-200 dark:hover:text-dark-950',
                controlsOpen && 'text-primary-600 dark:text-primary-400'
              )}
              title={t('chat.controls.title')}
              aria-expanded={controlsOpen}
            >
              <SlidersHorizontal className='h-3.5 w-3.5' />
            </button>
            <ChatMessages
              messages={currentSession.messages}
              streamingMessage={streamingMessage}
              streamingThinking={streamingThinking}
              streamingMessageId={streamingMessageId}
              isStreaming={isStreaming}
              toolActivities={toolActivities}
              onRegenerate={regenerateLastMessage}
              onSelectBranch={selectBranch}
              onEditResend={editAndResendMessage}
              followUpSuggestions={followUpSuggestions}
              onFollowUpSelect={suggestion => handleSendMessage(suggestion)}
              className='flex-1'
            />
            <ChatInput
              onSendMessage={handleSendMessage}
              onStopGeneration={stopGeneration}
              disabled={!currentSession}
            />
          </div>
          {currentSession && <ChatSourcesPanel session={currentSession} />}
          <ChatControlsPanel
            session={currentSession}
            open={controlsOpen}
            onClose={() => setControlsOpen(false)}
          />
        </div>
      </div>

      {chatOverlayOpen &&
        createPortal(
          <>
            {/* Transparent shield: iframes (artifact sandboxes) would
                otherwise swallow pointermove events during the drag. */}
            {overlayDragging && (
              <div
                className='fixed inset-0 z-[65] cursor-grabbing select-none'
                aria-hidden='true'
              />
            )}
            <div
              data-testid='floating-chat-overlay'
              className='fixed z-[70] flex w-[380px] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-2xl border border-black/[0.08] bg-surface shadow-2xl dark:border-white/[0.1] dark:bg-dark-25'
              style={{
                left: effectiveOverlayPosition.x,
                top: effectiveOverlayPosition.y,
                height: `min(${CHAT_OVERLAY_HEIGHT}px, calc(100dvh - 1rem))`,
              }}
            >
              <div
                onPointerDown={handleOverlayDragStart}
                className={cn(
                  'flex shrink-0 touch-none select-none items-center justify-between border-b border-black/[0.06] bg-gray-50 px-3 py-2 dark:border-white/[0.07] dark:bg-dark-100/50',
                  overlayDragging ? 'cursor-grabbing' : 'cursor-grab'
                )}
              >
                <div className='flex min-w-0 items-center gap-2 text-gray-500 dark:text-dark-600'>
                  <GripVertical className='h-3.5 w-3.5 shrink-0' />
                  <span className='truncate text-xs font-medium'>
                    {t('chat.overlay.title')}
                  </span>
                </div>
                <button
                  type='button'
                  onClick={() => setChatOverlayOpen(false)}
                  onPointerDown={e => e.stopPropagation()}
                  aria-label={t('chat.overlay.close')}
                  title={t('chat.overlay.close')}
                  className='flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-black/[0.06] hover:text-gray-700 dark:hover:bg-white/[0.08] dark:hover:text-dark-800'
                >
                  <X className='h-3.5 w-3.5' />
                </button>
              </div>
              <ChatMessages
                messages={currentSession.messages}
                streamingMessage={streamingMessage}
                streamingThinking={streamingThinking}
                streamingMessageId={streamingMessageId}
                isStreaming={isStreaming}
                toolActivities={toolActivities}
                onRegenerate={regenerateLastMessage}
                onSelectBranch={selectBranch}
                onEditResend={editAndResendMessage}
                className='min-h-0 flex-1'
              />
              <ChatInput
                onSendMessage={handleSendMessage}
                onStopGeneration={stopGeneration}
                disabled={!currentSession}
              />
            </div>
          </>,
          document.body
        )}
    </div>
  );
};

export default ChatPage;
