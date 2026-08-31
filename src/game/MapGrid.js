import { CONFIG } from '../config.js';

export const WATER = 0;
export const LAND = 1;
export const NEUTRAL = 0; // owner id 0 = 중립

/** 8방향 오프셋: 0..3 직교, 4..7 대각 */
export const DX8 = [1, -1, 0, 0, 1, 1, -1, -1];
export const DY8 = [0, 0, 1, -1, 1, -1, 1, -1];
export const DX4 = [1, -1, 0, 0];
export const DY4 = [0, 0, 1, -1];

/**
 * 지도 격자.
 * 지형(물/땅)과 소유권을 분리해 보관하고, 시설과 참호를 별도 레이어로 둔다.
 * 참호는 "참호가 있는 셀"이 아니라 셀과 셀 사이 edge 에 저장한다 (인수인계 6.3).
 */
export class MapGrid {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    const n = width * height;

    this.terrain = new Uint8Array(n);   // WATER | LAND
    this.owner = new Uint16Array(n);    // 0 = 중립, 1 = 플레이어, 2+ = AI
    this.city = new Uint8Array(n);      // 1 = 도시
    this.capital = new Uint8Array(n);   // 1 = 수도
    this.fort = new Uint8Array(n);      // 1 = 방어기지

    // 참호 edge 레이어.
    // trenchV[y*W + x] : 셀 (x-1,y) 와 (x,y) 사이의 세로 edge (x = 1..W-1)
    // trenchH[y*W + x] : 셀 (x,y-1) 와 (x,y) 사이의 가로 edge (y = 1..H-1)
    this.trenchV = new Uint8Array(n);
    this.trenchH = new Uint8Array(n);
    // 렌더러가 매 프레임 전체 배열을 훑지 않도록 설치된 edge 만 따로 모아 둔다
    this.trenchEdges = [];

    this.landCells = 0;
    this.ownerVersion = 0;   // 소유권이 바뀔 때마다 증가. 국경 재계산 생략 판정에 쓴다.
    this.dirty = [];        // 렌더러가 갱신해야 할 셀 목록
    this.dirtyAll = true;
  }

  /**
   * 물 셀의 연결 성분을 한 번만 계산해 둔다.
   * 지형은 게임 중에 바뀌지 않으므로 "이 해안에서 저 해안까지 배가 갈 수 있는가"는
   * 성분 비교만으로 O(1) 에 답할 수 있다. 매번 Dijkstra 를 돌 필요가 없다.
   */
  ensureWaterComponents() {
    if (this.waterComp) return this.waterComp;
    const n = this.width * this.height;
    const comp = new Int32Array(n).fill(-1);
    const stack = new Int32Array(n);
    let next = 0;
    for (let s = 0; s < n; s++) {
      if (this.terrain[s] !== WATER || comp[s] !== -1) continue;
      const id = next++;
      let top = 0;
      stack[top++] = s; comp[s] = id;
      while (top > 0) {
        const i = stack[--top];
        const x = this.xOf(i), y = this.yOf(i);
        for (let k = 0; k < 8; k++) {
          const nx = x + DX8[k], ny = y + DY8[k];
          if (!this.inBounds(nx, ny)) continue;
          const j = this.idx(nx, ny);
          if (this.terrain[j] !== WATER || comp[j] !== -1) continue;
          // 대각으로만 이어진 물은 배가 통과할 수 없으므로 같은 성분으로 보지 않는다
          if (k >= 4 && !(this.terrain[this.idx(nx, y)] === WATER && this.terrain[this.idx(x, ny)] === WATER)) continue;
          comp[j] = id;
          stack[top++] = j;
        }
      }
    }
    this.waterComp = comp;
    this.waterCompCount = next;
    return comp;
  }

  idx(x, y) { return y * this.width + x; }
  xOf(i) { return i % this.width; }
  yOf(i) { return (i / this.width) | 0; }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.width && y < this.height; }
  isLand(i) { return this.terrain[i] === LAND; }
  isWater(i) { return this.terrain[i] === WATER; }

  markDirty(i) {
    this.dirty.push(i);
    // 국경선 렌더링 때문에 이웃도 다시 그려야 한다
    const x = this.xOf(i), y = this.yOf(i);
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (this.inBounds(nx, ny)) this.dirty.push(this.idx(nx, ny));
    }
  }

  /** 육지이며 4방향으로 물과 접한 셀인가 */
  isCoast(i) {
    if (this.terrain[i] !== LAND) return false;
    const x = this.xOf(i), y = this.yOf(i);
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      if (this.terrain[this.idx(nx, ny)] === WATER) return true;
    }
    return false;
  }

  /** 셀 i 가 4방향으로 소유자 ownerId 의 땅과 접해 있는가 */
  touchesOwner(i, ownerId) {
    const x = this.xOf(i), y = this.yOf(i);
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const j = this.idx(nx, ny);
      if (this.terrain[j] === LAND && this.owner[j] === ownerId) return true;
    }
    return false;
  }

  // ---- 참호 edge 접근 ----------------------------------------------------

  /** 셀 a 와 셀 b 사이(직교 인접)에 참호가 있는가 */
  trenchBetween(ax, ay, bx, by) {
    if (ay === by) {
      const x = Math.max(ax, bx);            // 오른쪽 셀의 x 가 edge 인덱스
      if (x <= 0 || x >= this.width) return 0;
      return this.trenchV[ay * this.width + x];
    }
    if (ax === bx) {
      const y = Math.max(ay, by);
      if (y <= 0 || y >= this.height) return 0;
      return this.trenchH[y * this.width + ax];
    }
    return 0;
  }

  /**
   * 대각 이동이 넘는 참호.
   * 대각선은 두 개의 직교 경로 중 하나를 지나므로, 두 경로의 참호 중 큰 쪽을 적용한다.
   */
  trenchDiagonal(ax, ay, bx, by) {
    const a = Math.max(
      this.trenchBetween(ax, ay, bx, ay),
      this.trenchBetween(bx, ay, bx, by)
    );
    const b = Math.max(
      this.trenchBetween(ax, ay, ax, by),
      this.trenchBetween(ax, by, bx, by)
    );
    return Math.min(a, b); // 둘 다 막혀야 실제로 막힌 것
  }

  /** 격자 꼭짓점(래티스) 좌표계에서 edge 하나를 설치 가능한지 검사 */
  canBuildEdge(edge, ownerId) {
    const { a, b } = edge;
    if (a < 0 || b < 0) return false;
    if (this.terrain[a] !== LAND || this.terrain[b] !== LAND) return false;
    return this.owner[a] === ownerId || this.owner[b] === ownerId;
  }

  /** 래티스 edge 를 실제 배열에 기록 */
  setEdge(edge) {
    if (this.hasEdge(edge)) return;
    if (edge.horizontal) this.trenchH[edge.key] = 1;
    else this.trenchV[edge.key] = 1;
    this.trenchEdges.push({ horizontal: edge.horizontal, lx: edge.lx, ly: edge.ly });
  }

  hasEdge(edge) {
    return (edge.horizontal ? this.trenchH[edge.key] : this.trenchV[edge.key]) === 1;
  }
}
