/// <reference lib="webworker" />
/**
 * 指挥站位热区计算 Worker。
 *
 * 热区按 0.25 m 网格逐点评估全部演唱者的视线，40 m 宽舞台 / 500 人等极端场景
 * 计算量较大，放在 Worker 中执行可保证场景拖放时主线程不卡顿。计算本身复用
 * 共享几何核心 computeConductorHeatmap，与 analyzeScene 完全同一套判定语义。
 */
import { computeConductorHeatmap, type ConductorHeatmap, type Scene } from '../../shared/geometry';

self.onmessage = (e: MessageEvent<{ seq: number; scene: Scene }>) => {
  const { seq, scene } = e.data;
  const heatmap: ConductorHeatmap = computeConductorHeatmap(scene);
  (self as unknown as Worker).postMessage({ seq, heatmap });
};
