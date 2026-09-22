import { useMemo, useState } from 'react';
import {
  buildOcclusionGraph,
  occlusionChainFrom,
  type Analysis,
  type LOSStatus,
  type Scene,
} from '../../shared/geometry';
import { identityColor } from './colors';

interface GraphViewProps {
  scene: Scene;
  analysis: Analysis;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

const STATUS_LABEL: Record<LOSStatus, string> = {
  clear: '通畅',
  tangent: '相切',
  blocked: '被遮挡',
  degenerate: '退化',
};

/** 节点半径（舞台坐标单位，米） */
const NODE_R = 0.3;
/** 视图四周留白（米） */
const PAD = 0.9;

const edgeKey = (from: string, to: string) => `${from}>${to}`;

/**
 * 遮挡关系图谱：以当前分析构建「演唱者 → 最近遮挡者」有向图。
 * 节点按舞台站位布局（圆心重合的节点沿小圆环展开以免互相盖住），
 * 填充色表示通畅/相切/被遮挡/退化状态，描边为身份色（与舞台、侧栏一致）。
 * 选中演唱者时高亮其可达遮挡链路；循环关系以品红色标记并在标题栏列出。
 * 图谱由 analysis 派生（useMemo），场景拖动/导入/载入预设后立即重算。
 */
export function GraphView(props: GraphViewProps) {
  const { scene, analysis, selectedId, onSelect } = props;
  const [open, setOpen] = useState(true);

  const graph = useMemo(() => buildOcclusionGraph(analysis), [analysis]);
  const chain = useMemo(
    () => (selectedId ? occlusionChainFrom(graph, selectedId) : null),
    [graph, selectedId],
  );

  // 节点布局：默认取舞台坐标；圆心重合的一组节点沿小圆环展开
  const positions = useMemo(() => {
    const groups = new Map<string, Scene['singers']>();
    for (const s of scene.singers) {
      const key = `${Math.round(s.x * 1e6)}|${Math.round(s.y * 1e6)}`;
      const g = groups.get(key);
      if (g) g.push(s);
      else groups.set(key, [s]);
    }
    const pos = new Map<string, { x: number; y: number }>();
    for (const g of groups.values()) {
      if (g.length === 1) {
        pos.set(g[0].id, { x: g[0].x, y: g[0].y });
      } else {
        const k = g.length;
        // 环半径保证相邻节点不重叠（弦长 ≥ 2R），并限制最大展开范围
        const ring = Math.min(1.2, k <= 2 ? 0.4 : NODE_R / Math.sin(Math.PI / k) + 0.08);
        g.forEach((s, i) => {
          const a = (2 * Math.PI * i) / k - Math.PI / 2;
          pos.set(s.id, { x: s.x + ring * Math.cos(a), y: s.y + ring * Math.sin(a) });
        });
      }
    }
    return pos;
  }, [scene.singers]);

  // 视野：舞台矩形 ∪ 全部节点（含导入时可能位于舞台外的站位）
  const vb = useMemo(() => {
    let minX = 0;
    let minY = 0;
    let maxX = scene.stage.width;
    let maxY = scene.stage.depth;
    for (const p of positions.values()) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    return { x: minX - PAD, y: minY - PAD, w: maxX - minX + 2 * PAD, h: maxY - minY + 2 * PAD };
  }, [positions, scene.stage]);

  const nameOf = useMemo(
    () => new Map(graph.nodes.map((n) => [n.singerId, n.name])),
    [graph],
  );
  const outEdge = useMemo(() => new Map(graph.edges.map((e) => [e.from, e])), [graph]);

  // 高亮集合：选中者的可达链路 + 全图循环
  const chainNodes = new Set(chain?.nodes ?? []);
  const chainEdges = new Set((chain?.edges ?? []).map(([a, b]) => edgeKey(a, b)));
  const cycleNodes = new Set(graph.cycles.flat());
  const cycleEdges = new Set<string>();
  for (const cyc of graph.cycles) {
    for (let i = 0; i < cyc.length; i++) cycleEdges.add(edgeKey(cyc[i], cyc[(i + 1) % cyc.length]));
  }
  // 有有效链路时淡化其余元素，让可达链路突出
  const dimOthers = chainNodes.size > 0;

  return (
    <div className="graph-panel">
      <div className="graph-header">
        <h3>🕸 遮挡关系图谱</h3>
        <span className="graph-meta">
          {graph.edges.length} 条遮挡边
          {graph.cycles.length > 0 && (
            <b className="graph-meta-cycle"> · {graph.cycles.length} 个循环</b>
          )}
        </span>
        {graph.cycles.map((cyc, i) => (
          <span key={i} className="graph-cycle-tag" title="循环：互相成为对方链路上的最近遮挡者">
            循环 {[...cyc, cyc[0]].map((id) => nameOf.get(id) ?? id).join(' → ')}
          </span>
        ))}
        <span className="graph-legend">
          <i className="gdot st-clear" /> 通畅
          <i className="gdot st-tangent" /> 相切
          <i className="gdot st-blocked" /> 被遮挡
          <i className="gdot st-degenerate" /> 退化
        </span>
        <button className="graph-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? '收起 ▾' : '展开 ▴'}
        </button>
      </div>
      {open && (
        <div className="graph-body">
          {scene.singers.length === 0 ? (
            <p className="hint">暂无演唱者：双击舞台空白处或点「添加演唱者」后，图谱会自动出现。</p>
          ) : (
            <svg
              className="graph"
              viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
              preserveAspectRatio="xMidYMid meet"
              onClick={() => onSelect(null)}
            >
              <defs>
                <marker
                  id="g-arrow"
                  markerUnits="userSpaceOnUse"
                  markerWidth="0.24"
                  markerHeight="0.24"
                  refX="0.21"
                  refY="0.12"
                  orient="auto"
                >
                  <path d="M0,0 L0.24,0.12 L0,0.24 z" className="g-arrow-head" />
                </marker>
                <marker
                  id="g-arrow-chain"
                  markerUnits="userSpaceOnUse"
                  markerWidth="0.24"
                  markerHeight="0.24"
                  refX="0.21"
                  refY="0.12"
                  orient="auto"
                >
                  <path d="M0,0 L0.24,0.12 L0,0.24 z" className="g-arrow-head chain" />
                </marker>
                <marker
                  id="g-arrow-cycle"
                  markerUnits="userSpaceOnUse"
                  markerWidth="0.24"
                  markerHeight="0.24"
                  refX="0.21"
                  refY="0.12"
                  orient="auto"
                >
                  <path d="M0,0 L0.24,0.12 L0,0.24 z" className="g-arrow-head cycle" />
                </marker>
              </defs>

              {/* 有向边：被遮挡者 → 最近遮挡者 */}
              {graph.edges.map((e) => {
                const p1 = positions.get(e.from);
                const p2 = positions.get(e.to);
                if (!p1 || !p2) return null;
                const dx = p2.x - p1.x;
                const dy = p2.y - p1.y;
                const len = Math.hypot(dx, dy);
                if (len < 1e-9) return null;
                const ux = dx / len;
                const uy = dy / len;
                const isCycle = cycleEdges.has(edgeKey(e.from, e.to));
                const isChain = chainEdges.has(edgeKey(e.from, e.to));
                const cls = [
                  'gedge',
                  isCycle ? 'cycle' : '',
                  isChain ? 'chain' : '',
                  dimOthers && !isChain ? 'dimmed' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                const marker = isCycle
                  ? 'url(#g-arrow-cycle)'
                  : isChain
                    ? 'url(#g-arrow-chain)'
                    : 'url(#g-arrow)';
                return (
                  <line
                    key={edgeKey(e.from, e.to)}
                    x1={p1.x + ux * (NODE_R + 0.05)}
                    y1={p1.y + uy * (NODE_R + 0.05)}
                    x2={p2.x - ux * (NODE_R + 0.18)}
                    y2={p2.y - uy * (NODE_R + 0.18)}
                    className={cls}
                    markerEnd={marker}
                  >
                    <title>
                      {`${nameOf.get(e.from) ?? e.from} → ${nameOf.get(e.to) ?? e.to}` +
                        `（沿视线 ${e.distance.toFixed(2)} m 处进入）`}
                    </title>
                  </line>
                );
              })}

              {/* 节点：填充色 = 视线状态，描边 = 身份色 */}
              {graph.nodes.map((n) => {
                const p = positions.get(n.singerId);
                if (!p) return null;
                const idx = scene.singers.findIndex((s) => s.id === n.singerId);
                const selected = n.singerId === selectedId;
                const inChain = chainNodes.has(n.singerId);
                const inCycle = cycleNodes.has(n.singerId);
                const out = outEdge.get(n.singerId);
                const cls = [
                  'gnode',
                  selected ? 'selected' : '',
                  inChain ? 'chain' : '',
                  dimOthers && !inChain ? 'dimmed' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <g
                    key={n.singerId}
                    className={cls}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onSelect(n.singerId);
                    }}
                  >
                    <title>
                      {`${n.name}：${STATUS_LABEL[n.status]}` +
                        (out ? `，最近遮挡者 ${nameOf.get(out.to) ?? out.to}` : '') +
                        (inCycle ? '（位于遮挡循环中）' : '')}
                    </title>
                    {inCycle && (
                      <circle cx={p.x} cy={p.y} r={NODE_R + 0.13} className="gnode-cycle-ring" />
                    )}
                    {selected && (
                      <circle cx={p.x} cy={p.y} r={NODE_R + 0.07} className="gnode-selected-ring" />
                    )}
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={NODE_R}
                      className={`gnode-body st-${n.status}`}
                      style={{ stroke: identityColor(idx < 0 ? 0 : idx) }}
                    />
                    <text
                      x={p.x}
                      y={p.y}
                      textAnchor="middle"
                      dominantBaseline="central"
                      className="gnode-label"
                    >
                      {n.name}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
          <p className="graph-hint">
            节点位置对应舞台站位，边指向「沿视线最近的遮挡者」；点击节点联动选中舞台站位与侧栏详情，
            选中后高亮其可达遮挡链路，品红色为循环关系。
          </p>
        </div>
      )}
    </div>
  );
}
