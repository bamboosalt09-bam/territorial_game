import { MinHeap } from '../core/heap.js';
import { WATER, LAND, DX4, DY4, DX8, DY8 } from '../game/MapGrid.js';

const SQRT2 = Math.SQRT2;

/**
 * 해상 경로 탐색 (인수인계 17장).
 *
 * 핵심: 플레이어는 "목표 해안"만 고르고 출발 해안은 고르지 않는다.
 * 그래서 자국의 모든 해안에 붙은 물 셀을 동시에 출발점으로 넣는
 * multi-source Dijkstra 를 한 번만 돌린다. 그러면
 *   "가장 가까운 자국 해안" 과 "최단 해상 경로" 가 한 번에 나온다.
 * 자국 해안마다 A* 를 반복할 필요가 없다.
 */

let buf = null;
let stampCounter = 0;

function buffers(map) {
  const n = map.width * map.height;
  if (!buf || buf.n !== n) {
    buf = {
      n,
      dist: new Float64Array(n),
      parent: new Int32Array(n),
      origin: new Int32Array(n),   // 이 물 셀까지 이어진 출발 해안(육지 셀)
      stamp: new Uint32Array(n),
      heap: new MinHeap(4096),
    };
  }
  return buf;
}

/** 대각 이동이 육지 모서리를 뚫고 지나가지 않도록 검사 */
function diagonalOpen(map, x, y, nx, ny) {
  return map.terrain[map.idx(nx, y)] === WATER && map.terrain[map.idx(x, ny)] === WATER;
}

/**
 * 자국 해안에서 출발하는 multi-source Dijkstra.
 * isGoal(cell) 이 true 인 첫 물 셀에서 멈춘다.
 * 반환: { path: [물 셀...], startCoast, goalWater } 또는 null
 */
function searchFromOwnCoast(map, ownerId, isGoal) {
  const b = buffers(map);
  const stamp = ++stampCounter;
  const { dist, parent, origin } = b;
  b.heap.clear();

  const n = map.width * map.height;

  // 출발점: 자국 육지 해안 셀에 4방향으로 붙은 모든 물 셀
  let seeded = 0;
  for (let i = 0; i < n; i++) {
    if (map.terrain[i] !== LAND || map.owner[i] !== ownerId) continue;
    const x = map.xOf(i), y = map.yOf(i);
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!map.inBounds(nx, ny)) continue;
      const j = map.idx(nx, ny);
      if (map.terrain[j] !== WATER) continue;
      if (b.stamp[j] === stamp && dist[j] <= 0) continue;
      b.stamp[j] = stamp;
      dist[j] = 0;
      parent[j] = -1;
      origin[j] = i;
      b.heap.push(0, j);
      seeded++;
    }
  }
  if (seeded === 0) return null;

  while (b.heap.length > 0) {
    const d = b.heap.peekKey();
    const cur = b.heap.pop();
    if (b.stamp[cur] !== stamp || d > dist[cur] + 1e-9) continue;

    if (isGoal(cur)) {
      const path = [];
      let c = cur;
      while (c !== -1) { path.push(c); c = parent[c]; }
      path.reverse();
      return { path, startCoast: origin[cur], goalWater: cur };
    }

    const x = map.xOf(cur), y = map.yOf(cur);
    for (let k = 0; k < 8; k++) {
      const nx = x + DX8[k], ny = y + DY8[k];
      if (!map.inBounds(nx, ny)) continue;
      const j = map.idx(nx, ny);
      if (map.terrain[j] !== WATER) continue;
      const diagonal = k >= 4;
      if (diagonal && !diagonalOpen(map, x, y, nx, ny)) continue;
      const nd = d + (diagonal ? SQRT2 : 1);
      if (b.stamp[j] === stamp && dist[j] <= nd + 1e-9) continue;
      b.stamp[j] = stamp;
      dist[j] = nd;
      parent[j] = cur;
      origin[j] = origin[cur];
      b.heap.push(nd, j);
    }
  }
  return null;
}

/**
 * 목표 적 해안 셀까지의 상륙 경로.
 * 경로의 마지막 물 셀은 목표 해안과 인접한 셀이고, 그 뒤 마지막 한 걸음으로 상륙한다.
 */
export function findInvasionRoute(map, ownerId, targetLandCell) {
  if (map.terrain[targetLandCell] !== LAND) return null;
  const tx = map.xOf(targetLandCell), ty = map.yOf(targetLandCell);
  const adjacent = new Set();
  for (let k = 0; k < 4; k++) {
    const nx = tx + DX4[k], ny = ty + DY4[k];
    if (!map.inBounds(nx, ny)) continue;
    const j = map.idx(nx, ny);
    if (map.terrain[j] === WATER) adjacent.add(j);
  }
  if (adjacent.size === 0) return null;   // 해안이 아님

  const res = searchFromOwnCoast(map, ownerId, (c) => adjacent.has(c));
  if (!res) return null;
  return { ...res, targetCell: targetLandCell };
}

/** 특정 물 좌표(적 함선 위치)까지의 요격 경로 */
export function findRouteToWater(map, ownerId, goalWaterCell) {
  if (map.terrain[goalWaterCell] !== WATER) return null;
  return searchFromOwnCoast(map, ownerId, (c) => c === goalWaterCell);
}

/**
 * 이미 바다에 나와 있는 함선이 다른 물 셀까지 가는 경로 (요격 재계산용).
 * 출발점이 하나뿐이므로 multi-source 판을 쓰지 않는다.
 */
export function findRouteBetweenWater(map, fromWaterCell, goalWaterCell) {
  if (map.terrain[fromWaterCell] !== WATER || map.terrain[goalWaterCell] !== WATER) return null;
  if (fromWaterCell === goalWaterCell) return { path: [fromWaterCell] };

  const b = buffers(map);
  const stamp = ++stampCounter;
  const { dist, parent } = b;
  b.heap.clear();

  b.stamp[fromWaterCell] = stamp;
  dist[fromWaterCell] = 0;
  parent[fromWaterCell] = -1;
  b.heap.push(0, fromWaterCell);

  while (b.heap.length > 0) {
    const d = b.heap.peekKey();
    const cur = b.heap.pop();
    if (b.stamp[cur] !== stamp || d > dist[cur] + 1e-9) continue;
    if (cur === goalWaterCell) {
      const path = [];
      let c = cur;
      while (c !== -1) { path.push(c); c = parent[c]; }
      path.reverse();
      return { path };
    }
    const x = map.xOf(cur), y = map.yOf(cur);
    for (let k = 0; k < 8; k++) {
      const nx = x + DX8[k], ny = y + DY8[k];
      if (!map.inBounds(nx, ny)) continue;
      const j = map.idx(nx, ny);
      if (map.terrain[j] !== WATER) continue;
      const diagonal = k >= 4;
      if (diagonal && !diagonalOpen(map, x, y, nx, ny)) continue;
      const nd = d + (diagonal ? SQRT2 : 1);
      if (b.stamp[j] === stamp && dist[j] <= nd + 1e-9) continue;
      b.stamp[j] = stamp;
      dist[j] = nd;
      parent[j] = cur;
      b.heap.push(nd, j);
    }
  }
  return null;
}

/** 목표 해안까지 해상 경로가 존재하는지만 확인 (배 버튼 활성화 판정) */
export function hasInvasionRoute(map, ownerId, targetLandCell) {
  return findInvasionRoute(map, ownerId, targetLandCell) !== null;
}
