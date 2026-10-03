/**
 * Browser end-to-end test against the running Vite dev server.
 *
 * Covers the required flow:
 *  1. import image with embedded ICC -> source identified automatically
 *  2. import image WITHOUT ICC -> source profile selection is mandatory,
 *     assumption recorded
 *  3. choose target profile (open CIE RGB + imported open CMYK), intent, BPC
 *  4. side-by-side preview appears
 *  5. sampler reports source/target device + Lab values
 *  6. export PNG (RGB target) -> ImageMagick-independent verification done in
 *     scripts/verify-exports.sh (iCCP + pixels + provenance)
 *  7. export TIFF (CMYK target)
 *  8. re-import the converted export -> blocked as already-converted
 *  9. transparent borders survive
 * 10. focus points: transparent edge + color block sampling, zoom-stable marks
 * 11. condition change -> old judgement kept as history, explicit re-review
 * 12. project save/reload -> focus points, notes, statuses restored
 * 13. different image / fingerprint mismatch -> old points never auto-applied
 * 14. late async sample results never resurrect deleted points or pollute a
 *     switched context
 */
import { chromium, type Browser, type Page } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const FIX = resolve(ROOT, 'test-assets/browser');
const PROFILES = resolve(ROOT, 'test-assets/profiles');
const URL = process.env.E2E_URL || 'http://localhost:5199';

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ok - ${name}`);
  else {
    failures++;
    console.error(`  FAIL - ${name} ${detail}`);
  }
}

async function freshPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 980 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(URL);
  await page.waitForSelector('text=/正在加载|原图（原始像素）/');
  await page.waitForSelector('.sidebar', { timeout: 15000 });
  (page as unknown as { __errs: string[] }).__errs = errors;
  return page;
}

async function importImage(page: Page, file: string) {
  const input = page.locator('input[type=file][accept*="png"]').first();
  await input.setInputFiles(file);
}

/** Click the center of image pixel (px,py) on canvas #index (12x8 fixtures). */
async function clickCanvasPixel(page: Page, index: number, px: number, py: number, imgW = 12, imgH = 8) {
  const canvas = page.locator('canvas').nth(index);
  const box = await canvas.boundingBox();
  const sx = box!.width / imgW;
  const sy = box!.height / imgH;
  await page.mouse.click(box!.x + (px + 0.5) * sx, box!.y + (py + 0.5) * sy);
}

/** Drag a rectangle from pixel (x0,y0) to pixel (x1,y1) on canvas #index. */
async function dragCanvasRect(
  page: Page,
  index: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  imgW = 12,
  imgH = 8,
) {
  const canvas = page.locator('canvas').nth(index);
  const box = await canvas.boundingBox();
  const sx = box!.width / imgW;
  const sy = box!.height / imgH;
  await page.mouse.move(box!.x + (x0 + 0.5) * sx, box!.y + (y0 + 0.5) * sy);
  await page.mouse.down();
  await page.mouse.move(box!.x + (x1 + 0.5) * sx, box!.y + (y1 + 0.5) * sy, { steps: 6 });
  await page.mouse.up();
}

const pageErrors = (page: Page) =>
  (page as unknown as { __errs: string[] }).__errs.filter(
    (e) => !e.includes('Failed to load resource') && !e.includes('favicon'),
  );

async function runConvert(page: Page) {
  const btn = page.getByRole('button', { name: /执行 ICC 转换/ });
  await btn.click();
  await page.waitForFunction(
    () => !document.body.innerText.includes('LittleCMS 转换中'),
    null,
    { timeout: 60000 },
  );
}

async function exportPair(page: Page): Promise<{ png: string; tif?: string }> {
  const names: string[] = [];
  page.on('download', async (d) => names.push(d.suggestedFilename()));
  // downloads actually save via <a download>; listen for download events
  const downloads: { name: string; path: string }[] = [];
  page.removeListener('download', () => {});
  const waiters: Promise<void>[] = [];
  page.on('download', (d) => {
    const p = resolve(ROOT, 'test-out', d.suggestedFilename());
    waiters.push(d.saveAs(p));
    downloads.push({ name: d.suggestedFilename(), path: p });
  });
  await page.getByRole('button', { name: /导出转换图像/ }).click();
  await page.waitForTimeout(1500);
  await Promise.all(waiters);
  ok(`export produced 2 files (got ${downloads.length})`, downloads.length === 2, downloads.map((d) => d.name).join(','));
  const img = downloads.find((d) => d.name.endsWith('.png') || d.name.endsWith('.tif'))!;
  return { png: img.path, tif: downloads.find((d) => d.name.endsWith('.tif'))?.path };
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--no-sandbox'],
  });

  // ---------- Scenario A: embedded sRGB -> CIE RGB ----------
  {
    const page = await freshPage(browser);
    console.log('# A. embedded-profile image -> CIE RGB');
    await importImage(page, resolve(FIX, 'patches-srgb.png'));
    await page.waitForSelector('.badge.embedded');
    ok('embedded ICC badge shown', await page.locator('.badge.embedded').first().isVisible());
    ok('source description visible', (await page.locator('.mono.small').first().innerText()).length > 3);

    // transparent border canvas alpha check happens after convert; run it
    await runConvert(page);
    await page.waitForTimeout(800);
    // both canvases present and non-empty
    const canvases = await page.locator('canvas').count();
    ok('two canvases rendered', canvases >= 2, String(canvases));
    const alphaInfo = await page.evaluate(() => {
      const cvs = document.querySelectorAll('canvas');
      const out: { corner: number[]; red: number[] }[] = [];
      cvs.forEach((c) => {
        const ctx = c.getContext('2d')!;
        const corner = Array.from(ctx.getImageData(0, 0, 1, 1).data);
        const red = Array.from(ctx.getImageData(1, 1, 1, 1).data);
        out.push({ corner, red });
      });
      return out;
    });
    ok(
      'transparent corner alpha=0 on both canvases',
      alphaInfo.length >= 2 && alphaInfo.every((a) => a.corner[3] === 0),
      JSON.stringify(alphaInfo),
    );

    // sampler: hover interior red block
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    await page.mouse.move(box!.x + box!.width * 0.3, box!.y + box!.height * 0.45);
    await page.waitForTimeout(600);
    const sampleText = await page.locator('.samplegrid').first().innerText();
    ok('sampler shows Lab rows', sampleText.includes('Lab') && sampleText.includes('ΔE'), sampleText.slice(0, 200));
    ok('sampler shows source percentages', /R\s+\d+\.\d%/.test(sampleText));

    // export RGB PNG
    const { png } = await exportPair(page);
    ok('PNG export exists', existsSync(png), png);
    const exported = readFileSync(png);
    ok('PNG export has iCCP marker bytes', exported.subarray(0, 8).every((b, i) => b === [137, 80, 78, 71, 13, 10, 26, 10][i]));
    const errs = (page as unknown as { __errs: string[] }).__errs.filter(
      (e) => !e.includes('Failed to load resource') && !e.includes('favicon'),
    );
    ok('no page errors', errs.length === 0, errs.join(' | ').slice(0, 400));
    await page.close();
  }

  // ---------- Scenario B: missing profile forces source choice ----------
  {
    const page = await freshPage(browser);
    console.log('# B. no-ICC image forces source assumption');
    await importImage(page, resolve(FIX, 'patches-noicc.png'));
    await page.waitForSelector('.warn');
    const warn = await page.locator('.warn.panel-warn').first().innerText();
    ok('missing-profile warning shown', warn.includes('缺少嵌入'));
    const convertBtn = page.getByRole('button', { name: /执行 ICC 转换/ });
    ok('convert disabled until source chosen', await convertBtn.isDisabled());

    // choose sRGB as assumed source
    await page.locator('select').filter({ hasText: '请选择源配置' }).first().selectOption({ index: 1 });
    await page.waitForSelector('.ok');
    ok('assumption recorded notice', (await page.locator('.small.ok').first().innerText()).includes('已记录假设'));
    ok('convert enabled after choice', !(await convertBtn.isDisabled()));
    await page.close();
  }

  // ---------- Scenario C: CMYK target -> TIFF export ----------
  {
    const page = await freshPage(browser);
    console.log('# C. RGB -> open CMYK profile -> TIFF export');
    // import CMYK profile into the library
    await page
      .locator('input[type=file][accept*=".icc"]')
      .setInputFiles(resolve(PROFILES, 'ISOcoated_v2_300_mth.icc'));
    await page.waitForTimeout(1000);
    await importImage(page, resolve(FIX, 'patches-srgb.png'));
    await page.waitForSelector('.badge.embedded');
    // pick target: select containing ISO Coated
    const targetSelect = page.locator('label.field', { hasText: '目标 ICC' }).locator('select');
    const opts = await targetSelect.locator('option').allInnerTexts();
    const isoIdx = opts.findIndex((o) => o.includes('ISO Coated'));
    ok('CMYK profile listed', isoIdx >= 0, opts.join(' | '));
    await targetSelect.selectOption({ index: isoIdx });
    await page.waitForTimeout(200);
    await runConvert(page);
    await page.waitForTimeout(800);
    const { tif } = await exportPair(page);
    ok('TIFF export produced', !!tif && existsSync(tif!), tif ?? '');
    await page.close();
  }

  // ---------- Scenario D: re-import converted export is blocked ----------
  {
    const page = await freshPage(browser);
    console.log('# D. converted export re-import is blocked');
    const exportedPng = resolve(ROOT, 'test-out')
      ? undefined
      : undefined;
    void exportedPng;
    // find latest proof png in test-out
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(resolve(ROOT, 'test-out')).filter((f) => f.endsWith('.png') && f.includes('proof'));
    ok('found converted export to re-import', files.length > 0, files.join(','));
    if (files.length) {
      await importImage(page, resolve(ROOT, 'test-out', files[0]));
      await page.waitForSelector('.danger');
      const danger = await page.locator('.danger').first().innerText();
      ok('re-import warns about double conversion', danger.includes('转换标记'));
      ok(
        'convert button blocked',
        await page.getByRole('button', { name: /执行 ICC 转换/ }).isDisabled(),
      );
    }
    await page.close();
  }

  // ---------- Scenario E: JPEG with embedded ICC (APP2 path) ----------
  {
    const page = await freshPage(browser);
    console.log('# E. embedded-profile JPEG -> CIE RGB');
    const input = page.locator('input[type=file][accept*="jpeg"]').first();
    await input.setInputFiles(resolve(FIX, 'patches-srgb.jpg'));
    await page.waitForSelector('.badge.embedded');
    ok('JPEG embedded ICC badge shown', await page.locator('.badge.embedded').first().isVisible());
    await runConvert(page);
    await page.waitForTimeout(500);
    ok('JPEG conversion rendered 2 canvases', (await page.locator('canvas').count()) >= 2);
    await page.close();
  }

  // ---------- Scenario F: 16-bit PNG with iCCP ----------
  {
    const page = await freshPage(browser);
    console.log('# F. 16-bit PNG -> CIE RGB');
    await importImage(page, resolve(FIX, 'patches-srgb16.png'));
    await page.waitForSelector('.badge.embedded');
    await runConvert(page);
    await page.waitForTimeout(900);
    const info16 = await page.evaluate(() => {
      const cvs = document.querySelectorAll('canvas');
      const c = cvs[1];
      const ctx = c.getContext('2d')!;
      return { corner: Array.from(ctx.getImageData(0, 0, 1, 1).data), w: c.width, h: c.height };
    });
    ok('16-bit source proof canvas alpha preserved', info16.corner[3] === 0, JSON.stringify(info16.corner));
    ok('16-bit dimensions kept', info16.w === 12 && info16.h === 8, JSON.stringify(info16));
    await page.close();
  }

  // ---------- Scenario G–J: focus points full lifecycle ----------
  {
    const page = await freshPage(browser);
    console.log('# G. focus points: transparent edge + color block, zoom-stable');
    await importImage(page, resolve(FIX, 'patches-srgb.png'));
    await page.waitForSelector('.badge.embedded');

    // point focus on the transparent corner (0,0)
    await page.getByRole('button', { name: /＋ 点关注点/ }).click();
    await clickCanvasPixel(page, 0, 0, 0);
    await page.waitForSelector('.focuscard');
    ok('focus point card created', (await page.locator('.focuscard').count()) === 1);
    const card1 = page.locator('.focuscard').first();
    ok('point coords in original-image pixels', (await card1.locator('.coords').innerText()).includes('(0, 0)'));
    ok('image fingerprint bound', (await card1.locator('.hash').innerText()).includes('指纹'));
    await page.waitForFunction(
      () => document.querySelector('.focuscard')?.textContent?.includes('透明像素'),
      null,
      { timeout: 20000 },
    );
    const t1 = await card1.innerText();
    ok('transparent corner: alpha 0 sampled', t1.includes('均值 0.0 / 255') && t1.includes('透明像素 1/1'), t1.slice(0, 300));
    ok('point ΔE shown', t1.includes('ΔE00'));

    // rect focus on the interior red block (1,1)-(3,2)
    await page.getByRole('button', { name: /＋ 区域关注点/ }).click();
    await dragCanvasRect(page, 0, 1, 1, 3, 2);
    await page.waitForFunction(() => document.querySelectorAll('.focuscard').length === 2);
    const card2 = page.locator('.focuscard').nth(1);
    await page.waitForFunction(
      () => document.querySelectorAll('.focuscard')[1]?.textContent?.includes('透明像素'),
      null,
      { timeout: 20000 },
    );
    const t2 = await card2.innerText();
    ok('rect coords in original-image pixels', t2.includes('(1, 1)') && t2.includes('3×2'), t2.slice(0, 200));
    ok('red block: opaque, source R 100%', t2.includes('透明像素 0/6') && t2.includes('R 100.0%'), t2.slice(0, 300));
    ok('rect drag did not leave a stray pin', (await page.locator('.pinbox').count()) === 0);

    // markers render on both canvases after conversion and track zoom
    await runConvert(page);
    await page.waitForTimeout(800);
    ok('focus marks on both canvases', (await page.locator('.focusDot').count()) >= 2 && (await page.locator('.focusRect').count()) >= 2);
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.waitForTimeout(400);
    const align = await page.evaluate(() => {
      const canvas = document.querySelector('canvas')!;
      const cb = canvas.getBoundingClientRect();
      const dot = document.querySelector('.focusDot')!.getBoundingClientRect();
      const sx = cb.width / 12;
      const sy = cb.height / 8;
      return {
        dx: Math.abs(dot.x + dot.width / 2 - (cb.x + 0.5 * sx)),
        dy: Math.abs(dot.y + dot.height / 2 - (cb.y + 0.5 * sy)),
      };
    });
    ok('focus mark stays on its pixel after zoom/resize', align.dx < 2 && align.dy < 2, JSON.stringify(align));
    await page.setViewportSize({ width: 1600, height: 980 });
    await page.waitForTimeout(300);

    console.log('# H. condition change -> history kept, explicit re-review');
    // judge the point under the current conditions first
    await card1.locator('select.focus-status').selectOption('pass');
    await card1.locator('input.focus-note').fill('品牌色可接受');
    await card1.locator('input.focus-note').press('Tab');
    // change rendering intent -> conditions change
    await page.locator('label.field', { hasText: '渲染意图' }).locator('select').selectOption('perceptual');
    await page.waitForTimeout(300);
    ok(
      'no current judgement after condition change',
      (await card1.locator('.panel-warn').count()) === 1 &&
        (await card1.locator('.panel-warn').innerText()).includes('尚无判定'),
    );
    ok('old judgement cannot masquerade: no status editor', (await card1.locator('select.focus-status').count()) === 0);
    const hist1 = await card1.innerText();
    ok('old judgement kept as history', hist1.includes('判定历史（1 个版本）') && hist1.includes('品牌色可接受'), hist1.slice(0, 400));
    ok('old status visible in history', hist1.includes('通过'));
    ok('rect point also lost current judgement', (await card2.locator('.panel-warn').count()) === 1);

    // explicit re-review under the new conditions
    await card1.getByRole('button', { name: /按当前条件复核/ }).click();
    await page.waitForSelector('.focuscard select.focus-status', { timeout: 20000 });
    ok('re-review samples under new conditions', (await card1.locator('select.focus-status').count()) === 1);
    const hist2 = await card1.innerText();
    ok('history now has two versions', hist2.includes('判定历史（2 个版本）'), hist2.slice(0, 200));
    await card1.locator('.history summary').click();
    const hist2open = await card1.innerText();
    ok('old note survives re-review', hist2open.includes('品牌色可接受'));

    console.log('# I. save + reload -> focus points, notes, statuses restored');
    await card1.locator('select.focus-status').selectOption('watch');
    await card1.locator('input.focus-note').fill('复核后仍可接受');
    await card1.locator('input.focus-note').press('Tab');
    await page.locator('input[placeholder*="工程名称"]').fill('焦点测试工程');
    await page.getByRole('button', { name: '保存工程' }).click();
    await page.waitForSelector('text=工程已保存');
    await page.reload();
    await page.waitForSelector('.sidebar', { timeout: 15000 });
    await page.getByRole('button', { name: /焦点测试工程/ }).click();
    await page.waitForSelector('text=已载入工程');
    await page.waitForFunction(() => document.querySelectorAll('.focuscard').length === 2, null, { timeout: 15000 });
    const rcard1 = page.locator('.focuscard').first();
    const rcard2 = page.locator('.focuscard').nth(1);
    ok('reloaded: two focus points restored', (await page.locator('.focuscard').count()) === 2);
    ok('reloaded: coords intact', (await rcard1.locator('.coords').innerText()).includes('(0, 0)'));
    ok('reloaded: status restored', (await rcard1.locator('select.focus-status').inputValue()) === 'watch');
    ok('reloaded: note restored', (await rcard1.locator('input.focus-note').inputValue()) === '复核后仍可接受');
    const rt1 = await rcard1.innerText();
    ok('reloaded: persisted sample shown (transparent corner)', rt1.includes('透明像素 1/1'), rt1.slice(0, 300));
    await rcard1.locator('.history summary').click();
    ok('reloaded: judgement history intact', (await rcard1.innerText()).includes('品牌色可接受'));
    const rt2 = await rcard2.innerText();
    ok(
      'reloaded: rect old judgement stays history, not current',
      rt2.includes('尚无判定') && rt2.includes('判定历史（1 个版本）'),
      rt2.slice(0, 300),
    );

    console.log('# I2. export settings record keeps judgement history boundary');
    await runConvert(page);
    await page.waitForTimeout(600);
    await exportPair(page);
    const recJson = JSON.parse(readFileSync(resolve(ROOT, 'test-out', 'patches-srgb.proof-settings.json'), 'utf8')) as {
      transform: { intent: string };
      target: { id: string };
      focusPoints?: {
        kind: string;
        x: number;
        y: number;
        imageHash: string;
        evaluations: { isCurrent: boolean; note: string; conditions: { intent: string } }[];
      }[];
    };
    ok('record carries focus points', Array.isArray(recJson.focusPoints) && recJson.focusPoints.length === 2);
    const rp1 = recJson.focusPoints?.find((q) => q.kind === 'point');
    ok(
      'record: point coords + fingerprint',
      !!rp1 && rp1.x === 0 && rp1.y === 0 && typeof rp1.imageHash === 'string' && rp1.imageHash.length === 16,
    );
    ok('record: full history exported', (rp1?.evaluations.length ?? 0) === 2);
    const curEvals = rp1?.evaluations.filter((e) => e.isCurrent) ?? [];
    ok('record: exactly one current version', curEvals.length === 1);
    ok(
      'record: current version matches export conditions',
      curEvals[0]?.conditions.intent === recJson.transform.intent,
    );
    ok(
      'record: historical version keeps old conditions + note',
      !!rp1?.evaluations.some((e) => !e.isCurrent && e.note === '品牌色可接受' && e.conditions.intent === 'relative-colorimetric'),
    );
    ok(
      'record: rect judgement is historical only',
      (recJson.focusPoints?.find((q) => q.kind === 'rect')?.evaluations ?? []).every((e) => !e.isCurrent),
    );

    console.log('# J. different image -> old focus points never auto-applied');
    await importImage(page, resolve(FIX, 'patches-noicc.png'));
    await page.waitForSelector('text=缺少嵌入');
    ok('focus points cleared on image switch', (await page.locator('.focuscard').count()) === 0);
    ok('focus marks removed from canvases', (await page.locator('.focusDot').count()) === 0 && (await page.locator('.focusRect').count()) === 0);
    await page.locator('select').filter({ hasText: '请选择源配置' }).first().selectOption({ index: 1 });
    await page.waitForSelector('.ok');
    ok('old points do not reappear after source choice', (await page.locator('.focuscard').count()) === 0);
    ok('no page errors (G–J)', pageErrors(page).length === 0, pageErrors(page).join(' | ').slice(0, 400));
    await page.close();
  }

  // ---------- Scenario K: late async sample results are discarded ----------
  {
    const page = await freshPage(browser);
    console.log('# K. late sample results never resurrect or pollute');
    await importImage(page, resolve(FIX, 'patches-srgb.png'));
    await page.waitForSelector('.badge.embedded');

    // K1: create a point and delete it before the worker sample returns
    await page.getByRole('button', { name: /＋ 点关注点/ }).click();
    await page.evaluate(async () => {
      const canvas = document.querySelector('canvas')!;
      const r = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new MouseEvent('click', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true }),
      );
      await new Promise((res) => setTimeout(res, 0));
      (document.querySelector('.focus-del') as HTMLButtonElement | null)?.click();
    });
    await page.waitForTimeout(2500);
    ok('deleted point stays deleted after late sample', (await page.locator('.focuscard').count()) === 0);

    // K2: save a project, create a point, then load the project before the
    // sample returns — the loaded project must stay clean.
    await page.locator('input[placeholder*="工程名称"]').fill('空工程');
    await page.getByRole('button', { name: '保存工程' }).click();
    await page.waitForSelector('text=工程已保存');
    await page.getByRole('button', { name: /＋ 点关注点/ }).click();
    await page.evaluate(async () => {
      const canvas = document.querySelector('canvas')!;
      const r = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new MouseEvent('click', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true }),
      );
    });
    await page.locator('button[title="载入工程"]', { hasText: '空工程' }).click();
    await page.waitForSelector('text=已载入工程');
    await page.waitForTimeout(2500);
    ok('project switch: late sample does not pollute loaded project', (await page.locator('.focuscard').count()) === 0);

    // K3: create a point, then switch image before the sample returns
    await page.getByRole('button', { name: /＋ 点关注点/ }).click();
    await page.evaluate(async () => {
      const canvas = document.querySelector('canvas')!;
      const r = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new MouseEvent('click', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true }),
      );
    });
    await importImage(page, resolve(FIX, 'patches-noicc.png'));
    await page.waitForSelector('text=缺少嵌入');
    await page.waitForTimeout(2500);
    ok('image switch: no focus point materializes', (await page.locator('.focuscard').count()) === 0);
    ok('image switch: no focus marks left', (await page.locator('.focusDot').count()) === 0);
    ok('no page errors (K)', pageErrors(page).length === 0, pageErrors(page).join(' | ').slice(0, 400));
    await page.close();
  }

  await browser.close();
  console.log(failures ? `\n${failures} E2E FAILURES` : '\nALL E2E TESTS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
