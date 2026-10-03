<script lang="ts">
  import type { ProofConcern, ConcernShape } from '../color/concern';

  interface Props {
    title: string;
    subtitle?: string;
    width: number;
    height: number;
    /** raw RGBA pixels to draw */
    rgba?: Uint8Array | null;
    /** CSS color-management hint for display */
    displayMode?: 'original' | 'softproof';
    pins?: { x: number; y: number }[];
    concerns?: ProofConcern[];
    selectedConcernId?: string;
    hover?: { x: number; y: number } | null;
    /** 'sample' = 单击钉选/取样；'point' = 单击建关注点；'rect' = 拖拽建矩形关注点 */
    creationMode?: 'sample' | 'point' | 'rect';
    onmove?: (x: number, y: number) => void;
    onleave?: () => void;
    onpin?: (x: number, y: number) => void;
    onCreatePoint?: (x: number, y: number) => void;
    onCreateRect?: (x0: number, y0: number, x1: number, y1: number) => void;
    onSelectConcern?: (id: string) => void;
    accent?: string;
  }

  let {
    title,
    subtitle = '',
    width,
    height,
    rgba = null,
    displayMode = 'softproof',
    pins = [],
    concerns = [],
    selectedConcernId = '',
    hover = null,
    creationMode = 'sample',
    onmove,
    onleave,
    onpin,
    onCreatePoint,
    onCreateRect,
    onSelectConcern,
    accent = '#5aa7ff',
  }: Props = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let container = $state<HTMLDivElement | null>(null);
  let scale = $state(1);

  // 矩形拖拽（原图坐标；与缩放完全解耦）。
  let dragStart = $state<{ x: number; y: number } | null>(null);
  let dragNow = $state<{ x: number; y: number } | null>(null);
  let suppressClick = false;

  // Draw whenever pixels or size change.
  $effect(() => {
    if (!canvas) return;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (rgba) {
      const buf = new Uint8ClampedArray(rgba.byteLength);
      buf.set(rgba);
      const img = new ImageData(buf, width, height);
      ctx.putImageData(img, 0, 0);
    } else {
      ctx.clearRect(0, 0, width, height);
    }
    fit();
  });

  // Fit inside container while keeping pixel aspect 1:1.
  $effect(() => {
    if (!container) return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(container);
    return () => ro.disconnect();
  });

  function fit() {
    if (!container || !width || !height) return;
    const rect = container.getBoundingClientRect();
    scale = Math.min(rect.width / width, rect.height / height, 4);
    if (canvas) {
      canvas.style.width = `${Math.round(width * scale)}px`;
      canvas.style.height = `${Math.round(height * scale)}px`;
    }
  }

  function eventXY(e: MouseEvent): { x: number; y: number } {
    const rect = canvas!.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * width);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * height);
    return {
      x: Math.min(width - 1, Math.max(0, x)),
      y: Math.min(height - 1, Math.max(0, y)),
    };
  }

  function onClick(e: MouseEvent) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    // 矩形模式下纯点击不产生任何东西（避免误建临时取样点）。
    if (creationMode === 'rect') return;
    const { x, y } = eventXY(e);
    if (creationMode === 'point') onCreatePoint?.(x, y);
    else onpin?.(x, y);
  }

  function onDown(e: MouseEvent) {
    if (creationMode !== 'rect') return;
    e.preventDefault();
    dragStart = eventXY(e);
    dragNow = dragStart;
  }
  function onDrag(e: MouseEvent) {
    const { x, y } = eventXY(e);
    if (dragStart) {
      dragNow = { x, y };
      return; // 拖拽建矩形时不触发悬停取样
    }
    onmove?.(x, y);
  }
  function onUp() {
    if (!dragStart || !dragNow) {
      dragStart = null;
      dragNow = null;
      return;
    }
    const moved = dragStart.x !== dragNow.x || dragStart.y !== dragNow.y;
    if (moved) {
      onCreateRect?.(dragStart.x, dragStart.y, dragNow.x, dragNow.y);
      suppressClick = true;
    } else {
      // 点击而未拖出面积：不建空矩形，让 click 走 point 回调（更不令人意外）。
      suppressClick = false;
    }
    dragStart = null;
    dragNow = null;
  }

  function verdictColor(c: ProofConcern): string {
    const v = c.versions[c.versions.length - 1]?.verdict ?? 'pending';
    return v === 'pass' ? 'var(--accent-2)' : v === 'warn' ? 'var(--warn)' : v === 'fail' ? 'var(--danger)' : 'var(--muted)';
  }

  function hitConcern(x: number, y: number): ProofConcern | null {
    // 反向命中检测也在原图坐标里完成。
    for (let i = concerns.length - 1; i >= 0; i--) {
      const c = concerns[i];
      if (hitShape(c.shape, x, y)) return c;
    }
    return null;
  }

  function hitShape(sh: ConcernShape, x: number, y: number): boolean {
    if (sh.kind === 'point') return Math.abs(sh.x - x) <= 2 && Math.abs(sh.y - y) <= 2;
    return x >= sh.x0 && x <= sh.x1 && y >= sh.y0 && y <= sh.y1;
  }

  function shapeName(sh: ConcernShape): string {
    return sh.kind === 'point' ? `点 (${sh.x}, ${sh.y})` : `矩形 (${sh.x0}, ${sh.y0})–(${sh.x1}, ${sh.y1})`;
  }

  function handleClickSelect(e: MouseEvent) {
    const { x, y } = eventXY(e);
    const hit = hitConcern(x, y);
    if (hit) {
      onSelectConcern?.(hit.id);
    } else {
      onClick(e);
    }
  }
