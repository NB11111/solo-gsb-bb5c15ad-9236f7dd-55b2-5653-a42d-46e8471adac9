/** 站位身份色板：按演唱者序号取色，用于“最近遮挡者”着色对应 */
const PALETTE = [
  '#e6194b',
  '#3cb44b',
  '#4363d8',
  '#f58231',
  '#911eb4',
  '#42d4f4',
  '#f032e6',
  '#bfef45',
  '#469990',
  '#dcbeff',
  '#9a6324',
  '#800000',
];

export function identityColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}
