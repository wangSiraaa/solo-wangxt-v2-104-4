/**
 * Node-side unit tests for the pure modules: ICC parse/extract, PNG encoder
 * (incl. iCCP + provenance), TIFF CMYK encoder, and color math.
 *
 * Run: npx tsx scripts/test-node.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { readProfileInfo } from '../src/lib/icc/profileInfo';
import { extractEmbeddedICC } from '../src/lib/icc/extractEmbedded';
import { encodePng } from '../src/lib/codec/png';
import { encodeTiffCmyk } from '../src/lib/codec/tiff';
import { detectProvenance } from '../src/lib/icc/provenance';
import { deltaE2000 } from '../src/lib/color/colorMath';
import { fnv1a64 } from '../src/lib/color/hash';
import {
  buildConditionSnapshot,
  conditionKey,
  fingerprintGate,
  imageFingerprintOf,
  makeVersion,
  normalizeRect,
  profileSnapshotOf,
  rectSamplePoints,
  reviveConcern,
  shapeLabel,
  toExportView,
  toRegionSample,
  statsOf,
  type ProofConcern,
} from '../src/lib/color/concern';
import type { SampleInfo } from '../src/lib/color/engine';

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(root, 'test-out');
mkdirSync(outDir, { recursive: true });

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ok - ${name}`);
  else {
    failures++;
    console.error(`  FAIL - ${name} ${detail}`);
  }
}

console.log('# ICC profiles');
const srgbIcc = readFileSync(resolve(root, 'public/profiles/sRGB-elle-V2-srgbtrc.icc'));
const cieIcc = readFileSync(resolve(root, 'public/profiles/CIERGB-elle-V2-g22.icc'));
const cmykIcc = readFileSync(resolve('/workspace/test-assets/profiles/ISOcoated_v2_300_mth.icc'));

const sInfo = readProfileInfo(srgbIcc);
check('sRGB profile parsed', sInfo.valid && sInfo.colorSpace === 'RGB' && sInfo.channels === 3, JSON.stringify(sInfo));
check('sRGB description non-empty', sInfo.description.length > 3, sInfo.description);
const cInfo = readProfileInfo(new Uint8Array(cmykIcc));
check('CMYK profile parsed', cInfo.valid && cInfo.colorSpace === 'CMYK' && cInfo.channels === 4, cInfo.description);

console.log('# Color patch PNG (8-bit RGBA, transparent borders)');
// 4x3 image: corners fully transparent, interior solid primaries + mid gray
const W = 4,
  H = 3;
const rgba = new Uint8Array(W * H * 4);
const px = (x: number, y: number, r: number, g: number, b: number, a: number) => {
  const i = (y * W + x) * 4;
  rgba.set([r, g, b, a], i);
};
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px(x, y, 200, 200, 200, 255);
px(0, 0, 255, 0, 0, 0); // transparent corner
px(W - 1, 0, 0, 255, 0, 0);
px(0, H - 1, 0, 0, 255, 0);
px(W - 1, H - 1, 255, 255, 0, 0);
px(1, 1, 255, 0, 0, 255);
px(2, 1, 0, 255, 0, 255);
px(1, 2, 0, 0, 255, 255);
px(2, 2, 128, 128, 128, 255);

const pngBytes = encodePng({
  width: W,
  height: H,
  colorChannels: 3,
  bitDepth: 8,
  data: rgba,
  hasAlpha: true,
  icc: srgbIcc,
  iccName: 'sRGB test',
  text: {
    'softproof-bench-conversion':
      'v=1; source=test; target=CIERGB; intent=relative-colorimetric; bpc=1; this-file-is-converted-not-original=1',
  },
});
writeFileSync(resolve(outDir, 'patches.png'), pngBytes);
check('PNG signature', pngBytes.subarray(0, 8).join(',') === [137, 80, 78, 71, 13, 10, 26, 10].join(','));
const reIcc = extractEmbeddedICC(pngBytes);
check('iCCP round-trips byte-for-byte', !!reIcc && Buffer.from(reIcc).equals(Buffer.from(srgbIcc)));
const prov = detectProvenance(pngBytes);
check('provenance marker detected in PNG', prov.converted);

console.log('# 16-bit gray PNG');
const g16 = new Uint16Array(W * H);
for (let i = 0; i < g16.length; i++) g16[i] = i * 4000;
const gPng = encodePng({
  width: W,
  height: H,
  colorChannels: 1,
  bitDepth: 16,
  data: new Uint8Array(g16.buffer),
  hasAlpha: false,
  icc: srgbIcc,
});
writeFileSync(resolve(outDir, 'gray16.png'), gPng);
check('16-bit PNG produced', gPng.length > W * H * 2 + 50);

console.log('# CMYK TIFF');
const cmyk = new Uint8Array(W * H * 4);
const inks = [
  [0, 0, 0, 0],
  [255, 0, 0, 0],
  [0, 255, 0, 0],
  [0, 0, 255, 0],
  [0, 0, 0, 255],
  [10, 20, 30, 40],
  [200, 100, 50, 25],
  [0, 0, 0, 128],
  [128, 128, 128, 128],
  [5, 5, 5, 5],
  [30, 60, 90, 120],
  [255, 255, 255, 255],
];
for (let i = 0; i < W * H; i++) cmyk.set(inks[i % inks.length], i * 4);
const tif = encodeTiffCmyk({
  width: W,
  height: H,
  data: cmyk,
  channels: 4,
  icc: new Uint8Array(cmykIcc),
  description: 'softproof-bench-conversion: CMYK export test; this-file-is-converted-not-original=1',
});
writeFileSync(resolve(outDir, 'patches-cmyk.tif'), tif);
check('TIFF II header', tif[0] === 0x49 && tif[1] === 0x49);
const tProv = detectProvenance(tif);
check('provenance marker detected in TIFF', tProv.converted);

console.log('# embedded ICC extraction from JPEG / 16-bit PNG');
{
  const browserDir = resolve(root, 'test-assets/browser');
  const jpegIcc = extractEmbeddedICC(readFileSync(resolve(browserDir, 'patches-srgb.jpg')));
  check('JPEG APP2 ICC extracted', !!jpegIcc && jpegIcc!.byteLength === srgbIcc.byteLength, String(jpegIcc?.byteLength));
  if (jpegIcc) {
    const ji = readProfileInfo(jpegIcc);
    check('JPEG embedded ICC parses as sRGB', ji.valid && ji.colorSpace === 'RGB', ji.description);
  }
  const noIcc = extractEmbeddedICC(readFileSync(resolve(browserDir, 'patches-noicc.jpg')));
  check('JPEG without profile returns null', noIcc === null);
  const p16Icc = extractEmbeddedICC(readFileSync(resolve(browserDir, 'patches-srgb16.png')));
  check('16-bit PNG iCCP extracted byte-for-byte', !!p16Icc && Buffer.from(p16Icc!).equals(Buffer.from(srgbIcc)));
}

console.log('# color math');
// Black vs white CIEDE2000 ~= 100
const de = deltaE2000({ L: 0, a: 0, b: 0 }, { L: 100, a: 0, b: 0 });
check('dE00 black-white ~100', Math.abs(de - 100) < 0.01, String(de));
check('dE00 identical = 0', deltaE2000({ L: 50, a: 10, b: -10 }, { L: 50, a: 10, b: -10 }) === 0);
const h1 = fnv1a64(new Uint8Array([1, 2, 3]));
check('hash stable & hex16', h1.length === 16 && h1 === fnv1a64(new Uint8Array([1, 2, 3])) && h1 !== fnv1a64(new Uint8Array([1, 2, 4])));

console.log('# proof concerns domain');
{
  const srgbSnap = profileSnapshotOf({
    id: 'builtin-srgb',
    description: 'sRGB',
    colorSpace: 'RGB',
    origin: 'builtin',
    bytes: new Uint8Array(srgbIcc),
  });
  const cieSnap = profileSnapshotOf({
    id: 'builtin-cie',
    description: 'CIE RGB',
    colorSpace: 'RGB',
    origin: 'builtin',
    bytes: new Uint8Array(cieIcc),
  });
  const cond = (target = cieSnap, intent: 'relative-colorimetric' | 'perceptual' = 'relative-colorimetric', bpc = true) =>
    buildConditionSnapshot({
      source: srgbSnap,
      target,
      intent,
      blackPointCompensation: bpc,
      proofIntent: 'relative-colorimetric',
      sourceAssumed: false,
      imageProvenanceConverted: false,
    });

  // 指纹：内容或尺寸变化即不同。
  const imgA = new Uint8Array([1, 2, 3, 4]);
  const fpA = imageFingerprintOf(imgA, 4, 3);
  const imgB = new Uint8Array([1, 2, 3, 5]);
  check('fingerprint changes with content', fpA !== imageFingerprintOf(imgB, 4, 3));
  check('fingerprint changes with dims', fpA !== imageFingerprintOf(imgA, 5, 3));

  // 指纹过闸：匹配的放行，不匹配的隔离，原数组不被改动。
  const mkConcern = (id: string, fp: string): ProofConcern => ({
    id,
    label: id,
    createdAt: '',
    shape: { kind: 'point', x: 0, y: 0 },
    imageFingerprint: fp,
    imageName: 'x.png',
    imageWidth: 4,
    imageHeight: 3,
    versions: [makeVersion({ index: 1, condition: cond(), status: 'ok' })],
  });
  const fpOther = imageFingerprintOf(imgB, 4, 3);
  const stored = [mkConcern('pc-match', fpA), mkConcern('pc-other', fpOther)];
  const gated = fingerprintGate(stored, fpA);
  check('gate binds only fingerprint-matching concerns', gated.matched.length === 1 && gated.matched[0].id === 'pc-match');
  check('gate quarantines mismatching concerns', gated.quarantined.length === 1 && gated.quarantined[0].id === 'pc-other');
  check('gate does not mutate input', stored.length === 2);
  check('gate with no match quarantines all', fingerprintGate(stored, 'nope:0x0').matched.length === 0);

  // 矩形归一化 + 取样位（四角 + 中心，去重）。
  const r = normalizeRect({ x: 3, y: 2 }, { x: 1, y: 0 }, 10, 8);
  check('rect normalized', r.kind === 'rect' && r.x0 === 1 && r.y0 === 0 && r.x1 === 3 && r.y1 === 2, JSON.stringify(r));
  const clamped = normalizeRect({ x: 9, y: 9 }, { x: 50, y: 50 }, 4, 3);
  check('rect clamped to image bounds', clamped.x0 === 3 && clamped.y0 === 2 && clamped.x1 === 3 && clamped.y1 === 2, JSON.stringify(clamped));
  const pts = rectSamplePoints(r);
  check('rect samples corners + center', pts.length === 5, JSON.stringify(pts));
  check('1px rect de-duplicates sample points', rectSamplePoints({ kind: 'rect', x0: 2, y0: 2, x1: 2, y1: 2 }).length === 1);
  check('point shape label', shapeLabel({ kind: 'point', x: 7, y: 9 }) === '点 (7, 9)');

  // 条件键区分目标/意图/BPC。
  const k1 = conditionKey(cond());
  const srgbAsTarget = profileSnapshotOf({ id: 'builtin-srgb', description: 'sRGB', colorSpace: 'RGB', origin: 'builtin', bytes: new Uint8Array(srgbIcc) });
  check('condition key differs by target', k1 !== conditionKey(cond(srgbAsTarget)));
  check('condition key differs by intent', k1 !== conditionKey(cond(cieSnap, 'perceptual')));
  check('condition key differs by BPC', k1 !== conditionKey(cond(cieSnap, 'relative-colorimetric', false)));
  check('condition key stable for identical condition', k1 === conditionKey(cond()));
  // 同 id 但字节被替换的配置也必须区分。
  const tampered = { ...cieSnap, byteHash: 'deadbeefdeadbeef' };
  check('condition key differs when same-id profile bytes change', k1 !== conditionKey(cond(tampered)));

  // 构造关注点 + 两个版本，验证历史冻结语义。
  const sample: SampleInfo = {
    sourceDevice: [1, 0, 0],
    sourceLab: [50, 70, 50],
    targetDevice: [0.8, 0.1, 0.1],
    targetLab: [49, 68, 48],
    alpha8: 0,
    sourceColorSpace: 'RGB',
    targetColorSpace: 'RGB',
  };
  const v1 = makeVersion({ index: 1, condition: cond(), status: 'ok', verdict: 'pass', note: '品牌红-旧条件' });
  v1.samples = [toRegionSample(1, 0, sample)];
  v1.stats = statsOf(v1.samples);
  const concern: ProofConcern = {
    id: 'pc-1',
    label: '透明边缘',
    createdAt: new Date().toISOString(),
    shape: { kind: 'point', x: 0, y: 0 },
    imageFingerprint: fpA,
    imageName: 'a.png',
    imageWidth: 4,
    imageHeight: 3,
    versions: [v1],
  };
  const v2 = makeVersion({ index: 2, condition: cond(srgbAsTarget), status: 'ok', basedOnVersionId: v1.id });
  v2.samples = [toRegionSample(0, 0, { ...sample, alpha8: 255, targetLab: [55, 60, 40] })];
  v2.stats = statsOf(v2.samples);
  concern.versions.push(v2);
  check('history keeps both versions', concern.versions.length === 2 && concern.versions[0].note === '品牌红-旧条件');
  check('old verdict/note not overwritten', concern.versions[0].verdict === 'pass' && concern.versions[0].note === '品牌红-旧条件');
  check('version stats computed', v1.stats!.deltaEMax >= 0 && v1.stats!.alphaMin === 0 && v2.stats!.alphaMax === 255, JSON.stringify(v1.stats));
  check('recheck chain recorded', v2.basedOnVersionId === v1.id);
  check('export view marks history policy + current', (() => {
    const view = toExportView(concern, false);
    return view.historyPolicy === 'versions-frozen-on-condition-change' &&
      view.currentVersionId === v2.id && view.currentMatchesLive === false && view.versions.length === 2;
  })());

  // 重载：未完成的 sampling 版本必须被标记 interrupted，而不是继续等待。
  const interrupted = reviveConcern(JSON.parse(JSON.stringify({
    ...concern,
    versions: [
      ...concern.versions,
      makeVersion({ index: 3, condition: cond(), status: 'sampling' }),
    ],
  })));
  check('revive marks in-flight version as interrupted', !!interrupted && interrupted!.versions[2].status === 'interrupted');
  check('revive rejects garbage', reviveConcern(null) === null && reviveConcern({ versions: [] }) === null);
  check('revive keeps finished versions intact', !!interrupted && interrupted!.versions[0].status === 'ok');
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL NODE TESTS PASSED');
process.exit(failures ? 1 : 0);
