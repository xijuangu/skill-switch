import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  {
    test: {
      name: 'node',
      environment: 'node',
      include: ['tests/**/*.test.ts'],
      exclude: ['tests/renderer/**/*'],
      globals: true
    }
  },
  {
    test: {
      name: 'renderer',
      environment: 'jsdom',
      include: ['tests/renderer/**/*.test.tsx'],
      globals: true,
      setupFiles: ['tests/renderer/setup.ts'],
      css: true,
      esbuild: {
        jsx: 'automatic'
      }
    }
  }
])
