import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Vitest configuration for renderer wiring tests.
 *
 * Deliberately separate from the existing npm scripts: those bundle with esbuild into .cjs and run
 * under plain node, and they stay exactly as they are. This runner only covers what needs a DOM —
 * hooks and components whose correctness lives in whether the wiring calls the right thing.
 *
 * `jsdom` rather than `happy-dom`: the components under test use ResizeObserver-free paths, but jsdom
 * is the closer match for the browser APIs React itself asserts on, and the Electron renderer is the
 * environment being approximated.
 *
 * The `.tsx` include means these files are type-aware linted and typechecked like app code, which is
 * the point: a wiring test that drifts from the real prop types is worse than none.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    // Only the wiring suite. The esbuild-based suites are run by their own scripts and are not
    // discovered here, so neither runner can disturb the other.
    include: ['testing/**/*.test.ts', 'testing/**/*.test.tsx'],
    // Installs a stub bridge before any test file is imported. Required rather than a convenience:
    // the app's client constructs itself at module scope from `window.conveyor`, so app code cannot
    // be imported until a bridge exists.
    setupFiles: ['testing/setup-bridge.ts'],
    // Explicit imports rather than globals, so the eslint config needs no test-only additions.
    globals: false,
    restoreMocks: true,
    // A failing React render should fail with a usable trace rather than a screenful of DOM.
    reporters: ['default'],
  },
  // The app's tsconfig sets `jsx: react-jsx`, so sources do not import React. Vitest transforms
  // independently of tsc and defaults to the classic runtime, which is why `React is not defined`
  // appeared until this was set — the tests must compile the way the app does.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      // Mirrors the `@/*` path alias the app uses.
      '@': resolve(import.meta.dirname),
    },
  },
})
