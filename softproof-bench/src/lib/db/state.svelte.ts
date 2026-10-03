/**
 * Central application state (Svelte 5 runes). Owns:
 *  - imported image bytes + embedded/assumed source profile decision
 *  - profile library (IndexedDB)
 *  - target profile, intent, BPC
 *  - worker conversion results + sampler
 *  - 校样关注点 (proof concerns): points/rects bound to the original image
 *    fingerprint with frozen per-version condition snapshots + full history
 *  - project save/load
 */
import { idbAll, idbDelete, idbPut, STORE_PROJECTS, STORE_PROFILES, type StoredProfile, type StoredProject } from './db';
import { seedBuiltinProfiles } from './builtinProfiles';
import { extractEmbeddedICC, detectContainer } from '../icc/extractEmbedded';
import { readProfileInfo, type ProfileInfo, type ColorSpaceKind } from '../icc/profileInfo';
import { detectProvenance } from '../icc/provenance';
import { runConvert, runSample, runSampleBatch, type ConvertedPayload } from '../workers/client';
import type { EngineParams, SampleInfo } from '../color/engine';
import type { RenderingIntent } from '../color/lcms';
import {
  buildConditionSnapshot,
  conditionKey,
  fingerprintGate,
  imageFingerprintOf,
  latestVersion,
  makeVersion,
  normalizeRect,
  profileSnapshotOf,
  rectSamplePoints,
  reviveConcern,
  toRegionSample,
  VERDICT_LABEL,
  type ConcernShape,
  type ConcernVerdict,
  type ConditionSnapshot,
  type ProofConcern,
  type ProfileSnapshot,
} from '../color/concern';

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

/**
 * 关注点在图像解码完成前先暂存在这里；拿到尺寸（指纹需要宽高）后按指纹
 * 过闸：匹配的进入 state.concerns，不匹配的进入隔离区，绝不自动套用。
 */
