import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill();
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  try { await Promise.race([exited, new Promise<never>((_, reject) => { const limit = setTimeout(() => reject(new Error('preview did not exit')), 4000); limit.unref(); })]); } finally { clearTimeout(timer); }
}

test('current production native project', { tag: '@mobile' }, async ({ page }) => {
  const child = spawn(process.execPath, ['scripts/preview.mjs'], { cwd: new URL('../..', import.meta.url), env: { ...process.env, PREVIEW_PORT: '4198' }, stdio: 'pipe' });
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.on('data', () => resolve()); child.once('exit', code => reject(new Error(`preview exited ${code}`))); });
    await page.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:4198' ? route.continue() : route.abort());
    await page.goto('http://127.0.0.1:4198/#/project/stats');
    await expect(page.getByRole('heading', { name: 'stats', level: 1 })).toBeVisible();
    await expect(page.getByText('Application telemetry', { exact: true })).toBeVisible();
    await expect(page.getByText('522 HTTP requests')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot('production-stats.webp', { fullPage: true });
  } finally { await stop(child); }
});