</script>

<div class="view stack">
  <div class="row spread">
    <div>
      <strong>{title}</strong>
      {#if subtitle}<span class="muted small"> · {subtitle}</span>{/if}
    </div>
    <span class="badge" class:embedded={displayMode === 'softproof'}>
      {displayMode === 'softproof' ? '软打样预览（目标→显示器模拟）' : '原图像素（嵌入/假设源配置）'}
    </span>
  </div>
  <div class="stage checker scroll" bind:this={container}>
    <div class="canvasWrap" style={`--accent:${accent}`}>
      <canvas
        bind:this={canvas}
        onmousemove={onDrag}
        onmouseleave={() => onleave?.()}
        onclick={handleClickSelect}
        onmousedown={onDown}
        onmouseup={onUp}
      ></canvas>
      {#if hover}
        <div
          class="mark hover"
          style={`left:${hover.x * scale}px;top:${hover.y * scale}px`}
        ></div>
      {/if}
      {#each pins as p}
        <div class="mark pin" style={`left:${p.x * scale}px;top:${p.y * scale}px`}></div>
      {/each}

      {#each concerns as c (c.id)}
        {@const sel = c.id === selectedConcernId}
        {#if c.shape.kind === 'point'}
          <button
            type="button"
            class="cmark cpoint {sel ? 'sel' : ''}"
            style={`left:${c.shape.x * scale}px;top:${c.shape.y * scale}px;--vc:${verdictColor(c)}`}
            title={`关注点：${c.label || shapeName(c.shape)}`}
            onclick={(e) => {
              e.stopPropagation();
              onSelectConcern?.(c.id);
            }}
          ></button>
        {:else}
          <button
            type="button"
            class="cmark crect {sel ? 'sel' : ''}"
            style={`left:${c.shape.x0 * scale}px;top:${c.shape.y0 * scale}px;width:${(c.shape.x1 - c.shape.x0 + 1) * scale}px;height:${(c.shape.y1 - c.shape.y0 + 1) * scale}px;--vc:${verdictColor(c)}`}
            title={`关注点：${c.label || shapeName(c.shape)}`}
            onclick={(e) => {
              e.stopPropagation();
              onSelectConcern?.(c.id);
            }}
          ></button>
        {/if}
      {/each}

      {#if dragStart && dragNow}
        <div
          class="dragrect"
          style={`left:${Math.min(dragStart.x, dragNow.x) * scale}px;top:${Math.min(dragStart.y, dragNow.y) * scale}px;width:${(Math.abs(dragNow.x - dragStart.x) + 1) * scale}px;height:${(Math.abs(dragNow.y - dragStart.y) + 1) * scale}px`}
        ></div>
      {/if}
    </div>
  </div>
</div>

<style>
  .view {
    min-height: 0;
    flex: 1;
  }
  .stage {
    flex: 1;
    min-height: 240px;
    border: 1px solid var(--line);
    border-radius: 8px;
    display: flex;
    align-items: flex-start;
    justify-content: flex-start;
    padding: 8px;
  }
  .canvasWrap {
    position: relative;
    line-height: 0;
  }
  canvas {
    image-rendering: pixelated;
    border: 1px solid #00000055;
    cursor: crosshair;
  }
  .mark {
    position: absolute;
    width: 12px;
    height: 12px;
    margin-left: -6px;
    margin-top: -6px;
    border-radius: 50%;
    pointer-events: none;
  }
  .mark.hover {
    border: 1.5px solid var(--accent);
  }
  .mark.pin {
    border: 2px solid var(--accent);
    background: #00000055;
  }
  .cmark {
    position: absolute;
    padding: 0;
    background: transparent;
    border: none;
    pointer-events: auto;
    cursor: pointer;
  }
  .cpoint {
    width: 14px;
    height: 14px;
    margin-left: -7px;
    margin-top: -7px;
    border-radius: 50%;
    background: #00000066;
    border: 2px solid var(--vc);
    box-shadow: 0 0 0 1px #00000088;
  }
  .crect {
    border: 2px solid var(--vc);
    background: color-mix(in srgb, var(--vc) 12%, transparent);
    box-shadow: 0 0 0 1px #00000088 inset;
  }
  .cmark.sel {
    outline: 2px solid #ffffff;
    outline-offset: 1px;
  }
  .dragrect {
    position: absolute;
    border: 1.5px dashed #ffffff;
    background: #5aa7ff22;
    pointer-events: none;
  }
</style>
