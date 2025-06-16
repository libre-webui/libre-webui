import React from 'react';
import { ModelManager } from '@/components/ModelManager';

export const ModelsPage: React.FC = () => {
  return (
    <div className='h-full overflow-auto'>
      <div className='max-w-6xl mx-auto p-6'>
        <div className='mb-8'>
          <h1 className='text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2'>
            Model Management
          </h1>
          <p className='text-gray-700 dark:text-gray-300'>
            Manage your Ollama models, download new ones, and monitor system
            resources.
          </p>
        </div>

        <ModelManager />
      </div>
    </div>
  );
};

export default ModelsPage;
