/**
 * Central application state (Svelte 5 runes). Owns:
 *  - imported image bytes + embedded/assumed source profile decision
 *  - profile library (IndexedDB)
 *  - target profile, intent, BPC
 *  - worker conversion results + sampler
 *  - project save/load
 */
import { idbAll, idbDelete, idbPut, STORE_PROJECTS, STORE_PROFILES, type StoredProfile, type StoredProject } from './db';
import { seedBuiltinProfiles } from './builtinProfiles';
import { extractEmbeddedICC, detectContainer } from '../icc/extractEmbedded';
import { readProfileInfo, type ProfileInfo, type ColorSpaceKind } from '../icc/profileInfo';
import { detectProvenance } from '../icc/provenance';
import { runConvert, runSample, runSampleRegion, type ConvertedPayload } from '../workers/client';
import type { EngineParams, RegionSampleInfo, SampleInfo } from '../color/engine';
import type { RenderingIntent } from '../color/lcms';
import { fnv1a64 } from '../color/hash';
import { deltaE2000, fromTriple } from '../color/colorMath';
import {
  conditionsKeyOf,
  evaluationAcceptsResult,
  evaluationForConditions,
  focusAppliesToImage,
  reviveFocusPoint,
  serializeFocusPoint,
  type FocusEvaluation,
  type FocusPoint,
  type FocusStatus,
  type ProofConditions,
} from '../color/focus';

export type SourceStatus =
  | { kind: 'none' }
  | { kind: 'embedded'; info: ProfileInfo }
  | { kind: 'missing'; info: null }
  | { kind: 'assumed'; info: ProfileInfo; assumedFromId: string };

export interface ImportedImage {
  bytes: Uint8Array;
  name: string;
  width?: number;
  height?: number;
  bitDepth: 8 | 16;
  container: string;
  embedded: Uint8Array | null;
  provenance: { converted: boolean; detail?: string };
}

interface SamplePoint {
  x: number;
  y: number;
  info?: SampleInfo | null;
  pending?: boolean;
  error?: string;
}

let uid = 1;
export const newId = (p = 'p') => `${p}-${Date.now().toString(36)}-${uid++}`;

