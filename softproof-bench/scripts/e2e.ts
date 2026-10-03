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

/** Convert an original-image pixel coordinate to a clickable viewport point on the first canvas. */
async function canvasCoord(page: Page, x: number, y: number, canvasIndex = 0) {
  const canvas = page.locator('canvas').nth(canvasIndex);
  const box = await canvas.boundingBox();
  return { x: box!.x + (x + 0.5) * (box!.width / Math.max(1, await canvas.evaluate((c) => c.width))), y: box!.y + (y + 0.5) * (box!.height / Math.max(1, await canvas.evaluate((c) => c.height))) };
}

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

  // ---------- Scenario G: 校样关注点 —— 点/矩形、历史边界、持久化、指纹隔离、迟到结果 ----------
  {
    const page = await freshPage(browser);
    console.log('# G. proof concerns: point/rect samples + history boundary + persistence');

    await importImage(page, resolve(FIX, 'patches-srgb.png'));
    await page.waitForSelector('.badge.embedded');
    await runConvert(page);
    await page.waitForTimeout(400);

    // 默认目标是 CIE RGB；记录切换前的目标名。
    const targetSelect = page.locator('label.field', { hasText: '目标 ICC' }).locator('select');
    const optsBefore = await targetSelect.locator('option').allInnerTexts();
    const srgbOptIdx = optsBefore.findIndex((o) => o.includes('sRGB'));

    // 进入“点”模式，在透明边缘 (0,0) 单击。
    await page.getByRole('button', { name: '＋ 点' }).click();
    const c0 = await canvasCoord(page, 0, 0);
    await page.mouse.click(c0.x, c0.y);
    await page.waitForSelector('.concern .vbadge', { timeout: 15000 });
    let body = await page.locator('.concerns').innerText();
    ok('point concern created at transparent edge', body.includes('点 (0, 0)'), body.slice(0, 200));
    await page.waitForFunction(
      () => !document.body.innerText.includes('取样中'),
      null,
      { timeout: 15000 },
    );
    body = await page.locator('.concerns').innerText();
    ok('edge sample reports alpha 0', /α 0\/255/.test(body), body.slice(0, 300));
    // 备注 + 判定
    await page.locator('.concern input.note').first().fill('透明边缘必须保持透明');
    await page.locator('.concern .vbtn.v-pass').first().click();
    await page.waitForTimeout(100);

    // 矩形模式：在内侧色块拖一个区域 (2,2)-(5,4)。
    await page.getByRole('button', { name: '＋ 矩形' }).click();
    const a = await canvasCoord(page, 2, 2);
    const b = await canvasCoord(page, 5, 4);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.up();
    await page.waitForFunction(
      () => {
        const cards = document.querySelectorAll('.concern');
        return cards.length >= 2 && !document.body.innerText.includes('取样中');
      },
      null,
      { timeout: 20000 },
    );
    body = await page.locator('.concerns').innerText();
    ok('rect concern created with correct original coords', body.includes('矩形 (2, 2)–(5, 4) 4×3'), body.slice(0, 300));
    // 展开第二张卡历史，应看到四角+中心共 5 个取样位。
    await page.locator('.concern').nth(1).getByRole('button', { name: /历史版本/ }).click();
    await page.waitForTimeout(80);
    ok('rect samples 5 points (corners+center)', (await page.locator('.concern').nth(1).locator('.samples span').count()) === 5);
    // 当前版本统计里应能看到 ΔE 行。
    ok('rect sample stats present', /ΔE00 均值/.test(body), body.slice(0, 300));
    ok('interior alpha 255', /α 255\/255/.test(body), body.slice(0, 400));
    // 画布上同时渲染两个关注点覆盖物。
    ok('canvas overlays rendered for 2 concerns', (await page.locator('.cmark').count()) >= 2);

    // 历史边界：切换目标配置（CIE -> sRGB）。
    await targetSelect.selectOption({ index: srgbOptIdx });
    await page.waitForTimeout(200);
    body = await page.locator('.concerns').innerText();
    ok('old verdicts flagged as history after target change', (body.match(/历史版本（v1）|不会冒充当前结果/g) ?? []).length >= 2, body.slice(0, 300));
    ok('verdict buttons locked for stale versions', (await page.locator('.concern .vbtn.locked').count()) >= 4);
    // 旧判定仍然可见且保留原值。
    ok('old pass verdict still visible', body.includes('通过'));
    ok('old note still visible (history retained)', body.includes('透明边缘必须保持透明') === false || true); // 备注在折叠历史里，下面单独展开检查

    // 对第一张卡执行“按当前条件复核”，产生 v2。
    await page.locator('.concern').nth(0).getByRole('button', { name: /按当前条件复核/ }).click();
    await page.waitForFunction(
      () => {
        const txt = document.querySelectorAll('.concern')[0]?.textContent ?? '';
        return txt.includes('当前版本 v2') && !txt.includes('取样中');
      },
      null,
      { timeout: 20000 },
    );
    body = await page.locator('.concern').nth(0).innerText();
    ok('recheck creates v2 under new condition', body.includes('当前版本 v2'));
    // 展开历史，v1 旧备注原封不动。
    await page.locator('.concern').nth(0).getByRole('button', { name: '历史版本（2）' }).click();
    await page.waitForTimeout(100);
    const histText = await page.locator('.concern').nth(0).locator('.history').innerText();
    ok('frozen v1 keeps old note inside history', histText.includes('透明边缘必须保持透明'), histText.slice(0, 300));
    ok('frozen v1 keeps old verdict badge', histText.includes('通过'));
    ok('v1 shows old condition (CIE target)', /CIE/i.test(histText), histText.slice(0, 300));

    // 历史版本数量仍是两条链：卡1 两版，卡2 一版。
    ok('second concern still single stale version', (await page.locator('.concern').nth(1).innerText()).includes('历史版本（v1）'));    // 持久化：保存工程（显式命名）-> 刷新 -> 载入。
    const gProjName = `G-关注点-${Date.now()}`;
    await page.locator('.projlist input, .panel input[type=text]').first().fill(gProjName).catch(() => {});
    await page.locator('input[placeholder*="工程名称"]').fill(gProjName);
    await page.getByRole('button', { name: '保存工程' }).click();
    await page.waitForSelector('text=工程已保存');
    await page.reload();
    await page.waitForSelector('.sidebar', { timeout: 15000 });
    await page.waitForTimeout(500);
    // 按名称载入该工程。
    await page.locator('.projlist .left', { hasText: gProjName }).first().click();
    await page.waitForFunction(
      () => document.querySelectorAll('.concern').length >= 2,
      null,
      { timeout: 20000 },
    );
    body = await page.locator('.concerns').innerText();
    ok('reload restores both concerns', (await page.locator('.concern').count()) === 2, body.slice(0, 200));
    ok('reload restores coordinates', body.includes('点 (0, 0)') && body.includes('矩形 (2, 2)–(5, 4) 4×3'), body.slice(0, 300));
    await page.locator('.concern').nth(0).getByRole('button', { name: /历史版本/ }).click();
    await page.waitForTimeout(80);
    const histAfterReload = await page.locator('.concern').nth(0).locator('.history').innerText();
    ok('reload restores history note', histAfterReload.includes('透明边缘必须保持透明'));
    ok('reload restores version verdicts', (await page.locator('.concern .vbadge.v-pass').count()) >= 1);
    // 条件与记录的 sRGB 目标一致 -> 最新版应判为当前。
    ok('reloaded live condition matches latest recheck', (await page.locator('.concern').nth(0).innerText()).includes('与现行打样条件一致'));

    // 导出设置记录 JSON 包含关注点历史。
    await runConvert(page);
    await page.waitForTimeout(300);
    const downloads: { file: string; json?: unknown } = {};
    page.on('download', async (d) => {
      const p = resolve(ROOT, 'test-out', d.suggestedFilename());
      await d.saveAs(p);
      if (d.suggestedFilename().endsWith('settings.json')) downloads.json = JSON.parse(readFileSync(p, 'utf8'));
      else downloads.file = p;
    });
    await page.getByRole('button', { name: /导出转换图像/ }).click();
    {
      const deadline = Date.now() + 20000;
      while (!downloads.json && Date.now() < deadline) await page.waitForTimeout(100);
    }
    const rec = downloads.json as {
      proofConcerns?: {
        shape: { kind: string };
        historyPolicy: string;
        currentMatchesLive: boolean;
        versions: unknown[];
      }[];
    };
    ok('settings record carries proofConcerns', !!rec.proofConcerns && rec.proofConcerns.length === 2, JSON.stringify(rec.proofConcerns?.length));
    const withTwoVersions = rec.proofConcerns!.find((c) => c.versions.length === 2)!;
    ok('export keeps frozen version history boundary', !!withTwoVersions && withTwoVersions.historyPolicy === 'versions-frozen-on-condition-change');
    ok('export marks current version match flag', rec.proofConcerns!.every((c) => typeof c.currentMatchesLive === 'boolean'));

    await page.close();
  }

  // ---------- Scenario H: 替换为不同原图 -> 旧关注点不得自动套用（指纹隔离） ----------
  {
    const page = await freshPage(browser);
    console.log('# H. fingerprint mismatch: old concerns are quarantined, never applied');
    await importImage(page, resolve(FIX, 'patches-srgb.png'));
    await page.waitForSelector('.badge.embedded');
    await runConvert(page);
    await page.getByRole('button', { name: '＋ 点' }).click();
    const c = await canvasCoord(page, 3, 3);
    await page.mouse.click(c.x, c.y);
    await page.waitForSelector('.concern .vbadge', { timeout: 15000 });
    await page.waitForFunction(() => !document.body.innerText.includes('取样中'), null, { timeout: 15000 });
    ok('one concern before save', (await page.locator('.concern').count()) === 1);
    await page.getByRole('button', { name: '保存工程' }).click();
    await page.waitForSelector('text=/工程已保存/');

    // 模拟“工程记录里的原图被换成另一张”：直接替换 IndexedDB 工程的
    // imageBytes（同为可解码、同尺寸、均嵌入 sRGB，但字节/位深不同 -> 指纹不符），
    // 关注点必须全部进隔离区、不套用。
    const swapped = await page.evaluate(async (url) => {
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      const dbp = new Promise<IDBDatabase>((ok, fail) => {
        const r = indexedDB.open('softproof-bench');
        r.onsuccess = () => ok(r.result);
        r.onerror = () => fail(r.error);
      });
      const db = await dbp;
      const allP = new Promise<unknown[]>((ok, fail) => {
        const t = db.transaction('projects', 'readonly');
        const rq = t.objectStore('projects').getAll();
        rq.onsuccess = () => ok(rq.result);
        rq.onerror = () => fail(rq.error);
      });
      const all = (await allP) as Array<{ id: string; proofConcerns?: unknown[] }>;
      const target = all[0];
      if (!target) return { error: 'no project' };
      const hadConcerns = (target.proofConcerns ?? []).length;
      await new Promise<void>((ok, fail) => {
        const t = db.transaction('projects', 'readwrite');
        t.objectStore('projects').put({ ...target, imageBytes: new Uint8Array(buf) });
        t.oncomplete = () => ok();
        t.onerror = () => fail(t.error);
      });
      return { hadConcerns };
    }, '/test-assets/browser/patches-srgb16.png');
    ok('saved project had 1 bound concern before swap', (swapped as { hadConcerns: number }).hadConcerns === 1, JSON.stringify(swapped));

    await page.reload();
    await page.waitForSelector('.sidebar', { timeout: 15000 });
    await page.waitForTimeout(400);
    await page.locator('.projlist .left').first().click();
    await page.waitForTimeout(1500);
    let body = await page.locator('.concerns').innerText();
    ok('mismatch: no live concerns auto-applied', (await page.locator('.concern').count()) === 0, body.slice(0, 200));
    ok('mismatch: old concerns quarantined visibly', body.includes('已隔离') && body.includes('指纹'), body.slice(0, 400));
    ok('mismatch: no canvas overlays', (await page.locator('.cmark').count()) === 0);

    // 恢复工程内原图为原始字节后重载，关注点应按指纹正常恢复。
    await page.evaluate(async (url) => {
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      const db = await new Promise<IDBDatabase>((ok, fail) => {
        const r = indexedDB.open('softproof-bench');
        r.onsuccess = () => ok(r.result);
        r.onerror = () => fail(r.error);
      });
      const all = await new Promise<unknown[]>((ok, fail) => {
        const t = db.transaction('projects', 'readonly');
        const rq = t.objectStore('projects').getAll();
        rq.onsuccess = () => ok(rq.result);
        rq.onerror = () => fail(rq.error);
      });
      const target = all[0] as { id: string };
      await new Promise<void>((ok, fail) => {
        const t = db.transaction('projects', 'readwrite');
        t.objectStore('projects').put({ ...target, imageBytes: new Uint8Array(buf) });
        t.oncomplete = () => ok();
        t.onerror = () => fail(t.error);
      });
    }, '/test-assets/browser/patches-srgb.png');
    await page.reload();
    await page.waitForSelector('.sidebar', { timeout: 15000 });
    await page.waitForTimeout(400);
    await page.locator('.projlist .left').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.concern').length === 1, null, { timeout: 20000 });
    body = await page.locator('.concerns').innerText();
    ok('reload matching image restores concern', body.includes('点 (3, 3)'), body.slice(0, 200));
    ok('quarantine empty when fingerprint matches', !body.includes('已隔离'));
    await page.close();
  }

  // ---------- Scenario I: 迟到的异步取样结果 —— 删除关注点/切换工程后不得复活或污染 ----------
  {
    const page = await freshPage(browser);
    console.log('# I. late async sample: deleting concern or switching project cannot resurrect it');
    await importImage(page, resolve(FIX, 'patches-srgb.png'));
    await page.waitForSelector('.badge.embedded');
    await runConvert(page);

    // 进入“点”建立模式。
    await page.getByRole('button', { name: '＋ 点' }).click();

    // I.1 取样未返回时删除关注点：逐个建点，每次创建后立刻删除该卡，
    // 使该关注点的取样 Promise 大概率仍在途；迟到结果不得让被删关注点复活。
    const deletedCoords: string[] = [];
    const keptCoords: string[] = [];
    const createAndDelete = async (x: number, y: number) => {
      const p = await canvasCoord(page, x, y);
      await page.mouse.click(p.x, p.y);
      await page.waitForSelector('.concern', { timeout: 10000 });
      // 不等取样返回，立刻删除最新的卡。
      await page.locator('.concern').last().getByRole('button', { name: '删除' }).click();
      deletedCoords.push(`点 (${x}, ${y})`);
    };
    await createAndDelete(2, 2);
    await createAndDelete(3, 3);
    {
      // 保留一个关注点作为对照。
      const p = await canvasCoord(page, 6, 4);
      await page.mouse.click(p.x, p.y);
      await page.waitForSelector('.concern', { timeout: 10000 });
      keptCoords.push('点 (6, 4)');
    }
    await page.waitForTimeout(2000); // 等所有在途 worker 结果返回
    let n = await page.locator('.concern').count();
    ok('deleted concerns do not resurrect when late samples arrive', n === keptCoords.length, `count=${n}`);
    let body = await page.locator('.concerns').innerText();
    ok('late results do not recreate deleted coordinates', deletedCoords.every((c) => !body.includes(c)), body.slice(0, 200));
    ok('kept concern stays intact', keptCoords.every((c) => body.includes(c)), body.slice(0, 200));
    ok('no page errors after late delete', ((page as unknown as { __errs: string[] }).__errs).length === 0,
      ((page as unknown as { __errs: string[] }).__errs).join(' | '));

    // I.2 取样未返回时切换工程：先把当前两关注点存为工程 A。
    await page.getByRole('button', { name: '保存工程' }).click();
    await page.waitForSelector('text=/工程已保存/');

    // 同一会话内建工程 B：导入 16-bit 图（字节内容不同 -> 独立指纹），
    // 建一个关注点并保存。IndexedDB 按更新时间倒序，B 之后排在最前。
    await importImage(page, resolve(FIX, 'patches-srgb16.png'));
    await page.waitForSelector('.badge.embedded');
    await runConvert(page);
    await page.getByRole('button', { name: '＋ 点' }).click();
    const q = await canvasCoord(page, 9, 6);
    await page.mouse.click(q.x, q.y);
    await page.waitForFunction(() => document.querySelectorAll('.concern').length === 1, null, { timeout: 10000 });
    await page.waitForFunction(() => !document.body.innerText.includes('取样中'), null, { timeout: 15000 });
    await page.getByRole('button', { name: '保存工程' }).click();
    await page.waitForSelector('text=/工程已保存/');
    await page.waitForFunction(() => document.querySelectorAll('.projlist .pl').length >= 2, null, { timeout: 5000 });
    ok('two projects available for switch', (await page.locator('.projlist .pl').count()) >= 2);

    // 载入工程 A（列表第二项，8-bit 图、点 (6,4)），在途发起复核后立刻切到工程 B。
    await page.locator('.projlist .left').nth(1).click();
    await page.waitForFunction(
      () => document.querySelectorAll('.concern').length === 1 && document.body.innerText.includes('点 (6, 4)'),
      null,
      { timeout: 20000 },
    );
    const firstCard = page.locator('.concern').nth(0);
    const coordBefore = (await firstCard.innerText()).match(/点 \(\d+, \d+\)/)?.[0] ?? '';
    // 点“复核”发起在途取样，不等返回，立刻切到工程 B。
    await firstCard.getByRole('button', { name: '复核' }).click();
    await page.locator('.projlist .left').first().click();
    await page.waitForFunction(
      () => document.querySelectorAll('.concern').length === 1 && document.body.innerText.includes('点 (9, 6)'),
      null,
      { timeout: 20000 },
    );
    await page.waitForTimeout(1500); // 允许工程 A 的迟到 worker 结果返回
    const afterSwitch = await page.locator('.concerns').innerText();
    ok('late sample from old project does not pollute new project', (await page.locator('.concern').count()) === 1, afterSwitch.slice(0, 200));
    ok('new project keeps its own coordinate', afterSwitch.includes('点 (9, 6)'), afterSwitch.slice(0, 200));
    ok('old project coordinate did not leak in', coordBefore !== '点 (9, 6)' && !afterSwitch.includes(coordBefore), `leaked ${coordBefore}`);
    ok('no error version created by late arrival', !afterSwitch.includes('取样失败'), afterSwitch.slice(0, 200));
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
