import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(tmpdir(), 'fieldwork-browser-'));
export default defineConfig({
  testDir: './tests/browser', workers: 1, fullyParallel: false, timeout: 60000,
  use: { baseURL: 'http://127.0.0.1:4173', browserName: 'chromium', channel: 'chromium', viewport: { width: 1440, height: 1100 }, trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run build && npm start', url: 'http://127.0.0.1:4173/api/health', reuseExistingServer: false, timeout: 120000,
    env: { PORT: '4173', CLIENT_URL: 'http://127.0.0.1:4173', DATA_DIR: path.join(root, 'data'), ARTIFACTS_DIR: path.join(root, 'runs'), RUN_ID: 'browser-test' },
  },
});
