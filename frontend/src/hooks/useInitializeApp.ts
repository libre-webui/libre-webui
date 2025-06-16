import { useEffect } from 'react';
import { useChatStore } from '@/store/chatStore';
import { ollamaApi } from '@/utils/api';
import toast from 'react-hot-toast';

export const useInitializeApp = () => {
  const {
    loadSessions,
    loadModels,
    loadPreferences,
    setSelectedModel,
    models,
  } = useChatStore();

  useEffect(() => {
    const initialize = async () => {
      try {
        // Check Ollama health
        const healthResponse = await ollamaApi.checkHealth();
        if (!healthResponse.success) {
          toast.error(
            "Ollama service is not available. Please make sure it's running."
          );
          return;
        }

        // Load preferences first, then models and sessions
        await loadPreferences();
        await Promise.all([loadModels(), loadSessions()]);
      } catch (error) {
        console.error('Failed to initialize app:', error);
        toast.error('Failed to connect to the backend service');
      }
    };

    initialize();
  }, [loadSessions, loadModels, loadPreferences]);

  // Set default model when models are loaded
  useEffect(() => {
    console.log(
      '🔄 useInitializeApp: models effect triggered, models.length:',
      models.length
    );

    if (models.length > 0) {
      // Check if we already have a selected model from backend preferences
      const { selectedModel: currentSelected } = useChatStore.getState();
      console.log('📋 Current selected model from store:', currentSelected);

      if (currentSelected) {
        // Verify the selected model from backend is still available
        const availableModelNames = models.map(m => m.name);
        console.log('📋 Available models:', availableModelNames);

        if (!availableModelNames.includes(currentSelected)) {
          // Selected model no longer available, use first available
          console.log(
            '⚠️ Selected model not available, falling back to first model:',
            models[0].name
          );
          setSelectedModel(models[0].name);
        } else {
          // Model is available, keep it selected (don't override)
          console.log(
            '✅ Keeping selected model from preferences:',
            currentSelected
          );
        }
      } else {
        // No model selected, use first available
        console.log(
          '⚠️ No model selected, using first available:',
          models[0].name
        );
        setSelectedModel(models[0].name);
      }
    }
  }, [models, setSelectedModel]);
};
