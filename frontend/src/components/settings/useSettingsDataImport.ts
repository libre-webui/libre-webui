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
import type { ChatSession, UserPreferences } from '@/types';

export type ImportMergeStrategy = 'skip' | 'overwrite' | 'merge';

export interface SettingsImportResult {
  preferences: { imported: boolean; error: string | null };
  sessions: { imported: number; skipped: number; errors: string[] };
  documents: { imported: number; skipped: number; errors: string[] };
}

interface UseSettingsDataImportOptions {
  preferences: UserPreferences;
  sessions: ChatSession[];
  loadPreferences: () => Promise<void>;
  loadSessions: () => Promise<void>;
}

export function useSettingsDataImport({
  preferences,
  sessions,
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

  const handleExportData = () => {
    const data = {
      format: 'libre-webui-export',
      version: '1.0',
      preferences,
      sessions,
      documents: [],
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
      const importData = JSON.parse(fileContent);

      if (!importData.format || importData.format !== 'libre-webui-export') {
        throw new Error(
          'Invalid export format. Please use a valid Libre WebUI export file.'
        );
      }

      const result = await preferencesApi.importData(
        importData,
        mergeStrategy === 'overwrite' ? 'replace' : 'merge'
      );

      if (result.success && result.data) {
        setImportResult({
          preferences: { imported: true, error: null },
          sessions: { imported: 0, skipped: 0, errors: [] },
          documents: { imported: 0, skipped: 0, errors: [] },
        });
        toast.success('Data imported successfully');

        await loadPreferences();
        await loadSessions();
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
