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
  buildFocusRecord,
  conditionsKeyOf,
  evaluationAcceptsResult,
  evaluationForConditions,
  focusAppliesToImage,
  reviveFocusPoint,
  serializeFocusPoint,
  type FocusPoint,
  type ProofConditions,
} from '../src/lib/color/focus';

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

console.log('# 校样关注点（focus points）');
{
  const condA: ProofConditions = {
    sourceProfileId: 'embedded:abc',
    sourceProfileDescription: 'sRGB',
    sourceIsEmbedded: true,
    sourceAssumed: false,
    targetProfileId: 'builtin-ciergb-elle',
    targetProfileDescription: 'CIE RGB',
    targetColorSpace: 'RGB',
    intent: 'relative-colorimetric',
    blackPointCompensation: true,
    proofIntent: 'relative-colorimetric',
  };
  const keyA = conditionsKeyOf(condA);
  check('conditions key stable', keyA === conditionsKeyOf({ ...condA }));
  check(
    'conditions key reacts to intent',
    conditionsKeyOf({ ...condA, intent: 'perceptual' }) !== keyA,
  );
  check(
    'conditions key reacts to target profile',
    conditionsKeyOf({ ...condA, targetProfileId: 'icc-other' }) !== keyA,
  );
  check(
    'conditions key reacts to BPC and proof intent',
    conditionsKeyOf({ ...condA, blackPointCompensation: false }) !== keyA &&
      conditionsKeyOf({ ...condA, proofIntent: 'absolute-colorimetric' }) !== keyA,
  );

  const imgHash = fnv1a64(new Uint8Array([9, 8, 7]));
  const point: FocusPoint = {
    id: 'fp-1',
    createdAt: '2026-10-03T00:00:00.000Z',
    kind: 'rect',
    x: 1,
    y: 1,
    w: 3,
    h: 2,
    label: '区域 1',
    imageHash: imgHash,
    imageName: 'patches.png',
    imageWidth: 12,
    imageHeight: 8,
    evaluations: [
      {
        id: 'fe-old',
        createdAt: '2026-10-03T00:00:00.000Z',
        conditions: condA,
        conditionsKey: keyA,
        sample: null,
        deltaE: 1.23,
        status: 'pass',
        note: '旧条件下通过',
      },
    ],
  };

  check('focus point applies only to its image fingerprint', focusAppliesToImage(point, imgHash));
  check(
    'focus point rejected on fingerprint mismatch',
    !focusAppliesToImage(point, fnv1a64(new Uint8Array([9, 8, 8]))),
  );

  // 条件变更 -> 追加复核版本，旧版本保留
  const condB: ProofConditions = { ...condA, intent: 'perceptual' };
  point.evaluations.push({
    id: 'fe-new',
    createdAt: '2026-10-03T01:00:00.000Z',
    conditions: condB,
    conditionsKey: conditionsKeyOf(condB),
    sample: null,
    deltaE: 2.5,
    status: 'watch',
    note: '新条件复核',
  });
  check('history keeps both versions', point.evaluations.length === 2);
  check(
    'current evaluation matches only its own conditions',
    evaluationForConditions(point, keyA)?.id === 'fe-old' &&
      evaluationForConditions(point, conditionsKeyOf(condB))?.id === 'fe-new' &&
      evaluationForConditions(point, 'nonexistent') === undefined,
  );

  // 序列化剥离 pending；载入后不得有 pending 残留
  const pendingPoint: FocusPoint = {
    ...point,
    evaluations: [{ ...point.evaluations[0], id: 'fe-pending', pending: true }],
  };
  const serialized = serializeFocusPoint(pendingPoint);
  check('serialize strips runtime pending flag', serialized.evaluations[0].pending === undefined);
  const revived = reviveFocusPoint(JSON.parse(JSON.stringify(serialized)) as FocusPoint);
  check('revive never restores pending', revived.evaluations[0].pending === false);
  check(
    'round-trip keeps judgement history intact',
    revived.evaluations[0].note === '旧条件下通过' && revived.evaluations[0].status === 'pass',
  );

  // 迟到结果守卫：只接受仍存在且仍 pending 的判定
  check(
    'late result accepted only for pending evaluation',
    evaluationAcceptsResult(pendingPoint, 'fe-pending')?.id === 'fe-pending',
  );
  check(
    'late result dropped for completed evaluation',
    evaluationAcceptsResult(point, 'fe-old') === undefined,
  );
  check('late result dropped for deleted point', evaluationAcceptsResult(undefined, 'fe-pending') === undefined);
  check(
    'late result dropped for unknown evaluation id',
    evaluationAcceptsResult(pendingPoint, 'nope') === undefined,
  );

  // 导出记录：历史完整保留，只有当前条件版本被标记
  const rec = buildFocusRecord([point], conditionsKeyOf(condB));
  check('export record keeps all versions', rec.length === 1 && rec[0].evaluations.length === 2);
  check(
    'export record flags exactly the current-conditions version',
    rec[0].evaluations.filter((e) => e.isCurrent).length === 1 &&
      rec[0].evaluations.find((e) => e.isCurrent)?.status === 'watch',
  );
  check(
    'export record carries image fingerprint and coordinates',
    rec[0].imageHash === imgHash && rec[0].x === 1 && rec[0].w === 3,
  );
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL NODE TESTS PASSED');
process.exit(failures ? 1 : 0);
