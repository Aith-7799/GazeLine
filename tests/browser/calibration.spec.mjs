import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { createServer, normalizePath } from 'vite';
import { gazeRuntime } from '../../server/gazeRuntime.mjs';

let server, url;
test.beforeAll(async () => {
  const root = normalizePath(fileURLToPath(new URL('../../', import.meta.url))).replace(/\/$/, '');
  server = await createServer({
    configFile: false, root,
    envDir: false, cacheDir: 'node_modules/.vite-calibration',
    optimizeDeps: { entries: ['index.html'] },
    server: { host: '127.0.0.1', port: 0, fs: { deny: ['**/.*', `${root}/**/.*/**`, '**/*.sqlite*'] } },
    plugins: [gazeRuntime()],
  });
  await server.listen();
  url = 'http://127.0.0.1:' + server.httpServer.address().port;
});
test.afterAll(async () => { await server?.close(); });

async function openWizard(page) {
  await page.goto(url);
  await page.evaluate(async () => {
    const { runCalibrationWizard } = await import('/src/app/calibration.ts');
    document.body.style.minHeight = '250vh';
    window.scrollTo(0, 400);
    window.captured = [];
    window.capturePoint = async (x, y) => ({ gazeX: x, gazeY: y });
    window.wizardResult = runCalibrationWizard({
      async captureCalibrationSample(x, y) {
        window.captured.push({ x, y });
        return window.capturePoint(x, y);
      },
    }, new AbortController().signal);
  });
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 2048, height: 192 }, { width: 320, height: 568 }]) {
  test(`all 17 target centres match the samples at ${viewport.width} Ã— ${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openWizard(page);
    const target = page.locator('.cal-target');
    for (let i = 0; i < 17; i++) {
      await expect(target).toHaveAccessibleName(`Capture point ${i + 1}`);
      const box = await target.boundingBox();
      const header = await page.locator('.cal-progress').boundingBox();
      const footer = await page.locator('.cal-footer').boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(header.y + header.height);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(footer.y);
      expect(footer.y + footer.height).toBeLessThanOrEqual(viewport.height + 1);
      await target.click();
      await expect.poll(() => page.evaluate(() => window.captured.length)).toBe(i + 1);
      const sample = await page.evaluate(() => window.captured.at(-1));
      expect(sample.x).toBeCloseTo(box.x + box.width / 2, 1);
      expect(sample.y).toBeCloseTo(box.y + box.height / 2, 1);
    }
    expect(await page.evaluate(async () => (await window.wizardResult).length)).toBe(17);
  });
}

test('a miss retries the same dot and a late capture cannot advance a restarted wizard', async ({ page }) => {
  await openWizard(page);
  await page.evaluate(() => { window.capturePoint = () => null; });
  const target = page.locator('.cal-target');
  await target.click();
  await expect(page.getByRole('status')).toContainText('try again');
  await expect(target).toHaveAccessibleName('Capture point 1');
  await page.evaluate(() => { window.capturePoint = () => new Promise(resolve => { window.release = resolve; }); });
  await target.dblclick();
  await expect.poll(() => page.evaluate(() => window.captured.length)).toBe(2);
  await page.getByRole('button', { name: 'Restart' }).click();
  await page.evaluate(() => window.release({ gazeX: 1, gazeY: 1 }));
  await expect(target).toHaveAccessibleName('Capture point 1');
  await page.evaluate(() => { window.capturePoint = (x, y) => ({ gazeX: x, gazeY: y }); });
  await target.focus();
  await page.keyboard.down('Space');
  await expect(target).toHaveAccessibleName('Capture point 2');
  await page.keyboard.up('Space');
  await page.setViewportSize({ width: 980, height: 520 });
  await expect(target).toHaveAccessibleName('Capture point 1');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.wizardResult)).toBeNull();
  await expect(page.locator('.cal-overlay')).toHaveCount(0);
});
