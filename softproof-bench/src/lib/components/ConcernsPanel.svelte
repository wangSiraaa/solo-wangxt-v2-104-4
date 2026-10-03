<script lang="ts">
  import type { AppState } from '../db/state.svelte';
  import {
    latestVersion,
    shapeLabel,
    conditionKey,
    type ConcernVerdict,
    type ProofConcern,
    type RegionSample,
  } from '../color/concern';

  type Mode = 'sample' | 'point' | 'rect';
  let { app, mode = $bindable<Mode>('sample') }: { app: AppState; mode?: Mode } = $props();
  const s = app.state;
  let expandedHistoryId = $state<string | null>(null);

  const verdicts: ConcernVerdict[] = ['pending', 'pass', 'warn', 'fail'];

  const live = $derived(app.liveCondition());
  const liveKey = $derived(live ? conditionKey(live) : '');

  function versionMatches(c: ProofConcern): boolean {
    return !!liveKey && conditionKey(latestVersion(c).condition) === liveKey;
  }

  function setMode(m: Mode) {
    mode = m;
  }

  function fmtCond(v: ReturnType<typeof latestVersion>): string {
    const c = v.condition;
    return `${c.source.description} → ${c.target.description} · ${c.intent} · BPC ${c.blackPointCompensation ? '开' : '关'} · 软打样 ${c.proofIntent}`;
  }

  function shortHash(h: string): string {
    return h.slice(0, 10);
  }
</script>

