<script lang="ts">
  import type { AppState } from '../db/state.svelte';
  import { deltaE2000, fromTriple, rgbHex, type Lab } from '../color/colorMath';
  import {
    FOCUS_STATUS_LABEL,
    FOCUS_STATUS_ORDER,
    type FocusEvaluation,
    type FocusPoint,
    type FocusStatus,
  } from '../color/focus';
  import type { RegionSampleInfo } from '../color/engine';

  let { app }: { app: AppState } = $props();
  const s = app.state;

  const fmtDev = (v: number, cs: string): string => {
    if (cs === 'CMYK') return `${v.toFixed(1)}`;
    return `${(v * 100).toFixed(1)}%`;
  };
  const channelsLabel = (cs: string): string[] =>
    cs === 'CMYK' ? ['C', 'M', 'Y', 'K'] : cs === 'GRAY' ? ['K(灰)'] : ['R', 'G', 'B'];
  const lab = (t: [number, number, number]): Lab => fromTriple(t);

  function hexOf(smp: RegionSampleInfo, side: 'source' | 'target'): string | null {
    const cs = side === 'source' ? smp.sourceColorSpace : smp.targetColorSpace;
    const d = side === 'source' ? smp.sourceDevice : smp.targetDevice;
    if (cs !== 'RGB') return null;
    const dev8 = (v: number) => Math.round(v * 255);
    return rgbHex(dev8(d[0]), dev8(d[1]), dev8(d[2]));
  }

  const coordsOf = (p: FocusPoint): string =>
    p.kind === 'point' ? `(${p.x}, ${p.y})` : `(${p.x}, ${p.y}) · ${p.w}×${p.h}px`;

  const condLine = (e: FocusEvaluation): string =>
    `${e.conditions.targetProfileDescription} · ${e.conditions.intent} · BPC ${e.conditions.blackPointCompensation ? '开' : '关'} · 打样 ${e.conditions.proofIntent}`;

  const srcLine = (e: FocusEvaluation): string =>
    e.conditions.sourceAssumed
      ? `源 ${e.conditions.sourceProfileDescription}（假设）`
      : e.conditions.sourceIsEmbedded
        ? `源 ${e.conditions.sourceProfileDescription}（嵌入）`
        : `源 ${e.conditions.sourceProfileDescription}`;

  function onStatus(pointId: string, ev: Event) {
    app.setFocusStatus(pointId, (ev.currentTarget as HTMLSelectElement).value as FocusStatus);
  }
  function onNote(pointId: string, ev: Event) {
    app.setFocusNote(pointId, (ev.currentTarget as HTMLInputElement).value);
  }
</script>

