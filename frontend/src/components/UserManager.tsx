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
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { usersApi } from '@/utils/api';
import type { User, UserCreateRequest, UserUpdateRequest } from '@/types';
import { Button, Input, Label, ModalShell } from '@/components/ui';
import {
  Clock3,
  Edit,
  Plus,
  RefreshCw,
  Search,
  Shield,
  ShieldOff,
  Trash2,
  User as UserIcon,
  UserCheck,
  Users,
} from 'lucide-react';
import { PasswordStrengthMeter } from '@/components/PasswordStrengthMeter';

const selectClass =
  'h-11 w-full rounded-xl border border-line bg-surface-raised px-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-60';

function errorMessage(error: unknown, fallback: string): string {
  const apiError = error as {
    response?: { data?: { message?: string } };
  } | null;
  return (
    apiError?.response?.data?.message ||
    (error instanceof Error ? error.message : fallback) ||
    fallback
  );
}

interface UserFormProps {
  user: User | null;
  currentUserId?: string;
  onClose: () => void;
  onSaved: (user: User) => void;
}

function UserForm({ user, currentUserId, onClose, onSaved }: UserFormProps) {
  const { t } = useTranslation();
  const [formData, setFormData] = useState<UserCreateRequest>({
    username: user?.username ?? '',
    email: user?.email ?? '',
    password: '',
    role: user?.role ?? 'user',
  });
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState('');
  const isSelf = user?.id === currentUserId;
  const close = () => {
    if (!savingRef.current) onClose();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    const failure = t(
      user ? 'userManager.form.updateFailed' : 'userManager.form.createFailed'
    );
    try {
      const update: UserUpdateRequest = {
        username: formData.username.trim(),
        email: formData.email.trim() || null,
        role: isSelf ? user!.role : formData.role,
      };
      // An empty password preserves the existing credential when editing.
      if (formData.password) update.password = formData.password;
      const response = user
        ? await usersApi.updateUser(user.id, update)
        : await usersApi.createUser({
            ...formData,
            username: formData.username.trim(),
            email: formData.email.trim(),
          });
      if (!response.success || !response.data) {
        throw new Error(response.message || failure);
      }
      onSaved(response.data);
      toast.success(
        t(
          user
            ? 'userManager.form.updateSuccess'
            : 'userManager.form.createSuccess'
        )
      );
    } catch (error: unknown) {
      setError(errorMessage(error, failure));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <ModalShell
      titleId='user-form-title'
      title={t(
        user ? 'userManager.form.title.edit' : 'userManager.form.title.create'
      )}
      subtitle={
        user ? (
          <span className='break-all'>{user.username}</span>
        ) : (
          t('userManager.subtitle')
        )
      }
      onClose={close}
      testId='user-form-dialog'
    >
      <form onSubmit={submit} className='space-y-5' aria-busy={saving}>
        <fieldset disabled={saving} className='min-w-0 space-y-4'>
          <Input
            id='user-form-username'
            label={t('userManager.form.username')}
            autoFocus
            autoComplete='off'
            value={formData.username}
            onChange={event =>
              setFormData({ ...formData, username: event.target.value })
            }
            required
          />
          <Input
            id='user-form-email'
            label={`${t('userManager.form.email')}${user ? ` (${t('common.optional')})` : ''}`}
            type='email'
            dir='ltr'
            autoComplete='off'
            value={formData.email}
            onChange={event =>
              setFormData({ ...formData, email: event.target.value })
            }
            required={!user}
          />
          <div>
            <Input
              id='user-form-password'
              label={`${t('userManager.form.password')}${user ? ` (${t('common.optional')})` : ''}`}
              type='password'
              autoComplete='new-password'
              value={formData.password}
              onChange={event =>
                setFormData({ ...formData, password: event.target.value })
              }
              required={!user}
              helper={user ? t('userManager.form.passwordHint') : undefined}
            />
            <PasswordStrengthMeter password={formData.password} />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='user-form-role'>{t('userManager.form.role')}</Label>
            <select
              id='user-form-role'
              value={formData.role}
              onChange={event =>
                setFormData({
                  ...formData,
                  role: event.target.value as User['role'],
                })
              }
              disabled={isSelf}
              aria-describedby={isSelf ? 'user-form-role-hint' : undefined}
              className={selectClass}
            >
              <option value='user'>{t('userManager.roles.user')}</option>
              <option value='admin'>{t('userManager.roles.admin')}</option>
            </select>
            {isSelf && (
              <p id='user-form-role-hint' className='text-xs text-ink-muted'>
                {t('userManager.directory.editSelfRole')}
              </p>
            )}
          </div>
        </fieldset>
        {error && (
          <p
            role='alert'
            className='text-sm text-error-600 dark:text-error-400'
          >
            {error}
          </p>
        )}
        <div className='flex flex-wrap justify-end gap-2 border-t border-line pt-4'>
          <Button
            type='button'
            variant='outline'
            onClick={close}
            disabled={saving}
            className='min-h-11'
          >
            {t('common.cancel')}
          </Button>
          <Button
            type='submit'
            loading={saving}
            disabled={!formData.username.trim()}
            className='min-h-11'
          >
            {t(
              saving
                ? user
                  ? 'userManager.form.updating'
                  : 'userManager.form.creating'
                : user
                  ? 'userManager.form.updateButton'
                  : 'userManager.form.createButton'
            )}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}

type AccountAction = { kind: 'delete' | 'reset'; user: User };

export const UserManager: React.FC = () => {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const currentUser = useAuthStore(state => state.user);
  const setCurrentUser = useAuthStore(state => state.setUser);
  const [editor, setEditor] = useState<User | 'create' | null>(null);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<'all' | User['role']>('all');
  const [action, setAction] = useState<AccountAction | null>(null);
  const [actionError, setActionError] = useState('');
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const busyRef = useRef(false);
  const {
    data: users = [],
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ['users'],
    queryFn: async (): Promise<User[]> => {
      const response = await usersApi.getUsers();
      if (!response.success || !response.data) {
        throw new Error(t('userManager.directory.loadFailed'));
      }
      return response.data;
    },
  });

  const refreshUsers = () => {
    void queryClient.invalidateQueries({ queryKey: ['users'] });
  };
  const saveUser = (saved: User) => {
    queryClient.setQueryData<User[]>(['users'], (previous = []) =>
      previous.some(user => user.id === saved.id)
        ? previous.map(user => (user.id === saved.id ? saved : user))
        : [...previous, saved]
    );
    if (saved.id === currentUser?.id) setCurrentUser(saved);
    setEditor(null);
    refreshUsers();
  };
  const query = search.trim().toLocaleLowerCase(i18n.language);
  const filtered = users.filter(
    user =>
      (role === 'all' || user.role === role) &&
      `${user.username} ${user.email ?? ''}`
        .toLocaleLowerCase(i18n.language)
        .includes(query)
  );
  const pending = filtered.filter(user => user.status === 'pending');
  const active = filtered.filter(user => user.status !== 'pending');
  const pendingCount = users.filter(user => user.status === 'pending').length;
  const activeCount = users.length - pendingCount;
  const hasFilters = Boolean(search || role !== 'all');
  const clearFilters = () => {
    setSearch('');
    setRole('all');
  };

  const approve = async (user: User) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyUserId(user.id);
    try {
      const response = await usersApi.approveUser(user.id);
      if (!response.success || !response.data) {
        throw new Error(response.message || t('userManager.approval.failed'));
      }
      saveUser(response.data);
      toast.success(
        t('userManager.approval.approved', { name: user.username })
      );
    } catch (error: unknown) {
      toast.error(errorMessage(error, t('userManager.approval.failed')));
    } finally {
      busyRef.current = false;
      setBusyUserId(null);
    }
  };

  const confirmAction = async () => {
    if (!action || busyRef.current) return;
    if (action.kind === 'delete' && action.user.id === currentUser?.id) return;
    busyRef.current = true;
    setBusyUserId(action.user.id);
    setActionError('');
    const failure = t(
      action.kind === 'delete'
        ? 'userManager.deleteFailed'
        : 'userManager.mfaResetFailed'
    );
    try {
      if (action.kind === 'delete') {
        const response = await usersApi.deleteUser(action.user.id);
        if (!response.success) throw new Error(response.message || failure);
        queryClient.setQueryData<User[]>(['users'], (previous = []) =>
          previous.filter(user => user.id !== action.user.id)
        );
        refreshUsers();
        toast.success(t('userManager.deleteSuccess'));
      } else {
        const response = await usersApi.resetUserMfa(action.user.id);
        if (!response.success) throw new Error(response.message || failure);
        toast.success(
          t(
            response.data?.removed
              ? 'userManager.mfaResetSuccess'
              : 'userManager.mfaResetNothing',
            { name: action.user.username }
          )
        );
      }
      setAction(null);
    } catch (error: unknown) {
      setActionError(errorMessage(error, failure));
    } finally {
      busyRef.current = false;
      setBusyUserId(null);
    }
  };
  const openAction = (kind: AccountAction['kind'], user: User) => {
    setActionError('');
    setAction({ kind, user });
  };

  const identity = (user: User) => (
    <div className='flex min-w-0 items-start gap-3'>
      <div
        className='flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-subtle text-ink-muted'
        aria-hidden='true'
      >
        {user.status === 'pending' ? (
          <Clock3 size={18} />
        ) : user.role === 'admin' ? (
          <Shield size={18} />
        ) : (
          <UserIcon size={18} />
        )}
      </div>
      <div className='min-w-0'>
        <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
          <h3 className='min-w-0 break-all text-sm font-medium text-ink'>
            <bdi>{user.username}</bdi>
          </h3>
          {user.id === currentUser?.id && (
            <span className='text-xs text-ink-muted'>
              ({t('chatMessage.you')})
            </span>
          )}
          <span className='rounded-md border border-line px-1.5 py-0.5 text-xs text-ink-muted'>
            {t(
              user.role === 'admin'
                ? 'userManager.roles.admin'
                : 'userManager.roles.user'
            )}
          </span>
        </div>
        <p className='mt-1 break-all text-sm text-ink-muted'>
          <bdi>{user.email || t('userManager.noEmail')}</bdi>
        </p>
        <p className='mt-1 text-xs text-ink-subtle'>
          {t(
            user.status === 'pending'
              ? 'userManager.approval.registered'
              : 'userManager.columns.created'
          )}
          : {new Date(user.createdAt).toLocaleDateString(i18n.language)}
        </p>
      </div>
    </div>
  );

  const empty = (message: string) => (
    <div className='px-4 py-8 text-center'>
      <Users
        size={24}
        className='mx-auto mb-3 text-ink-subtle'
        aria-hidden='true'
      />
      <p className='text-sm text-ink-muted'>{message}</p>
    </div>
  );

  return (
    <div className='min-w-0 space-y-5' data-testid='user-directory'>
      <div className='rounded-2xl border border-line bg-surface p-4'>
        <div className='flex flex-wrap items-center gap-2'>
          <div className='relative min-w-0 basis-full sm:flex-1 sm:basis-48'>
            <Search
              size={16}
              aria-hidden='true'
              className='pointer-events-none absolute start-3.5 top-3.5 text-ink-subtle'
            />
            <Input
              type='search'
              aria-label={t('userManager.search')}
              placeholder={t('userManager.search')}
              value={search}
              onChange={event => setSearch(event.target.value)}
              className='ps-10'
            />
          </div>
          <div className='min-w-0 flex-1 sm:max-w-36'>
            <Label htmlFor='user-role-filter' className='sr-only'>
              {t('userManager.columns.role')}
            </Label>
            <select
              id='user-role-filter'
              value={role}
              onChange={event => setRole(event.target.value as typeof role)}
              className={selectClass}
            >
              <option value='all'>{t('userManager.directory.allRoles')}</option>
              <option value='admin'>{t('userManager.roles.admin')}</option>
              <option value='user'>{t('userManager.roles.user')}</option>
            </select>
          </div>
          <Button
            type='button'
            variant='outline'
            onClick={() => void refetch()}
            disabled={isFetching}
            className='min-h-11 min-w-11 px-3'
            aria-label={t('common.refresh')}
            title={t('common.refresh')}
          >
            <RefreshCw
              size={16}
              aria-hidden='true'
              className={
                isFetching
                  ? 'animate-spin motion-reduce:animate-none'
                  : undefined
              }
            />
          </Button>
          <Button
            type='button'
            onClick={() => setEditor('create')}
            disabled={!!busyUserId}
            className='min-h-11'
          >
            <Plus size={16} aria-hidden='true' />
            {t('userManager.createUser')}
          </Button>
        </div>
        <div className='mt-3 flex min-h-5 flex-wrap items-center justify-between gap-2'>
          <p role='status' className='text-xs text-ink-muted'>
            {isLoading
              ? t('userManager.loading')
              : t('userManager.directory.results', {
                  visible: filtered.length,
                  total: users.length,
                })}
          </p>
          {hasFilters && (
            <Button
              type='button'
              size='sm'
              variant='ghost'
              onClick={clearFilters}
              className='min-h-11 sm:min-h-8'
            >
              {t('userManager.directory.clearFilters')}
            </Button>
          )}
        </div>
      </div>
      {isError && (
        <div
          role='alert'
          className='flex flex-wrap items-center justify-between gap-3 rounded-xl border border-error-500/30 p-4'
        >
          <p className='text-sm text-ink'>
            {t('userManager.directory.loadFailed')}
          </p>
          <Button
            type='button'
            variant='outline'
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            {t('common.retry')}
          </Button>
        </div>
      )}
      {!isLoading && (!isError || users.length > 0) && (
        <>
          {pendingCount > 0 && (
            <section
              data-testid='pending-user-approvals'
              aria-labelledby='pending-users-title'
              className='overflow-hidden rounded-2xl border border-warning-500/30 bg-surface'
            >
              <div className='border-b border-line bg-warning-500/[0.06] p-4'>
                <h3
                  id='pending-users-title'
                  className='flex items-center gap-2 text-sm font-semibold text-ink'
                >
                  <Clock3
                    size={16}
                    aria-hidden='true'
                    className='text-warning-700 dark:text-warning-400'
                  />
                  {t('userManager.approval.title')}{' '}
                  <span className='text-ink-muted'>({pendingCount})</span>
                </h3>
                <p className='mt-1 text-xs leading-relaxed text-ink-muted'>
                  {t('userManager.approval.description')}
                </p>
              </div>
              <div className='divide-y divide-line'>
                {pending.map(user => (
                  <div
                    key={user.id}
                    data-testid='pending-user-row'
                    className='flex flex-col gap-3 p-4 xl:flex-row xl:items-center xl:justify-between'
                  >
                    {identity(user)}
                    <div className='flex shrink-0 flex-wrap gap-2'>
                      <Button
                        type='button'
                        size='sm'
                        data-testid='approve-user-button'
                        onClick={() => void approve(user)}
                        disabled={!!busyUserId}
                        loading={busyUserId === user.id}
                        className='min-h-11 sm:min-h-9'
                      >
                        <UserCheck size={16} aria-hidden='true' />
                        {t('userManager.approval.activate')}
                      </Button>
                      <Button
                        type='button'
                        size='sm'
                        variant='outline'
                        onClick={() => openAction('delete', user)}
                        disabled={!!busyUserId}
                        className='min-h-11 sm:min-h-9'
                      >
                        {t('userManager.approval.reject')}
                      </Button>
                    </div>
                  </div>
                ))}
                {pending.length === 0 &&
                  empty(t('userManager.noUsersMatching'))}
              </div>
            </section>
          )}
          <section
            aria-labelledby='active-users-title'
            className='overflow-hidden rounded-2xl border border-line bg-surface'
          >
            <div className='border-b border-line px-4 py-3'>
              <h3
                id='active-users-title'
                className='text-sm font-semibold text-ink'
              >
                {t('userManager.directory.title')}{' '}
                <span className='text-ink-muted'>({activeCount})</span>
              </h3>
            </div>
            <div className='divide-y divide-line'>
              {active.map(user => (
                <div
                  key={user.id}
                  data-testid='user-row'
                  className='flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between'
                >
                  {identity(user)}
                  <div className='flex shrink-0 items-center gap-1.5'>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      onClick={() => setEditor(user)}
                      disabled={!!busyUserId}
                      aria-label={`${t('common.edit')}: ${user.username}`}
                      className='min-h-11 sm:min-h-9'
                    >
                      <Edit size={15} aria-hidden='true' />
                      {t('common.edit')}
                    </Button>
                    <Button
                      type='button'
                      variant='ghost'
                      size='sm'
                      data-testid='reset-mfa-button'
                      aria-label={`${t('userManager.mfaReset')}: ${user.username}`}
                      title={t('userManager.mfaReset')}
                      onClick={() => openAction('reset', user)}
                      disabled={!!busyUserId}
                      className='min-h-11 min-w-11 sm:min-h-9 sm:min-w-9 px-2'
                    >
                      <ShieldOff size={16} aria-hidden='true' />
                    </Button>
                    <Button
                      type='button'
                      variant='ghost'
                      size='sm'
                      aria-label={`${t('common.delete')}: ${user.username}`}
                      title={
                        user.id === currentUser?.id
                          ? t('userManager.cannotDeleteSelf')
                          : t('common.delete')
                      }
                      onClick={() => openAction('delete', user)}
                      disabled={user.id === currentUser?.id || !!busyUserId}
                      className='min-h-11 min-w-11 sm:min-h-9 sm:min-w-9 px-2 text-error-600 dark:text-error-400'
                    >
                      <Trash2 size={16} aria-hidden='true' />
                    </Button>
                  </div>
                </div>
              ))}
              {active.length === 0 &&
                empty(
                  t(
                    hasFilters
                      ? 'userManager.noUsersMatching'
                      : 'userManager.directory.empty'
                  )
                )}
            </div>
          </section>
        </>
      )}
      {editor && (
        <UserForm
          key={editor === 'create' ? 'create' : editor.id}
          user={editor === 'create' ? null : editor}
          currentUserId={currentUser?.id}
          onClose={() => setEditor(null)}
          onSaved={saveUser}
        />
      )}
      {action && (
        <ModalShell
          titleId='user-action-title'
          title={t(
            action.kind === 'reset'
              ? 'userManager.mfaReset'
              : action.user.status === 'pending'
                ? 'userManager.approval.reject'
                : 'userManager.directory.deleteTitle'
          )}
          onClose={() => {
            if (!busyRef.current) setAction(null);
          }}
          testId='user-action-dialog'
        >
          <p className='break-words text-sm leading-relaxed text-ink-muted'>
            {t(
              action.kind === 'delete'
                ? 'userManager.deleteConfirm'
                : 'userManager.mfaResetConfirm',
              { name: action.user.username }
            )}
          </p>
          {actionError && (
            <p
              role='alert'
              className='text-sm text-error-600 dark:text-error-400'
            >
              {actionError}
            </p>
          )}
          <div className='flex flex-wrap justify-end gap-2 border-t border-line pt-4'>
            <Button
              type='button'
              variant='outline'
              onClick={() => setAction(null)}
              disabled={!!busyUserId}
              className='min-h-11'
            >
              {t('common.cancel')}
            </Button>
            <Button
              type='button'
              variant='danger'
              loading={!!busyUserId}
              onClick={() => void confirmAction()}
              className='min-h-11'
            >
              {t(
                action.kind === 'delete'
                  ? 'common.delete'
                  : 'userManager.mfaReset'
              )}
            </Button>
          </div>
        </ModalShell>
      )}
    </div>
  );
};
