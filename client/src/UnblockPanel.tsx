import type { Scene, UnblockCandidate, UnblockResult } from '../../shared/geometry';

export type UnblockStatus = 'idle' | 'done' | 'stale';

export interface UnblockState {
  /** 搜索时针对的演唱者 id */
  singerId: string;
  /** 搜索时场景的版本号（场景每变一次 +1），用于判定结果是否过期 */
  sceneVersion: number;
  status: UnblockStatus;
  result: UnblockResult | null;
  /** 当前预览的候选序号（result.candidates 的下标）；null = 不预览 */
  previewIndex: number | null;
}

interface UnblockPanelProps {
  scene: Scene;
  selectedSingerId: string | null;
  state: UnblockState | null;
  onSearch: () => void;
  onPreview: (index: number | null) => void;
  onApply: (candidate: UnblockCandidate) => void;
}

function fmt(n: number): string {
  return n.toFixed(2);
}

/**
 * 自动解遮挡面板：只在选中演唱者时出现。
 * 候选数据全部来自共享几何核心 findUnblockCandidates（App 中以纯函数方式调用，不改场景）。
 */
export function UnblockPanel(props: UnblockPanelProps) {
  const { scene, selectedSingerId, state } = props;
  const singer = selectedSingerId ? scene.singers.find((s) => s.id === selectedSingerId) : null;

  if (!singer) return null;

  const mine = state && state.singerId === singer.id ? state : null;
  const stale = mine?.status === 'stale';
  // 过期时仍展示旧结果供参考，但不可预览/应用（见下方交互禁用）
  const result = mine ? mine.result : null;
  const previewIndex = !stale && mine?.status === 'done' ? mine.previewIndex : null;

  return (
    <section className="panel unblock">
      <h3>🎯 自动解遮挡（{singer.name}）</h3>
      <p className="hint unblock-rule">
        在舞台内按 0.5 m 网格采样并细化，只移动 <b>{singer.name}</b> 一人；候选须满足视线不被侵入、
        与他人圆心距 ≥ 两半径之和、整圆留在舞台内。
      </p>
      <button
        className="unblock-search"
        onClick={() => {
          props.onPreview(null);
          props.onSearch();
        }}
      >
        {result ? '重新搜索最小位移候选' : '搜索解遮挡位置'}
      </button>

      {stale && (
        <p className="unblock-stale">
          ⚠ 场景已变化（位置/半径/指挥/人员变动），以下结果已过期，请重新搜索。
        </p>
      )}

      {result &&
        (result.error ? (
          <p className="unblock-empty error">✗ {result.error}</p>
        ) : result.alreadyClear ? (
          <p className="unblock-empty ok">✓ {singer.name} 当前位置视线已通畅，无需移动。</p>
        ) : result.candidates.length === 0 ? (
          <p className="unblock-empty error">
            ✗ 未找到可行方案：采样 {result.sampledCount} 个位置均无法同时满足三条约束
            （只允许移动 {singer.name}，其余站位保持不动）。
          </p>
        ) : (
          <>
            <p className="unblock-meta">
              采样 {result.sampledCount} 个位置，其中 {result.feasibleCount} 个可行；按位移距离排序前{' '}
              {result.candidates.length} 个：
            </p>
            <ul className="candidate-list">
              {result.candidates.map((c, i) => (
                <li
                  key={i}
                  className={previewIndex === i ? 'selected' : ''}
                  onClick={() => !stale && props.onPreview(previewIndex === i ? null : i)}
                  title={stale ? '结果已过期，请重新搜索' : '点击在舞台上预览该位置'}
                  style={stale ? { cursor: 'default', opacity: 0.6 } : undefined}
                >
                  <span className={`cand-rank rank-${i + 1}`}>{i + 1}</span>
                  <span className="cand-info">
                    位移 <b>{fmt(c.distance)}</b> m → ({fmt(c.x)}, {fmt(c.y)})
                  </span>
                  <button
                    className="cand-apply"
                    disabled={stale}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!stale) props.onApply(c);
                    }}
                  >
                    应用
                  </button>
                </li>
              ))}
            </ul>
            {previewIndex !== null && (
              <div className="preview-bar">
                正在预览候选 {previewIndex + 1}（虚线圆），满意后点「应用」；
                <button className="link" onClick={() => props.onPreview(null)}>
                  取消预览
                </button>
              </div>
            )}
          </>
        ))}

      {result && result.infeasibleSamples.length > 0 && (
        <div className="infeasible">
          <h4>距当前位置最近的不可行位置</h4>
          <ul>
            {result.infeasibleSamples.map((s, i) => (
              <li key={i}>
                <span className="infeas-pos">
                  {s.distance < 1e-6
                    ? '当前位置'
                    : `位移 ${fmt(s.distance)} m → (${fmt(s.x)}, ${fmt(s.y)})`}
                </span>
                {s.violations.slice(0, 2).map((v, j) => (
                  <span key={j} className={`violation v-${v.type}`}>
                    {v.message}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