<div class="panel stack focus-panel">
  <h2>校样关注点（绑定原图指纹与打样条件）</h2>

  <div class="row">
    <button
      class:active={s.focusMode === 'point'}
      disabled={!s.image || !s.sourceProfile || !s.targetProfile}
      onclick={() => app.armFocus('point')}>＋ 点关注点</button
    >
    <button
      class:active={s.focusMode === 'rect'}
      disabled={!s.image || !s.sourceProfile || !s.targetProfile}
      onclick={() => app.armFocus('rect')}>＋ 区域关注点</button
    >
  </div>
  {#if s.focusMode === 'point'}
    <div class="small ok">建点模式：在任一画布单击，坐标按原图像素记录。</div>
  {:else if s.focusMode === 'rect'}
    <div class="small ok">区域模式：在任一画布拖拽框选，坐标按原图像素记录。</div>
  {/if}

  {#if !s.image}
    <div class="small muted">导入原图后，可把品牌色、透明边缘等关键区域钉为关注点，判定随打样条件留档。</div>
  {:else if s.focusPoints.length === 0}
    <div class="small muted">尚无关注点。点/区域均记录源与目标取样、ΔE、判定与备注；条件变更后旧判定保留为历史。</div>
  {/if}

  {#each s.focusPoints as p (p.id)}
    {@const cur = app.currentEvaluationOf(p)}
    <div class="focuscard" data-focus-id={p.id}>
      <div class="row spread">
        <div class="row">
          <strong class="small">{p.label}</strong>
          <span class="badge">{p.kind === 'point' ? '点' : '区域'}</span>
          <span class="mono small coords">{coordsOf(p)}</span>
        </div>
        <button class="ghost small danger focus-del" onclick={() => app.removeFocus(p.id)}>删除</button>
      </div>
      <div class="small muted hash" title={`原图内容指纹 ${p.imageHash}`}>
        指纹 {p.imageHash.slice(0, 8)}… · {p.imageName}
      </div>

      {#if cur}
        <!-- 当前打样条件下的判定版本 -->
        {#if cur.pending}
          <div class="small muted">取样中…</div>
        {:else if cur.error}
          <div class="small danger">{cur.error}</div>
          <button class="small" onclick={() => app.reviewFocus(p.id)}>重新取样</button>
        {:else if cur.sample}
          {@render sampleTable(cur.sample, cur.deltaE)}
          <div class="row">
            <label class="field grow">
              判定
              <select class="focus-status" value={cur.status} onchange={(e) => onStatus(p.id, e)}>
                {#each FOCUS_STATUS_ORDER as st}
                  <option value={st}>{FOCUS_STATUS_LABEL[st]}</option>
                {/each}
              </select>
            </label>
          </div>
          <label class="field">
            备注
            <input
              class="focus-note"
              type="text"
              placeholder="如：品牌主色可接受偏差 / 透明边缘无残色…"
              value={cur.note}
              onchange={(e) => onNote(p.id, e)}
            />
          </label>
        {/if}
      {:else}
        <!-- 条件已变更：当前条件下无判定，旧判定只作为历史展示 -->
        <div class="panel-warn small warn">当前打样条件下尚无判定；下方历史版本不会被当作当前结果。</div>
        <button class="small primary review-btn" onclick={() => app.reviewFocus(p.id)}>按当前条件复核</button>
      {/if}

      {#if p.evaluations.length > 1 || (!cur && p.evaluations.length > 0)}
        <details class="history" open={!cur}>
          <summary class="small muted">判定历史（{p.evaluations.length} 个版本）</summary>
          {#each [...p.evaluations].reverse() as e (e.id)}
            {@const isCur = e === cur}
            <div class="histitem" class:iscurrent={isCur}>
              <div class="row spread">
                <span class="small">
                  {#if isCur}<span class="badge embedded">当前</span>{/if}
                  <span class="badge status-{e.status}">{FOCUS_STATUS_LABEL[e.status]}</span>
                  <span class="muted mono">{new Date(e.createdAt).toLocaleString()}</span>
                </span>
                {#if e.deltaE != null}<span class="mono small">ΔE00 {e.deltaE.toFixed(2)}</span>{/if}
              </div>
              <div class="small muted">{condLine(e)}</div>
              <div class="small muted">{srcLine(e)}</div>
              {#if e.pending}
                <div class="small muted">取样中…</div>
              {:else if e.error}
                <div class="small danger">{e.error}</div>
              {:else if e.sample}
                {@const smp = e.sample}
                <div class="mono small">
                  源 {smp.sourceDevice.map((v, i) => `${channelsLabel(smp.sourceColorSpace)[i]} ${fmtDev(v, smp.sourceColorSpace)}`).join(' ')}
                  → 目标 {smp.targetDevice.map((v, i) => `${channelsLabel(smp.targetColorSpace)[i]} ${fmtDev(v, smp.targetColorSpace)}`).join(' ')}
                </div>
                <div class="mono small">
                  Lab {smp.sourceLab.map((v) => v.toFixed(2)).join(' ')} → {smp.targetLab.map((v) => v.toFixed(2)).join(' ')} · α {smp.alpha8}/255
                </div>
              {:else}
                <div class="small muted">无取样数据（保存时取样尚未返回）。</div>
              {/if}
              {#if e.note}<div class="small note">备注：{e.note}</div>{/if}
            </div>
          {/each}
        </details>
      {/if}
    </div>
  {/each}
</div>

{#snippet sampleTable(smp: RegionSampleInfo, de: number | null)}
  {@const srcCh = channelsLabel(smp.sourceColorSpace)}
  {@const dstCh = channelsLabel(smp.targetColorSpace)}
  {@const srcHex = hexOf(smp, 'source')}
  {@const dstHex = hexOf(smp, 'target')}
  <div class="stack samplegrid">
    <table>
      <thead>
        <tr>
          <th></th>
          <th>源（{smp.sourceColorSpace}）</th>
          <th>目标（{smp.targetColorSpace}）</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="muted">设备值</td>
          <td class="mono">
            {#each srcCh as c, i}
              <span class="chip">{c} {fmtDev(smp.sourceDevice[i], smp.sourceColorSpace)}</span>
            {/each}
            {#if srcHex}<div class="swatch" style={`background:${srcHex}`}>{srcHex}</div>{/if}
          </td>
          <td class="mono">
            {#each dstCh as c, i}
              <span class="chip">{c} {fmtDev(smp.targetDevice[i], smp.targetColorSpace)}</span>
            {/each}
            {#if dstHex}<div class="swatch" style={`background:${dstHex}`}>{dstHex}</div>{/if}
          </td>
        </tr>
        <tr>
          <td class="muted">Lab（double）</td>
          <td class="mono">{smp.sourceLab.map((v) => v.toFixed(2)).join('  ')}</td>
          <td class="mono">{smp.targetLab.map((v) => v.toFixed(2)).join('  ')}</td>
        </tr>
        <tr>
          <td class="muted">Alpha</td>
          <td class="mono" colspan="2">
            均值 {smp.meanAlpha8.toFixed(1)} / 255 · 透明像素 {smp.transparentPixels}/{smp.totalPixels}
          </td>
        </tr>
      </tbody>
    </table>
    <div class="row spread de">
      <span class="muted small">色差 ΔE00（源/目标 Lab，D50）</span>
      <strong class:warn={(de ?? 0) >= 2} class:danger={(de ?? 0) >= 6}>{de != null ? de.toFixed(2) : '—'}</strong>
    </div>
  </div>
{/snippet}

<style>
  .focus-panel button.active {
    border-color: var(--accent-2);
    color: var(--accent-2);
  }
  .focuscard {
    border-top: 1px solid var(--line);
    padding-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .coords {
    color: var(--text);
  }
  .hash {
    font-size: 11px;
  }
  .grow {
    flex: 1;
  }
  .panel-warn {
    border-radius: 6px;
    padding: 6px 8px;
    background: #7a5a2322;
    border: 1px solid #7a5a2355;
  }
  .review-btn {
    align-self: flex-start;
  }
  .history summary {
    cursor: pointer;
    user-select: none;
  }
  .histitem {
    border-left: 2px solid var(--line);
    padding: 4px 0 4px 8px;
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .histitem.iscurrent {
    border-left-color: var(--accent-2);
  }
  .note {
    color: var(--text);
  }
  .badge.status-pass {
    color: var(--accent-2);
    border-color: #2f6b4c;
  }
  .badge.status-fail {
    color: var(--danger);
    border-color: #6b2f2f;
  }
  .badge.status-watch {
    color: var(--warn);
    border-color: #7a5a23;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    text-align: left;
    vertical-align: top;
    padding: 4px 6px;
    border-bottom: 1px solid #ffffff0d;
  }
  th {
    font-size: 11px;
    color: var(--muted);
    font-weight: 500;
  }
  .chip {
    display: inline-block;
    margin: 0 5px 2px 0;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 0 6px;
  }
  .swatch {
    margin-top: 3px;
    display: inline-block;
    color: #fff;
    text-shadow: 0 1px 2px #000;
    padding: 1px 8px;
    border-radius: 4px;
    border: 1px solid #00000066;
  }
  .de strong {
    font-size: 16px;
  }
</style>
