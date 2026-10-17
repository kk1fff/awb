import { chromium } from 'playwright';

export type Capture = (url: string, output: string) => Promise<void>;
export const capture: Capture = async (url, output) => {
  const deadline = Date.now() + 30000;
  const remaining = () => Math.max(1, deadline - Date.now());
  const browser = await chromium.launch({
    headless: true,
    channel: 'chromium',
    timeout: remaining(),
  });
  const timer = setTimeout(() => void browser.close(), remaining());
  try {
    const page = await browser.newPage({
      viewport: { width: 1024, height: 768 },
      deviceScaleFactor: 1,
    });
    page.setDefaultTimeout(remaining());
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() });
    await page.waitForFunction(
      () => Boolean(window.__sceneReady || window.__sceneError),
      undefined,
      { timeout: remaining() },
    );
    const rendererError = await page.evaluate(() => window.__sceneError);
    if (rendererError) throw new Error(rendererError);
    if (errors.length) throw new Error(errors.join('\n'));
    await page.locator('canvas').screenshot({ path: output, timeout: remaining() });
  } finally {
    clearTimeout(timer);
    await browser.close();
  }
};
