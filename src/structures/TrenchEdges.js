import { CONFIG } from '../config.js';
import { LAND, DX4, DY4 } from '../game/MapGrid.js';

/**
 * 참호는 셀이 아니라 셀과 셀 사이의 edge 에 놓인다 (인수인계 6.3).
 *
 * 좌표계:
 *   래티스(격자 꼭짓점) 좌표 (cx, cy) 는 셀 (cx, cy) 의 좌상단 모서리다.
 *   래티스에서 가로로 한 칸 이동 = 셀 (cx, cy-1) 와 (cx, cy) 사이의 가로 edge
 *   래티스에서 세로로 한 칸 이동 = 셀 (cx-1, cy) 와 (cx, cy) 사이의 세로 edge
 *
 * 즉 플레이어가 그린 선 자체가 방벽이 되고, 그 선을 "넘는" 공격만 페널티를 받는다.
 * 셀 전체에 참호 속성을 주는 방식(1차 프로토타입의 오류)은 쓰지 않는다.
 */

/** 화면 좌표(셀 단위 실수)를 가장 가까운 래티스 꼭짓점으로 스냅 */
export function snapToLattice(map, fx, fy) {
  return {
    x: Math.max(0, Math.min(map.width, Math.round(fx))),
    y: Math.max(0, Math.min(map.height, Math.round(fy))),
  };
}

function horizontalEdge(map, cx, cy) {
  if (cy <= 0 || cy >= map.height || cx < 0 || cx >= map.width) return null;
  return {
    horizontal: true,
    key: cy * map.width + cx,
    a: (cy - 1) * map.width + cx,   // 위 셀
    b: cy * map.width + cx,         // 아래 셀
    lx: cx, ly: cy, dir: 'h',
  };
}

function verticalEdge(map, cx, cy) {
  if (cx <= 0 || cx >= map.width || cy < 0 || cy >= map.height) return null;
  return {
    horizontal: false,
    key: cy * map.width + cx,
    a: cy * map.width + (cx - 1),   // 왼 셀
    b: cy * map.width + cx,         // 오른 셀
    lx: cx, ly: cy, dir: 'v',
  };
}

/**
 * 래티스 좌표 두 점을 잇는 계단형 선을 edge 목록으로 변환한다.
 * 대각 점프 없이 단위 직교 스텝만 만들어 실제 방벽이 끊기지 않게 한다.
 */
export function traceLatticeLine(map, x0, y0, x1, y1) {
  const edges = [];
  const dx = x1 - x0, dy = y1 - y0;
  const sx = Math.sign(dx), sy = Math.sign(dy);
  const adx = Math.abs(dx), ady = Math.abs(dy);
  let x = x0, y = y0, ex = 0, ey = 0;
  const limit = CONFIG.trench.maxEdgesPerLine;

  while ((ex < adx || ey < ady) && edges.length < limit) {
    const takeX = ex < adx && (ey >= ady || (ex + 1) * ady <= (ey + 1) * adx);
    if (takeX) {
      const cx = Math.min(x, x + sx);
      const e = horizontalEdge(map, cx, y);
      if (e) edges.push(e);
      x += sx; ex++;
    } else {
      const cy = Math.min(y, y + sy);
      const e = verticalEdge(map, x, cy);
      if (e) edges.push(e);
      y += sy; ey++;
    }
  }
  return edges;
}

/**
 * 참호선 미리보기.
 * 설치 가능한 구간만 비용을 매긴다 (물을 건너거나 남의 땅으로 나가는 구간은 불가).
 */
export function planTrench(map, ownerId, from, to) {
  const raw = traceLatticeLine(map, from.x, from.y, to.x, to.y);
  const segments = [];
  let buildable = 0;
  for (const e of raw) {
    const ok = map.canBuildEdge(e, ownerId) && !map.hasEdge(e);
    const already = map.hasEdge(e);
    e.buildable = ok;
    e.already = already;
    if (ok) buildable++;
    segments.push(e);
  }
  return {
    segments,
    buildableCount: buildable,
    cost: Math.round(buildable * CONFIG.trench.costPerEdge),
  };
}

/** 계획을 실제로 설치. 지불 가능한 만큼만 짓는다. */
export function commitTrench(map, country, plan) {
  let built = 0;
  const unit = CONFIG.trench.costPerEdge;
  for (const e of plan.segments) {
    if (!e.buildable) continue;
    if (country.balance < unit) break;
    map.setEdge(e);
    country.balance -= unit;
    built++;
  }
  return built;
}

/**
 * AI 용: 지정한 셀 주변에서 자국 영토와 적/중립 영토가 맞닿은 실제 국경 edge 를 참호로 만든다.
 * 플레이어의 자유 드로잉과 같은 edge 배열을 쓴다.
 */
export function fortifyBorderAround(map, country, centerCell, radius, budgetEdges) {
  const cx = map.xOf(centerCell), cy = map.yOf(centerCell);
  const unit = CONFIG.trench.costPerEdge;
  let built = 0;
  for (let dy = -radius; dy <= radius && built < budgetEdges; dy++) {
    for (let dx = -radius; dx <= radius && built < budgetEdges; dx++) {
      const x = cx + dx, y = cy + dy;
      if (!map.inBounds(x, y)) continue;
      const i = map.idx(x, y);
      if (map.terrain[i] !== LAND || map.owner[i] !== country.id) continue;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX4[k], ny = y + DY4[k];
        if (!map.inBounds(nx, ny)) continue;
        const j = map.idx(nx, ny);
        if (map.terrain[j] !== LAND) continue;
        if (map.owner[j] === country.id) continue;
        const e = (ny === y)
          ? verticalEdge(map, Math.max(x, nx), y)
          : horizontalEdge(map, x, Math.max(y, ny));
        if (!e || map.hasEdge(e)) continue;
        if (country.balance < unit) return built;
        map.setEdge(e);
        country.balance -= unit;
        built++;
        if (built >= budgetEdges) return built;
      }
    }
  }
  return built;
}
