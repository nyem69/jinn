import { defineConfig } from 'vitest/config'
import os from 'node:os'
import path from 'node:path'

// Point JINN_HOME at a per-process tmp directory so tests never touch the
// developer's real ~/.jinn (which carries legacy state and would either be
// corrupted by tests OR poison test runs by carrying a partially-migrated
// schema). Setting it here happens before any test module imports
// shared/paths.ts, so SESSIONS_DB and friends resolve under the tmp tree.
const JIMMY_TEST_HOME = path.join(os.tmpdir(), `jinn-vitest-${process.pid}`)

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    env: {
      JINN_HOME: JIMMY_TEST_HOME,
    },
  },
})
