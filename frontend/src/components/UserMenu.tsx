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

import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { authApi, usersApi } from '@/utils/api';
import {
  User,
  LogOut,
  Settings,
  Shield,
  ChevronDown,
  Camera,
  X,
} from 'lucide-react';
import { AvatarUpload } from '@/components/AvatarUpload';

interface UserMenuProps {
  onSettingsClick?: () => void;
}

export const UserMenu: React.FC<UserMenuProps> = ({ onSettingsClick }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [showAvatarModal, setShowAvatarModal] = useState(false);
  const [avatarValue, setAvatarValue] = useState('');
  const [isSavingAvatar, setIsSavingAvatar] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({
    top: 0,
    right: 0,
  });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { user, logout, isAdmin, systemInfo, setUser } = useAuthStore();
  const navigate = useNavigate();

  // Initialize avatar value when user changes
  useEffect(() => {
    if (user?.avatar) {
      setAvatarValue(user.avatar);
    }
  }, [user?.avatar]);

  // Calculate dropdown position
  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.bottom + 8,
        right: window.innerWidth - rect.right,
      });
    }
  }, [isOpen]);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLogout = async () => {
    try {
      await authApi.logout();
      logout();
      navigate('/login');
      toast.success('Logged out successfully');
    } catch (error) {
      console.error('Logout error:', error);
      // Still logout locally even if API call fails
      logout();
      navigate('/login');
    }
  };

  const handleUserManagement = () => {
    navigate('/users');
    setIsOpen(false);
  };

  const handleSettings = () => {
    if (onSettingsClick) {
      onSettingsClick();
    }
    setIsOpen(false);
  };

  const handleAvatarClick = () => {
    setShowAvatarModal(true);
    setIsOpen(false);
  };

  const handleSaveAvatar = async () => {
    setIsSavingAvatar(true);
    try {
      const response = await usersApi.updateMyAvatar(avatarValue || null);
      if (response.success && response.data) {
        setUser(response.data);
        toast.success('Profile picture updated');
        setShowAvatarModal(false);
      } else {
        toast.error(response.message || 'Failed to update avatar');
      }
    } catch (error) {
      console.error('Failed to update avatar:', error);
      toast.error('Failed to update profile picture');
    } finally {
      setIsSavingAvatar(false);
    }
  };

  // Don't show user menu if system doesn't require auth
  if (!systemInfo?.requiresAuth || !user) {
    return null;
  }

  return (
    <div className='relative'>
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className='flex items-center space-x-2 p-1.5 sm:p-2 rounded-lg hover:bg-gray-50 dark:hover:bg-dark-200 active:bg-gray-100 dark:active:bg-dark-100 transition-colors touch-manipulation'
      >
        <div className='flex items-center space-x-2'>
          {user.avatar ? (
            <img
              src={user.avatar}
              alt={user.username}
              className='w-7 h-7 sm:w-8 sm:h-8 rounded-full object-cover'
            />
          ) : (
            <div className='w-7 h-7 sm:w-8 sm:h-8 bg-primary-500 rounded-full flex items-center justify-center'>
              <span className='text-white text-xs sm:text-sm font-medium'>
                {user.username.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <div className='hidden sm:block text-left'>
            <p className='text-sm font-medium text-gray-900 dark:text-gray-100'>
              {user.username}
            </p>
            <p className='text-xs text-gray-500 dark:text-gray-400'>
              {user.role}
            </p>
          </div>
          <ChevronDown
            size={14}
            className={`hidden sm:block text-gray-500 dark:text-gray-400 transition-transform ${
              isOpen ? 'rotate-180' : ''
            }`}
          />
        </div>
      </button>

      {isOpen &&
        createPortal(
          <div
            ref={menuRef}
            className='w-48 sm:w-52 border border-gray-200 dark:border-dark-200 rounded-xl shadow-2xl'
            style={{
              position: 'fixed',
              top: dropdownPosition.top,
              right: Math.max(8, dropdownPosition.right), // Ensure minimum 8px margin from screen edge
              backgroundColor: document.documentElement.classList.contains(
                'dark'
              )
                ? '#2d2d2d'
                : '#ffffff',
              opacity: '1',
              backdropFilter: 'blur(4px)',
              WebkitBackdropFilter: 'blur(4px)',
              boxShadow:
                '0 25px 50px -12px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(255, 255, 255, 0.1)',
              zIndex: 2147483647,
            }}
          >
            <div
              className='p-3 border-b border-gray-200 dark:border-dark-200'
              style={{
                backgroundColor: 'transparent',
              }}
            >
              <p className='text-sm font-medium text-gray-900 dark:text-gray-100'>
                {user.username}
              </p>
              <p className='text-xs text-gray-500 dark:text-gray-400'>
                {user.email || 'No email provided'}
              </p>
              <div className='flex items-center mt-1'>
                {user.role === 'admin' && (
                  <Shield size={12} className='text-primary-500 mr-1' />
                )}
                <span className='text-xs text-gray-500 dark:text-gray-400 capitalize'>
                  {user.role}
                </span>
              </div>
            </div>

            <div className='py-1'>
              <button
                onClick={handleAvatarClick}
                className='w-full flex items-center px-3 py-2.5 sm:py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-200 active:bg-gray-100 dark:active:bg-dark-100 touch-manipulation transition-colors'
              >
                <Camera size={16} className='mr-3 flex-shrink-0' />
                Change Picture
              </button>

              <button
                onClick={handleSettings}
                className='w-full flex items-center px-3 py-2.5 sm:py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-200 active:bg-gray-100 dark:active:bg-dark-100 touch-manipulation transition-colors'
              >
                <Settings size={16} className='mr-3 flex-shrink-0' />
                Settings
              </button>

              {isAdmin() && (
                <button
                  onClick={handleUserManagement}
                  className='w-full flex items-center px-3 py-2.5 sm:py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-200 active:bg-gray-100 dark:active:bg-dark-100 touch-manipulation transition-colors'
                >
                  <User size={16} className='mr-3 flex-shrink-0' />
                  User Management
                </button>
              )}

              <div className='border-t border-gray-200 dark:border-dark-200 mt-1 pt-1'>
                <button
                  onClick={handleLogout}
                  className='w-full flex items-center px-3 py-2.5 sm:py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 active:bg-red-100 dark:active:bg-red-900/30 touch-manipulation transition-colors'
                >
                  <LogOut size={16} className='mr-3 flex-shrink-0' />
                  Sign Out
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* Avatar Upload Modal */}
      {showAvatarModal &&
        createPortal(
          <div
            className='fixed inset-0 z-[2147483647] flex items-center justify-center bg-black/50'
            onClick={() => setShowAvatarModal(false)}
          >
            <div
              className='bg-white dark:bg-dark-100 rounded-xl shadow-2xl p-6 w-full max-w-md mx-4'
              onClick={e => e.stopPropagation()}
            >
              <div className='flex items-center justify-between mb-4'>
                <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100'>
                  Change Profile Picture
                </h3>
                <button
                  onClick={() => setShowAvatarModal(false)}
                  className='p-1 hover:bg-gray-100 dark:hover:bg-dark-200 rounded-lg transition-colors'
                >
                  <X size={20} className='text-gray-500' />
                </button>
              </div>

              <div className='space-y-4'>
                <AvatarUpload value={avatarValue} onChange={setAvatarValue} />

                <div className='flex justify-end gap-3 pt-4 border-t border-gray-200 dark:border-dark-300'>
                  <button
                    onClick={() => setShowAvatarModal(false)}
                    className='px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-dark-200 rounded-lg transition-colors'
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSaveAvatar}
                    disabled={isSavingAvatar}
                    className='px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors'
                  >
                    {isSavingAvatar ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
