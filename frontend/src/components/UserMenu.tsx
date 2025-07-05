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
import { authApi } from '@/utils/api';
import { User, LogOut, Settings, Shield, ChevronDown } from 'lucide-react';

export const UserMenu: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({
    top: 0,
    right: 0,
  });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { user, logout, isAdmin, systemInfo } = useAuthStore();
  const navigate = useNavigate();

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
    navigate('/settings');
    setIsOpen(false);
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
        className='flex items-center space-x-2 p-2 rounded-lg hover:bg-gray-50 dark:hover:bg-dark-200 transition-colors'
      >
        <div className='flex items-center space-x-2'>
          <div className='w-8 h-8 bg-primary-500 rounded-full flex items-center justify-center'>
            <span className='text-white text-sm font-medium'>
              {user.username.charAt(0).toUpperCase()}
            </span>
          </div>
          <div className='hidden sm:block text-left'>
            <p className='text-sm font-medium text-gray-900 dark:text-gray-100'>
              {user.username}
            </p>
            <p className='text-xs text-gray-500 dark:text-gray-400'>
              {user.role}
            </p>
          </div>
          <ChevronDown
            size={16}
            className={`text-gray-500 dark:text-gray-400 transition-transform ${
              isOpen ? 'rotate-180' : ''
            }`}
          />
        </div>
      </button>

      {isOpen &&
        createPortal(
          <div
            ref={menuRef}
            className='w-48 border border-gray-200 dark:border-dark-200 rounded-xl shadow-2xl'
            style={{
              position: 'fixed',
              top: dropdownPosition.top,
              right: dropdownPosition.right,
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
                {user.email}
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
                onClick={handleSettings}
                className='w-full flex items-center px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-200'
              >
                <Settings size={16} className='mr-2' />
                Settings
              </button>

              {isAdmin() && !systemInfo?.singleUserMode && (
                <button
                  onClick={handleUserManagement}
                  className='w-full flex items-center px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-200'
                >
                  <User size={16} className='mr-2' />
                  User Management
                </button>
              )}

              <div className='border-t border-gray-200 dark:border-dark-200 mt-1 pt-1'>
                <button
                  onClick={handleLogout}
                  className='w-full flex items-center px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                >
                  <LogOut size={16} className='mr-2' />
                  Sign Out
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
