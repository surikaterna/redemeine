import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Redemeine',
  tagline: 'Sane defaults CQRS/ES aggregates library for TypeScript',
  favicon: 'img/favicon.ico',
  url: 'https://surikaterna.github.io', 
  baseUrl: '/redemeine/', 
  organizationName: 'surikaterna-github-username', 
  projectName: 'redemeine', 
  trailingSlash: false,
  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'warn',

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/surikaterna/redemeine/tree/main/website/',
          // Remove the "docs" prefix from URLs so it feels more like a seamless app
          routeBasePath: '/', 
        },
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
        // Points to your library's entry file
        entryPoints: ['../src/index.ts'],
        tsconfig: '../tsconfig.json',
        // Output directory inside the `docs` folder
        out: 'api',
        // Standardize the TypeDoc output to match Docusaurus MDX
        plugin: ['typedoc-plugin-markdown'],
        // Clean the directory on every build
        cleanOutputDir: true,
        // Automatically inject the API reference into your sidebar
        sidebar: {
          categoryLabel: 'API Reference',
          position: 6,
          fullNames: false,
        },
        // Turn off the default TypeDoc README so it doesn't clash with your index.md
        readme: 'none',
        // Group by Mixins, Builders, etc. (uses your @category tags)
        categorizeByGroup: true, 
      },
    ],
  ],

  themeConfig: {
    // The RTK 2.0 standard: A clean navbar separating concepts from reference
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
          href: 'https://github.com/your-github-username/redemeine',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Tutorial', to: '/tutorials/essentials' },
            { label: 'API Reference', to: '/api' },
          ],
        },
        {
          title: 'Community',
          items: [
            { label: 'GitHub Discussions', href: 'https://github.com/your-github-username/redemeine/discussions' },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Redemeine. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      // Add support for terminal commands and JSON
      additionalLanguages: ['bash', 'json', 'typescript'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;