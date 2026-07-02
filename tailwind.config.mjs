/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#ffffff',
          secondary: '#f8f8f8',
          hover: '#f3f3f3',
          active: '#eeeeee',
        },
        border: {
          DEFAULT: '#e5e5e5',
          subtle: '#eeeeee',
        },
        foreground: {
          DEFAULT: '#1a1a1a',
          secondary: '#6b6b6b',
          tertiary: '#999999',
          muted: '#bfbfbf',
        },
        primary: {
          DEFAULT: '#2563eb',
          hover: '#1d4ed8',
          active: '#1e40af',
          subtle: '#eff6ff',
          foreground: '#ffffff',
        },
        success: {
          DEFAULT: '#16a34a',
          hover: '#15803d',
          subtle: '#f0fdf4',
        },
        warning: {
          DEFAULT: '#d97706',
          hover: '#b45309',
          subtle: '#fffbeb',
        },
        danger: {
          DEFAULT: '#dc2626',
          hover: '#b91c1c',
          subtle: '#fef2f2',
        },
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', '"PingFang SC"', '"Microsoft YaHei"', 'sans-serif'],
        mono: ['"SF Mono"', '"Cascadia Code"', '"Fira Code"', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
        xs: ['0.75rem', { lineHeight: '1rem' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
        base: ['0.875rem', { lineHeight: '1.375rem' }],
        lg: ['0.9375rem', { lineHeight: '1.5rem' }],
        xl: ['1.0625rem', { lineHeight: '1.5rem' }],
        '2xl': ['1.25rem', { lineHeight: '1.75rem' }],
      },
      borderRadius: {
        sm: '0.25rem',
        DEFAULT: '0.375rem',
        md: '0.5rem',
        lg: '0.625rem',
        xl: '0.75rem',
      },
      boxShadow: {
        dialog: '0 16px 48px -12px rgba(0, 0, 0, 0.15)',
        menu: '0 4px 16px -4px rgba(0, 0, 0, 0.12)',
        toast: '0 4px 16px -4px rgba(0, 0, 0, 0.12)',
      },
      transitionDuration: {
        fast: '100ms',
        normal: '150ms',
      },
    },
  },
  plugins: [],
}
