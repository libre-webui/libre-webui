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
import { useTranslation } from 'react-i18next';
import { preferencesApi } from '@/utils/api';
import type {
  ArchiveSectionResult,
  DataArchiveExclusion,
  DataArchivePreflight,
} from '@/utils/api/preferencesApi';
import { parsePortableArchiveJson } from '@/utils/dataArchive';

export type ImportMergeStrategy = 'skip' | 'overwrite';

export interface SettingsImportResult {
  preferences: { imported: boolean; error: string | null };
  sessionFolders: ArchiveSectionResult;
  sessions: ArchiveSectionResult;
  notes: ArchiveSectionResult;
  knowledgeCollections: ArchiveSectionResult;
  documents: ArchiveSectionResult;
  warnings: string[];
  exclusions: DataArchiveExclusion[];
}

interface UseSettingsDataImportOptions {
  loadPreferences: () => Promise<void>;
  loadSessions: () => Promise<void>;
  loadFolders: () => Promise<void>;
}

export function useSettingsDataImport({
  loadPreferences,
  loadSessions,
  loadFolders,
}: UseSettingsDataImportOptions) {
  const { t } = useTranslation();
  const [importing, setImporting] = useState(false);
  const [preflighting, setPreflighting] = useState(false);
  const [preflight, setPreflight] = useState<DataArchivePreflight | null>(null);
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
  const preflightRequestIdRef = useRef(0);

  const resetImportState = () => {
    preflightRequestIdRef.current += 1;
    setPreflight(null);
    setPreflighting(false);
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
      a.download = `libre-webui-user-data-v3-${
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

  const runPreflight = async (
    file: File,
    strategy: ImportMergeStrategy
  ): Promise<void> => {
    const requestId = preflightRequestIdRef.current + 1;
    preflightRequestIdRef.current = requestId;
    setPreflighting(true);
    setPreflight(null);
    try {
      parsePortableArchiveJson(await file.text());
      const response = await preferencesApi.preflightImport(file, strategy);
      if (!response.success || !response.data?.valid) {
        throw new Error(
          response.error || t('settings.data.archiveValidationFailed')
        );
      }
      if (preflightRequestIdRef.current === requestId) {
        setPreflight(response.data);
      }
    } catch (error) {
      if (preflightRequestIdRef.current === requestId) {
        toast.error(
          error instanceof Error
            ? error.message
            : t('settings.data.archiveValidationFailed')
        );
      }
    } finally {
      if (preflightRequestIdRef.current === requestId) {
        setPreflighting(false);
      }
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
      void runPreflight(file, mergeStrategy);
    }
  };

  const handleMergeStrategyChange = (strategy: ImportMergeStrategy) => {
    setMergeStrategy(strategy);
    if (selectedImportFile) {
      void runPreflight(selectedImportFile, strategy);
    }
  };

  const handleConfirmImport = async () => {
    if (
      !selectedImportFile ||
      !preflight ||
      preflight.strategy !== mergeStrategy
    ) {
      return;
    }

    setImporting(true);
    try {
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
          notes: result.data.notes,
          knowledgeCollections: result.data.knowledgeCollections,
          documents: result.data.documents,
          warnings: result.data.warnings,
          exclusions: result.data.exclusions,
        });
        toast.success('Portable data archive imported');

        const reloads = await Promise.allSettled([
          loadPreferences(),
          loadSessions(),
          loadFolders(),
        ]);
        if (reloads.some(reload => reload.status === 'rejected')) {
          toast.error(t('settings.data.refreshAfterImportFailed'));
        }
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
    preflighting,
    preflight,
    showImportOptions,
    mergeStrategy,
    importResult,
    setImportResult,
    importFileInputRef,
    handleExportData,
    handleImportFileSelect,
    handleMergeStrategyChange,
    handleConfirmImport,
    handleCancelImport,
  };
}
