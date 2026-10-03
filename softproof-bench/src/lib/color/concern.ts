/**
 * 校样关注点（Proof Concerns）领域模型。
 *
 * 一个关注点是操作员在**原图坐标**中建立的点或矩形区域，记录：
 *  - 形状与原图坐标（不依赖 Canvas 缩放/显示状态，因此不会随预览漂移）
 *  - 绑定的原图**内容指纹**（容器内原始字节 FNV-1a 哈希 + 尺寸），
 *    指纹不匹配的关注点绝不自动套用
 *  - 每次判定的**完整打样条件快照**（源/目标配置身份与字节哈希、意图、BPC、
 *    软打样意图、源假设、出处标记）
 *  - 源/目标取样信息、ΔE00、判定状态、备注、时间戳
 *
 * 历史边界：条件变更后，旧版本（versions 中的历史条目）**原样冻结**，
 * 绝不被原地改写；只有最新版本在与当前条件一致时可编辑判定/备注，
 * 条件不一致时必须显式创建“复核”新版本。
 */
import type { ColorSpaceKind } from '../icc/profileInfo';
import type { RenderingIntent } from './lcms';
import type { SampleInfo } from './engine';
import { deltaE2000, fromTriple } from './colorMath';
import { fnv1a64 } from './hash';

/** 判定状态：待判定 / 通过 / 偏差可接受 / 不通过。 */
export type ConcernVerdict = 'pending' | 'pass' | 'warn' | 'fail';

export const VERDICT_LABEL: Record<ConcernVerdict, string> = {
  pending: '待判定',
  pass: '通过',
  warn: '关注',
  fail: '不通过',
};

/** 版本的取样生命周期。重载工程时 'sampling' 一律归为 'interrupted'。 */
export type SampleStatus = 'sampling' | 'ok' | 'error' | 'interrupted';

export interface PointShape {
  kind: 'point';
  x: number;
  y: number;
}

