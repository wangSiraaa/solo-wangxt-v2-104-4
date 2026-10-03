/**
 * 校样关注点 (proof focus points).
 *
 * A focus point is a point or rectangular region pinned to ORIGINAL IMAGE
 * pixel coordinates. It records, per proofing-condition snapshot, the sampled
 * source/target values, ΔE2000, the operator's judgement and notes.
 *
 * Invariants this module is built around:
 *
 *  1. Every focus point is bound to the CONTENT FINGERPRINT of the original
 *     image (fnv1a64 of the file bytes). A point must never be applied to a
 *     different image, even if dimensions coincide.
 *  2. Every evaluation carries a FULL proofing-condition snapshot (source /
 *     target profile identity, intent, BPC, proof intent). When conditions
 *     change, old evaluations stay as read-only history; a re-review appends
 *     a NEW evaluation instead of rewriting the old one.
 *  3. `pending` is runtime-only (async sample in flight) and is stripped
 *     before persistence, so a reloaded project never resurrects a
 *     half-finished sample.
 */
import type { RenderingIntent } from './lcms';
import type { ColorSpaceKind } from '../icc/profileInfo';
import type { RegionSampleInfo } from './engine';

export type FocusStatus = 'pending' | 'pass' | 'fail' | 'watch';

export const FOCUS_STATUS_LABEL: Record<FocusStatus, string> = {
  pending: '待判定',
  pass: '通过',
  fail: '不通过',
  watch: '观察',
};

export const FOCUS_STATUS_ORDER: FocusStatus[] = ['pending', 'pass', 'fail', 'watch'];

/** Complete proofing-condition snapshot an evaluation is judged under. */
export interface ProofConditions {
  sourceProfileId: string;
  sourceProfileDescription: string;
  sourceIsEmbedded: boolean;
  sourceAssumed: boolean;
  targetProfileId: string;
  targetProfileDescription: string;
  targetColorSpace: ColorSpaceKind;
  intent: RenderingIntent;
  blackPointCompensation: boolean;
  proofIntent: RenderingIntent;
}

/**
 * Signature of the proofing conditions. Two evaluations with the same key
 * were judged under interchangeable conditions; an evaluation only counts as
 * "current" when its key equals the live conditions key.
 */
export function conditionsKeyOf(c: ProofConditions): string {
  return [
    c.sourceProfileId,
    c.targetProfileId,
    c.intent,
    c.blackPointCompensation ? 1 : 0,
    c.proofIntent,
  ].join('|');
}

export interface FocusEvaluation {
  id: string;
  createdAt: string;
  /** Snapshot of the proofing conditions this judgement belongs to. */
  conditions: ProofConditions;
  conditionsKey: string;
  /** Mean sample over the region (1x1 for points); null until the worker replied. */
  sample: RegionSampleInfo | null;
  deltaE: number | null;
  status: FocusStatus;
  note: string;
  error?: string;
  /** Runtime only: async sample in flight. Never persisted. */
  pending?: boolean;
}

export interface FocusPoint {
  id: string;
  createdAt: string;
  kind: 'point' | 'rect';
  /** Original-image pixel coordinates; points are stored as 1x1. */
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  /** fnv1a64 fingerprint of the original image bytes this point belongs to. */
  imageHash: string;
  imageName: string;
  imageWidth: number;
  imageHeight: number;
  /** Chronological judgement history; old entries are read-only. */
  evaluations: FocusEvaluation[];
}

/** A focus point only applies to the exact image bytes it was created on. */
export function focusAppliesToImage(p: FocusPoint, imageHash: string): boolean {
  return p.imageHash === imageHash;
}

/** The evaluation valid under the live conditions, if any. */
export function evaluationForConditions(p: FocusPoint, conditionsKey: string): FocusEvaluation | undefined {
  return p.evaluations.find((e) => e.conditionsKey === conditionsKey);
}

export function latestEvaluationOf(p: FocusPoint): FocusEvaluation | undefined {
  return p.evaluations[p.evaluations.length - 1];
}

/**
 * Guard for late async sample results: only a still-pending evaluation of a
 * still-existing point may receive a result. Callers additionally check the
 * image fingerprint / session epoch before invoking this.
 */
export function evaluationAcceptsResult(
  p: FocusPoint | undefined,
  evalId: string,
): FocusEvaluation | undefined {
  const e = p?.evaluations.find((q) => q.id === evalId);
  return e && e.pending ? e : undefined;
}

/** Strip runtime-only flags before writing to IndexedDB / JSON. */
export function serializeFocusPoint(p: FocusPoint): FocusPoint {
  // Deep plain-ify: reactive state proxies must not leak into IndexedDB
  // (structured clone rejects them with DataCloneError). Focus data is
  // JSON-safe by design (numbers, strings, plain arrays only).
  return JSON.parse(
    JSON.stringify({
      ...p,
      evaluations: p.evaluations.map((e) => {
        const { pending: _pending, ...rest } = e;
        return rest;
      }),
    }),
  ) as FocusPoint;
}

/** Restore a persisted point; nothing may be pending after a reload. */
export function reviveFocusPoint(p: FocusPoint): FocusPoint {
  return {
    ...p,
    evaluations: p.evaluations.map((e) => ({ ...e, pending: false })),
  };
}

/** Export-record view: full history, each version stamped with its own
 *  conditions; exactly the live-conditions evaluation is flagged current. */
export interface FocusPointRecord {
  id: string;
  kind: 'point' | 'rect';
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  imageHash: string;
  imageName: string;
  evaluations: {
    createdAt: string;
    isCurrent: boolean;
    conditions: ProofConditions;
    sample: RegionSampleInfo | null;
    deltaE: number | null;
    status: FocusStatus;
    note: string;
  }[];
}

export function buildFocusRecord(points: FocusPoint[], currentConditionsKey: string): FocusPointRecord[] {
  return points.map((p) => ({
    id: p.id,
    kind: p.kind,
    label: p.label,
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    imageHash: p.imageHash,
    imageName: p.imageName,
    evaluations: p.evaluations.map((e) => ({
      createdAt: e.createdAt,
      isCurrent: e.conditionsKey === currentConditionsKey,
      conditions: { ...e.conditions },
      sample: e.sample,
      deltaE: e.deltaE,
      status: e.status,
      note: e.note,
    })),
  }));
}
