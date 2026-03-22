import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Redemeine',
  tagline: 'Sane defaults CQRS/ES aggregates library for TypeScript',
  favicon: 'img/favicon.ico',

  // GitHub Pages configuration
  url: 'https://surikaterna.github.io',
  baseUrl: '/redemeine/',
  organizationName: 'surikaterna',
  projectName: 'redemeine',
  trailingSlash: false,
  onBrokenLinks: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  presets: [
    [
      'classic',
      {
        docs: {
          path: '../docs',
          sidebarPath: './sidebars.ts',

          // ADD THIS EXCLUDE ARRAY:
          exclude: ['ai/**'], // <-- Tells Docusaurus to ignore the AI context folder entirely

          editUrl: 'https://github.com/surikaterna/redemeine/tree/main/',
          routeBasePath: 'docs', // <-- This puts your markdown pages safely at /docs/...
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    [
      'docusaurus-plugin-typedoc',
      {
        id: 'default', // Explicitly set the ID        
        // Look UP one folder to find your TypeScript source code
        entryPoints: ['../src/redemeine.ts'],
        tsconfig: '../tsconfig.json',
        // Output the generated API docs into your root docs folder
        out: '../docs/api',
        plugin: ['typedoc-plugin-markdown'],
        sidebar: {
          categoryLabel: 'API Reference',
          position: 6,
          fullNames: false,
        },
        readme: 'none',
      },
    ],
  ],

  themeConfig: {
    navbar: {
      title: 'Redemeine',
      logo: {
        alt: 'Redemeine Logo',
        src: 'img/logo.svg',
      },
      items: [
        {
          // Explicitly points to your docs/index.md file
          type: 'doc',
          docId: 'index',
          position: 'left',
          label: 'Documentation',
        },
        {
          // Links to the separate API sidebar we just created
          type: 'docSidebar',
          sidebarId: 'apiSidebar',
          label: 'API Reference',
          position: 'left'
        },
        {
          href: 'https://github.com/surikaterna/redemeine',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      copyright: `Copyright © ${new Date().getFullYear()} Redemeine. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'typescript', 'json'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;