function createAppState() {
  const state = $state({
    ready: false as boolean,
    initError: '' as string,
    profiles: [] as StoredProfile[],
    image: null as ImportedImage | null,
    /** effective source profile bytes (embedded bytes or chosen library profile) */
    sourceProfile: null as StoredProfile | null,
    sourceEmbeddedInfo: null as ProfileInfo | null,
    sourceAssumed: false,
    targetProfile: null as StoredProfile | null,
    intent: 'relative-colorimetric' as RenderingIntent,
    blackPointCompensation: true,
    proofIntent: 'relative-colorimetric' as RenderingIntent,
    converting: false,
    convertError: '' as string,
    result: null as ConvertedPayload | null,
    /** params signature the current result was computed with */
    resultKey: '' as string,
    hover: { x: 0, y: 0, info: null as SampleInfo | null, pending: false } as SamplePoint,
    pins: [] as SamplePoint[],
    projects: [] as { id: string; name: string; updatedAt: string }[],
    busyProfiles: false,
    notice: '' as string,
    showOriginalManaged: true,
    /** fnv1a64 fingerprint of the current original image bytes. */
    imageHash: '' as string,
    /** 校样关注点：仅属于当前原图（按内容指纹绑定）。 */
    focusPoints: [] as FocusPoint[],
    /** 画布建点模式：单击建点 / 拖拽建区域。 */
    focusMode: null as 'point' | 'rect' | null,
  });

  /**
   * Bumped whenever the working context is replaced (new image import or
   * project load). Async focus samples capture the epoch at dispatch and are
   * discarded on arrival when it no longer matches, so a late result can
   * never land on a deleted point or leak into another project.
   */
  let focusEpoch = 0;
  let focusSeq = 0;

  async function init() {
    try {
      await seedBuiltinProfiles();
      state.profiles = await idbAll<StoredProfile>(STORE_PROFILES);
      state.profiles.sort((a, b) => a.description.localeCompare(b.description));
      if (!state.targetProfile) {
        const wide = state.profiles.find((p) => p.id === 'builtin-ciergb-elle') ?? state.profiles[0] ?? null;
        state.targetProfile = wide;
      }
      state.projects = (await idbAll<StoredProject>(STORE_PROJECTS)).map((p: StoredProject) => ({
        id: p.id,
        name: p.name,
        updatedAt: p.updatedAt,
      }));
      state.projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      state.ready = true;
    } catch (err) {
      state.initError = err instanceof Error ? err.message : String(err);
    }
  }

  async function importImage(file: File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const container = detectContainer(bytes);
    if (container === 'unknown') {
      state.notice = '仅支持 PNG / JPEG / WebP。';
      return;
    }
    const embedded = extractEmbeddedICC(bytes);
    const provenance = detectProvenance(bytes);
    const info = embedded ? readProfileInfo(embedded) : null;
    state.image = {
      bytes,
      name: file.name,
      bitDepth: container === 'png' && bytes[24] === 16 ? 16 : 8,
      container,
      embedded,
      provenance,
    };
    state.sourceEmbeddedInfo = embedded && info?.valid ? info : null;
    state.result = null;
    state.resultKey = '';
    state.pins = [];
    state.hover.info = null;
    state.convertError = '';
    state.sourceAssumed = false;
    state.sourceProfile = null;
    // 换图即换工作上下文：关注点绑定原图内容指纹，绝不自动套用到新图；
    // 递增 epoch 使旧图尚未返回的取样结果全部作废。
    focusEpoch++;
    focusSeq = 0;
    state.imageHash = fnv1a64(bytes);
    state.focusPoints = [];
    state.focusMode = null;

    if (embedded && info?.valid) {
      // Profile the pixels were actually tagged with; record identity for display.
      state.sourceProfile = {
        id: 'embedded:' + (info.profileId || file.name),
        bytes: embedded,
        description: info.description || `嵌入配置 (${info.colorSpaceSig.trim()})`,
        colorSpace: info.colorSpace,
        channels: info.channels,
        origin: 'builtin-open', // origin field semantics live in the record; UI overrides label
        addedAt: '',
        size: embedded.byteLength,
      };
    }
    // Missing profile -> no default guess; operator must choose (enforced in UI).
  }

  function chooseSourceProfile(id: string) {
    const p = state.profiles.find((x) => x.id === id);
    if (!p || !state.image) return;
    state.sourceProfile = p;
    state.sourceAssumed = !state.image.embedded;
    invalidate();
  }

  function chooseTargetProfile(id: string) {
    state.targetProfile = state.profiles.find((x) => x.id === id) ?? null;
    invalidate();
  }

  function invalidate() {
    state.result = null;
    state.resultKey = '';
    state.hover.info = null;
  }

  const paramsKey = $derived(
    state.image && state.sourceProfile && state.targetProfile
      ? [
          state.sourceProfile.id,
          state.targetProfile.id,
          state.intent,
          state.blackPointCompensation ? 1 : 0,
          state.proofIntent,
          state.image.bytes.byteLength,
        ].join('|')
      : '',
  );

  const needsSourceChoice = $derived(!!state.image && !state.image.embedded && !state.sourceAssumed);

  /** Live proofing conditions; null until source+target are both decided. */
  function currentConditions(): ProofConditions | null {
    if (!state.image || !state.sourceProfile || !state.targetProfile) return null;
    return {
      sourceProfileId: state.sourceProfile.id,
      sourceProfileDescription: state.sourceProfile.description,
      sourceIsEmbedded: !!state.image.embedded && !state.sourceAssumed,
      sourceAssumed: state.sourceAssumed,
      targetProfileId: state.targetProfile.id,
      targetProfileDescription: state.targetProfile.description,
      targetColorSpace: state.targetProfile.colorSpace,
      intent: state.intent,
      blackPointCompensation: state.blackPointCompensation,
      proofIntent: state.proofIntent,
    };
  }

  /** Signature of the live proofing conditions (matches FocusEvaluation.conditionsKey). */
  const conditionsKey = $derived.by(() => {
    const c = currentConditions();
    return c ? conditionsKeyOf(c) : '';
  });

  // ---------------- 校样关注点 ----------------

  function armFocus(mode: 'point' | 'rect') {
    state.focusMode = state.focusMode === mode ? null : mode;
  }

  function newEvaluation(cond: ProofConditions): FocusEvaluation {
    return {
      id: newId('fe'),
      createdAt: new Date().toISOString(),
      conditions: cond,
      conditionsKey: conditionsKeyOf(cond),
      sample: null,
      deltaE: null,
      status: 'pending',
      note: '',
      pending: true,
    };
  }

  /**
   * Create a focus point/region in ORIGINAL IMAGE coordinates and sample it
   * under the current conditions. The evaluation is bound to the condition
   * snapshot taken right now; later condition changes cannot rewrite it.
   */
  function addFocus(kind: 'point' | 'rect', x: number, y: number, w: number, h: number, imgW: number, imgH: number) {
    const cond = currentConditions();
    if (!state.image || !cond) {
      state.notice = '请先确定源配置与目标配置，再建立校样关注点。';
      return;
    }
    state.focusMode = null; // one-shot arming
    const cx = Math.max(0, Math.min(imgW - 1, Math.round(x)));
    const cy = Math.max(0, Math.min(imgH - 1, Math.round(y)));
    const cw = Math.max(1, Math.min(imgW - cx, Math.round(w)));
    const ch = Math.max(1, Math.min(imgH - cy, Math.round(h)));
    focusSeq++;
    const point: FocusPoint = {
      id: newId('fp'),
      createdAt: new Date().toISOString(),
      kind,
      x: cx,
      y: cy,
      w: kind === 'point' ? 1 : cw,
      h: kind === 'point' ? 1 : ch,
      label: kind === 'point' ? `点 ${focusSeq}` : `区域 ${focusSeq}`,
      imageHash: state.imageHash,
      imageName: state.image.name,
      imageWidth: imgW,
      imageHeight: imgH,
      evaluations: [],
    };
    point.evaluations.push(newEvaluation(cond));
    state.focusPoints.push(point);
    dispatchEvalSample(point.id, point.evaluations[0].id);
  }

  function removeFocus(id: string) {
    const i = state.focusPoints.findIndex((p) => p.id === id);
    if (i >= 0) state.focusPoints.splice(i, 1);
    // 该点尚未返回的取样会在到达时被守卫丢弃，不会复活此点。
  }

  /**
   * 复核：在当前打样条件下取样判定。同条件已存在判定时就地刷新取样
   * （同一条件快照，判定与备注保留）；条件已变更则追加新版本，旧判定
   * 保留为只读历史。
   */
  function reviewFocus(id: string) {
    const cond = currentConditions();
    if (!cond) return;
    const p = state.focusPoints.find((q) => q.id === id);
    if (!p) return;
    const key = conditionsKeyOf(cond);
    const existing = p.evaluations.find((e) => e.conditionsKey === key);
    if (existing) {
      existing.pending = true;
      existing.error = undefined;
      dispatchEvalSample(p.id, existing.id);
    } else {
      const ev = newEvaluation(cond);
      p.evaluations.push(ev);
      dispatchEvalSample(p.id, ev.id);
    }
  }

  /** The evaluation valid under the live conditions (undefined => history only). */
  function currentEvaluationOf(p: FocusPoint): FocusEvaluation | undefined {
    return evaluationForConditions(p, conditionsKey);
  }

  function setFocusStatus(pointId: string, status: FocusStatus) {
    const p = state.focusPoints.find((q) => q.id === pointId);
    if (!p) return;
    const e = currentEvaluationOf(p);
    // 只有当前条件版本可判定；历史版本只读，不能原地改写。
    if (!e || e.pending || !e.sample) return;
    e.status = status;
  }

  function setFocusNote(pointId: string, note: string) {
    const p = state.focusPoints.find((q) => q.id === pointId);
    if (!p) return;
    const e = currentEvaluationOf(p);
    if (!e || e.pending) return;
    e.note = note;
  }

  /**
   * Dispatch the async region sample for one evaluation. Everything the
   * worker needs is captured NOW (image bytes, profiles, params) so the
   * computation always matches the evaluation's own condition snapshot,
   * regardless of what the operator changes while it runs.
   */
  function dispatchEvalSample(pointId: string, evalId: string) {
    if (!state.image || !state.sourceProfile || !state.targetProfile) return;
    const p = state.focusPoints.find((q) => q.id === pointId);
    if (!p) return;
    const epoch = focusEpoch;
    const hash = state.imageHash;
    const params: EngineParams = {
      intent: state.intent,
      blackPointCompensation: state.blackPointCompensation,
      proofIntent: state.proofIntent,
    };
    const req = {
      imageBytes: state.image.bytes,
      sourceIcc: state.sourceProfile.bytes,
      targetIcc: state.targetProfile.bytes,
      params,
      x: p.x,
      y: p.y,
      w: p.w,
      h: p.h,
    };
    void runSampleRegion(req)
      .then((info) => applyEvalResult(pointId, evalId, epoch, hash, info, undefined))
      .catch((err) => applyEvalResult(pointId, evalId, epoch, hash, null, String(err)));
  }

  /** Late-result guard: drop anything whose context has moved on. */
  function applyEvalResult(
    pointId: string,
    evalId: string,
    epoch: number,
    hash: string,
    info: RegionSampleInfo | null,
    error: string | undefined,
  ) {
    if (epoch !== focusEpoch) return; // 工程/原图已切换
    if (hash !== state.imageHash) return; // 内容指纹不匹配
    const p = state.focusPoints.find((q) => q.id === pointId);
    const e = evaluationAcceptsResult(p, evalId); // 已删除或已被取代 -> 丢弃
    if (!e) return;
    if (info) {
      e.sample = info;
      e.deltaE = deltaE2000(fromTriple(info.sourceLab), fromTriple(info.targetLab));
      e.error = undefined;
    } else {
      e.error = error ?? '取样失败';
    }
    e.pending = false;
  }

  async function convertNow() {
    if (!state.image || !state.sourceProfile || !state.targetProfile) return;
    state.converting = true;
    state.convertError = '';
    try {
      const params: EngineParams = {
        intent: state.intent,
        blackPointCompensation: state.blackPointCompensation,
        proofIntent: state.proofIntent,
      };
      const r = await runConvert({
        imageBytes: state.image.bytes,
        sourceIcc: state.sourceProfile.bytes,
        targetIcc: state.targetProfile.bytes,
        params,
      });
      state.result = r;
      state.resultKey = paramsKey;
    } catch (err) {
      state.convertError = err instanceof Error ? err.message : String(err);
    } finally {
      state.converting = false;
    }
  }

  async function sample(x: number, y: number): Promise<SampleInfo | null> {
    if (!state.image || !state.sourceProfile || !state.targetProfile) return null;
    const params: EngineParams = {
      intent: state.intent,
      blackPointCompensation: state.blackPointCompensation,
      proofIntent: state.proofIntent,
    };
    return runSample({
      imageBytes: state.image.bytes,
      sourceIcc: state.sourceProfile.bytes,
      targetIcc: state.targetProfile.bytes,
      params,
      x,
      y,
    });
  }

  function pin(x: number, y: number) {
    const point: SamplePoint = { x, y, pending: true };
    state.pins.push(point);
    void sample(x, y)
      .then((info) => {
        point.info = info;
        point.pending = false;
      })
      .catch((err) => {
        point.error = String(err);
        point.pending = false;
      });
  }
  function removePin(i: number) {
    state.pins.splice(i, 1);
  }

  async function importProfiles(files: FileList | File[]) {
    state.busyProfiles = true;
    const added: string[] = [];
    for (const file of [...files]) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const info = readProfileInfo(bytes);
      if (!info.valid || (info.colorSpace !== 'RGB' && info.colorSpace !== 'CMYK' && info.colorSpace !== 'GRAY')) {
        state.notice = `已跳过 ${file.name}：不是有效的 RGB/CMYK/Gray ICC 配置。`;
        continue;
      }
      const id = newId('icc');
      const profile: StoredProfile = {
        id,
        bytes,
        description: info.description || file.name,
        colorSpace: info.colorSpace,
        channels: info.channels,
        origin: 'user-imported',
        addedAt: new Date().toISOString(),
        size: bytes.byteLength,
      };
      await idbPut(STORE_PROFILES, profile);
      added.push(profile.description);
    }
    state.profiles = await idbAll<StoredProfile>(STORE_PROFILES);
    state.profiles.sort((a, b) => a.description.localeCompare(b.description));
    state.busyProfiles = false;
    if (added.length) state.notice = `已加入配置库：${added.join('、')}`;
  }

  async function saveProject(name: string) {
    if (!state.image || !state.sourceProfile) return;
    const id = newId('proj');
    const p: StoredProject = {
      id,
      name: name || state.image.name,
      updatedAt: new Date().toISOString(),
      imageBytes: state.image.bytes,
      imageName: state.image.name,
      embeddedICC: state.image.embedded ?? undefined,
      sourceProfileId: state.sourceProfile.id.startsWith('embedded:') ? null : state.sourceProfile.id,
      sourceIsEmbedded: !!state.image.embedded,
      sourceAssumptionNote: state.sourceAssumed
        ? '原图缺少嵌入配置，操作员手动选择源配置（假设已记录）'
        : undefined,
      targetProfileId: state.targetProfile?.id ?? null,
      intent: state.intent,
      blackPointCompensation: state.blackPointCompensation,
      proofIntent: state.proofIntent,
      provenanceSeen: state.image.provenance.converted,
      // 关注点随工程持久化：完整判定历史（每条自带条件快照），
      // 运行时 pending 标记在序列化时剥离。
      focusPoints: state.focusPoints.map(serializeFocusPoint),
    };
    await idbPut(STORE_PROJECTS, p);
    state.projects = (await idbAll<StoredProject>(STORE_PROJECTS)).map((x) => ({
      id: x.id,
      name: x.name,
      updatedAt: x.updatedAt,
    }));
    state.projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    state.notice = `工程已保存到本机 IndexedDB：${p.name}`;
  }

  async function loadProject(id: string) {
    const p = await idbGetProject(id);
    if (!p) return;
    // 切换工程 = 切换工作上下文：旧工程未返回的取样一律作废。
    focusEpoch++;
    focusSeq = 0;
    const embedded = p.embeddedICC ?? null;
    state.image = {
      bytes: p.imageBytes,
      name: p.imageName,
      bitDepth: detectContainer(p.imageBytes) === 'png' && p.imageBytes[24] === 16 ? 16 : 8,
      container: detectContainer(p.imageBytes),
      embedded,
      provenance: detectProvenance(p.imageBytes),
    };
    state.imageHash = fnv1a64(p.imageBytes);
    const all = await idbAll<StoredProfile>(STORE_PROFILES);
    state.profiles = all.sort((a, b) => a.description.localeCompare(b.description));
    if (p.sourceIsEmbedded && embedded) {
      const info = readProfileInfo(embedded);
      state.sourceProfile = {
        id: 'embedded:' + (info.profileId || p.imageName),
        bytes: embedded,
        description: info.description || '嵌入配置',
        colorSpace: info.colorSpace,
        channels: info.channels,
        origin: 'builtin-open',
        addedAt: '',
        size: embedded.byteLength,
      };
      state.sourceAssumed = false;
      state.sourceEmbeddedInfo = info;
    } else if (p.sourceProfileId) {
      const sp = all.find((x) => x.id === p.sourceProfileId) ?? null;
      state.sourceProfile = sp;
      state.sourceAssumed = true;
      state.sourceEmbeddedInfo = null;
    }
    state.targetProfile = all.find((x) => x.id === p.targetProfileId) ?? null;
    state.intent = p.intent;
    state.blackPointCompensation = p.blackPointCompensation;
    state.proofIntent = p.proofIntent ?? 'relative-colorimetric';
    // 关注点按内容指纹恢复：指纹不匹配（换了原图）的点一律不套用。
    const storedFocus = p.focusPoints ?? [];
    state.focusPoints = storedFocus.filter((fp) => focusAppliesToImage(fp, state.imageHash)).map(reviveFocusPoint);
    focusSeq = state.focusPoints.length;
    state.focusMode = null;
    invalidate();
    state.notice =
      storedFocus.length > state.focusPoints.length
        ? `已载入工程：${p.name}（${storedFocus.length - state.focusPoints.length} 个关注点因原图指纹不匹配未恢复）`
        : `已载入工程：${p.name}`;
  }

  async function deleteProject(id: string) {
    await idbDelete(STORE_PROJECTS, id);
    state.projects = state.projects.filter((p) => p.id !== id);
  }

  async function deleteProfile(id: string) {
    if (id.startsWith('builtin-')) return;
    await idbDelete(STORE_PROFILES, id);
    state.profiles = state.profiles.filter((p) => p.id !== id);
    if (state.sourceProfile?.id === id) state.sourceProfile = null;
    if (state.targetProfile?.id === id) state.targetProfile = null;
    invalidate();
  }

  return {
    state,
    init,
    importImage,
    chooseSourceProfile,
    chooseTargetProfile,
    convertNow,
    sample,
    pin,
    removePin,
    importProfiles,
    saveProject,
    loadProject,
    deleteProject,
    deleteProfile,
    armFocus,
    addFocus,
    removeFocus,
    reviewFocus,
    currentEvaluationOf,
    setFocusStatus,
    setFocusNote,
    get needsSourceChoice() {
      return needsSourceChoice;
    },
    get paramsKey() {
      return paramsKey;
    },
    get conditionsKey() {
      return conditionsKey;
    },
  };
}

async function idbGetProject(id: string): Promise<StoredProject | undefined> {
  const all = await idbAll<StoredProject>(STORE_PROJECTS);
  return all.find((p) => p.id === id);
}

export type AppState = ReturnType<typeof createAppState>;

let singleton: AppState | null = null;
export function getApp(): AppState {
  singleton ??= createAppState();
  return singleton;
}

export type { ColorSpaceKind };
