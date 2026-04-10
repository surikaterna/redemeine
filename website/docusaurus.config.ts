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
        id: 'default',
        entryPoints: ['../src/redemeine.ts'],
        tsconfig: '../tsconfig.typedoc.json',
        out: '../docs/api',
        // Critical for CI success:
        cleanOutputDir: true,
        disableSources: true,
        validation: {
          invalidLink: false,
        },
        sidebar: {
          autoConfiguration: true,
          // REMOVE categoryLabel if it was still there!
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
          type: 'doc',
          docId: 'index',
          position: 'left',
          label: 'Documentation',
        },
        {
          // We change 'type: docSidebar' to a direct 'to' link
          // This ensures Docusaurus knows exactly which URL to hit
          type: 'doc',
          docId: 'api/index',
          label: 'API Reference',
          position: 'left',
          docsPluginId: 'default',
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