<div class="panel stack concerns">
  <h2>校样关注点（绑定原图内容指纹）</h2>

  <div class="row modes">
    <button class:on={mode === 'sample'} onclick={() => setMode('sample')} title="单击画布钉选临时取样点">取样</button>
    <button class:on={mode === 'point'} onclick={() => setMode('point')} title="在原图上单击建立点关注点">＋ 点</button>
    <button class:on={mode === 'rect'} onclick={() => setMode('rect')} title="在原图上拖拽建立矩形关注点">＋ 矩形</button>
  </div>
  <div class="small muted">
    {#if mode === 'sample'}
      单击任一画布钉选临时取样点（不保存）。
    {:else if mode === 'point'}
      <span class="warn">点模式：</span>在原图/预览上单击，即按该原图坐标建立关注点并取样。
    {:else}
      <span class="warn">矩形模式：</span>在画布上按住拖拽，四角+中心将一并取样。
    {/if}
  </div>

  {#if !app.canCreateConcern()}
    <div class="small muted">导入原图并确定源/目标配置后可建立关注点。</div>
  {/if}
  {#if s.imageFingerprint}
    <div class="small mono muted" title="原图原始字节 FNV-1a64 + 尺寸">
      原图指纹 <code>{shortHash(s.imageFingerprint)}</code>
    </div>
  {/if}

  {#if s.quarantinedConcerns.length > 0}
    <div class="quar small">
      ⚠ {s.quarantinedConcerns.length} 个关注点来自内容指纹不匹配的旧原图，已隔离、不会套用：
      {#each s.quarantinedConcerns as q (q.id)}
        <span class="qrow">
          {q.label || shapeLabel(q.shape)}（指纹 {shortHash(q.imageFingerprint)}）
          <button class="ghost small danger" onclick={() => app.removeConcern(q.id)}>清除</button>
        </span>
      {/each}
    </div>
  {/if}

  {#if s.concerns.length === 0}
    <div class="small muted">尚无关注点。客户关心的品牌色、透明边缘可建为点或矩形长期保留。</div>
  {:else}
    <div class="clist scroll">
      {#each s.concerns as c, idx (c.id)}
        {@const v = latestVersion(c)}
        {@const current = versionMatches(c)}
        {@const sel = s.selectedConcernId === c.id}
        {@const open = expandedHistoryId === c.id}
        <div
          class="concern {sel ? 'sel' : ''}"
          role="button"
          tabindex="0"
          onclick={() => app.selectConcern(c.id)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              app.selectConcern(c.id);
            }
          }}
        >
          <div class="row spread">
            <div class="small">
              <strong>{c.label || `关注点 #${idx + 1}`}</strong>
              <div class="muted mono">{shapeLabel(c.shape)}</div>
            </div>
            <span class={`vbadge v-${v.verdict}`}>{app.VERDICT_LABEL[v.verdict]}</span>
          </div>

          {#if v.status === 'sampling'}
            <div class="small muted">取样中…（第 {v.index} 版）</div>
          {:else if v.status === 'interrupted'}
            <div class="small warn">该版本取样未返回即被中断（历史保留）。</div>
          {:else if v.status === 'error'}
            <div class="small danger">取样失败：{v.error}</div>
          {:else if v.stats}
            <div class="small de-row">
              ΔE00 均值 <strong>{v.stats.deltaEMean.toFixed(2)}</strong>
              · 最大 {v.stats.deltaEMax.toFixed(2)} · 最小 {v.stats.deltaEMin.toFixed(2)}
              · α {v.stats.alphaMin}{v.stats.alphaMax !== v.stats.alphaMin ? `–${v.stats.alphaMax}` : ''}/255
            </div>
          {/if}

          {#if !current}
            <div class="histwarn small">
              ⏳ 打样条件已改变——本判定是<span class="warn">历史版本（v{v.index}）</span>，不会冒充当前结果。
              <button
                class="small primary"
                onclick={() => app.recheckConcern(c.id)}
              >
                按当前条件复核（新建版本）
              </button>
            </div>
          {:else}
            <div class="small ok">当前版本 v{v.index}，与现行打样条件一致。</div>
          {/if}

          <div class="row verdict-row">
            {#each verdicts as vd}
              <button class="vbtn v-{vd} {v.verdict === vd ? 'on' : ''} {current ? '' : 'locked'}"
                disabled={!current}
                title={current ? app.VERDICT_LABEL[vd] : '条件已变更：请先创建复核版本'}
                onclick={() => app.setConcernVerdict(c.id, vd)}
              >
                {app.VERDICT_LABEL[vd]}
              </button>
            {/each}
          </div>

          <div>
            <input
              type="text"
              class="note"
              placeholder={current ? '备注：客户关注、批次、判定依据…' : '历史版本备注不可改；请先复核'}
              value={v.note}
              disabled={!current}
              oninput={(e) => app.setConcernNote(c.id, (e.currentTarget as HTMLInputElement).value)}
            />
            <input
              type="text"
              class="small-label"
              placeholder="关注点名称（可选，如：品牌红 / 透明边缘）"
              value={c.label}
              oninput={(e) => app.setConcernLabel(c.id, (e.currentTarget as HTMLInputElement).value)}
            />
          </div>

          <div class="row spread foot">
            <button class="ghost small" onclick={() => (expandedHistoryId = open ? null : c.id)}>
              {open ? '收起历史' : `历史版本（${c.versions.length}）`}
            </button>
            <div class="row">
              <button class="ghost small" onclick={() => app.recheckConcern(c.id)} title="按当前条件再取一次并新建版本">
                复核
              </button>
              <button class="ghost small danger" onclick={() => app.removeConcern(c.id)}>删除</button>
            </div>
          </div>

          {#if open}
            <div class="history">
              {#each [...c.versions].reverse() as hv (hv.id)}
                <div class="hver {hv.id === v.id ? 'latest' : 'old'}">
                  <div class="row spread">
                    <strong>v{hv.index}</strong>
                    <span class={`vbadge v-${hv.verdict}`}>{app.VERDICT_LABEL[hv.verdict]}</span>
                  </div>
                  <div class="small muted">{new Date(hv.createdAt).toLocaleString()}{hv.basedOnVersionId ? ' · 复核自主上一版' : ''}</div>
                  <div class="small mono cond">{fmtCond(hv)}</div>
                  <div class="small muted">
                    源 {hv.condition.source.origin} · 源哈希 {shortHash(hv.condition.source.byteHash)} ·
                    目标哈希 {shortHash(hv.condition.target.byteHash)}
                    {hv.condition.sourceAssumed ? ' · 源为假设' : ''}
                  </div>
                  {#if hv.status === 'ok' && hv.stats}
                    <div class="small">ΔE 均值 {hv.stats.deltaEMean.toFixed(2)} / 最大 {hv.stats.deltaEMax.toFixed(2)}</div>
                    <div class="samples small mono">
                      {#each hv.samples as sm (sm.x + '-' + sm.y)}
                        {@render sampleChip(sm)}
                      {/each}
                    </div>
                  {:else if hv.status === 'sampling'}
                    <div class="small muted">取样中…</div>
                  {:else if hv.status === 'interrupted'}
                    <div class="small warn">取样中断（结果未返回）</div>
                  {:else}
                    <div class="small danger">取样失败：{hv.error}</div>
                  {/if}
                  {#if hv.note}<div class="small note-old">备注：{hv.note}</div>{/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

{#snippet sampleChip(sm: RegionSample)}
  <span title={`(${sm.x},${sm.y}) 源 Lab ${sm.sourceLab.map((n) => n.toFixed(1)).join(',')} → 目标 ${sm.targetLab.map((n) => n.toFixed(1)).join(',')}`}>
    ({sm.x},{sm.y}) ΔE {sm.deltaE.toFixed(2)} α{sm.alpha8}
  </span>
{/snippet}

<style>
  .concerns {
    gap: 8px;
  }
  .modes {
    gap: 6px;
  }
  .modes button.on {
    border-color: var(--accent);
    color: var(--accent);
  }
  .clist {
    max-height: 46vh;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .concern {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 10px;
    background: var(--panel-2);
    display: flex;
    flex-direction: column;
    gap: 6px;
    cursor: pointer;
  }
  .concern.sel {
    border-color: var(--accent);
  }
  .vbadge {
    font-size: 11px;
    padding: 1px 8px;
    border-radius: 99px;
    border: 1px solid var(--line);
    color: var(--muted);
  }
  .v-pass {
    color: var(--accent-2);
    border-color: #2f6b4c;
  }
  .v-warn {
    color: var(--warn);
    border-color: #7a5a23;
  }
  .v-fail {
    color: var(--danger);
    border-color: #7a3030;
  }
  .de-row strong {
    font-size: 14px;
  }
  .histwarn {
    border: 1px solid #7a5a2355;
    background: #7a5a2318;
    border-radius: 6px;
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    align-items: flex-start;
  }
  .verdict-row {
    gap: 4px;
  }
  .vbtn {
    font-size: 11.5px;
    padding: 3px 8px;
  }
  .vbtn.on.v-pass {
    background: #1d4d33;
    border-color: var(--accent-2);
  }
  .vbtn.on.v-warn {
    background: #4d3a1d;
    border-color: var(--warn);
  }
  .vbtn.on.v-fail {
    background: #4d2020;
    border-color: var(--danger);
  }
  .vbtn.on.v-pending {
    border-color: var(--muted);
  }
  .vbtn.locked {
    opacity: 0.45;
  }
  .note,
  .small-label {
    width: 100%;
    font-size: 12px;
  }
  .foot {
    margin-top: 2px;
  }
  .history {
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-top: 1px solid var(--line);
    padding-top: 6px;
  }
  .hver {
    border-radius: 6px;
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .hver.latest {
    background: #1c332655;
    border: 1px solid #2f6b4c55;
  }
  .hver.old {
    background: #2a241855;
    border: 1px solid #7a5a2344;
  }
  .cond {
    word-break: break-all;
  }
  .samples {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .samples span {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 0 6px;
  }
  .note-old {
    font-style: italic;
  }
  .quar {
    border: 1px dashed #7a5a23;
    border-radius: 6px;
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .qrow {
    display: flex;
    justify-content: space-between;
    gap: 6px;
    align-items: center;
  }
  code {
    font-family: var(--mono);
  }
</style>
