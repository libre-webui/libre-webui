const accentShades = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const neutralShades = [
  25, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950,
];

const variablePalette = (prefix, shades) =>
  Object.fromEntries(
    shades.map(shade => [
      shade,
      `rgb(var(--color-${prefix}-${shade}) / <alpha-value>)`,
    ])
  );

const variableAccent = prefix => variablePalette(prefix, accentShades);

const variableColor = name => `rgb(var(--color-${name}) / <alpha-value>)`;

// Coral replaces Tailwind's yellow and amber families so legacy utility names
// continue to work while every warning surface uses the product color.
const coralPalette = {
  50: '#ff7b52',
  100: '#ff7b52',
  200: '#ff7b52',
  300: '#ff7b52',
  400: '#ff7b52',
  500: '#ff7b52',
  600: '#ff7b52',
  700: '#ff7b52',
  800: '#ff7b52',
  900: '#ff7b52',
  950: '#ff7b52',
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      screens: {
        xs: '475px',
      },
      colors: {
        // Runtime accent scale — defaults to blue and can be changed in Appearance.
        primary: variableAccent('primary'),
        accent: variableAccent('accent'),
        // Semantic roles. These are the preferred colors for all shared UI and
        // resolve automatically in light and dark mode.
        canvas: variableColor('canvas'),
        surface: {
          DEFAULT: variableColor('surface'),
          subtle: variableColor('surface-subtle'),
          raised: variableColor('surface-raised'),
          overlay: variableColor('surface-overlay'),
          inverse: variableColor('surface-inverse'),
        },
        ink: {
          DEFAULT: variableColor('ink'),
          muted: variableColor('ink-muted'),
          subtle: variableColor('ink-subtle'),
          inverse: variableColor('ink-inverse'),
        },
        line: {
          DEFAULT: variableColor('line'),
          strong: variableColor('line-strong'),
        },
        // Runtime neutrals preserve these defaults unless accent adaptation is enabled.
        gray: variablePalette('gray', neutralShades),
        // Dark surface ladder for layered backgrounds — near-black warm neutrals.
        // Higher numeric keys = lighter text (inverted scale, kept for backwards compat).
        dark: variablePalette('dark', neutralShades),
        // DESIGN.md status colors
        success: {
          50: '#ecfdf5',
          100: '#d1fae5',
          200: '#a7f3d0',
          300: '#6ee7b7',
          400: '#34d399',
          500: '#34d399',
          600: '#10b981',
          700: '#059669',
          800: '#047857',
          900: '#064e3b',
        },
        warning: coralPalette,
        // Compatibility aliases for existing components.
        amber: coralPalette,
        yellow: coralPalette,
        error: {
          50: '#fef2f2',
          100: '#fee2e2',
          200: '#fecaca',
          300: '#fca5a5',
          400: '#f87171',
          500: '#f87171',
          600: '#ef4444',
          700: '#dc2626',
          800: '#b91c1c',
          900: '#7f1d1d',
        },
        info: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#60a5fa',
          600: '#3b82f6',
          700: '#2563eb',
          800: '#1d4ed8',
          900: '#1e3a8a',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          '-apple-system',
          'BlinkMacSystemFont',
          'SF Pro Text',
          'Segoe UI Variable',
          'Segoe UI',
          'Roboto',
          'Oxygen',
          'Ubuntu',
          'Cantarell',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'ui-monospace',
          'Fira Code',
          'SF Mono',
          'Monaco',
          'Inconsolata',
          'Roboto Mono',
          'source-code-pro',
          'monospace',
        ],
      },
      fontSize: {
        xs: ['0.75rem', { lineHeight: '1rem' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
        base: ['0.9375rem', { lineHeight: '1.625' }],
        lg: ['1.125rem', { lineHeight: '1.75rem' }],
        xl: ['1.25rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.5rem', { lineHeight: '2rem' }],
        '3xl': ['1.875rem', { lineHeight: '2.25rem' }],
      },
      spacing: {
        18: '4.5rem',
        88: '22rem',
      },
      borderRadius: {
        xl: '0.75rem',
        '2xl': '1rem',
        '3xl': '1.5rem',
      },
      boxShadow: {
        // Legacy glow names remain as restrained compatibility aliases.
        glow: '0 0 0 1px rgb(var(--color-primary-500) / 0.12), 0 6px 20px -14px rgb(var(--color-primary-500) / 0.18)',
        'glow-lg':
          '0 0 0 1px rgb(var(--color-primary-500) / 0.14), 0 12px 32px -20px rgb(var(--color-primary-500) / 0.2)',
        subtle: '0 1px 2px 0 rgb(0 0 0 / 0.035)',
        card: '0 1px 2px 0 rgb(0 0 0 / 0.035)',
        'card-hover':
          '0 8px 24px -18px rgb(0 0 0 / 0.22), 0 1px 2px rgb(0 0 0 / 0.04)',
        overlay:
          '0 24px 70px -28px rgb(0 0 0 / 0.28), 0 2px 8px rgb(0 0 0 / 0.06)',
      },
      animation: {
        'fade-in': 'fadeIn 0.18s cubic-bezier(0.22, 1, 0.36, 1)',
        'slide-in': 'slideIn 0.2s cubic-bezier(0.22, 1, 0.36, 1)',
        'slide-up': 'slideUp 0.18s cubic-bezier(0.22, 1, 0.36, 1)',
        'scale-in': 'scaleIn 0.16s cubic-bezier(0.22, 1, 0.36, 1)',
        'pulse-subtle': 'pulseSubtle 2.4s ease-in-out infinite',
        shimmer: 'shimmer 2s linear infinite',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideIn: {
          '0%': { transform: 'translateX(-6px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(6px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        scaleIn: {
          '0%': { transform: 'scale(0.985)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        pulseSubtle: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.8' },
        },
      },
      backdropBlur: {
        xs: '2px',
      },
    },
  },
  plugins: [],
};
