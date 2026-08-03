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
import { toast } from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { usersApi } from '@/utils/api';
import { User, UserCreateRequest, UserUpdateRequest } from '@/types';
import {
  Button,
  Input,
  Label,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui';
import {
  Clock3,
  Edit,
  Plus,
  Shield,
  Trash2,
  User as UserIcon,
  UserCheck,
} from 'lucide-react';
import { createLogger } from '@/utils/logger';
import { PASSWORD_REQUIREMENTS } from '@/utils/passwordPolicy';

const logger = createLogger('components:user-manager');

export const UserManager: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [formData, setFormData] = useState<UserCreateRequest>({
    username: '',
    email: '',
    password: '',
    role: 'user',
  });

  const { user: currentUser } = useAuthStore();

  const { data: users = [], isLoading: loading } = useQuery({
    queryKey: ['users'],
    queryFn: async (): Promise<User[]> => {
      const response = await usersApi.getUsers();
      if (!response.success || !response.data) {
        throw new Error(t('errors.generic'));
      }
      return response.data;
    },
  });

  const invalidateUsers = () =>
    queryClient.invalidateQueries({ queryKey: ['users'] });

  const pendingUsers = users.filter(user => user.status === 'pending');
  const activeUsers = users.filter(user => user.status !== 'pending');

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const response = await usersApi.createUser(formData);
      if (response.success && response.data) {
        await invalidateUsers();
        setFormData({ username: '', email: '', password: '', role: 'user' });
        setShowCreateForm(false);
        toast.success(t('userManager.form.createSuccess'));
      }
    } catch (error: unknown) {
      logger.error('Error creating user:', error);
      let errorMessage = t('userManager.form.createFailed');

      if (error instanceof Error && 'response' in error) {
        const apiError = error as Error & {
          response?: { data?: { message?: string } };
        };
        errorMessage =
          apiError.response?.data?.message ||
          t('userManager.form.createFailed');
      }

      toast.error(errorMessage);
    }
  };

  const handleUpdateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;

    try {
      const updateData: UserUpdateRequest = {
        username: formData.username,
        email: formData.email,
        role: formData.role,
      };

      // Only include password if it's provided
      if (formData.password && formData.password.trim() !== '') {
        updateData.password = formData.password;
      }

      const response = await usersApi.updateUser(editingUser.id, updateData);
      if (response.success && response.data) {
        await invalidateUsers();
        setEditingUser(null);
        setFormData({ username: '', email: '', password: '', role: 'user' });
        toast.success(t('userManager.form.updateSuccess'));
      }
    } catch (error: unknown) {
      logger.error('Error updating user:', error);
      let errorMessage = t('userManager.form.updateFailed');

      if (error instanceof Error && 'response' in error) {
        const apiError = error as Error & {
          response?: { data?: { message?: string } };
        };
        errorMessage =
          apiError.response?.data?.message ||
          t('userManager.form.updateFailed');
      }

      toast.error(errorMessage);
    }
  };

  const handleDeleteUser = async (userId: string, username: string) => {
    if (!confirm(t('userManager.deleteConfirm', { name: username }))) {
      return;
    }

    try {
      const response = await usersApi.deleteUser(userId);
      if (response.success) {
        await invalidateUsers();
        toast.success(t('userManager.deleteSuccess'));
      }
    } catch (error: unknown) {
      logger.error('Error deleting user:', error);
      let errorMessage = t('userManager.deleteFailed');

      if (error instanceof Error && 'response' in error) {
        const apiError = error as Error & {
          response?: { data?: { message?: string } };
        };
        errorMessage =
          apiError.response?.data?.message || t('userManager.deleteFailed');
      }

      toast.error(errorMessage);
    }
  };

  const handleApproveUser = async (user: User) => {
    try {
      const response = await usersApi.approveUser(user.id);
      if (response.success && response.data) {
        await invalidateUsers();
        toast.success(
          t('userManager.approval.approved', {
            name: user.username,
            defaultValue: '{{name}} can now sign in.',
          })
        );
      }
    } catch (error: unknown) {
      logger.error('Error approving user:', error);
      const apiError = error as {
        response?: { data?: { message?: string } };
      };
      toast.error(
        apiError.response?.data?.message ||
          t('userManager.approval.failed', 'The account could not be approved.')
      );
    }
  };

  const startEdit = (user: User) => {
    setEditingUser(user);
    setFormData({
      username: user.username,
      email: user.email || '', // Handle null email
      password: '',
      role: user.role,
    });
  };

  const cancelEdit = () => {
    setEditingUser(null);
    setFormData({ username: '', email: '', password: '', role: 'user' });
  };

  const resetForm = () => {
    setFormData({ username: '', email: '', password: '', role: 'user' });
    setShowCreateForm(false);
  };

  if (loading) {
    return (
      <div className='flex items-center justify-center p-8'>
        <div className='w-8 h-8 border-4 border-gray-200 dark:border-gray-600 border-t-primary-500 rounded-full animate-spin'></div>
      </div>
    );
  }

  return (
    <div className='space-y-4'>
      {/* Header with Add User Button */}
      <div className='flex justify-between items-center'>
        <div></div>
        <Button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className='flex items-center space-x-2 bg-primary-600 hover:bg-primary-700 dark:bg-primary-500 dark:hover:bg-primary-600'
        >
          <Plus size={16} />
          <span>{t('userManager.createUser')}</span>
        </Button>
      </div>

      {/* Create User Form */}
      {showCreateForm && (
        <Card className='bg-white dark:bg-dark-25 border border-gray-200 dark:border-dark-200 shadow-lg'>
          <CardHeader>
            <CardTitle className='text-gray-900 dark:text-gray-100'>
              {t('userManager.form.title.create')}
            </CardTitle>
            <CardDescription className='text-gray-600 dark:text-gray-400'>
              {t('userManager.subtitle')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreateUser} className='space-y-4'>
              <div className='grid grid-cols-2 gap-4'>
                <div>
                  <Label
                    htmlFor='username'
                    className='text-gray-700 dark:text-gray-300'
                  >
                    {t('userManager.form.username')}
                  </Label>
                  <Input
                    id='username'
                    value={formData.username}
                    onChange={e =>
                      setFormData({ ...formData, username: e.target.value })
                    }
                    required
                    className='bg-white dark:bg-dark-100 border-gray-300 dark:border-dark-300 text-gray-900 dark:text-gray-100'
                  />
                </div>
                <div>
                  <Label
                    htmlFor='email'
                    className='text-gray-700 dark:text-gray-300'
                  >
                    {t('userManager.form.email')}
                  </Label>
                  <Input
                    id='email'
                    type='email'
                    value={formData.email}
                    onChange={e =>
                      setFormData({ ...formData, email: e.target.value })
                    }
                    required
                    className='bg-white dark:bg-dark-100 border-gray-300 dark:border-dark-300 text-gray-900 dark:text-gray-100'
                  />
                </div>
              </div>
              <div className='grid grid-cols-2 gap-4'>
                <div>
                  <Label
                    htmlFor='password'
                    className='text-gray-700 dark:text-gray-300'
                  >
                    {t('userManager.form.password')}
                  </Label>
                  <Input
                    id='password'
                    type='password'
                    value={formData.password}
                    onChange={e =>
                      setFormData({ ...formData, password: e.target.value })
                    }
                    required
                    className='bg-white dark:bg-dark-100 border-gray-300 dark:border-dark-300 text-gray-900 dark:text-gray-100'
                  />
                  <p className='mt-1 text-xs text-ink-muted'>
                    {PASSWORD_REQUIREMENTS}
                  </p>
                </div>
                <div>
                  <Label
                    htmlFor='role'
                    className='text-gray-700 dark:text-gray-300'
                  >
                    {t('userManager.form.role')}
                  </Label>
                  <select
                    id='role'
                    value={formData.role}
                    onChange={e =>
                      setFormData({
                        ...formData,
                        role: e.target.value as 'admin' | 'user',
                      })
                    }
                    className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white dark:bg-dark-100 text-gray-900 dark:text-gray-100 transition-colors duration-200'
                  >
                    <option value='user'>{t('userManager.roles.user')}</option>
                    <option value='admin'>
                      {t('userManager.roles.admin')}
                    </option>
                  </select>
                </div>
              </div>
              <div className='flex space-x-2'>
                <Button type='submit'>
                  {t('userManager.form.createButton')}
                </Button>
                <Button type='button' variant='outline' onClick={resetForm}>
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Edit User Form */}
      {editingUser && (
        <Card className='bg-white dark:bg-dark-25 border border-gray-200 dark:border-dark-200 shadow-lg'>
          <CardHeader>
            <CardTitle className='text-gray-900 dark:text-gray-100'>
              {t('userManager.form.title.edit')}: {editingUser.username}
            </CardTitle>
            <CardDescription className='text-gray-600 dark:text-gray-400'>
              {t('userManager.subtitle')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleUpdateUser} className='space-y-4'>
              <div className='grid grid-cols-2 gap-4'>
                <div>
                  <Label
                    htmlFor='edit-username'
                    className='text-gray-700 dark:text-gray-300'
                  >
                    {t('userManager.form.username')}
                  </Label>
                  <Input
                    id='edit-username'
                    value={formData.username}
                    onChange={e =>
                      setFormData({ ...formData, username: e.target.value })
                    }
                    required
                    className='bg-white dark:bg-dark-100 border-gray-300 dark:border-dark-300 text-gray-900 dark:text-gray-100'
                  />
                </div>
                <div>
                  <Label
                    htmlFor='edit-email'
                    className='text-gray-700 dark:text-gray-300'
                  >
                    {t('userManager.form.email')}
                  </Label>
                  <Input
                    id='edit-email'
                    type='email'
                    value={formData.email}
                    onChange={e =>
                      setFormData({ ...formData, email: e.target.value })
                    }
                    required
                    className='bg-white dark:bg-dark-100 border-gray-300 dark:border-dark-300 text-gray-900 dark:text-gray-100'
                  />
                </div>
              </div>
              <div className='grid grid-cols-2 gap-4'>
                <div>
                  <Label
                    htmlFor='edit-password'
                    className='text-gray-700 dark:text-gray-300'
                  >
                    {t('userManager.form.password')} ({t('common.optional')})
                  </Label>
                  <Input
                    id='edit-password'
                    type='password'
                    value={formData.password}
                    onChange={e =>
                      setFormData({ ...formData, password: e.target.value })
                    }
                    placeholder={t('userManager.form.passwordHint')}
                    className='bg-white dark:bg-dark-100 border-gray-300 dark:border-dark-300 text-gray-900 dark:text-gray-100'
                  />
                  <p className='mt-1 text-xs text-ink-muted'>
                    {PASSWORD_REQUIREMENTS}
                  </p>
                </div>
                <div>
                  <Label
                    htmlFor='edit-role'
                    className='text-gray-700 dark:text-gray-300'
                  >
                    {t('userManager.form.role')}
                  </Label>
                  <select
                    id='edit-role'
                    value={formData.role}
                    onChange={e =>
                      setFormData({
                        ...formData,
                        role: e.target.value as 'admin' | 'user',
                      })
                    }
                    disabled={
                      editingUser?.id === currentUser?.id &&
                      currentUser?.role === 'admin'
                    }
                    className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white dark:bg-dark-100 text-gray-900 dark:text-gray-100 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed'
                  >
                    <option value='user'>{t('userManager.roles.user')}</option>
                    <option value='admin'>
                      {t('userManager.roles.admin')}
                    </option>
                  </select>
                  {editingUser?.id === currentUser?.id &&
                    currentUser?.role === 'admin' && (
                      <p className='mt-1 text-xs text-ink-muted'>
                        {t('userManager.cannotDeleteSelf')}
                      </p>
                    )}
                </div>
              </div>
              <div className='flex space-x-2'>
                <Button type='submit'>
                  {t('userManager.form.updateButton')}
                </Button>
                <Button type='button' variant='outline' onClick={cancelEdit}>
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {pendingUsers.length > 0 && (
        <Card
          data-testid='pending-user-approvals'
          className='border border-warning-500/30 bg-warning-500/[0.06] shadow-lg'
        >
          <CardHeader>
            <CardTitle className='flex items-center gap-2 text-gray-900 dark:text-gray-100'>
              <Clock3 className='h-5 w-5 text-warning-700 dark:text-warning-400' />
              {t('userManager.approval.title', 'Pending approvals')} (
              {pendingUsers.length})
            </CardTitle>
            <CardDescription className='text-gray-600 dark:text-gray-400'>
              {t(
                'userManager.approval.description',
                'Review new registrations before allowing them into this instance.'
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className='space-y-3'>
              {pendingUsers.map(user => (
                <div
                  key={user.id}
                  data-testid='pending-user-row'
                  className='flex flex-col gap-4 rounded-xl border border-warning-500/25 bg-surface p-4 sm:flex-row sm:items-center sm:justify-between'
                >
                  <div className='min-w-0'>
                    <h3 className='truncate font-medium text-ink'>
                      {user.username}
                    </h3>
                    <p className='truncate text-sm text-ink-muted'>
                      {user.email || t('userManager.noEmail')}
                    </p>
                    <p className='mt-1 text-xs text-ink-subtle'>
                      {t('userManager.approval.registered', 'Registered')}:{' '}
                      {new Date(user.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <div className='flex shrink-0 items-center gap-2'>
                    <Button
                      type='button'
                      size='sm'
                      data-testid='approve-user-button'
                      onClick={() => void handleApproveUser(user)}
                      className='gap-2'
                    >
                      <UserCheck size={16} />
                      {t('userManager.approval.activate', 'Activate account')}
                    </Button>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      aria-label={t(
                        'userManager.approval.reject',
                        'Reject registration'
                      )}
                      onClick={() =>
                        void handleDeleteUser(user.id, user.username)
                      }
                      className='text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-900/20 dark:hover:text-red-300'
                    >
                      <Trash2 size={16} />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Users List */}
      <Card className='bg-white dark:bg-dark-25 border border-gray-200 dark:border-dark-200 shadow-lg'>
        <CardHeader>
          <CardTitle className='text-gray-900 dark:text-gray-100'>
            {t('userManager.title')} ({activeUsers.length})
          </CardTitle>
          <CardDescription className='text-gray-600 dark:text-gray-400'>
            {t('userManager.subtitle')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className='space-y-3'>
            {activeUsers.map(user => (
              <div
                key={user.id}
                className='flex items-center justify-between p-4 bg-gray-50 dark:bg-dark-100 rounded-lg border border-gray-200 dark:border-dark-300'
              >
                <div className='flex items-center space-x-3'>
                  <div className='p-2 bg-primary-100 dark:bg-primary-900/20 rounded-lg'>
                    {user.role === 'admin' ? (
                      <Shield className='h-5 w-5 text-primary-600 dark:text-primary-400' />
                    ) : (
                      <UserIcon className='h-5 w-5 text-primary-600 dark:text-primary-400' />
                    )}
                  </div>
                  <div>
                    <h3 className='font-medium text-gray-900 dark:text-gray-100'>
                      {user.username}
                      {user.id === currentUser?.id && (
                        <span className='ml-2 text-xs text-primary-600 dark:text-primary-400 font-normal'>
                          ({t('chatMessage.you')})
                        </span>
                      )}
                    </h3>
                    <p className='text-sm text-gray-600 dark:text-gray-400'>
                      {user.email || t('userManager.noEmail')} •{' '}
                      {user.role === 'admin'
                        ? t('userManager.roles.admin')
                        : t('userManager.roles.user')}
                    </p>
                    <p className='text-xs text-gray-500 dark:text-gray-500'>
                      {t('userManager.columns.created')}:{' '}
                      {new Date(user.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <div className='flex space-x-2'>
                  <Button
                    variant='outline'
                    size='sm'
                    onClick={() => startEdit(user)}
                    className='text-gray-600 dark:text-gray-400 hover:text-primary-600 dark:hover:text-primary-400'
                  >
                    <Edit size={16} />
                  </Button>
                  <Button
                    variant='outline'
                    size='sm'
                    onClick={() => handleDeleteUser(user.id, user.username)}
                    disabled={user.id === currentUser?.id}
                    className='text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20'
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
