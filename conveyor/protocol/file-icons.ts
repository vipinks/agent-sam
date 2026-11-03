/**
 * Which file-type icon a row asks for, by name.
 *
 * Pure by construction: no file system, no renderer, no glob. The assets themselves are addressed in
 * `app/components/workbench/file-icon-assets.ts`, which keeps this module runnable under plain node
 * and lets the mapping be proved without a window.
 *
 * The precedence is the one the explorer readers expect, and it is fixed rather than incidental:
 * a name the contract pins wins first (`package-lock.json` is a lockfile, not a json file;
 * `tailwind.config.ts` is tailwind, not typescript), then a known dotfile prefix (`.env.*`), then a
 * compound suffix (`.d.ts`), then the last extension, then nothing. Unknown names return null so the
 * row keeps its Lucide fallback rather than borrowing an icon it does not own.
 */

export const FILE_ICON_KEYS = [
  'js',
  'mdx',
  'database',
  'json',
  'lock',
  'favicon',
  'svg',
  'toml',
  'editorconfig',
  'nodejs',
  'table',
  'xml',
  'changelog',
  'typescript',
  'readme',
  'tailwindcss',
  'vite',
  'tsconfig',
  'docker',
  'markdown',
  'css',
  'sass',
  'html',
  'react',
  'vue',
  'astro',
  'python',
  'java',
  'go',
  'rust',
  'ruby',
  'php',
  'c',
  'cpp',
  'csharp',
  'swift',
  'powershell',
  'yaml',
  'git',
  'license',
  'pdf',
  'word',
  'image',
  'console',
  'settings',
  'jsconfig',
  'graphql',
  'prisma',
  'npm',
  'eslint',
  'prettier',
] as const

export const FOLDER_ICON_KEYS = [
  'folder-src',
  'folder-lib',
  'folder-components',
  'folder-resource',
  'folder-api',
  'folder-database',
  'folder-dist',
  'folder-git',
  'folder-github',
  'folder-test',
  'folder-docs',
  'folder-config',
  'folder-public',
  'folder-scripts',
  'folder-images',
  'folder-font',
  'folder-app',
  'folder-client',
  'folder-utils',
  'folder-template',
] as const

export type FileIconKey = (typeof FILE_ICON_KEYS)[number]
export type FolderIconKey = (typeof FOLDER_ICON_KEYS)[number]
export type IconKey = FileIconKey | FolderIconKey

/** Every key this app ships, one asset file each — the list the asset glob is checked against. */
export const ICON_KEYS: readonly IconKey[] = [...FILE_ICON_KEYS, ...FOLDER_ICON_KEYS]

/**
 * Names whose answer is decided by the whole name rather than by its extension.
 *
 * Case is folded before lookup, so these are lower case only. The list is deliberately the names this
 * app's explorer meets every day and whose extension would otherwise give the wrong answer.
 */
const NAMED_FILES: Record<string, FileIconKey> = {
  'package-lock.json': 'lock',
  'npm-shrinkwrap.json': 'lock',
  'yarn.lock': 'lock',
  'pnpm-lock.yaml': 'lock',
  'bun.lock': 'lock',
  'bun.lockb': 'lock',
  'composer.lock': 'lock',
  'cargo.lock': 'lock',
  'gemfile.lock': 'lock',
  'poetry.lock': 'lock',
  'uv.lock': 'lock',
  'package.json': 'nodejs',
  '.nvmrc': 'nodejs',
  '.node-version': 'nodejs',
  dockerfile: 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  'compose.yml': 'docker',
  'compose.yaml': 'docker',
  'vite.config.ts': 'vite',
  'vite.config.js': 'vite',
  'vite.config.mjs': 'vite',
  'vite.config.cjs': 'vite',
  'electron.vite.config.ts': 'vite',
  'electron.vite.config.js': 'vite',
  'electron.vite.config.mjs': 'vite',
  'electron.vite.config.cjs': 'vite',
  'tailwind.config.ts': 'tailwindcss',
  'tailwind.config.js': 'tailwindcss',
  'tailwind.config.mjs': 'tailwindcss',
  'tailwind.config.cjs': 'tailwindcss',
  'postcss.config.ts': 'tailwindcss',
  'postcss.config.js': 'tailwindcss',
  'postcss.config.mjs': 'tailwindcss',
  'postcss.config.cjs': 'tailwindcss',
  'tsconfig.json': 'tsconfig',
  'jsconfig.json': 'jsconfig',
  '.editorconfig': 'editorconfig',
  'favicon.ico': 'favicon',
  'favicon.svg': 'favicon',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.npmrc': 'npm',
}

