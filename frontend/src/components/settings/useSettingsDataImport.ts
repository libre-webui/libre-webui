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

import React, { useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { preferencesApi } from '@/utils/api';
import type {
  ArchiveSectionResult,
  DataArchiveExclusion,
} from '@/utils/api/preferencesApi';
import { parsePortableArchiveJson } from '@/utils/dataArchive';
import type { ChatSession, UserPreferences } from '@/types';

export type ImportMergeStrategy = 'skip' | 'overwrite';

export interface SettingsImportResult {
  preferences: { imported: boolean; error: string | null };
  sessionFolders: ArchiveSectionResult;
  sessions: ArchiveSectionResult;
  knowledgeCollections: ArchiveSectionResult;
  documents: ArchiveSectionResult;
  warnings: string[];
  exclusions: DataArchiveExclusion[];
}

interface UseSettingsDataImportOptions {
  preferences: UserPreferences;
  sessions: ChatSession[];
  loadPreferences: () => Promise<void>;
  loadSessions: () => Promise<void>;
}

export function useSettingsDataImport({
  loadPreferences,
  loadSessions,
}: UseSettingsDataImportOptions) {
  const [importing, setImporting] = useState(false);
  const [showImportOptions, setShowImportOptions] = useState(false);
  const [mergeStrategy, setMergeStrategy] =
    useState<ImportMergeStrategy>('skip');
  const [importResult, setImportResult] = useState<SettingsImportResult | null>(
    null
  );
  const [selectedImportFile, setSelectedImportFile] = useState<File | null>(
    null
  );
  const importFileInputRef = useRef<HTMLInputElement>(null);

  const resetImportState = () => {
    setSelectedImportFile(null);
    if (importFileInputRef.current) {
      importFileInputRef.current.value = '';
    }
  };

  const handleExportData = async () => {
    try {
      const response = await preferencesApi.exportData();
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Export failed');
      }
      const blob = new Blob([JSON.stringify(response.data, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `libre-webui-user-data-v2-${
        new Date().toISOString().split('T')[0]
      }.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success('Portable data archive exported');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Export failed');
    }
  };

  const handleImportFileSelect = (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (file) {
      setSelectedImportFile(file);
      setShowImportOptions(true);
      setImportResult(null);
    }
  };

  const handleConfirmImport = async () => {
    if (!selectedImportFile) return;

    setImporting(true);
    try {
      const fileContent = await selectedImportFile.text();
      parsePortableArchiveJson(fileContent);

      // Preflight uses the same migration, ownership checks, and conflict
      // planner as import, but does not open a write transaction.
      const preflight = await preferencesApi.preflightImport(
        selectedImportFile,
        mergeStrategy
      );
      if (!preflight.success || !preflight.data?.valid) {
        throw new Error(preflight.error || 'Archive validation failed');
      }

      const result = await preferencesApi.importData(
        selectedImportFile,
        mergeStrategy
      );

      if (result.success && result.data) {
        setImportResult({
          preferences: {
            imported: result.data.preferences.imported,
            error: null,
          },
          sessionFolders: result.data.sessionFolders,
          sessions: result.data.sessions,
          knowledgeCollections: result.data.knowledgeCollections,
          documents: result.data.documents,
          warnings: result.data.warnings,
          exclusions: result.data.exclusions,
        });
        toast.success('Portable data archive imported');

        await loadPreferences();
        await loadSessions();
        window.dispatchEvent(new Event('libre:documents-updated'));
      } else {
        throw new Error(result.error || 'Import failed');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Import failed');
      setImportResult(null);
    } finally {
      setImporting(false);
      setShowImportOptions(false);
      resetImportState();
    }
  };

  const handleCancelImport = () => {
    setShowImportOptions(false);
    setImportResult(null);
    resetImportState();
  };

  return {
    importing,
    showImportOptions,
    mergeStrategy,
    setMergeStrategy,
    importResult,
    setImportResult,
    importFileInputRef,
    handleExportData,
    handleImportFileSelect,
    handleConfirmImport,
    handleCancelImport,
  };
}
