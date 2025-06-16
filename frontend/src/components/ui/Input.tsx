import React from 'react';
import { cn } from '@/utils';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helper?: string;
}

export const Input: React.FC<InputProps> = ({
  label,
  error,
  helper,
  className,
  id,
  ...props
}) => {
  const inputId = id || `input-${Math.random().toString(36).substr(2, 9)}`;

  return (
    <div className='space-y-1'>
      {label && (
        <label
          htmlFor={inputId}
          className='block text-sm font-medium text-gray-700 dark:text-dark-700'
        >
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={cn(
          'block w-full rounded-xl border border-gray-200 px-4 py-3 text-sm placeholder-gray-500 shadow-sm transition-all duration-200 bg-white text-gray-900',
          'focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none focus:shadow-md',
          'dark:border-dark-300 dark:bg-dark-100 dark:text-dark-800 dark:placeholder-dark-500',
          'dark:focus:border-primary-400 dark:focus:ring-primary-400/20',
          error &&
            'border-error-500 focus:border-error-500 focus:ring-error-500/20',
          className
        )}
        {...props}
      />
      {error && (
        <p className='text-sm text-error-600 dark:text-error-400'>{error}</p>
      )}
      {helper && !error && (
        <p className='text-sm text-gray-500 dark:text-dark-500'>{helper}</p>
      )}
    </div>
  );
};
