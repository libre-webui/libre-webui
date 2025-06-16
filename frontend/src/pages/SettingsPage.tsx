import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useAppStore } from '@/store/appStore';
import { useChatStore } from '@/store/chatStore';
import { preferencesApi, ollamaApi } from '@/utils/api';
import {
  Settings,
  Monitor,
  Palette,
  MessageSquare,
  Cpu,
  Database,
} from 'lucide-react';
import toast from 'react-hot-toast';

interface SystemInfo {
  ollamaVersion?: string;
  modelsCount: number;
  sessionsCount: number;
  isHealthy: boolean;
}

export const SettingsPage: React.FC = () => {
  const { preferences, setPreferences, setTheme } = useAppStore();
  const { models, sessions, clearAllSessions } = useChatStore();
  const [systemInfo, setSystemInfo] = useState<SystemInfo>({
    modelsCount: 0,
    sessionsCount: 0,
    isHealthy: false,
  });
  const [loading, setLoading] = useState(false);
  const [tempSystemMessage, setTempSystemMessage] = useState(
    preferences.systemMessage
  );

  // Load system information
  useEffect(() => {
    loadSystemInfo();
  }, [models, sessions]);

  const loadSystemInfo = async () => {
    try {
      const [healthResponse, versionResponse] = await Promise.all([
        ollamaApi.checkHealth().catch(() => ({ success: false })),
        ollamaApi.getVersion().catch(() => ({ success: false, data: null })),
      ]);

      setSystemInfo({
        ollamaVersion:
          versionResponse.success && versionResponse.data
            ? versionResponse.data.version
            : undefined,
        modelsCount: models.length,
        sessionsCount: sessions.length,
        isHealthy: healthResponse.success,
      });
    } catch (error) {
      console.error('Failed to load system info:', error);
    }
  };

  const handleUpdatePreferences = async (
    updates: Partial<typeof preferences>
  ) => {
    setLoading(true);
    try {
      const response = await preferencesApi.updatePreferences(updates);
      if (response.success && response.data) {
        setPreferences(response.data);
        toast.success('Settings updated successfully');
      }
    } catch (error: any) {
      toast.error('Failed to update settings: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleThemeChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const mode = event.target.value as 'light' | 'dark';
    const newTheme = { mode };
    setTheme(newTheme);
    handleUpdatePreferences({ theme: newTheme });
  };

  const handleSystemMessageSave = () => {
    handleUpdatePreferences({ systemMessage: tempSystemMessage });
  };

  const handleClearAllSessions = async () => {
    if (
      !window.confirm(
        'Are you sure you want to delete all chat sessions? This action cannot be undone.'
      )
    ) {
      return;
    }

    try {
      await clearAllSessions();
      toast.success('All chat sessions deleted');
      loadSystemInfo();
    } catch (error: any) {
      toast.error('Failed to clear sessions: ' + error.message);
    }
  };

  const handleExportData = () => {
    const data = {
      preferences,
      sessions,
      exportedAt: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `libre-webui-export-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast.success('Data exported successfully');
  };

  return (
    <div className='h-full overflow-auto'>
      <div className='max-w-4xl mx-auto p-6'>
        <div className='mb-8'>
          <h1 className='text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2'>
            Settings
          </h1>
          <p className='text-gray-700 dark:text-gray-300'>
            Configure your Libre WebUI preferences and manage your data.
          </p>
        </div>

        <div className='space-y-8'>
          {/* System Status */}
          <div className='bg-white dark:bg-gray-800 rounded-lg p-6 shadow-sm'>
            <div className='flex items-center gap-3 mb-6'>
              <Monitor className='h-5 w-5 text-blue-600' />
              <h2 className='text-xl font-semibold text-gray-900 dark:text-gray-100'>
                System Status
              </h2>
            </div>

            <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4'>
              <div className='bg-gray-50 dark:bg-gray-700 rounded-lg p-4'>
                <div className='flex items-center gap-2 mb-2'>
                  <div
                    className={`w-3 h-3 rounded-full ${systemInfo.isHealthy ? 'bg-green-500' : 'bg-red-500'}`}
                  />
                  <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                    Ollama Status
                  </span>
                </div>
                <p className='text-lg font-semibold text-gray-900 dark:text-gray-100'>
                  {systemInfo.isHealthy ? 'Healthy' : 'Offline'}
                </p>
                {systemInfo.ollamaVersion && (
                  <p className='text-xs text-gray-500 dark:text-gray-400'>
                    v{systemInfo.ollamaVersion}
                  </p>
                )}
              </div>

              <div className='bg-gray-50 dark:bg-gray-700 rounded-lg p-4'>
                <div className='flex items-center gap-2 mb-2'>
                  <Cpu className='h-3 w-3 text-blue-500' />
                  <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                    Models
                  </span>
                </div>
                <p className='text-lg font-semibold text-gray-900 dark:text-gray-100'>
                  {systemInfo.modelsCount}
                </p>
              </div>

              <div className='bg-gray-50 dark:bg-gray-700 rounded-lg p-4'>
                <div className='flex items-center gap-2 mb-2'>
                  <MessageSquare className='h-3 w-3 text-green-500' />
                  <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                    Chat Sessions
                  </span>
                </div>
                <p className='text-lg font-semibold text-gray-900 dark:text-gray-100'>
                  {systemInfo.sessionsCount}
                </p>
              </div>

              <div className='bg-gray-50 dark:bg-gray-700 rounded-lg p-4'>
                <div className='flex items-center gap-2 mb-2'>
                  <Database className='h-3 w-3 text-purple-500' />
                  <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                    Current Model
                  </span>
                </div>
                <p className='text-sm font-semibold text-gray-900 dark:text-gray-100 truncate'>
                  {preferences.defaultModel || 'Not set'}
                </p>
              </div>
            </div>
          </div>

          {/* Appearance */}
          <div className='bg-white dark:bg-gray-800 rounded-lg p-6 shadow-sm'>
            <div className='flex items-center gap-3 mb-6'>
              <Palette className='h-5 w-5 text-purple-600' />
              <h2 className='text-xl font-semibold text-gray-900 dark:text-gray-100'>
                Appearance
              </h2>
            </div>

            <div className='space-y-4'>
              <div>
                <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                  Theme
                </label>
                <Select
                  value={preferences.theme.mode}
                  onChange={handleThemeChange}
                  options={[
                    { value: 'light', label: 'Light Mode' },
                    { value: 'dark', label: 'Dark Mode' },
                  ]}
                  className='max-w-xs'
                />
              </div>
            </div>
          </div>

          {/* Model Settings */}
          <div className='bg-white dark:bg-gray-800 rounded-lg p-6 shadow-sm'>
            <div className='flex items-center gap-3 mb-6'>
              <Settings className='h-5 w-5 text-gray-600' />
              <h2 className='text-xl font-semibold text-gray-900 dark:text-gray-100'>
                Model Settings
              </h2>
            </div>

            <div className='space-y-4'>
              <div>
                <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                  Default Model
                </label>
                <Select
                  value={preferences.defaultModel}
                  onChange={e =>
                    handleUpdatePreferences({ defaultModel: e.target.value })
                  }
                  options={[
                    { value: '', label: 'Select a model...' },
                    ...models.map(model => ({
                      value: model.name,
                      label: `${model.name} (${(model.size / (1024 * 1024 * 1024)).toFixed(1)}GB)`,
                    })),
                  ]}
                  className='max-w-md'
                  disabled={models.length === 0}
                />
                {models.length === 0 && (
                  <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
                    No models available. Please download models from the Models
                    page.
                  </p>
                )}
              </div>

              <div>
                <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                  System Message
                </label>
                <Textarea
                  value={tempSystemMessage}
                  onChange={e => setTempSystemMessage(e.target.value)}
                  placeholder="Enter a system message to customize the assistant's behavior..."
                  rows={4}
                  className='w-full'
                />
                <div className='flex items-center justify-between mt-2'>
                  <p className='text-xs text-gray-500 dark:text-gray-400'>
                    This message will be sent at the beginning of every
                    conversation.
                  </p>
                  <Button
                    onClick={handleSystemMessageSave}
                    size='sm'
                    disabled={
                      loading || tempSystemMessage === preferences.systemMessage
                    }
                  >
                    Save
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {/* Data Management */}
          <div className='bg-white dark:bg-gray-800 rounded-lg p-6 shadow-sm'>
            <div className='flex items-center gap-3 mb-6'>
              <Database className='h-5 w-5 text-orange-600' />
              <h2 className='text-xl font-semibold text-gray-900 dark:text-gray-100'>
                Data Management
              </h2>
            </div>

            <div className='space-y-4'>
              <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
                <div>
                  <h3 className='text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                    Export Data
                  </h3>
                  <p className='text-xs text-gray-500 dark:text-gray-400 mb-3'>
                    Download your settings and chat history as a JSON file.
                  </p>
                  <Button
                    onClick={handleExportData}
                    variant='outline'
                    size='sm'
                    className='w-full'
                  >
                    Export All Data
                  </Button>
                </div>

                <div>
                  <h3 className='text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                    Clear Sessions
                  </h3>
                  <p className='text-xs text-gray-500 dark:text-gray-400 mb-3'>
                    Delete all chat sessions permanently. This cannot be undone.
                  </p>
                  <Button
                    onClick={handleClearAllSessions}
                    variant='outline'
                    size='sm'
                    className='w-full text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 border-red-200 hover:border-red-300 dark:border-red-800 dark:hover:border-red-700'
                    disabled={sessions.length === 0}
                  >
                    Clear All Sessions ({sessions.length})
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {/* Information */}
          <div className='bg-gray-50 dark:bg-gray-800 rounded-lg p-6'>
            <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4'>
              About Libre WebUI
            </h3>
            <div className='space-y-2 text-sm text-gray-700 dark:text-gray-300'>
              <p>
                <strong>Privacy First:</strong> All your data stays on your
                machine. No telemetry, no tracking.
              </p>
              <p>
                <strong>Open Source:</strong> 100% free and open source software
                licensed under MIT.
              </p>
              <p>
                <strong>Local Inference:</strong> Powered by Ollama for
                completely offline AI inference.
              </p>
              <p className='pt-2 border-t border-gray-200 dark:border-gray-700'>
                <em>
                  &quot;Like Rick Rubin strips music to its essence, Libre WebUI
                  strips away UI complexity. Simple. Minimal. Effective.&quot;
                </em>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;
