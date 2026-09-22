import type { ConductorCandidate, ConductorHeatmap, Scene } from '../../shared/geometry';

/** 正在预览的指挥候选（以坐标标识，场景编辑后按新网格重新匹配） */
export interface HeatPreview {
  x: number;
  y: number;
}

export type HeatStatus = 'computing' | 'ready';

interface HeatmapPanelProps {
  scene: Scene;
  heatmap: ConductorHeatmap | null;
  status: HeatStatus;
  /** 热区格渲染边长（米），可缩放 */
  cellSize: number;
  onCellSize: (size: number) => void;
  preview: HeatPreview | null;
  onPreview: (p: HeatPreview | null) => void;
  onApply: (c: ConductorCandidate) => void;
  onClose: () => void;
}

const BANDS = [
  { label: '优 ≥90%', cls: 'hb-4' },
  { label: '良 ≥70%', cls: 'hb-3' },
  { label: '中 ≥50%', cls: 'hb-2' },
  { label: '差 ≥30%', cls: 'hb-1' },
  { label: '不可用 <30%', cls: 'hb-0' },
];

const round2 = (n: number) => n.toFixed(2);

/**
 * 指挥站位热区面板：列出分数最高且彼此至少相距 1 m 的 3 个候选，
 * 展示每个候选的通畅/相切/遮挡/退化明细。点击候选仅预览全部视线，
 * 再点「应用」才移动指挥；场景编辑后由 App 自动触发重算。
 */
export function HeatmapPanel(props: HeatmapPanelProps) {
  const { heatmap, status, preview } = props;
  const empty = heatmap !== null && heatmap.total === 0;

  const isPreviewing = (c: ConductorCandidate) =>
    preview !== null && Math.abs(preview.x - c.x) < 1e-9 && Math.abs(preview.y - c.y) < 1e-9;

  return (
    <section className="panel heat-panel">
      <h3>
        🧭 指挥站位热区
        <button className="heat-close" onClick={props.onClose} title="退出热区模式">
          ✕
        </button>
      </h3>
      <p className="hint heat-rule">
        在舞台前方 x∈[-1, W+1]、y∈[-2.8, 0] 按 <b>0.25 m</b> 网格模拟指挥位置；分数以
        <b> 通畅人数为主、相切人数为次</b>（相切计 0.5 人，退化视线不可用）。场景编辑后立即重算。
      </p>

      <label className="heat-scale">
        热区格大小 <b>{round2(props.cellSize)} m</b>
        <input
          type="range"
          min={0.1}
          max={0.8}
          step={0.05}
          value={props.cellSize}
          onChange={(e) => props.onCellSize(Number(e.target.value))}
        />
      </label>

      {status === 'computing' && (
        <p className="heat-status">⏳ 正在按 0.25 m 网格重算热区…</p>
      )}

      {empty && (
        <p className="heat-empty">
          场景中还没有演唱者：双击舞台空白处或点「＋ 添加演唱者」后，热区与候选会立即出现。
        </p>
      )}

      {heatmap && !empty && (
        <>
          <p className="heat-meta">
            共评估 <b>{heatmap.points.length}</b> 个指挥位置 · {heatmap.total} 名演唱者 ·
            最高分 {heatmap.bestScore} 分
          </p>

          {heatmap.candidates.length === 0 ? (
            <p className="heat-empty">没有可推荐的指挥位置。</p>
          ) : (
            <ul className="heat-cand-list">
              {heatmap.candidates.map((c, i) => {
                const active = isPreviewing(c);
                return (
                  <li
                    key={`${c.x}|${c.y}`}
                    className={active ? 'selected' : ''}
                    onClick={() => props.onPreview(active ? null : { x: c.x, y: c.y })}
                    title="点击仅预览该位置的全部视线，应用需再确认"
                  >
                    <span className={`cand-rank rank-${i + 1}`}>{i + 1}</span>
                    <span className="heat-cand-info">
                      <span className="heat-cand-pos">
                        ({round2(c.x)}, {round2(c.y)}) · {c.score} 分 · 距现指挥 {round2(c.distanceToConductor)} m
                      </span>
                      <span className="heat-cand-detail">
                        <i className="hstat clear" /> {c.clear} 通畅
                        <i className="hstat tangent" /> {c.tangent} 相切
                        <i className="hstat blocked" /> {c.blocked} 遮挡
                        {c.degenerate > 0 && (
                          <>
                            <i className="hstat degenerate" /> {c.degenerate} 退化
                          </>
                        )}
                      </span>
                    </span>
                    <button
                      className="cand-apply"
                      disabled={!active}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (active) props.onApply(c);
                      }}
                      title={active ? '把指挥移动到该位置' : '请先点击候选预览'}
                    >
                      应用
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {preview && (
            <div className="preview-bar">
              正在预览 ({round2(preview.x)}, {round2(preview.y)}) 处的全部视线（指挥尚未移动）；
              <button className="link" onClick={() => props.onPreview(null)}>
                取消预览
              </button>
            </div>
          )}

          <div className="heat-legend">
            {BANDS.map((b) => (
              <span key={b.cls} className="heat-legend-item">
                <i className={`hsq ${b.cls}`} /> {b.label}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