interface PendingBind {
  concerns: ProofConcern[];
  quarantine: ProofConcern[];
}

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
    // ---- 校样关注点 ----
    /** 已通过原图内容指纹校验、绑定到当前原图的关注点。 */
    concerns: [] as ProofConcern[],
    /** 指纹不匹配的旧关注点：保留可查，但绝不渲染/套用。 */
    quarantinedConcerns: [] as ProofConcern[],
    selectedConcernId: '' as string,
    /** 当前原图内容指纹（解码完成后可得）。 */
    imageFingerprint: '' as string,
    imageWidth: 0,
    imageHeight: 0,
    /**
     * 每次载入工程/导入图片递增；即使原图字节引用恰好未变（连续载入同一工程），
     * App 的解码/过闸 effect 也必须重跑，否则关注点永远停留在 pendingBind。
     */
    imageBindEpoch: 0,
    currentProjectId: '' as string,
    currentProjectName: '' as string,
    /**
     * 异步会话纪元：换图/切换/载入工程时递增。所有取样 Promise 落地前
     * 必须核对纪元，迟到结果只能被丢弃，不能写入新图像/新工程。
     */
    sessionEpoch: 0,
  });

  let pendingBind: PendingBind | null = null;

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

  function bumpEpoch() {
    state.sessionEpoch++;
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
    // 换图即新会话：任何在途取样立刻失效；旧关注点不向新原图迁移。
    bumpEpoch();
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
    state.concerns = [];
    state.quarantinedConcerns = [];
    state.selectedConcernId = '';
    state.imageFingerprint = '';
    state.imageWidth = 0;
    state.imageHeight = 0;
    state.imageBindEpoch++;
    state.currentProjectId = '';
    state.currentProjectName = '';
    pendingBind = null;

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

  /** 画布侧完成原图解码后回报尺寸；此刻才能计算内容指纹并放行关注点。 */
  function setImageDims(width: number, height: number) {
    if (!state.image || !width || !height) return;
    state.image.width = width;
    state.image.height = height;
    state.imageWidth = width;
    state.imageHeight = height;
    const fp = imageFingerprintOf(state.image.bytes, width, height);
    state.imageFingerprint = fp;
    if (pendingBind) {
      const bound = pendingBind;
      pendingBind = null;
      // 内容指纹过闸：不匹配的旧关注点只进隔离区，绝不自动套用。
      const { matched, quarantined: qNew } = fingerprintGate(bound.concerns, fp);
      const quarantined = [...bound.quarantine, ...qNew];
      state.concerns = matched;
      state.quarantinedConcerns = quarantined;
      state.selectedConcernId = matched[0]?.id ?? '';
      if (matched.length && quarantined.length) {
        state.notice = `已恢复 ${matched.length} 个与原图指纹匹配的关注点；${quarantined.length} 个因内容指纹不符已隔离，不会套用。`;
      } else if (matched.length) {
        state.notice = `已恢复 ${matched.length} 个绑定当前原图的关注点。`;
      } else if (bound.concerns.length) {
        state.notice = `工程中的 ${bound.concerns.length} 个关注点与当前原图内容指纹不匹配，已全部隔离，不会自动套用。`;
      }
    }
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
    return sampleBatch([{ x, y }]).then((r) => (r ? r[0] : null));
  }

  async function sampleBatch(points: { x: number; y: number }[]): Promise<SampleInfo[] | null> {
    if (!state.image || !state.sourceProfile || !state.targetProfile) return null;
    const params: EngineParams = {
      intent: state.intent,
      blackPointCompensation: state.blackPointCompensation,
      proofIntent: state.proofIntent,
    };
    return runSampleBatch({
      imageBytes: state.image.bytes,
      sourceIcc: state.sourceProfile.bytes,
      targetIcc: state.targetProfile.bytes,
      params,
      points,
    });
  }

  function pin(x: number, y: number) {
    const point: SamplePoint = { x, y, pending: true };
    state.pins.push(point);
    const epoch = state.sessionEpoch;
    void sample(x, y)
      .then((info) => {
        if (epoch !== state.sessionEpoch) return; // 迟到结果属于旧会话，丢弃
        point.info = info;
        point.pending = false;
      })
      .catch((err) => {
        if (epoch !== state.sessionEpoch) return;
        point.error = String(err);
        point.pending = false;
      });
  }
  function removePin(i: number) {
    state.pins.splice(i, 1);
  }

  // ===================== 校样关注点 =====================

  function profileOriginOf(p: StoredProfile, embedded: boolean, assumed: boolean): ProfileSnapshot['origin'] {
    if (embedded && !assumed) return 'embedded';
    if (assumed) return 'assumed';
    return p.origin === 'builtin-open' ? 'builtin' : 'user-library';
  }

  /** 当前打样条件的完整快照；条件不完整时返回 null。 */
  function liveCondition(): ConditionSnapshot | null {
    if (!state.image || !state.sourceProfile || !state.targetProfile || !state.imageFingerprint) return null;
    const sourceSnap = profileSnapshotOf({
      id: state.sourceProfile.id,
      description: state.sourceProfile.description,
      colorSpace: state.sourceProfile.colorSpace,
      origin: profileOriginOf(state.sourceProfile, !!state.image.embedded, state.sourceAssumed),
      bytes: state.sourceProfile.bytes,
    });
    const targetSnap = profileSnapshotOf({
      id: state.targetProfile.id,
      description: state.targetProfile.description,
      colorSpace: state.targetProfile.colorSpace,
      origin: state.targetProfile.origin === 'builtin-open' ? 'builtin' : 'user-library',
      bytes: state.targetProfile.bytes,
    });
    return buildConditionSnapshot({
      source: sourceSnap,
      target: targetSnap,
      intent: state.intent,
      blackPointCompensation: state.blackPointCompensation,
      proofIntent: state.proofIntent,
      sourceAssumed: state.sourceAssumed,
      sourceAssumptionNote: state.sourceAssumed
        ? '原图缺少嵌入配置，操作员手动选择源配置（假设已记录）'
        : undefined,
      imageProvenanceConverted: state.image.provenance.converted,
    });
  }

  /** 某关注点最新版本是否仍与当前 live 条件一致（否则旧判定只算历史）。 */
  function concernMatchesLive(c: ProofConcern): boolean {
    const live = liveCondition();
    if (!live) return false;
    return conditionKey(latestVersion(c).condition) === conditionKey(live);
  }

  function canCreateConcern(): boolean {
    return !!(state.image && state.sourceProfile && state.targetProfile && state.imageFingerprint);
  }

  function createPointConcern(x: number, y: number): ProofConcern | null {
    return createConcern({ kind: 'point', x, y });
  }

  function createRectConcern(x0: number, y0: number, x1: number, y1: number): ProofConcern | null {
    return createConcern(normalizeRect({ x: x0, y: y0 }, { x: x1, y: y1 }, state.imageWidth, state.imageHeight));
  }

  function createConcern(shape: ConcernShape): ProofConcern | null {
    if (!state.image || !state.imageFingerprint || !state.imageWidth || !state.sourceProfile || !state.targetProfile) {
      state.notice = '原图、源/目标配置与原图指纹齐备后才能建立关注点。';
      return null;
    }
    const condition = liveCondition();
    if (!condition) return null;

    const concern: ProofConcern = {
      id: newId('pc'),
      label: '',
      createdAt: new Date().toISOString(),
      shape,
      imageFingerprint: state.imageFingerprint,
      imageName: state.image.name,
      imageWidth: state.imageWidth,
      imageHeight: state.imageHeight,
      versions: [],
    };
    state.concerns.push(concern);
    // 从 state 代理中取回对象——异步回调必须改代理而不是入栈前的原始对象，
    // 否则 Svelte 不会收到变更通知（UI 会永远停在“取样中”）。
    const liveConcern = state.concerns[state.concerns.length - 1];
    liveConcern.versions.push(makeVersion({ index: 1, condition, status: 'sampling' }));
    const version = liveConcern.versions[0];
    state.selectedConcernId = liveConcern.id;

    // 异步取样：捕获纪元/指纹/版本 id，任何一项对不上都丢弃迟到结果。
    const epoch = state.sessionEpoch;
    const fp = state.imageFingerprint;
    const concernId = liveConcern.id;
    const points = rectSamplePoints(shape);
    void sampleBatch(points)
      .then((infos) => {
        if (!isSampleStillOurs(epoch, fp, concernId, version.id)) return;
        if (!infos) {
          version.status = 'error';
          version.error = '取样未能执行（条件不完整）';
          return;
        }
        version.samples = points.map((p, i) => toRegionSample(p.x, p.y, infos[i]));
        version.stats = toStats(version.samples);
        version.status = 'ok';
      })
      .catch((err) => {
        if (!isSampleStillOurs(epoch, fp, concernId, version.id)) return;
        version.status = 'error';
        version.error = err instanceof Error ? err.message : String(err);
      });
    return liveConcern;
  }

  function toStats(samples: ProofConcern['versions'][number]['samples']) {
    if (!samples.length) return null;
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

  /** 迟到异步结果的唯一放行条件：会话、原图指纹、关注点及该版本都未变化。 */
  function isSampleStillOurs(epoch: number, fp: string, concernId: string, versionId: string): boolean {
    if (epoch !== state.sessionEpoch || fp !== state.imageFingerprint) return false;
    const c = state.concerns.find((x) => x.id === concernId);
    if (!c) return false; // 关注点已删除——迟到结果不得让它复活
    const v = latestVersion(c);
    return v.id === versionId && v.status === 'sampling';
  }

  function findConcern(id: string): ProofConcern | null {
    return state.concerns.find((c) => c.id === id) ?? null;
  }

  /** 修改判定/备注：仅允许在最新版本且条件仍与当前一致时进行；
   *  旧条件下的版本一律冻结，不能被原地“刷新”成当前结果。 */
  function setConcernVerdict(id: string, verdict: ConcernVerdict) {
    const c = findConcern(id);
    if (!c) return;
    const v = latestVersion(c);
    if (!concernMatchesLive(c)) {
      state.notice = '打样条件已变更：该判定属于历史版本且保持不变；请先创建基于新条件的复核。';
      return;
    }
    v.verdict = verdict;
  }

  function setConcernNote(id: string, note: string) {
    const c = findConcern(id);
    if (!c) return;
    const v = latestVersion(c);
    if (!concernMatchesLive(c)) {
      state.notice = '打样条件已变更：历史备注保持不变；请在基于新条件的复核版本中记录。';
      return;
    }
    v.note = note;
  }

  function setConcernLabel(id: string, label: string) {
    const c = findConcern(id);
    if (c) c.label = label;
  }

  function selectConcern(id: string) {
    state.selectedConcernId = id;
  }

  function removeConcern(id: string) {
    const i = state.concerns.findIndex((c) => c.id === id);
    if (i < 0) {
      // 也允许从隔离区移除。
      const q = state.quarantinedConcerns.findIndex((c) => c.id === id);
      if (q >= 0) state.quarantinedConcerns.splice(q, 1);
      return;
    }
    state.concerns.splice(i, 1);
    if (state.selectedConcernId === id) state.selectedConcernId = state.concerns[0]?.id ?? '';
    // 不 bump 纪元：在途 Promise 由 isSampleStillOurs 的“关注点不存在”检查拦截，
    // 迟到结果无法重建该关注点。
  }

  /**
   * 显式创建基于当前（新）条件的复核：追加新版本，旧版本原样保留在
   * versions 历史中。条件与最新版本完全相同时（如上次取样中断/出错）
   * 也允许重测。
   */
  function recheckConcern(id: string): ProofConcern | null {
    const c = findConcern(id);
    if (!c) return null;
    const condition = liveCondition();
    if (!condition) {
      state.notice = '当前打样条件不完整，无法创建复核。';
      return null;
    }
    const prev = latestVersion(c);
    const sameCondition = conditionKey(prev.condition) === conditionKey(condition);
    if (sameCondition && prev.status === 'ok') {
      state.notice = '当前条件与最新判定一致且取样完整，无需复核；改变目标配置或意图后再复核。';
      return null;
    }
    c.versions.push(
      makeVersion({
        index: c.versions.length + 1,
        condition,
        status: 'sampling',
        basedOnVersionId: prev.id,
      }),
    );
    // 取回 state 代理中的新版本，异步结果写代理。
    const version = latestVersion(c);
    // 沿用上一版的判定草稿与备注（可改），但取样与 ΔE 必须重新取得。
    version.verdict = 'pending';
    version.note = '';

    const epoch = state.sessionEpoch;
    const fp = state.imageFingerprint;
    const points = rectSamplePoints(c.shape);
    void sampleBatch(points)
      .then((infos) => {
        if (!isSampleStillOurs(epoch, fp, c.id, version.id)) return;
        if (!infos) {
          version.status = 'error';
          version.error = '取样未能执行（条件不完整）';
          return;
        }
        version.samples = points.map((p, i) => toRegionSample(p.x, p.y, infos[i]));
        version.stats = toStats(version.samples);
        version.status = 'ok';
      })
      .catch((err) => {
        if (!isSampleStillOurs(epoch, fp, c.id, version.id)) return;
        version.status = 'error';
        version.error = err instanceof Error ? err.message : String(err);
      });
    return c;
  }

  // ===================== 配置库 / 工程 =====================

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
    const updating = state.currentProjectId
      ? (await idbAll<StoredProject>(STORE_PROJECTS)).find((p) => p.id === state.currentProjectId)
      : undefined;
    const id = updating?.id ?? newId('proj');
    const p: StoredProject = {
      id,
      name: name || updating?.name || state.currentProjectName || state.image.name,
      updatedAt: new Date().toISOString(),
      imageBytes: state.image.bytes,
      imageName: state.image.name,
      embeddedICC: state.image.embedded ?? undefined,
      sourceProfileId: state.sourceProfile.id.startsWith('embedded:') ? null : state.sourceProfile.id,
      sourceIsEmbedded: !!state.image.embedded && !state.sourceAssumed,
      sourceAssumptionNote: state.sourceAssumed
        ? '原图缺少嵌入配置，操作员手动选择源配置（假设已记录）'
        : undefined,
      targetProfileId: state.targetProfile?.id ?? null,
      intent: state.intent,
      blackPointCompensation: state.blackPointCompensation,
      proofIntent: state.proofIntent,
      provenanceSeen: state.image.provenance.converted,
      proofConcerns: toPlain(state.concerns),
      quarantineConcerns: toPlain(state.quarantinedConcerns),
    };
    await idbPut(STORE_PROJECTS, p);
    state.currentProjectId = id;
    state.currentProjectName = p.name;
    state.projects = (await idbAll<StoredProject>(STORE_PROJECTS)).map((x) => ({
      id: x.id,
      name: x.name,
      updatedAt: x.updatedAt,
    }));
    state.projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    state.notice = `工程已保存到本机 IndexedDB：${p.name}（${state.concerns.length} 个关注点，历史版本完整保留）`;
  }

  async function loadProject(id: string) {
    const p = await idbGetProject(id);
    if (!p) return;
    // 切换工程即新会话：上一工程的一切在途取样立即作废。
    bumpEpoch();
    const embedded = p.embeddedICC ?? null;
    state.image = {
      bytes: p.imageBytes,
      name: p.imageName,
      bitDepth: detectContainer(p.imageBytes) === 'png' && p.imageBytes[24] === 16 ? 16 : 8,
      container: detectContainer(p.imageBytes),
      embedded,
      provenance: detectProvenance(p.imageBytes),
    };
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
    } else {
      state.sourceProfile = null;
      state.sourceAssumed = false;
      state.sourceEmbeddedInfo = null;
    }
    state.targetProfile = all.find((x) => x.id === p.targetProfileId) ?? null;
    state.intent = p.intent;
    state.blackPointCompensation = p.blackPointCompensation;
    state.proofIntent = p.proofIntent ?? 'relative-colorimetric';
    invalidate();
    state.pins = [];
    state.hover.info = null;
    state.currentProjectId = p.id;
    state.currentProjectName = p.name;
    state.imageFingerprint = '';
    state.imageWidth = 0;
    state.imageHeight = 0;
    state.imageBindEpoch++;
    state.selectedConcernId = '';
    state.concerns = [];
    state.quarantinedConcerns = [];
    // 关注点先暂存，待原图解码出尺寸、算出内容指纹后再按指纹过闸。
    const revived = (p.proofConcerns ?? []).map((r) => reviveConcern(r)).filter((r): r is ProofConcern => !!r);
    const revivedQ = (p.quarantineConcerns ?? []).map((r) => reviveConcern(r)).filter((r): r is ProofConcern => !!r);
    pendingBind = { concerns: revived, quarantine: revivedQ };
    state.notice = `已载入工程：${p.name}`;
  }

  async function deleteProject(id: string) {
    await idbDelete(STORE_PROJECTS, id);
    state.projects = state.projects.filter((p) => p.id !== id);
    if (state.currentProjectId === id) {
      // 删除的是当前工程：作废全部在途取样，防止迟到结果落进已删上下文。
      bumpEpoch();
      state.currentProjectId = '';
      state.currentProjectName = '';
    }
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
    setImageDims,
    chooseSourceProfile,
    chooseTargetProfile,
    invalidate,
    convertNow,
    sample,
    sampleBatch,
    pin,
    removePin,
    // concerns
    createPointConcern,
    createRectConcern,
    recheckConcern,
    removeConcern,
    setConcernVerdict,
    setConcernNote,
    setConcernLabel,
    selectConcern,
    concernMatchesLive,
    liveCondition,
    canCreateConcern,
    VERDICT_LABEL,
    importProfiles,
    saveProject,
    loadProject,
    deleteProject,
    deleteProfile,
    get needsSourceChoice() {
      return needsSourceChoice;
    },
    get paramsKey() {
      return paramsKey;
    },
  };
}

/** Svelte proxy -> 纯结构化数据（IndexedDB structured clone 不能克隆 runes proxy）。 */
function toPlain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
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
