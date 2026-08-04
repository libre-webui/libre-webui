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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  Eye,
  NotebookPen,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { RichMessageContent } from '@/components/ui/RichMessageContent';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui';
import { notesApi } from '@/utils/api';
import { cn, formatTimestamp } from '@/utils';
import { createLogger } from '@/utils/logger';
import type { Note } from '@/types';

const logger = createLogger('pages:notes');

const AUTOSAVE_DELAY_MS = 800;

export const NotesPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [titleDraft, setTitleDraft] = useState('');
  const [contentDraft, setContentDraft] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'idle'>(
    'idle'
  );
  const saveTimerRef = useRef<number | null>(null);

  const selectedNote = useMemo(
    () => notes.find(note => note.id === selectedId) ?? null,
    [notes, selectedId]
  );

  useEffect(() => {
    let cancelled = false;
    notesApi
      .getNotes()
      .then(response => {
        if (cancelled) return;
        if (response.success && response.data) {
          setNotes(response.data);
        }
      })
      .catch(error => logger.error('Failed to load notes:', error))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectNote = (note: Note) => {
    flushPendingSave();
    setSelectedId(note.id);
    setTitleDraft(note.title);
    setContentDraft(note.content);
    setPreviewing(false);
    setSaveState('idle');
  };

  const scheduleSave = (noteId: string, title: string, content: string) => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    setSaveState('saving');
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void persistNote(noteId, title, content);
    }, AUTOSAVE_DELAY_MS);
  };

  const persistNote = async (
    noteId: string,
    title: string,
    content: string
  ) => {
    try {
      const response = await notesApi.updateNote(noteId, { title, content });
      if (response.success && response.data) {
        const updated = response.data;
        setNotes(previous =>
          [updated, ...previous.filter(note => note.id !== noteId)].sort(
            (a, b) => b.updatedAt - a.updatedAt
          )
        );
        setSaveState('saved');
      }
    } catch (error) {
      logger.error('Failed to save note:', error);
      toast.error(t('notes.saveFailed'));
      setSaveState('idle');
    }
  };

  const flushPendingSave = () => {
    if (saveTimerRef.current !== null && selectedId) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      void persistNote(selectedId, titleDraft, contentDraft);
    }
  };

  useEffect(
    () => () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    },
    []
  );

  const handleCreate = async () => {
    try {
      const response = await notesApi.createNote('', '');
      if (response.success && response.data) {
        const note = response.data;
        setNotes(previous => [note, ...previous]);
        selectNote(note);
      }
    } catch (error) {
      logger.error('Failed to create note:', error);
      toast.error(t('notes.createFailed'));
    }
  };

  const handleDelete = async (noteId: string) => {
    if (!window.confirm(t('notes.deleteConfirm'))) return;
    try {
      const response = await notesApi.deleteNote(noteId);
      if (response.success) {
        setNotes(previous => previous.filter(note => note.id !== noteId));
        if (selectedId === noteId) {
          setSelectedId(null);
        }
      }
    } catch (error) {
      logger.error('Failed to delete note:', error);
      toast.error(t('notes.deleteFailed'));
    }
  };

  const filteredNotes = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return notes;
    return notes.filter(
      note =>
        note.title.toLowerCase().includes(text) ||
        note.content.toLowerCase().includes(text)
    );
  }, [notes, query]);

  return (
    <div
      className='flex h-full min-h-0 overflow-hidden'
      data-testid='notes-page'
    >
      {/* Note list */}
      <div
        data-testid='notes-list'
        className={cn(
          'min-h-0 w-full shrink-0 flex-col border-e border-black/[0.06] dark:border-white/[0.07] md:w-72',
          selectedNote ? 'hidden md:flex' : 'flex'
        )}
      >
        <div className='flex items-center justify-between px-4 pb-2 pt-4'>
          <h1 className='text-sm font-semibold text-gray-900 dark:text-dark-900'>
            {t('notes.title')}
          </h1>
          <Button
            size='sm'
            variant='ghost'
            onClick={() => void handleCreate()}
            className='h-7 w-7 p-0'
            title={t('notes.new')}
          >
            <Plus className='h-4 w-4' />
          </Button>
        </div>
        <div className='relative mx-3 mb-2'>
          <Search className='pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400 dark:text-dark-500' />
          <input
            type='search'
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('common.search')}
            className='w-full rounded-lg border border-transparent bg-black/[0.04] py-1.5 pe-2.5 ps-8 text-base text-gray-900 placeholder:text-gray-400 focus:border-primary-500/40 focus:outline-none dark:bg-white/[0.05] dark:text-dark-900 dark:placeholder:text-dark-500 sm:text-[13px]'
          />
        </div>
        <div className='scroll-region min-h-0 flex-1 overflow-y-auto px-2 pb-3 scrollbar-thin'>
          {loading ? null : filteredNotes.length === 0 ? (
            <div className='px-3 py-10 text-center'>
              <NotebookPen className='mx-auto mb-2 h-6 w-6 text-gray-300 dark:text-dark-400' />
              <p className='text-xs text-gray-400 dark:text-dark-500'>
                {t('notes.empty')}
              </p>
            </div>
          ) : (
            <div className='space-y-0.5'>
              {filteredNotes.map(note => (
                <div
                  key={note.id}
                  data-testid='note-list-item'
                  onClick={() => selectNote(note)}
                  className={cn(
                    'group cursor-pointer rounded-lg px-2.5 py-2 transition-colors',
                    selectedId === note.id
                      ? 'bg-white ring-1 ring-black/[0.04] dark:bg-dark-200 dark:ring-white/[0.05]'
                      : 'hover:bg-white/60 dark:hover:bg-dark-200/60'
                  )}
                >
                  <div className='flex items-center justify-between gap-2'>
                    <p className='truncate text-[13px] font-medium text-gray-900 dark:text-dark-900'>
                      {note.title || t('notes.untitled')}
                    </p>
                    <button
                      onClick={event => {
                        event.stopPropagation();
                        void handleDelete(note.id);
                      }}
                      className='shrink-0 rounded-md p-1 text-red-500 opacity-100 transition-opacity hover:bg-red-50 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 dark:hover:bg-red-900/20'
                      title={t('common.delete')}
                    >
                      <Trash2 className='h-3 w-3' />
                    </button>
                  </div>
                  <p className='mt-0.5 truncate text-[11px] text-gray-400 dark:text-dark-500'>
                    {formatTimestamp(note.updatedAt, i18n.language)}
                    {note.content.trim() && (
                      <>
                        {' · '}
                        {note.content.trim().slice(0, 60)}
                      </>
                    )}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Editor */}
      <div
        data-testid='notes-editor'
        className={cn(
          'min-w-0 flex-1 flex-col',
          selectedNote ? 'flex' : 'hidden md:flex'
        )}
      >
        {selectedNote ? (
          <>
            <div className='flex min-w-0 items-center gap-1.5 border-b border-black/[0.06] px-2.5 py-2.5 dark:border-white/[0.07] sm:gap-2 sm:px-5 sm:py-3'>
              <Button
                size='sm'
                variant='ghost'
                onClick={() => {
                  flushPendingSave();
                  setSelectedId(null);
                  setPreviewing(false);
                }}
                className='h-9 w-9 shrink-0 p-0 md:hidden'
                title={`${t('common.back')}: ${t('notes.title')}`}
                aria-label={`${t('common.back')}: ${t('notes.title')}`}
                data-testid='notes-mobile-back'
              >
                <ArrowLeft className='h-4 w-4 rtl:rotate-180' />
              </Button>
              <input
                data-testid='notes-title-editor'
                dir='auto'
                value={titleDraft}
                onChange={event => {
                  setTitleDraft(event.target.value);
                  scheduleSave(
                    selectedNote.id,
                    event.target.value,
                    contentDraft
                  );
                }}
                placeholder={t('notes.untitled')}
                className='min-w-0 flex-1 bg-transparent text-base font-semibold text-gray-950 placeholder:text-gray-400 focus:outline-none dark:text-dark-950 dark:placeholder:text-dark-500 sm:text-lg'
              />
              <span
                className='hidden shrink-0 text-[11px] text-gray-400 dark:text-dark-500 sm:inline'
                aria-live='polite'
              >
                {saveState === 'saving'
                  ? t('common.saving')
                  : saveState === 'saved'
                    ? t('notes.saved')
                    : ''}
              </span>
              <Button
                size='sm'
                variant='ghost'
                onClick={() => setPreviewing(previous => !previous)}
                className='h-9 w-9 shrink-0 gap-1.5 p-0 text-xs sm:h-8 sm:w-auto sm:px-2.5'
                title={previewing ? t('common.edit') : t('artifacts.preview')}
                aria-label={
                  previewing ? t('common.edit') : t('artifacts.preview')
                }
                data-testid='notes-preview-toggle'
              >
                {previewing ? (
                  <>
                    <Pencil className='h-3.5 w-3.5' />
                    <span className='hidden sm:inline'>{t('common.edit')}</span>
                  </>
                ) : (
                  <>
                    <Eye className='h-3.5 w-3.5' />
                    <span className='hidden sm:inline'>
                      {t('artifacts.preview')}
                    </span>
                  </>
                )}
              </Button>
            </div>
            {previewing ? (
              <div
                data-testid='notes-preview'
                className='scroll-region min-h-0 flex-1 overflow-y-auto px-4 py-3 scrollbar-thin sm:px-5 sm:py-4'
              >
                <RichMessageContent content={contentDraft} />
              </div>
            ) : (
              <textarea
                data-testid='notes-content-editor'
                dir='auto'
                value={contentDraft}
                onChange={event => {
                  setContentDraft(event.target.value);
                  scheduleSave(selectedNote.id, titleDraft, event.target.value);
                }}
                onBlur={flushPendingSave}
                placeholder={t('notes.contentPlaceholder')}
                className='min-h-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-base leading-relaxed text-gray-900 placeholder:text-gray-400 focus:outline-none dark:text-dark-900 dark:placeholder:text-dark-500 sm:px-5 sm:py-4 sm:text-[13.5px]'
              />
            )}
          </>
        ) : (
          <div className='flex flex-1 items-center justify-center'>
            <div className='text-center'>
              <NotebookPen className='mx-auto mb-3 h-8 w-8 text-gray-300 dark:text-dark-400' />
              <p className='text-sm text-gray-500 dark:text-dark-600'>
                {t('notes.selectOrCreate')}
              </p>
              <Button
                size='sm'
                onClick={() => void handleCreate()}
                className='mt-4 gap-1.5'
              >
                <Plus className='h-3.5 w-3.5' />
                {t('notes.new')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default NotesPage;
