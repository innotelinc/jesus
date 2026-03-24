import type { InstalledTheme } from './plugin-types';

const nordCSS = `
:root {
  --color-border: #d8dee9;
  --color-input: #d8dee9;
  --color-ring: #81a1c1;
  --color-background: #eceff4;
  --color-foreground: #2e3440;
  --color-primary: #5e81ac;
  --color-primary-foreground: #eceff4;
  --color-secondary: #e5e9f0;
  --color-secondary-foreground: #2e3440;
  --color-muted: #d8dee9;
  --color-muted-foreground: #4c566a;
  --color-accent: #81a1c1;
  --color-accent-foreground: #2e3440;
  --color-destructive: #bf616a;
  --color-destructive-foreground: #eceff4;
  --color-popover: #eceff4;
  --color-popover-foreground: #2e3440;
}
.dark {
  --color-border: #3b4252;
  --color-input: #3b4252;
  --color-ring: #88c0d0;
  --color-background: #2e3440;
  --color-foreground: #eceff4;
  --color-primary: #88c0d0;
  --color-primary-foreground: #2e3440;
  --color-secondary: #3b4252;
  --color-secondary-foreground: #eceff4;
  --color-muted: #3b4252;
  --color-muted-foreground: #d8dee9;
  --color-accent: #434c5e;
  --color-accent-foreground: #88c0d0;
  --color-destructive: #bf616a;
  --color-destructive-foreground: #eceff4;
  --color-popover: #3b4252;
  --color-popover-foreground: #eceff4;
}`;

const catppuccinCSS = `
:root {
  --color-border: #ccd0da;
  --color-input: #ccd0da;
  --color-ring: #8839ef;
  --color-background: #eff1f5;
  --color-foreground: #4c4f69;
  --color-primary: #8839ef;
  --color-primary-foreground: #eff1f5;
  --color-secondary: #e6e9ef;
  --color-secondary-foreground: #4c4f69;
  --color-muted: #dce0e8;
  --color-muted-foreground: #6c6f85;
  --color-accent: #8839ef;
  --color-accent-foreground: #eff1f5;
  --color-destructive: #d20f39;
  --color-destructive-foreground: #eff1f5;
  --color-popover: #eff1f5;
  --color-popover-foreground: #4c4f69;
}
.dark {
  --color-border: #45475a;
  --color-input: #45475a;
  --color-ring: #cba6f7;
  --color-background: #1e1e2e;
  --color-foreground: #cdd6f4;
  --color-primary: #cba6f7;
  --color-primary-foreground: #1e1e2e;
  --color-secondary: #313244;
  --color-secondary-foreground: #cdd6f4;
  --color-muted: #313244;
  --color-muted-foreground: #a6adc8;
  --color-accent: #45475a;
  --color-accent-foreground: #cba6f7;
  --color-destructive: #f38ba8;
  --color-destructive-foreground: #1e1e2e;
  --color-popover: #313244;
  --color-popover-foreground: #cdd6f4;
}`;

const solarizedCSS = `
:root {
  --color-border: #eee8d5;
  --color-input: #eee8d5;
  --color-ring: #268bd2;
  --color-background: #fdf6e3;
  --color-foreground: #657b83;
  --color-primary: #268bd2;
  --color-primary-foreground: #fdf6e3;
  --color-secondary: #eee8d5;
  --color-secondary-foreground: #586e75;
  --color-muted: #eee8d5;
  --color-muted-foreground: #93a1a1;
  --color-accent: #268bd2;
  --color-accent-foreground: #fdf6e3;
  --color-destructive: #dc322f;
  --color-destructive-foreground: #fdf6e3;
  --color-popover: #fdf6e3;
  --color-popover-foreground: #657b83;
}
.dark {
  --color-border: #073642;
  --color-input: #073642;
  --color-ring: #268bd2;
  --color-background: #002b36;
  --color-foreground: #839496;
  --color-primary: #268bd2;
  --color-primary-foreground: #002b36;
  --color-secondary: #073642;
  --color-secondary-foreground: #93a1a1;
  --color-muted: #073642;
  --color-muted-foreground: #586e75;
  --color-accent: #073642;
  --color-accent-foreground: #268bd2;
  --color-destructive: #dc322f;
  --color-destructive-foreground: #fdf6e3;
  --color-popover: #073642;
  --color-popover-foreground: #93a1a1;
}`;

export const BUILTIN_THEMES: InstalledTheme[] = [
  {
    id: 'builtin-nord',
    name: 'Nord',
    version: '1.0.0',
    author: 'Built-in',
    description: 'Arctic, north-bluish color palette inspired by nordtheme.com',
    css: nordCSS,
    variants: ['light', 'dark'],
    enabled: true,
    builtIn: true,
  },
  {
    id: 'builtin-catppuccin',
    name: 'Catppuccin',
    version: '1.0.0',
    author: 'Built-in',
    description: 'Soothing pastel theme with Latte (light) and Mocha (dark) variants',
    css: catppuccinCSS,
    variants: ['light', 'dark'],
    enabled: true,
    builtIn: true,
  },
  {
    id: 'builtin-solarized',
    name: 'Solarized',
    version: '1.0.0',
    author: 'Built-in',
    description: 'Precision colors for machines and people by Ethan Schoonover',
    css: solarizedCSS,
    variants: ['light', 'dark'],
    enabled: true,
    builtIn: true,
  },
];
