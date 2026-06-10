/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          navy: 'var(--brand-navy)',
          blue: 'var(--brand-blue)'
        },
        bg: {
          primary: 'var(--color-background-primary)',
          secondary: 'var(--color-background-secondary)',
          tertiary: 'var(--color-background-tertiary)',
          info: 'var(--color-background-info)',
          danger: 'var(--color-background-danger)',
          warning: 'var(--color-background-warning)',
          success: 'var(--color-background-success)'
        },
        content: {
          primary: 'var(--color-text-primary)',
          secondary: 'var(--color-text-secondary)',
          tertiary: 'var(--color-text-tertiary)',
          info: 'var(--color-text-info)',
          danger: 'var(--color-text-danger)',
          warning: 'var(--color-text-warning)',
          success: 'var(--color-text-success)'
        },
        edge: {
          tertiary: 'var(--color-border-tertiary)',
          secondary: 'var(--color-border-secondary)',
          info: 'var(--color-border-info)',
          danger: 'var(--color-border-danger)'
        },
        page: 'var(--page-bg)'
      },
      borderRadius: {
        md: 'var(--border-radius-md)',
        lg: 'var(--border-radius-lg)'
      },
      fontFamily: {
        sans: 'var(--font-sans)'
      },
      fontWeight: {
        normal: '400',
        medium: '500'
      }
    }
  },
  plugins: []
}
