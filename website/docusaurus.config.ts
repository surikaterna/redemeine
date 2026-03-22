import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
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
  onBrokenMarkdownLinks: 'warn',

  presets: [
    [
      'classic',
      {
        docs: {
          // Look UP one folder to find your actual markdown files
          path: '../docs',
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/surikaterna/redemeine/tree/main/',
          routeBasePath: '/', // Serves the docs at the root of the site
        },
        blog: false, // Disable the blog feature
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
        // Look UP one folder to find your TypeScript source code
        entryPoints: ['../src/index.ts'],
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
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Documentation',
        },
        {
          to: '/api', 
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