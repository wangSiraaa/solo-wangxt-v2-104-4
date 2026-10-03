<script lang="ts">
  import type { SampleInfo } from '../color/engine';

  export interface FocusMark {
    kind: 'point' | 'rect';
    x: number;
    y: number;
    w: number;
    h: number;
    /** true when the point has no judgement under the live conditions. */
    stale: boolean;
  }

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
    hover?: { x: number; y: number } | null;
    onmove?: (x: number, y: number) => void;
    onleave?: () => void;
    onpin?: (x: number, y: number) => void;
    /** 校样关注点：建点模式与标记（坐标均为原图像素）。 */
    focusMode?: 'point' | 'rect' | null;
    focusMarks?: FocusMark[];
    onfocuspoint?: (x: number, y: number) => void;
    onfocusrect?: (x: number, y: number, w: number, h: number) => void;
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
    hover = null,
    onmove,
    onleave,
    onpin,
    focusMode = null,
    focusMarks = [],
    onfocuspoint,
    onfocusrect,
    accent = '#5aa7ff',
  }: Props = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let container = $state<HTMLDivElement | null>(null);
  let scale = $state(1);
  /** in-progress rubber band for rect focus creation, in image pixels */
  let drag = $state<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** swallow the click that follows a completed rect drag (no stray pin) */
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

  // Leaving rect mode cancels any half-drawn rubber band.
  $effect(() => {
    if (focusMode !== 'rect') drag = null;
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

  function handleClick(e: MouseEvent) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (focusMode === 'rect') return; // rect creation is pointer-driven
    const { x, y } = eventXY(e);
    if (focusMode === 'point') {
      onfocuspoint?.(x, y);
      return;
    }
    onpin?.(x, y);
  }

  function handlePointerDown(e: PointerEvent) {
    if (focusMode !== 'rect') return;
    const { x, y } = eventXY(e);
    drag = { x0: x, y0: y, x1: x, y1: y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function handlePointerMove(e: PointerEvent) {
    if (drag) {
      const { x, y } = eventXY(e);
      drag = { ...drag, x1: x, y1: y };
    }
  }

  function handlePointerUp(e: PointerEvent) {
    if (!drag) return;
    const d = drag;
    drag = null;
    suppressClick = true;
    const x = Math.min(d.x0, d.x1);
    const y = Math.min(d.y0, d.y1);
    const w = Math.abs(d.x1 - d.x0) + 1;
    const h = Math.abs(d.y1 - d.y0) + 1;
    onfocusrect?.(x, y, w, h);
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
        class:arming={!!focusMode}
        onmousemove={(e) => onmove?.(eventXY(e).x, eventXY(e).y)}
        onmouseleave={() => onleave?.()}
        onclick={handleClick}
        onpointerdown={handlePointerDown}
        onpointermove={handlePointerMove}
        onpointerup={handlePointerUp}
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
      {#each focusMarks as m}
        {#if m.kind === 'rect'}
          <div
            class="mark focusRect"
            class:stale={m.stale}
            style={`left:${m.x * scale}px;top:${m.y * scale}px;width:${m.w * scale}px;height:${m.h * scale}px`}
          ></div>
        {:else}
          <div
            class="mark focusDot"
            class:stale={m.stale}
            style={`left:${(m.x + 0.5) * scale}px;top:${(m.y + 0.5) * scale}px`}
          ></div>
        {/if}
      {/each}
      {#if drag}
        {@const rx = Math.min(drag.x0, drag.x1)}
        {@const ry = Math.min(drag.y0, drag.y1)}
        {@const rw = Math.abs(drag.x1 - drag.x0) + 1}
        {@const rh = Math.abs(drag.y1 - drag.y0) + 1}
        <div
          class="mark focusRect dragging"
          style={`left:${rx * scale}px;top:${ry * scale}px;width:${rw * scale}px;height:${rh * scale}px`}
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
  canvas.arming {
    cursor: copy;
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
  /* 校样关注点标记：坐标存的是原图像素，渲染时乘以当前缩放，
     因此缩放画布不会让标记漂移。 */
  .mark.focusDot {
    width: 14px;
    height: 14px;
    margin-left: -7px;
    margin-top: -7px;
    border-radius: 3px;
    border: 2px solid var(--accent-2);
    background: #35d07f33;
    transform: rotate(45deg);
  }
  .mark.focusRect {
    width: auto;
    height: auto;
    margin: 0;
    border-radius: 2px;
    border: 2px solid var(--accent-2);
    background: #35d07f18;
  }
  .mark.focusRect.dragging {
    border-style: dashed;
    background: #35d07f26;
  }
  .mark.focusDot.stale,
  .mark.focusRect.stale {
    border-color: var(--warn);
    background: #ffb45422;
  }
</style>
