import type { Component } from "solid-js";

type Props = {
  size?: number;
  class?: string;
};

const DOT = 79.6723;
const COLS = [364.216, 623.72, 883.224, 1142.73, 1402.23];
const ROWS = [364.216, 621.444, 878.672, 1135.9, 1393.13, 1650.35];

const BRIGHT = "var(--nz-brand-bright, #1AD592)";
const DEEP = "var(--nz-brand-deep, #08885A)";

const PATTERN: Array<[number, number, string]> = [
  [0, 0, BRIGHT], [1, 0, BRIGHT], [2, 0, BRIGHT], [3, 0, BRIGHT], [4, 0, BRIGHT],
  [0, 1, DEEP],   [1, 1, DEEP],   [2, 1, DEEP],   [3, 1, BRIGHT], [4, 1, BRIGHT],
  [2, 2, BRIGHT], [3, 2, BRIGHT],
  [1, 3, BRIGHT], [2, 3, BRIGHT],
  [0, 4, BRIGHT], [1, 4, BRIGHT], [2, 4, DEEP],   [3, 4, DEEP],   [4, 4, DEEP],
  [0, 5, BRIGHT], [1, 5, BRIGHT], [2, 5, BRIGHT], [3, 5, BRIGHT], [4, 5, BRIGHT],
];

export const BrandMark: Component<Props> = (props) => {
  const size = () => props.size ?? 22;
  return (
    <svg
      class={`nz-brand-mark ${props.class ?? ""}`}
      width={size()}
      height={size() * (2015 / 1767)}
      viewBox="0 0 1767 2015"
      fill="none"
      aria-label="NoteZ"
      role="img"
    >
      {PATTERN.map(([cx, cy, fill]) => (
        <circle cx={COLS[cx]} cy={ROWS[cy]} r={DOT} fill={fill} />
      ))}
    </svg>
  );
};
