import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  analyzeSinger,
  type Analysis,
  type HeatCandidate,
  type HeatZone,
  type Scene,
  type SingerLOS,
  type UnblockCandidate,
} from '../../shared/geometry';
import { identityColor } from './colors';
import { heatFill } from './heatColors';

export const CONDUCTOR_ID = '__conductor__';

/** 自动解遮挡候选的舞台预览（仅渲染数据，不写入场景） */
export interface StagePreview {
  singerId: string;
  x: number;
  y: number;
  candidates: UnblockCandidate[];
  previewIndex: number;
}

/** 指挥站位热区的舞台数据：热区本体 + 当前预览的候选序号（null = 不预览） */
export interface StageHeat {
  zone: HeatZone;
  previewIndex: number | null;
}

interface StageProps {
  scene: Scene;
  analysis: Analysis;
  selectedId: string | null;
  preview: StagePreview | null;
  heat: StageHeat | null;
  onSelect: (id: string | null) => void;
  onMoveSinger: (id: string, x: number, y: number) => void;
  onMoveConductor: (x: number, y: number) => void;
  onAddSingerAt: (x: number, y: number) => void;
  onRadiusChange: (id: string, radius: number) => void;
  /** 点击舞台上的候选标记：null 表示取消预览 */
  onPreviewCandidate: (index: number | null) => void;
  /** 点击热区候选标记：null 表示取消预览（只预览，不移动指挥） */
  onPreviewHeatCandidate: (index: number | null) => void;
}

/** 舞台四周留白（米），y 负方向留给指挥活动区 */
const PAD = { left: 1.2, right: 1.2, top: 3.0, bottom: 1.0 };

function statusOf(results: SingerLOS[], id: string): SingerLOS | undefined {
  return results.find((r) => r.singerId === id);
}

