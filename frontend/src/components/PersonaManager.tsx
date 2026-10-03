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
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Users } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { LoadingState } from '@/components/ui/LoadingState';
import { personaApi } from '@/utils/api';
import { Persona } from '@/types';
import toast from 'react-hot-toast';
import PersonaCard from './PersonaCard';
import PersonaForm from './PersonaForm';
import PersonaImportExport from './PersonaImportExport';

export const PersonaManager: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingPersona, setEditingPersona] = useState<Persona | null>(null);
  const [showImportExport, setShowImportExport] = useState(false);

  const {
    data: personas = [],
    isLoading: loading,
    isError: loadFailed,
    refetch: refetchPersonas,
  } = useQuery({
    queryKey: ['personas'],
    queryFn: async (): Promise<Persona[]> => {
      const response = await personaApi.getPersonas();
      if (!response.success) {
        throw new Error(response.error || 'Failed to load personas');
      }
      return response.data || [];
    },
  });

  const reloadPersonas = async () => {
    await queryClient.invalidateQueries({ queryKey: ['personas'] });
    await refetchPersonas();
  };

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
        await reloadPersonas();
      } else {
        toast.error(t('personaManager.deleteFailed') + ': ' + response.error);
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(t('personaManager.deleteFailed') + ': ' + errorMessage);
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
      toast.error(t('personaManager.downloadFailed') + ': ' + errorMessage);
    }
  };

  const handleFormSubmit = async (savedPersona: Persona) => {
    setEditingPersona(savedPersona);
    await reloadPersonas();
  };

  const handleFormCancel = () => {
    setShowCreateForm(false);
    setEditingPersona(null);
  };

  if (loading) {
    return <LoadingState label={t('personaManager.loading')} />;
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
        onImport={reloadPersonas}
        onClose={() => setShowImportExport(false)}
      />
    );
  }

  return (
    <div className='space-y-6'>
      <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
        <div className='text-sm text-gray-500 dark:text-dark-500'>
          <span className='font-medium text-gray-900 dark:text-dark-800'>
            {t('personaManager.stats.title')}
          </span>{' '}
          · {t('personaManager.stats.count', { count: personas.length })}
        </div>
        <div className='flex flex-wrap gap-2'>
          <Button
            onClick={() => setShowImportExport(true)}
            variant='outline'
            className='px-4'
          >
            {t('personaManager.importExport')}
          </Button>
          <Button onClick={handleCreatePersona} className='px-4'>
            {t('personaManager.createButton')}
          </Button>
        </div>
      </div>

      {/* Personas Grid */}
      {/* A failed load must not read as "create your first persona". */}
      {loadFailed && personas.length === 0 ? (
        <ErrorState
          message={t('personaManager.loadFailed')}
          onRetry={() => void refetchPersonas()}
        />
      ) : personas.length === 0 ? (
        <EmptyState
          icon={Users}
          titleAs='h3'
          title={t('personaManager.empty.title')}
          description={t('personaManager.empty.description')}
          action={
            <Button onClick={handleCreatePersona} className='px-6 py-2'>
              {t('personaManager.empty.button')}
            </Button>
          }
        />
      ) : (
        <div className='grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3'>
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
