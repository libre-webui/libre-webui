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

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { personaApi } from '@/utils/api';
import { Persona } from '@/types';
import toast from 'react-hot-toast';
import PersonaCard from './PersonaCard';
import PersonaForm from './PersonaForm';
import PersonaImportExport from './PersonaImportExport';

export const PersonaManager: React.FC = () => {
  const { t } = useTranslation();
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingPersona, setEditingPersona] = useState<Persona | null>(null);
  const [showImportExport, setShowImportExport] = useState(false);

  // Load personas
  const loadPersonas = async () => {
    setLoading(true);
    try {
      const response = await personaApi.getPersonas();
      if (response.success) {
        setPersonas(response.data || []);
      } else {
        toast.error(
          t('personaManager.failed', { action: 'load' }) + ': ' + response.error
        );
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(
        t('personaManager.failed', { action: 'load' }) + ': ' + errorMessage
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPersonas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreatePersona = () => {
    setEditingPersona(null);
    setShowCreateForm(true);
  };

  const handleEditPersona = (persona: Persona) => {
    setEditingPersona(persona);
    setShowCreateForm(true);
  };

  const handleDeletePersona = async (persona: Persona) => {
    if (!confirm(t('personaManager.deleteConfirm', { name: persona.name }))) {
      return;
    }

    try {
      const response = await personaApi.deletePersona(persona.id);
      if (response.success) {
        toast.success(
          t('personaManager.deleteSuccess', { name: persona.name })
        );
        await loadPersonas();
      } else {
        toast.error(
          t('personaManager.failed', { action: 'delete' }) +
            ': ' +
            response.error
        );
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(
        t('personaManager.failed', { action: 'delete' }) + ': ' + errorMessage
      );
    }
  };

  const handleDownloadPersona = async (persona: Persona) => {
    try {
      await personaApi.downloadPersona(persona.id, persona.name);
      toast.success(
        t('personaManager.downloadSuccess', { name: persona.name })
      );
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(
        t('personaManager.failed', { action: 'download' }) + ': ' + errorMessage
      );
    }
  };

  const handleFormSubmit = async () => {
    setShowCreateForm(false);
    setEditingPersona(null);
    await loadPersonas();
  };

  const handleFormCancel = () => {
    setShowCreateForm(false);
    setEditingPersona(null);
  };

  if (loading) {
    return (
      <div className='flex items-center justify-center p-8'>
        <div className='text-gray-600 dark:text-dark-600'>
          {t('personaManager.loading')}
        </div>
      </div>
    );
  }

  if (showCreateForm) {
    return (
      <PersonaForm
        persona={editingPersona}
        onSubmit={handleFormSubmit}
        onCancel={handleFormCancel}
      />
    );
  }

  if (showImportExport) {
    return (
      <PersonaImportExport
        personas={personas}
        onImport={loadPersonas}
        onClose={() => setShowImportExport(false)}
      />
    );
  }

  return (
    <div className='space-y-6'>
      {/* Header */}
      <div className='flex items-center justify-between'>
        <div>
          <h1 className='text-2xl font-bold text-gray-900 dark:text-dark-800'>
            {t('personaManager.title')}
          </h1>
          <p className='text-gray-600 dark:text-dark-600 mt-1'>
            {t('personaManager.subtitle')}
          </p>
        </div>
        <div className='flex gap-3'>
          <Button
            onClick={() => setShowImportExport(true)}
            variant='outline'
            className='px-4 py-2'
          >
            {t('personaManager.importExport')}
          </Button>
          <Button onClick={handleCreatePersona} className='px-4 py-2'>
            {t('personaManager.createButton')}
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className='bg-white dark:bg-dark-100 rounded-lg p-6 shadow-sm border border-gray-200 dark:border-dark-300'>
        <div className='flex items-center justify-between'>
          <div>
            <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800'>
              {t('personaManager.stats.title')}
            </h3>
            <p className='text-gray-600 dark:text-dark-600'>
              {t('personaManager.stats.count', { count: personas.length })}
            </p>
          </div>
          <div className='text-3xl font-bold text-gray-900 dark:text-dark-800'>
            {personas.length}
          </div>
        </div>
      </div>

      {/* Personas Grid */}
      {personas.length === 0 ? (
        <div className='bg-white dark:bg-dark-100 rounded-lg p-12 shadow-sm border border-gray-200 dark:border-dark-300 text-center'>
          <div className='text-gray-400 dark:text-dark-500 mb-4'>
            <svg
              className='w-16 h-16 mx-auto'
              fill='none'
              stroke='currentColor'
              viewBox='0 0 24 24'
              xmlns='http://www.w3.org/2000/svg'
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth={2}
                d='M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z'
              />
            </svg>
          </div>
          <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800 mb-2'>
            {t('personaManager.empty.title')}
          </h3>
          <p className='text-gray-600 dark:text-dark-600 mb-6'>
            {t('personaManager.empty.description')}
          </p>
          <Button onClick={handleCreatePersona} className='px-6 py-2'>
            {t('personaManager.empty.button')}
          </Button>
        </div>
      ) : (
        <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6'>
          {personas.map(persona => (
            <PersonaCard
              key={persona.id}
              persona={persona}
              onEdit={handleEditPersona}
              onDelete={handleDeletePersona}
              onDownload={handleDownloadPersona}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default PersonaManager;