/** The last extension's answer, once none of the whole-name rules claimed the file. */
const EXTENSIONS: Record<string, FileIconKey> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'react',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'react',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  mdx: 'mdx',
  md: 'markdown',
  markdown: 'markdown',
  mkd: 'markdown',
  css: 'css',
  scss: 'sass',
  sass: 'sass',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  astro: 'astro',
  py: 'python',
  pyi: 'python',
  java: 'java',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  pdf: 'pdf',
  doc: 'word',
  docx: 'word',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  tiff: 'image',
  tif: 'image',
  ico: 'image',
  sh: 'console',
  bash: 'console',
  zsh: 'console',
  fish: 'console',
  graphql: 'graphql',
  gql: 'graphql',
  prisma: 'prisma',
  sql: 'database',
  db: 'database',
  sqlite: 'database',
  sqlite3: 'database',
  csv: 'table',
  tsv: 'table',
  xlsx: 'table',
  xls: 'table',
  xml: 'xml',
  svg: 'svg',
  toml: 'toml',
  lock: 'lock',
}

/** The icon key for a file name, or null when the name asks for none. */
export function fileIconKey(name: string): FileIconKey | null {
  const lower = name.trim().toLowerCase()
  if (lower.length === 0) return null

  const named = NAMED_FILES[lower]
  if (named) return named

  // Name shapes the contract pins: README* has no extension rule of its own, tsconfig.*.json is a
  // family rather than one name, and the tool configs are written with any of four extensions.
  if (lower.startsWith('readme')) return 'readme'
  if (lower.startsWith('changelog')) return 'changelog'
  if (lower.startsWith('license') || lower.startsWith('licence')) return 'license'
  if (lower === 'tsconfig.json' || (lower.startsWith('tsconfig.') && lower.endsWith('.json'))) return 'tsconfig'
  if (lower.startsWith('vite.config.') || lower.startsWith('electron.vite.config.')) return 'vite'
  if (lower.startsWith('tailwind.config.') || lower.startsWith('postcss.config.')) return 'tailwindcss'
  if (lower.startsWith('eslint.config.') || lower.startsWith('.eslintrc')) return 'eslint'
  if (lower.startsWith('prettier.config.') || lower.startsWith('.prettierrc') || lower === '.prettierignore') {
    return 'prettier'
  }
  if (lower.startsWith('docker-compose.')) return 'docker'

  // A known dotfile prefix, before the extension stage: `.env.local`'s last extension is `local`,
  // which alone would ask for nothing.
  if (lower === '.env' || lower.startsWith('.env.')) return 'settings'

  // A compound suffix, before the extension stage: the file is TypeScript source, not a `.ts` by luck.
  if (lower.endsWith('.d.ts')) return 'typescript'

  const dot = lower.lastIndexOf('.')
  if (dot < 0 || dot === lower.length - 1) return null
  return EXTENSIONS[lower.slice(dot + 1)] ?? null
}

/**
 * Folders that keep a Material glyph instead of the Lucide pair.
 *
 * Null is the default: an unnamed folder, and every folder the user invented, still draws the
 * `Folder`/`FolderOpen` pair this app has always used. `vendor` is deliberately absent — it is a
 * dependency cache, not a source directory, and the contract names it as the default case.
 */
const NAMED_FOLDERS: Record<string, FolderIconKey> = {
  src: 'folder-src',
  source: 'folder-src',
  lib: 'folder-lib',
  libs: 'folder-lib',
  library: 'folder-lib',
  components: 'folder-components',
  component: 'folder-components',
  resource: 'folder-resource',
  resources: 'folder-resource',
  api: 'folder-api',
  apis: 'folder-api',
  endpoints: 'folder-api',
  database: 'folder-database',
  databases: 'folder-database',
  db: 'folder-database',
  dist: 'folder-dist',
  build: 'folder-dist',
  out: 'folder-dist',
  git: 'folder-git',
  '.github': 'folder-github',
  github: 'folder-github',
  test: 'folder-test',
  tests: 'folder-test',
  __tests__: 'folder-test',
  spec: 'folder-test',
  specs: 'folder-test',
  docs: 'folder-docs',
  doc: 'folder-docs',
  documentation: 'folder-docs',
  config: 'folder-config',
  configs: 'folder-config',
  public: 'folder-public',
  scripts: 'folder-scripts',
  script: 'folder-scripts',
  images: 'folder-images',
  image: 'folder-images',
  img: 'folder-images',
  font: 'folder-font',
  fonts: 'folder-font',
  app: 'folder-app',
  client: 'folder-client',
  utils: 'folder-utils',
  util: 'folder-utils',
  template: 'folder-template',
  templates: 'folder-template',
}

/** The icon key for a folder name, or null when the folder keeps the Lucide pair. */
export function folderIconKey(name: string): FolderIconKey | null {
  return NAMED_FOLDERS[name.trim().toLowerCase()] ?? null
}
