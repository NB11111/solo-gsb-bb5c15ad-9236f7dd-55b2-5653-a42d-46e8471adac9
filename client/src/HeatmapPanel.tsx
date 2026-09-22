import type { HeatCandidate, HeatZone } from '../../shared/geometry';
import { HEAT_TIER_LABEL, heatSwatch } from './heatColors';

interface HeatmapPanelProps {
  zone: HeatZone;
  previewIndex: number | null;
  onPreview: (index: number | null) => void;
  onApply: (candidate: HeatCandidate) => void;
}

function fmt(n: number): string {
  return n.toFixed(2);
}

const TIERS = [0, 1, 2, 3, 4, 5] as const;

/**
 * 指挥站位热区面板：热区与候选全部来自共享几何核心 buildConductorHeatZone
 * （App 中以 useMemo 派生，任何场景编辑后立即重算）。
 * 点击候选只在舞台上预览该位置的全部视线；确认后才应用指挥位置。
 */
export function HeatmapPanel(props: HeatmapPanelProps) {
  const { zone, previewIndex } = props;

  return (
    <section className="panel heat-panel">
      <h3>🛰 指挥站位热区</h3>
      <p className="hint heat-rule">
        在舞台前方 x∈[{zone.bounds.minX}, {fmt(zone.bounds.maxX)}]、y∈[{zone.bounds.minY}, 0] 区域按{' '}
        {zone.gridStep} m 网格模拟指挥位置；分数按<b>通畅人数为主、相切人数为次</b>排列
        （退化视线计为不可用），舞台上叠加分档热区，可滚轮/滑杆缩放、拖动平移。
      </p>

      {zone.empty ? (
        <p className="heat-empty error">
          ✗ 空场景：暂无演唱者。请双击舞台空白处添加演唱者，或在工具栏载入预设；
          添加后热区与候选会立即重算。
        </p>
      ) : (
        <>
          <div className="heat-legend">
            {TIERS.map((t) => (
              <span key={t} className="heat-legend-item" title={HEAT_TIER_LABEL[t]}>
                <i className="heat-swatch" style={{ background: heatSwatch(t) }} />
                {t === 0 ? '不可用' : `${t} 档`}
              </span>
            ))}
          </div>
          <p className="heat-meta">
            共评估 {zone.spots.length} 个候选位置 × {zone.totalSingers} 名演唱者；
            以下为分数最高且彼此相距 ≥1 m 的 {zone.candidates.length} 个可用候选（至多 3 个）。
          </p>

          {zone.candidates.length === 0 ? (
            <p className="heat-empty error">
              ✗ 热区内没有可用的指挥位置：所有采样点都无人视线通畅（全部被遮挡或退化）。
              请调整站位（缩小半径、移开过近站位）后热区会立即重算。
            </p>
          ) : (
            <ul className="heat-cand-list">
              {zone.candidates.map((c, i) => (
                <li key={i} className={previewIndex === i ? 'selected' : ''}>
                  <div
                    className="heat-cand-head"
                    onClick={() => props.onPreview(previewIndex === i ? null : i)}
                    title="点击在舞台上仅预览该位置的全部视线（不移动指挥）"
                  >
                    <span className={`cand-rank rank-${i + 1}`}>{i + 1}</span>
                    <span className="heat-cand-pos">
                      指挥位 ({fmt(c.x)}, {fmt(c.y)})
                      <b className={`heat-score tier-text-${c.tier}`}>分档 {c.tier}</b>
                    </span>
                  </div>
                  <div className="heat-cand-stats">
                    <span className="hstat clear">通畅 {c.clear}</span>
                    <span className="hstat tangent">相切 {c.tangent}</span>
                    <span className="hstat blocked">遮挡 {c.blocked}</span>
                    {c.degenerate > 0 && <span className="hstat degenerate">退化 {c.degenerate}</span>}
                  </div>
                  {c.blocked > 0 && (
                    <div className="heat-cand-detail" title="该候选位置下视线被遮挡的演唱者">
                      被遮挡：
                      {c.analysis.results
                        .filter((r) => r.status === 'blocked')
                        .slice(0, 12)
                        .map((r) => r.singerName)
                        .join('、')}
                      {c.blocked > 12 ? ` 等 ${c.blocked} 人` : ''}
                    </div>
                  )}
                  {c.degenerate > 0 && (
                    <div className="heat-cand-detail" title="与该候选指挥位置重合、视线退化的演唱者">
                      退化：
                      {c.analysis.results
                        .filter((r) => r.status === 'degenerate')
                        .map((r) => r.singerName)
                        .join('、')}
                    </div>
                  )}
                  <div className="heat-cand-actions">
                    <button
                      className="link"
                      onClick={() => props.onPreview(previewIndex === i ? null : i)}
                    >
                      {previewIndex === i ? '取消视线预览' : '预览全部视线'}
                    </button>
                    <button className="cand-apply" onClick={() => props.onApply(c)}>
                      确认应用指挥位置
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {previewIndex !== null && zone.candidates[previewIndex] && (
            <div className="preview-bar">
              正在预览候选 {previewIndex + 1} 的全部视线（空心三角，真实指挥未移动）；确认无误后点
              「确认应用指挥位置」。
            </div>
          )}
        </>
      )}
    </section>
  );
}