export interface RectShape {
  kind: 'rect';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type ConcernShape = PointShape | RectShape;

/** 配置身份快照：既记录库内 id，也记录字节哈希，防止同 id 配置被替换后冒充。 */
export interface ProfileSnapshot {
  id: string;
  description: string;
  colorSpace: ColorSpaceKind;
  origin: 'embedded' | 'assumed' | 'builtin' | 'user-library';
  byteLength: number;
  byteHash: string;
}

/** 一次判定所依赖的完整打样条件，随该版本永久冻结。 */
export interface ConditionSnapshot {
  schema: 1;
  source: ProfileSnapshot;
  target: ProfileSnapshot;
  intent: RenderingIntent;
  blackPointCompensation: boolean;
  proofIntent: RenderingIntent;
  sourceAssumed: boolean;
  sourceAssumptionNote?: string;
  imageProvenanceConverted: boolean;
}

/** 单个取样位（矩形区域取四角+中心共 5 点）。 */
export interface RegionSample {
  x: number;
  y: number;
  alpha8: number;
  sourceDevice: number[];
  targetDevice: number[];
  sourceLab: [number, number, number];
  targetLab: [number, number, number];
  deltaE: number;
}

export interface SampleStats {
  deltaEMean: number;
  deltaEMax: number;
  deltaEMin: number;
  alphaMin: number;
  alphaMax: number;
}

export interface ConcernVersion {
  id: string;
  index: number;
  createdAt: string;
  /** 创建该版本时的条件快照；历史版本永不变更。 */
  condition: ConditionSnapshot;
  status: SampleStatus;
  samples: RegionSample[];
  stats: SampleStats | null;
  error?: string;
  verdict: ConcernVerdict;
  note: string;
  /** 复核链：记录上一版本 id，便于审计。 */
  basedOnVersionId?: string;
}

/**
 * 关注点本体。imageFingerprint 在建立时绑定原图内容；只有指纹一致的
 * 原图才能载入这些关注点，不一致时进入 quarantine 而不是静默套用。
 */
export interface ProofConcern {
  id: string;
  label: string;
  createdAt: string;
  shape: ConcernShape;
  imageFingerprint: string;
  imageName: string;
  imageWidth: number;
  imageHeight: number;
  versions: ConcernVersion[];
}

/** 矩形区域的取样位：四角 + 中心（宽/高为 1 时去重）。 */
export function rectSamplePoints(shape: ConcernShape): { x: number; y: number }[] {
  if (shape.kind === 'point') return [{ x: shape.x, y: shape.y }];
  const pts = [
    { x: shape.x0, y: shape.y0 },
    { x: shape.x1, y: shape.y0 },
    { x: shape.x0, y: shape.y1 },
    { x: shape.x1, y: shape.y1 },
    { x: Math.round((shape.x0 + shape.x1) / 2), y: Math.round((shape.y0 + shape.y1) / 2) },
  ];
  const seen = new Set<string>();
  return pts.filter((p) => {
    const k = `${p.x},${p.y}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 归一化矩形（坐标全部约束在原图范围内，x0<=x1，y0<=y1）。 */
export function normalizeRect(a: { x: number; y: number }, b: { x: number; y: number }, w: number, h: number): RectShape {
  const clampX = (v: number) => Math.min(w - 1, Math.max(0, v));
  const clampY = (v: number) => Math.min(h - 1, Math.max(0, v));
  const ax = clampX(a.x);
  const ay = clampY(a.y);
  const bx = clampX(b.x);
  const by = clampY(b.y);
  return {
    kind: 'rect',
    x0: Math.min(ax, bx),
    y0: Math.min(ay, by),
    x1: Math.max(ax, bx),
    y1: Math.max(ay, by),
  };
}

export function shapeLabel(shape: ConcernShape): string {
  if (shape.kind === 'point') return `点 (${shape.x}, ${shape.y})`;
  const w = shape.x1 - shape.x0 + 1;
  const h = shape.y1 - shape.y0 + 1;
  return `矩形 (${shape.x0}, ${shape.y0})–(${shape.x1}, ${shape.y1}) ${w}×${h}`;
}

/** 原图内容指纹：原始字节哈希 + 尺寸。容器内任何像素变化都会改变哈希。 */
export function imageFingerprintOf(bytes: Uint8Array, width: number, height: number): string {
  return `${fnv1a64(bytes)}:${width}x${height}`;
}

/**
 * 内容指纹过闸：只有与当前原图指纹完全一致的关注点才允许进入工作台；
 * 不一致的一律进入 quarantine（可查看/清除），绝不渲染、不套用、不参与取样。
 * 输入数组不会被修改。
 */
export function fingerprintGate(
  stored: ProofConcern[],
  currentFingerprint: string,
): { matched: ProofConcern[]; quarantined: ProofConcern[] } {
  const matched: ProofConcern[] = [];
  const quarantined: ProofConcern[] = [];
  for (const c of stored) (c.imageFingerprint === currentFingerprint ? matched : quarantined).push(c);
  return { matched, quarantined };
}

export function profileSnapshotOf(opts: {
  id: string;
  description: string;
  colorSpace: ColorSpaceKind;
  origin: ProfileSnapshot['origin'];
  bytes: Uint8Array;
}): ProfileSnapshot {
  return {
    id: opts.id,
    description: opts.description,
    colorSpace: opts.colorSpace,
    origin: opts.origin,
    byteLength: opts.bytes.byteLength,
    byteHash: fnv1a64(opts.bytes),
  };
}

export function buildConditionSnapshot(opts: {
  source: ProfileSnapshot;
  target: ProfileSnapshot;
  intent: RenderingIntent;
  blackPointCompensation: boolean;
  proofIntent: RenderingIntent;
  sourceAssumed: boolean;
  sourceAssumptionNote?: string;
  imageProvenanceConverted: boolean;
}): ConditionSnapshot {
  return { schema: 1, ...opts };
}

/** 条件身份键：任一打样条件改变即不同，用于判定旧版本是否仍为“当前条件”。 */
export function conditionKey(c: ConditionSnapshot): string {
  return [
    c.source.id,
    c.source.byteHash,
    c.target.id,
    c.target.byteHash,
    c.intent,
    c.blackPointCompensation ? 1 : 0,
    c.proofIntent,
    c.sourceAssumed ? 1 : 0,
    c.imageProvenanceConverted ? 1 : 0,
  ].join('|');
}

export function toRegionSample(x: number, y: number, info: SampleInfo): RegionSample {
  return {
    x,
    y,
    alpha8: info.alpha8,
    sourceDevice: info.sourceDevice,
    targetDevice: info.targetDevice,
    sourceLab: info.sourceLab,
    targetLab: info.targetLab,
    deltaE: deltaE2000(fromTriple(info.sourceLab), fromTriple(info.targetLab)),
  };
}

export function statsOf(samples: RegionSample[]): SampleStats {
  const des = samples.map((s) => s.deltaE);
  const alphas = samples.map((s) => s.alpha8);
  return {
    deltaEMean: des.reduce((a, b) => a + b, 0) / des.length,
    deltaEMax: Math.max(...des),
    deltaEMin: Math.min(...des),
    alphaMin: Math.min(...alphas),
    alphaMax: Math.max(...alphas),
  };
}

export function latestVersion(c: ProofConcern): ConcernVersion {
  return c.versions[c.versions.length - 1];
}

export function makeVersion(opts: {
  index: number;
  condition: ConditionSnapshot;
  status: SampleStatus;
  samples?: RegionSample[];
  stats?: SampleStats | null;
  error?: string;
  verdict?: ConcernVerdict;
  note?: string;
  basedOnVersionId?: string;
}): ConcernVersion {
  const samples = opts.samples ?? [];
  return {
    id: `cv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    index: opts.index,
    createdAt: new Date().toISOString(),
    condition: opts.condition,
    status: opts.status,
    samples,
    stats: opts.stats ?? (samples.length ? statsOf(samples) : null),
    error: opts.error,
    verdict: opts.verdict ?? 'pending',
    note: opts.note ?? '',
    basedOnVersionId: opts.basedOnVersionId,
  };
}

/**
 * 持久化/结构恢复：补齐缺失字段，并把上次未完成的异步取样标记为
 * “interrupted”（迟到的网络线程结果在状态层另有 epoch/令牌拦截）。
 */
export function reviveConcern(raw: unknown): ProofConcern | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Partial<ProofConcern>;
  if (
    typeof c.id !== 'string' ||
    typeof c.imageFingerprint !== 'string' ||
    !c.shape ||
    !Array.isArray(c.versions) ||
    c.versions.length === 0
  ) {
    return null;
  }
  const versions = c.versions.map((v) =>
    v.status === 'sampling'
      ? { ...v, status: 'interrupted' as SampleStatus, error: v.error || '取样在工程保存/切换时未返回，已中断' }
      : v,
  );
  return {
    id: c.id,
    label: c.label ?? '',
    createdAt: c.createdAt ?? '',
    shape: c.shape,
    imageFingerprint: c.imageFingerprint,
    imageName: c.imageName ?? '',
    imageWidth: c.imageWidth ?? 0,
    imageHeight: c.imageHeight ?? 0,
    versions,
  };
}

/** 导出设置记录中的关注点视图（历史完整保留，并显式标记当前版本）。 */
export interface ExportConcernView {
  id: string;
  label: string;
  shape: ConcernShape;
  imageFingerprint: string;
  imageName: string;
  imageWidth: number;
  imageHeight: number;
  createdAt: string;
  historyPolicy: 'versions-frozen-on-condition-change';
  currentVersionId: string | null;
  /** 当前 live 条件是否与最新版本一致；null 表示当前无法建立条件。 */
  currentMatchesLive: boolean | null;
  versions: Array<{
    id: string;
    index: number;
    createdAt: string;
    condition: ConditionSnapshot;
    sampleStatus: SampleStatus;
    samples: RegionSample[];
    stats: SampleStats | null;
    error?: string;
    verdict: ConcernVerdict;
    note: string;
    basedOnVersionId?: string;
  }>;
}

export function toExportView(c: ProofConcern, currentMatchesLive: boolean | null): ExportConcernView {
  const latest = latestVersion(c);
  return {
    id: c.id,
    label: c.label,
    shape: c.shape,
    imageFingerprint: c.imageFingerprint,
    imageName: c.imageName,
    imageWidth: c.imageWidth,
    imageHeight: c.imageHeight,
    createdAt: c.createdAt,
    historyPolicy: 'versions-frozen-on-condition-change',
    currentVersionId: latest ? latest.id : null,
    currentMatchesLive,
    versions: c.versions.map((v) => ({
      id: v.id,
      index: v.index,
      createdAt: v.createdAt,
      condition: v.condition,
      sampleStatus: v.status,
      samples: v.samples,
      stats: v.stats,
      error: v.error,
      verdict: v.verdict,
      note: v.note,
      basedOnVersionId: v.basedOnVersionId,
    })),
  };
}
