import { CONFIG } from '../config.js';
import { MapGrid, WATER, LAND, DX4, DY4 } from './MapGrid.js';
import { makeRng } from '../core/rng.js';

/** 값 노이즈용 격자 기울기 없는 단순 보간 노이즈 */
function makeValueNoise(rng, size) {
  const g = new Float32Array(size * size);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  const smooth = (t) => t * t * (3 - 2 * t);
  return function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const x0 = ((xi % size) + size) % size, x1 = (x0 + 1) % size;
    const y0 = ((yi % size) + size) % size, y1 = (y0 + 1) % size;
    const sx = smooth(xf), sy = smooth(yf);
    const n00 = g[y0 * size + x0], n10 = g[y0 * size + x1];
    const n01 = g[y1 * size + x0], n11 = g[y1 * size + x1];
    const a = n00 + (n10 - n00) * sx;
    const b = n01 + (n11 - n01) * sx;
    return a + (b - a) * sy;
  };
}

/**
 * 물/땅 두 종류만 있는 지도를 생성한다 (인수인계 2.1 : 지형은 두 개뿐).
 * fBm 노이즈 + 가장자리 감쇠로 대륙과 섬을 만들고,
 * 목표 육지 비율에 맞춰 임계값을 이분 탐색으로 맞춘다.
 */
export function generateMap(seed) {
  const cfg = CONFIG.map;
  const W = cfg.width, H = cfg.height;
  const rng = makeRng(seed);
  const noise = makeValueNoise(rng, 256);
  const map = new MapGrid(W, H);
  const field = new Float32Array(W * H);

  const cx = W / 2, cy = H / 2;
  const maxR = Math.hypot(cx, cy);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let amp = 1, freq = cfg.noiseScale, sum = 0, norm = 0;
      for (let o = 0; o < cfg.octaves; o++) {
        sum += noise(x * freq, y * freq) * amp;
        norm += amp;
        amp *= 0.5;
        freq *= 2;
      }
      let v = sum / norm;
      // 가장자리는 바다로: 중심에서 멀수록 값을 깎는다
      const d = Math.hypot(x - cx, y - cy) / maxR;
      v -= cfg.edgeFalloff * Math.max(0, d - 0.45) / 0.55;
      field[y * W + x] = v;
    }
  }

  // 목표 육지 비율에 맞는 임계값 찾기
  const sorted = Float32Array.from(field).sort();
  const threshold = sorted[Math.floor(sorted.length * (1 - cfg.landRatio))];
  for (let i = 0; i < field.length; i++) {
    map.terrain[i] = field[i] >= threshold ? LAND : WATER;
  }

  removeTinyIslands(map, cfg.minIslandCells);
  countLand(map);
  return map;
}

/** 너무 작은 육지 덩어리를 바다로 되돌린다 (시작 지점 후보 오염 방지) */
function removeTinyIslands(map, minCells) {
  const n = map.width * map.height;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const comp = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (map.terrain[s] !== LAND || seen[s]) continue;
    let top = 0, count = 0;
    stack[top++] = s; seen[s] = 1;
    while (top > 0) {
      const i = stack[--top];
      comp[count++] = i;
      const x = map.xOf(i), y = map.yOf(i);
      for (let k = 0; k < 4; k++) {
        const nx = x + DX4[k], ny = y + DY4[k];
        if (!map.inBounds(nx, ny)) continue;
        const j = map.idx(nx, ny);
        if (map.terrain[j] === LAND && !seen[j]) { seen[j] = 1; stack[top++] = j; }
      }
    }
    if (count < minCells) {
      for (let k = 0; k < count; k++) map.terrain[comp[k]] = WATER;
    }
  }
}

function countLand(map) {
  let c = 0;
  for (let i = 0; i < map.terrain.length; i++) if (map.terrain[i] === LAND) c++;
  map.landCells = c;
}

/**
 * 서로 최대한 멀리 떨어진 시작 지점을 고른다 (farthest-point sampling).
 * 바다에 바로 붙지 않은 안쪽 육지를 선호해서 시작 블롭이 잘리는 걸 줄인다.
 */
export function pickStartCells(map, count, seed) {
  const rng = makeRng(seed ^ 0x5bf03635);
  const candidates = [];
  const W = map.width, H = map.height;
  const margin = CONFIG.match.startBlobRadius + 2;
  for (let y = margin; y < H - margin; y += 2) {
    for (let x = margin; x < W - margin; x += 2) {
      const i = map.idx(x, y);
      if (map.terrain[i] !== LAND) continue;
      // 반경 안이 충분히 육지인 곳만
      let land = 0, total = 0;
      const r = CONFIG.match.startBlobRadius;
      for (let dy = -r; dy <= r; dy += 2) {
        for (let dx = -r; dx <= r; dx += 2) {
          if (dx * dx + dy * dy > r * r) continue;
          total++;
          if (map.terrain[map.idx(x + dx, y + dy)] === LAND) land++;
        }
      }
      if (land / total >= 0.8) candidates.push(i);
    }
  }
  if (candidates.length === 0) return [];

  const picked = [candidates[Math.floor(rng() * candidates.length)]];
  const dist = new Float64Array(candidates.length).fill(Infinity);
  while (picked.length < count && picked.length < candidates.length) {
    const last = picked[picked.length - 1];
    const lx = map.xOf(last), ly = map.yOf(last);
    let bestI = -1, bestD = -1;
    for (let c = 0; c < candidates.length; c++) {
      const i = candidates[c];
      const d = Math.hypot(map.xOf(i) - lx, map.yOf(i) - ly);
      if (d < dist[c]) dist[c] = d;
      if (dist[c] > bestD) { bestD = dist[c]; bestI = i; }
    }
    if (bestI < 0) break;
    picked.push(bestI);
  }
  return picked;
}
