/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx,ts,tsx}',
    './components/**/*.{js,jsx,ts,tsx}',
    './lib/**/*.{js,jsx,ts,tsx}',
    './hooks/**/*.{js,jsx,ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--shadcn-border))',
        input: 'hsl(var(--shadcn-input))',
        ring: 'hsl(var(--shadcn-ring))',
        background: 'hsl(var(--shadcn-background))',
        foreground: 'hsl(var(--shadcn-foreground))',
        primary: {
          DEFAULT: 'hsl(var(--shadcn-primary))',
          foreground: 'hsl(var(--shadcn-primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--shadcn-secondary))',
          foreground: 'hsl(var(--shadcn-secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--shadcn-destructive))',
          foreground: 'hsl(var(--shadcn-destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--shadcn-muted))',
          foreground: 'hsl(var(--shadcn-muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--shadcn-accent))',
          foreground: 'hsl(var(--shadcn-accent-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--shadcn-radius)',
        md: 'calc(var(--shadcn-radius) - 2px)',
        sm: 'calc(var(--shadcn-radius) - 4px)',
      },
    },
  },
  plugins: [],
};
