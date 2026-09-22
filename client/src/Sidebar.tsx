import type { Analysis, Scene, SingerLOS, UnblockCandidate } from '../../shared/geometry';
import { identityColor } from './colors';
import { CONDUCTOR_ID } from './Stage';
import { UnblockPanel, type UnblockState } from './UnblockPanel';

interface SidebarProps {
  scene: Scene;
  analysis: Analysis;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRadiusChange: (id: string, radius: number) => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  unblock: UnblockState | null;
  onUnblockSearch: () => void;
  onUnblockPreview: (index: number | null) => void;
  onUnblockApply: (candidate: UnblockCandidate) => void;
}

const STATUS_LABEL: Record<SingerLOS['status'], string> = {
  clear: '通畅',
  tangent: '相切',
  blocked: '被遮挡',
  degenerate: '退化',
};

function fmt(n: number): string {
  return n.toFixed(2);
}

export function Sidebar(props: SidebarProps) {
  const { scene, analysis, selectedId } = props;
  const { summary } = analysis;
  const selectedSinger = scene.singers.find((s) => s.id === selectedId) ?? null;
  const selectedLOS = analysis.results.find((r) => r.singerId === selectedId) ?? null;

  const colorOf = (singerId: string) => {
    const idx = scene.singers.findIndex((s) => s.id === singerId);
    return identityColor(idx < 0 ? 0 : idx);
  };

  const blocked = analysis.results.filter((r) => r.status === 'blocked');
  const tangent = analysis.results.filter((r) => r.status === 'tangent');
  const degenerate = analysis.results.filter((r) => r.status === 'degenerate');

  return (
    <aside className="sidebar">
      <section className="panel stats">
        <span className="stat clear">通畅 {summary.clear}</span>
        <span className="stat tangent">相切 {summary.tangent}</span>
        <span className="stat blocked">被遮挡 {summary.blocked}</span>
        {summary.degenerate > 0 && <span className="stat degenerate">退化 {summary.degenerate}</span>}
        <span className="stat total">共 {summary.total} 人</span>
      </section>

      {analysis.warnings.length > 0 && (
        <section className="panel warnings">
          <h3>⚠ 警告</h3>
          <ul>
            {analysis.warnings.map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel">
        <h3>选中对象</h3>
        {selectedSinger ? (
          <div className="editor">
            <label>
              名称
              <input
                value={selectedSinger.name}
                onChange={(e) => props.onRename(selectedSinger.id, e.target.value)}
                maxLength={12}
              />
            </label>
            <label>
              人体半径 <b>{fmt(selectedSinger.radius)} m</b>
              <input
                type="range"
                min={0.1}
                max={1.0}
                step={0.01}
                value={selectedSinger.radius}
                onChange={(e) => props.onRadiusChange(selectedSinger.id, Number(e.target.value))}
              />
            </label>
            <div className="editor-pos">
              位置 ({fmt(selectedSinger.x)}, {fmt(selectedSinger.y)})
            </div>
            {selectedLOS && (
              <div className={`editor-status ${selectedLOS.status}`}>
                视线：{STATUS_LABEL[selectedLOS.status]}
                {selectedLOS.nearest && `（最近遮挡者 ${selectedLOS.nearest.blockerName}）`}
              </div>
            )}
            <button className="danger" onClick={() => props.onRemove(selectedSinger.id)}>
              删除该站位
            </button>
          </div>
        ) : selectedId === CONDUCTOR_ID ? (
          <p className="hint">已选中指挥，可在舞台上拖动调整位置。</p>
        ) : (
          <p className="hint">点击舞台上的站位圆或指挥进行选择；拖动可移动，滚轮可调整半径。</p>
        )}
      </section>

      {selectedSinger && (
        <UnblockPanel
          scene={scene}
          selectedSingerId={selectedSinger.id}
          state={props.unblock}
          onSearch={props.onUnblockSearch}
          onPreview={props.onUnblockPreview}
          onApply={props.onUnblockApply}
        />
      )}

      <section className="panel">
        <h3>演唱者（{scene.singers.length}）</h3>
        <ul className="singer-list">
          {scene.singers.map((s, idx) => {
            const los = analysis.results.find((r) => r.singerId === s.id);
            return (
              <li
                key={s.id}
                className={s.id === selectedId ? 'selected' : ''}
                onClick={() => props.onSelect(s.id)}
              >
                <span className="dot" style={{ background: identityColor(idx) }} />
                <span className="name">{s.name}</span>
                <span className="radius">r={fmt(s.radius)}</span>
                {los && <span className={`badge ${los.status}`}>{STATUS_LABEL[los.status]}</span>}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="panel">
        <h3>受阻关系（{blocked.length}）</h3>
        {blocked.length === 0 && <p className="hint">当前没有被遮挡的演唱者。</p>}
        <ul className="relation-list">
          {blocked.map((r) => (
            <li key={r.singerId}>
              <b>{r.singerName}</b> → 指挥：被{' '}
              <span className="dot" style={{ background: colorOf(r.nearest!.blockerId) }} />
              <b>{r.nearest!.blockerName}</b> 遮挡（沿视线 {fmt(r.nearest!.distance)} m 处进入，
              侵入 {fmt(-r.nearest!.clearance)} m）
              {r.occlusions.filter((o) => !o.tangent).length > 1 && (
                <span className="sub">
                  其余遮挡者：
                  {r.occlusions
                    .filter((o) => !o.tangent && o.blockerId !== r.nearest!.blockerId)
                    .map((o) => o.blockerName)
                    .join('、')}
                </span>
              )}
            </li>
          ))}
        </ul>
        {tangent.length > 0 && (
          <>
            <h3>相切（擦边，{tangent.length}）</h3>
            <ul className="relation-list">
              {tangent.map((r) => (
                <li key={r.singerId}>
                  <b>{r.singerName}</b> 的视线与{' '}
                  {r.occlusions
                    .filter((o) => o.tangent)
                    .map((o) => o.blockerName)
                    .join('、')}{' '}
                  相切（擦边，不判为遮挡）
                </li>
              ))}
            </ul>
          </>
        )}
        {degenerate.length > 0 && (
          <>
            <h3>视线退化（{degenerate.length}）</h3>
            <ul className="relation-list">
              {degenerate.map((r) => (
                <li key={r.singerId}>
                  <b>{r.singerName}</b> 与指挥位置重合，视线退化为点
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="panel legend">
        <h3>图例</h3>
        <p>
          <span className="swatch clear" /> 视线通畅
          <span className="swatch tangent" /> 相切擦边
          <span className="swatch degenerate" /> 退化
        </p>
        <p>
          被遮挡者的填充色 = <b>沿视线最近的遮挡者</b>的身份色（列表与站位圆描边的彩色圆点）。
        </p>
      </section>
    </aside>
  );
}
