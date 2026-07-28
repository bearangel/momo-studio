// renderer/tailwind.config.js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: { primary: '#1a1a1a', secondary: '#242424', tertiary: '#2e2e2e' },
        border: { subtle: '#3a3a3a', strong: '#4a4a4a' },
        accent: { blue: '#3b82f6', purple: '#8b5cf6' },
        status: {
          success: '#22c55e',
          info: '#3b82f6',
          warning: '#f59e0b',
          error: '#ef4444',
        },
      },
    },
  },
  plugins: [],
};