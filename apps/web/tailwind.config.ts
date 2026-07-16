import type { Config } from 'tailwindcss';

/**
 * The design system, such as it is.
 *
 * Every colour is declared as a CSS variable holding raw HSL *channels*, not a
 * finished colour. That indirection is what makes `bg-surface` work identically
 * in light and dark mode: the class never changes, only the variable behind it.
 * The alternative — `dark:` variants sprinkled on every element — means every
 * new component is another chance to forget one.
 *
 * The palette is deliberately narrow: two greys, one accent, and semantic
 * colours only where meaning demands them (success, danger). Premium interfaces
 * look calm because they *are* calm — most of the screen is one background
 * colour, and colour is spent only where it carries information.
 */
const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Page background — the largest surface, so it sets the mood.
        canvas: 'hsl(var(--canvas) / <alpha-value>)',
        // Cards and panels that sit on the canvas.
        surface: 'hsl(var(--surface) / <alpha-value>)',
        // Hover states and subtle fills.
        muted: 'hsl(var(--muted) / <alpha-value>)',

        border: 'hsl(var(--border) / <alpha-value>)',

        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        // Secondary text: labels, timestamps, helper copy.
        subtle: 'hsl(var(--subtle) / <alpha-value>)',

        // The single accent. Used for primary actions and nothing else — the
        // moment a second thing is indigo, the button stops meaning "click me".
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          foreground: 'hsl(var(--accent-foreground) / <alpha-value>)',
          subtle: 'hsl(var(--accent-subtle) / <alpha-value>)',
        },

        success: 'hsl(var(--success) / <alpha-value>)',
        warning: 'hsl(var(--warning) / <alpha-value>)',
        danger: 'hsl(var(--danger) / <alpha-value>)',
      },

      borderRadius: {
        // Rounded, but not cartoonish. 10px on cards is the Linear/Vercel range.
        card: '12px',
      },

      boxShadow: {
        // Barely-there elevation. A heavy drop shadow is the fastest way to make
        // an enterprise app look like a 2012 Bootstrap template.
        card: '0 1px 2px 0 rgb(0 0 0 / 0.04), 0 1px 3px 0 rgb(0 0 0 / 0.06)',
        popover: '0 4px 12px -2px rgb(0 0 0 / 0.08), 0 2px 6px -2px rgb(0 0 0 / 0.06)',
      },

      fontFamily: {
        // System stack. It loads instantly, matches the user's OS, and avoids a
        // flash of unstyled text — which no webfont is worth.
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        // Tabular figures for money and scores, so columns of numbers align.
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },

      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        // Short and subtle. Anything over ~200ms on a list item feels sluggish
        // once you have used the app for more than a minute.
        'fade-up': 'fade-up 180ms ease-out',
        shimmer: 'shimmer 1.6s infinite',
      },
    },
  },
  plugins: [],
};

export default config;
