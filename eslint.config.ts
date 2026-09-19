import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'out/**',
      'scripts/**', // plain node build scripts, outside the tsconfig project

      // Local scratch area: throwaway harnesses and captures, gitignored and imported by nothing.
      // Ignored here as well as deleted, so a future scratch area cannot silently poison the gate
      // the way this one did — an ignored path cannot contribute errors even if it grows again.
      '.preview/**',

      '.vscode/**',
      '.git/**',
      '.gitignore',
      '.eslintignore',
      '.eslintrc',
      '.prettierrc',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,jsx,ts,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        projectService: true,
      },
      globals: {
        // Browser globals that should be readonly
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        history: 'readonly',
        navigator: 'readonly',

        // Browser globals that can be modified
        console: 'writable',
        localStorage: 'writable',
        sessionStorage: 'writable',

        // Timer functions that can be modified
        setTimeout: 'writable',
        clearTimeout: 'writable',
        setInterval: 'writable',
        clearInterval: 'writable',

        // Node.js globals
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',

        // React globals
        React: 'readonly',
      },
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      // React specific rules
      'react/react-in-jsx-scope': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // TypeScript specific rules
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],

      // General rules
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'off',

      // Global modification rules
      'no-global-assign': [
        'error',
        {
          exceptions: ['console', 'localStorage', 'sessionStorage'],
        },
      ],
    },
  },
  // Node-side test harnesses: the runner, its stubs, and the CJS probes.
  //
  // These are deliberately CommonJS — they are launched with `node`, and the probes are run by
  // electron directly, before any bundler exists. `require`/`module`/`Buffer` are therefore the
  // correct primitives here, not a mistake, and the Node globals they use are declared rather than
  // assumed so the no-undef rule keeps meaning something everywhere else.
  {
    files: ['tests/**/*.cjs', 'tests/**/*.mjs'],
    languageOptions: {
      sourceType: 'commonjs',
      // Not part of the TypeScript program: these are launched by `node` and are deliberately
      // plain JavaScript, so there is no project for the type-aware parser to attach them to.
      // Without this, eslint reports a parsing error for each one.
      parserOptions: { projectService: false },
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'writable',
        Buffer: 'readonly',
        // Node's own web-standard globals. The Phase 11 smoke probes drive the packaged app over the
        // DevTools Protocol, so they use `fetch` for the target list and `WebSocket` for the
        // connection. Declared here rather than left undefined: `no-undef` should keep catching typos,
        // and a missing global that only appears in one probe is exactly the case it should not.
        fetch: 'readonly',
        WebSocket: 'readonly',
      },
    },
    rules: {
      // The whole point of these files is to be plain CommonJS that node can run unbuilt.
      '@typescript-eslint/no-require-imports': 'off',
      // The runner reports its own progress and summary the same way the suites do.
      'no-console': 'off',
    },
  },
  // The TypeScript node suites.
  //
  // `console.log` is their reporting mechanism, not incidental debugging: each suite prints its own
  // pass/fail lines and a summary, and the runner treats a non-zero exit as the real signal. Holding
  // test output to the app's `no-console` rule would mean rewriting every suite's reporting for no
  // benefit, so the rule is relaxed here and only here.
  {
    files: ['tests/**/*.ts', 'tests/**/*.tsx'],
    rules: {
      'no-console': 'off',
    },
  },
  // Add specific configuration for preload files
  {
    files: ['app/**/*.ts', 'lib/**/*.ts', 'app/**/*.tsx', 'lib/**/*.tsx'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        window: 'readonly',
      },
    },
  },
]