export function Stage(props: StageProps) {
  const { scene, analysis, selectedId, heat } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const { width: W, depth: D } = scene.stage;
  const baseVb = useMemo(
    () => ({ x: -PAD.left, y: -PAD.top, w: W + PAD.left + PAD.right, h: D + PAD.top + PAD.bottom }),
    [W, D],
  );

  // ---- 热区缩放 / 平移（仅热区模式下可操作）----
  const heatMode = heat !== null;
  // 默认视图中心只依赖模式开关与舞台尺寸：拖动站位（热区重算）不应复位缩放
  const defaultCenter = useMemo(
    () => (heatMode ? { x: W / 2, y: -1.4 } : { x: W / 2, y: (D - 2.8) / 2 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [heatMode, W, D],
  );
  const [zoom, setZoom] = useState(1);
  const [center, setCenter] = useState({ ...defaultCenter });
  // 进入/退出热区或舞台尺寸变化时复位缩放（进入热区对准热区，退出回到全景）
  useEffect(() => {
    setZoom(1);
    setCenter({ ...defaultCenter });
  }, [defaultCenter]);

  const effectiveVb = useMemo(() => {
    if (zoom === 1) return baseVb;
    const cx = Math.min(baseVb.x + baseVb.w, Math.max(baseVb.x, center.x));
    const cy = Math.min(baseVb.y + baseVb.h, Math.max(baseVb.y, center.y));
    return { x: cx - baseVb.w / (2 * zoom), y: cy - baseVb.h / (2 * zoom), w: baseVb.w / zoom, h: baseVb.h / zoom };
  }, [zoom, center, baseVb]);

  // 始终把最新 viewBox/zoom/center 暴露给事件处理（指针坐标换算、滚轮缩放锚点）
  const vbRef = useRef(effectiveVb);
  vbRef.current = effectiveVb;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const centerRef = useRef(center);
  centerRef.current = center;

  const zoomAt = useCallback(
    (factor: number, anchorClientX?: number, anchorClientY?: number) => {
      const svg = svgRef.current;
      if (!svg) return;
      const vb = vbRef.current;
      const z = zoomRef.current;
      const rect = svg.getBoundingClientRect();
      const ax = anchorClientX ?? rect.left + rect.width / 2;
      const ay = anchorClientY ?? rect.top + rect.height / 2;
      // 锚点对应的舞台坐标（缩放前后保持不动）
      const sx = vb.x + ((ax - rect.left) / rect.width) * vb.w;
      const sy = vb.y + ((ay - rect.top) / rect.height) * vb.h;
      const nz = Math.min(3, Math.max(1, Number((z * factor).toFixed(3))));
      if (nz === z) return;
      const nvb = { w: baseVb.w / nz, h: baseVb.h / nz };
      const nx = sx - ((ax - rect.left) / rect.width) * nvb.w;
      const ny = sy - ((ay - rect.top) / rect.height) * nvb.h;
      setCenter({
        x: Math.min(baseVb.x + baseVb.w - nvb.w / 2, Math.max(baseVb.x + nvb.w / 2, nx + nvb.w / 2)),
        y: Math.min(baseVb.y + baseVb.h - nvb.h / 2, Math.max(baseVb.y + nvb.h / 2, ny + nvb.h / 2)),
      });
      setZoom(nz);
    },
    [baseVb],
  );

  /** 直接设置缩放倍率（滑杆），以视图中心为锚点 */
  const setZoomLevel = useCallback(
    (nz: number) => {
      const z = zoomRef.current;
      if (Math.abs(nz - z) < 1e-9) return;
      zoomAt(nz / z);
    },
    [zoomAt],
  );

  const resetView = useCallback(() => {
    setZoom(1);
    setCenter({ ...defaultCenter });
  }, [defaultCenter]);

  const toSceneCoords = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg) return { x: 0, y: 0 };
      const rect = svg.getBoundingClientRect();
      const vb = vbRef.current;
      return {
        x: vb.x + ((clientX - rect.left) / rect.width) * vb.w,
        y: vb.y + ((clientY - rect.top) / rect.height) * vb.h,
      };
    },
    [],
  );

  const clampSinger = useCallback(
    (x: number, y: number) => ({
      x: Math.min(W, Math.max(0, x)),
      y: Math.min(D, Math.max(0, y)),
    }),
    [W, D],
  );
  const clampConductor = useCallback(
    (x: number, y: number) => ({
      x: Math.min(W + 1, Math.max(-1, x)),
      y: Math.min(D + 0.5, Math.max(-2.8, y)),
    }),
    [W, D],
  );

  // ---- 拖放（站位/指挥）与热区平移 ----
  const panRef = useRef<{ startX: number; startY: number; cx: number; cy: number; moved: boolean } | null>(null);
  // 平移手势结束后抑制随之触发的 click，避免误取消选中
  const suppressClickRef = useRef(false);

  const onPointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = toSceneCoords(e.clientX, e.clientY);
    const obj =
      id === CONDUCTOR_ID ? scene.conductor : scene.singers.find((s) => s.id === id);
    if (!obj) return;
    dragRef.current = { id, dx: obj.x - p.x, dy: obj.y - p.y };
    props.onSelect(id);
  };

  const onBackgroundPointerDown = (e: React.PointerEvent) => {
    if (heatMode && zoomRef.current > 1) {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      const c = centerRef.current;
      panRef.current = { startX: e.clientX, startY: e.clientY, cx: c.x, cy: c.y, moved: false };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (drag) {
      const p = toSceneCoords(e.clientX, e.clientY);
      const x = p.x + drag.dx;
      const y = p.y + drag.dy;
      if (drag.id === CONDUCTOR_ID) {
        const c = clampConductor(x, y);
        props.onMoveConductor(c.x, c.y);
      } else {
        const c = clampSinger(x, y);
        props.onMoveSinger(drag.id, c.x, c.y);
      }
      return;
    }
    const pan = panRef.current;
    if (pan) {
      const svg = svgRef.current;
      if (svg) {
        const rect = svg.getBoundingClientRect();
        const vb = vbRef.current;
        const dxScene = ((e.clientX - pan.startX) / rect.width) * vb.w;
        const dyScene = ((e.clientY - pan.startY) / rect.height) * vb.h;
        if (Math.hypot(e.clientX - pan.startX, e.clientY - pan.startY) > 3) pan.moved = true;
        const nx = pan.cx - dxScene;
        const ny = pan.cy - dyScene;
        setCenter({
          x: Math.min(baseVb.x + baseVb.w - vb.w / 2, Math.max(baseVb.x + vb.w / 2, nx)),
          y: Math.min(baseVb.y + baseVb.h - vb.h / 2, Math.max(baseVb.y + vb.h / 2, ny)),
        });
      }
    }
  };

  const onPointerUp = (_e?: React.PointerEvent) => {
    // 背景抬手（站位/指挥/候选的 pointerdown 均 stopPropagation，不会走到这里）：
    // - 发生过平移：抑制随后的 click，避免误取消选中；
    // - 普通点击空白：直接取消选中（比 click 更可靠，指针捕获下也生效）。
    if (panRef.current) {
      suppressClickRef.current = panRef.current.moved;
    } else {
      props.onSelect(null);
    }
    dragRef.current = null;
    panRef.current = null;
  };

  /** 指针离开舞台：仅在正在拖动/平移时结束手势，避免悬停移出误取消选中 */
  const onPointerLeaveOrUp = (e: React.PointerEvent) => {
    if (dragRef.current || panRef.current) onPointerUp(e);
  };

  // ---- 滚轮：普通模式调站位半径；热区模式缩放热区 ----
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (e: WheelEvent) => {
      if (heatMode) {
        e.preventDefault();
        zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX, e.clientY);
        return;
      }
      const target = (e.target as Element).closest?.('[data-singer-id]');
      if (!target) return;
      e.preventDefault();
      const id = target.getAttribute('data-singer-id')!;
      const singer = props.scene.singers.find((s) => s.id === id);
      if (!singer) return;
      const delta = e.deltaY < 0 ? 0.02 : -0.02;
      const r = Math.min(1.0, Math.max(0.1, singer.radius + delta));
      props.onRadiusChange(id, Number(r.toFixed(2)));
    };
    svg.addEventListener('wheel', handler, { passive: false });
    return () => svg.removeEventListener('wheel', handler);
  }, [props, heatMode, zoomAt]);

  const gridLines = useMemo(() => {
    const lines: React.ReactElement[] = [];
    for (let x = 0; x <= W; x += 1) {
      lines.push(<line key={`v${x}`} x1={x} y1={0} x2={x} y2={D} className="grid" />);
    }
    for (let y = 0; y <= D; y += 1) {
      lines.push(<line key={`h${y}`} x1={0} y1={y} x2={W} y2={y} className="grid" />);
    }
    return lines;
  }, [W, D]);

  const colorOf = useCallback(
    (singerId: string) => {
      const idx = scene.singers.findIndex((s) => s.id === singerId);
      return identityColor(idx < 0 ? 0 : idx);
    },
    [scene.singers],
  );

  const conductor = scene.conductor;

  // 自动解遮挡：被预览的演唱者及其预览位置
  const previewSinger = props.preview
    ? scene.singers.find((s) => s.id === props.preview!.singerId)
    : undefined;
  const pv = props.preview && previewSinger ? props.preview : null;

  // 预览位置的视线（基于“只移动该演唱者”的临时场景计算，其余人不变）
  const pvLOS = useMemo(() => {
    if (!pv || !previewSinger) return null;
    const moved = { ...previewSinger, x: pv.x, y: pv.y };
    const others = scene.singers.filter((s) => s.id !== previewSinger.id);
    return { moved, los: analyzeSinger(scene.conductor, moved, [moved, ...others]) };
  }, [pv, previewSinger, scene]);

  // ---- 热区渲染 ----
  const heatPreview: HeatCandidate | null =
    heat && heat.previewIndex !== null ? (heat.zone.candidates[heat.previewIndex] ?? null) : null;
  // 预览候选时，用候选点的完整分析替代真实分析渲染全部视线（指挥不移动）
  const shownAnalysis = heatPreview ? heatPreview.analysis : analysis;
  const shownConductor = heatPreview ? { x: heatPreview.x, y: heatPreview.y } : conductor;
  const cell = heat ? heat.zone.gridStep : 0;

  return (
    <div
      className={`stage-canvas ${heatMode ? 'heat-mode' : ''} ${heatMode && zoom > 1 ? 'pannable' : ''}`}
    >
      <svg
        ref={svgRef}
        className="stage"
        viewBox={`${effectiveVb.x} ${effectiveVb.y} ${effectiveVb.w} ${effectiveVb.h}`}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeaveOrUp}
        onClick={() => {
          // 平移后的 click 被抑制；站位/指挥/候选已 stopPropagation
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          props.onSelect(null);
        }}
        onDoubleClick={(e) => {
          // 双击空白处才添加；落在站位圆/指挥/候选标记上时忽略
          if ((e.target as Element).closest?.('[data-singer-id], .conductor, .cand-marker, .heat-cand, .preview')) return;
          const p = toSceneCoords(e.clientX, e.clientY);
          const c = clampSinger(p.x, p.y);
          props.onAddSingerAt(Number(c.x.toFixed(2)), Number(c.y.toFixed(2)));
        }}
      >
        {/* 舞台区域与网格 */}
        <rect x={baseVb.x} y={baseVb.y} width={baseVb.w} height={baseVb.h} className="stage-bg" />
        <rect x={0} y={0} width={W} height={D} className="stage-floor" />
        {gridLines}
        <line x1={0} y1={0} x2={W} y2={0} className="stage-front" />
        <text x={0.1} y={-0.15} className="stage-label">
          舞台前沿（指挥区 y&lt;0）
        </text>
        <text x={W - 0.1} y={D - 0.15} className="stage-label" textAnchor="end">
          {W}m × {D}m · 双击空白处添加演唱者 · 滚轮调整半径
        </text>

        {/* 指挥站位热区：采样分档色块（点不中、不拦截任何交互） */}
        {heat && !heat.zone.empty && (
          <g className="heat-cells" pointerEvents="none">
            {heat.zone.spots.map((sp, i) => {
              const active = heatPreview && sp.x === heatPreview.x && sp.y === heatPreview.y;
              return (
                <rect
                  key={i}
                  x={sp.x - cell / 2}
                  y={sp.y - cell / 2}
                  width={cell + 0.004}
                  height={cell + 0.004}
                  className={`heat-cell tier-${sp.tier} ${active ? 'active' : ''}`}
                  style={{ fill: heatFill(sp.tier) }}
                />
              );
            })}
          </g>
        )}

        {/* 热区边界 */}
        {heat && (
          <g className="heat-border" pointerEvents="none">
            <rect
              x={heat.zone.bounds.minX}
              y={heat.zone.bounds.minY}
              width={heat.zone.bounds.maxX - heat.zone.bounds.minX}
              height={heat.zone.bounds.maxY - heat.zone.bounds.minY}
              className="heat-zone-rect"
            />
            <text
              x={heat.zone.bounds.minX + 0.1}
              y={heat.zone.bounds.minY + 0.3}
              className="heat-zone-label"
            >
              指挥站位热区 · 0.25 m 网格 · x∈[{heat.zone.bounds.minX}, {heat.zone.bounds.maxX.toFixed(0)}]、y∈[{heat.zone.bounds.minY}, 0]
            </text>
          </g>
        )}

        {/* 视线线段：热区模式下仅在预览候选时显示全部视线 */}
        {(!heatMode || heatPreview) &&
          scene.singers.map((singer) => {
            const los = statusOf(shownAnalysis.results, singer.id);
            if (!los || los.status === 'degenerate') return null;
            const cls =
              los.status === 'blocked' ? 'los los-blocked' : los.status === 'tangent' ? 'los los-tangent' : 'los los-clear';
            const stroke = los.status === 'blocked' && los.nearest ? colorOf(los.nearest.blockerId) : undefined;
            return (
              <g key={`los-${singer.id}`}>
                <line
                  x1={singer.x}
                  y1={singer.y}
                  x2={shownConductor.x}
                  y2={shownConductor.y}
                  className={cls}
                  style={stroke ? { stroke } : undefined}
                />
                {/* 最近遮挡者的进入点标记 */}
                {los.nearest && (
                  <circle
                    cx={singer.x + (shownConductor.x - singer.x) * los.nearest.tEnter}
                    cy={singer.y + (shownConductor.y - singer.y) * los.nearest.tEnter}
                    r={0.07}
                    className="los-enter"
                    style={{ fill: colorOf(los.nearest.blockerId) }}
                  />
                )}
              </g>
            );
          })}

        {/* 自动解遮挡：候选位置标记（小圆点 + 排名，点击在舞台上直接切换预览） */}
        {pv &&
          pv.candidates.map((c, i) => (
            <g
              key={`cand-${i}`}
              className={`cand-marker ${i === pv.previewIndex ? 'active' : ''}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                props.onPreviewCandidate(i === pv.previewIndex ? null : i);
              }}
            >
              <circle cx={c.x} cy={c.y} r={0.14} className="cand-dot" />
              <text x={c.x} y={c.y} textAnchor="middle" dominantBaseline="central" className="cand-num">
                {i + 1}
              </text>
            </g>
          ))}

        {/* 热区候选标记（排名圆点；点击只预览全部视线，不移动指挥） */}
        {heat &&
          heat.zone.candidates.map((c, i) => (
            <g
              key={`heat-cand-${i}`}
              className={`heat-cand ${heat.previewIndex === i ? 'active' : ''}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                props.onPreviewHeatCandidate(heat.previewIndex === i ? null : i);
              }}
            >
              <circle cx={c.x} cy={c.y} r={0.19} className="heat-cand-dot" />
              <text x={c.x} y={c.y} textAnchor="middle" dominantBaseline="central" className="heat-cand-num">
                {i + 1}
              </text>
              <title>{`候选 ${i + 1}（${c.x.toFixed(2)}, ${c.y.toFixed(2)}）：通畅 ${c.clear} / 相切 ${c.tangent} / 遮挡 ${c.blocked} / 退化 ${c.degenerate}，点击预览全部视线`}</title>
            </g>
          ))}

        {/* 自动解遮挡预览：位移虚线、临时站位圆与预览视线（不写入场景） */}
        {pv && previewSinger && pvLOS && (
          <g className="preview">
            <line
              x1={previewSinger.x}
              y1={previewSinger.y}
              x2={pv.x}
              y2={pv.y}
              className="preview-move"
            />
            <line
              x1={pv.x}
              y1={pv.y}
              x2={conductor.x}
              y2={conductor.y}
              className={
                pvLOS.los.status === 'clear'
                  ? 'los los-clear preview-los'
                  : pvLOS.los.status === 'tangent'
                    ? 'los los-tangent preview-los'
                    : 'los los-blocked preview-los'
              }
            />
            <circle cx={pv.x} cy={pv.y} r={previewSinger.radius} className="preview-body" />
            <text x={pv.x} y={pv.y} textAnchor="middle" dominantBaseline="central" className="preview-label">
              {previewSinger.name}
            </text>
          </g>
        )}

        {/* 真实指挥（热区预览时淡化），与预览位置以虚线相连 */}
        {heatPreview && (
          <line
            x1={conductor.x}
            y1={conductor.y}
            x2={heatPreview.x}
            y2={heatPreview.y}
            className="heat-preview-link"
            pointerEvents="none"
          />
        )}
        <g
          className={`conductor ${selectedId === CONDUCTOR_ID ? 'selected' : ''} ${heatPreview ? 'dimmed' : ''}`}
          transform={`translate(${conductor.x} ${conductor.y})`}
          onPointerDown={(e) => onPointerDown(e, CONDUCTOR_ID)}
        >
          <circle r={0.22} className="conductor-hit" />
          <path d="M0,-0.28 L0.24,0.18 L-0.24,0.18 Z" className="conductor-body" />
          <text y={0.5} textAnchor="middle" className="conductor-label">
            指挥
          </text>
        </g>

        {/* 热区预览指挥（空心三角 + 候选排名），点不中：点击穿透到背景用于平移 */}
        {heatPreview && (
          <g
            className="heat-preview-conductor"
            transform={`translate(${heatPreview.x} ${heatPreview.y})`}
            pointerEvents="none"
          >
            <circle r={0.34} className="heat-preview-ring" />
            <path d="M0,-0.28 L0.24,0.18 L-0.24,0.18 Z" className="heat-preview-body" />
            <text y={0.56} textAnchor="middle" className="heat-preview-label">
              候选 {(heat?.previewIndex ?? 0) + 1} 预览
            </text>
          </g>
        )}

        {/* 演唱者站位圆 */}
        {scene.singers.map((singer, idx) => {
          const los = statusOf(shownAnalysis.results, singer.id);
          const idColor = identityColor(idx);
          let fill = 'rgba(34,197,94,0.35)'; // clear
          if (los?.status === 'blocked' && los.nearest) fill = colorOf(los.nearest.blockerId);
          else if (los?.status === 'tangent') fill = 'rgba(245,158,11,0.55)';
          else if (los?.status === 'degenerate') fill = 'rgba(148,163,184,0.5)';
          return (
            <g
              key={singer.id}
              data-singer-id={singer.id}
              className={`singer ${selectedId === singer.id ? 'selected' : ''}`}
              onPointerDown={(e) => onPointerDown(e, singer.id)}
            >
              <circle cx={singer.x} cy={singer.y} r={singer.radius} className="singer-hit" />
              <circle
                cx={singer.x}
                cy={singer.y}
                r={singer.radius}
                className="singer-body"
                style={{ fill, stroke: idColor }}
              />
              <text x={singer.x} y={singer.y} textAnchor="middle" dominantBaseline="central" className="singer-label">
                {singer.name}
              </text>
            </g>
          );
        })}
      </svg>

      {/* 热区模式：缩放控制 + 空场景提示 */}
      {heatMode && (
        <>
          <div className="heat-zoom">
            <button
              title="缩小"
              onClick={() => zoomAt(1 / 1.25)}
              disabled={zoom <= 1.001}
            >
              －
            </button>
            <input
              type="range"
              min={1}
              max={3}
              step={0.05}
              value={zoom}
              onChange={(e) => setZoomLevel(Number(e.target.value))}
              aria-label="热区缩放"
            />
            <button title="放大" onClick={() => zoomAt(1.25)} disabled={zoom >= 2.999}>
              ＋
            </button>
            <span className="heat-zoom-value">{zoom.toFixed(2)}×</span>
            <button className="heat-zoom-reset" title="复位到热区全景" onClick={resetView}>
              复位
            </button>
            <span className="heat-zoom-hint">{zoom > 1 ? '拖动背景平移 · 滚轮缩放' : '滚轮以光标为锚点缩放'}</span>
          </div>
          {heat.zone.empty && (
            <div className="heat-empty-overlay">
              <div className="heat-empty-card">
                <b>空场景：暂无演唱者</b>
                <span>双击舞台空白处添加演唱者，或在工具栏载入预设后，热区与候选会立即重算。</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
