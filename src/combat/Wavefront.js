import { CONFIG } from '../config.js';
import { MinHeap } from '../core/heap.js';
import { hash01, hash2 } from '../core/rng.js';
import { LAND, NEUTRAL, DX4, DY4, DX8, DY8 } from '../game/MapGrid.js';

const SQRT2 = Math.SQRT2;

/**
 * 육상 공격 = 공유 국경 전체를 seed 로 하는 multi-source weighted wavefront.
 *
 * 왜 이렇게 하는가 (인수인계 8장):
 *  - 클릭 지점 하나에서 퍼지면 원/마름모가 된다. 그건 틀린 구현이다.
 *  - 두 나라가 맞닿은 국경선 "전체"가 동시에 출발선이므로, 등거리 집합은
 *    그 국경선의 offset curve 가 된다. 즉 굽은 국경은 굽은 채로 전진한다.
 *  - 참호/방어기지는 그 지점의 step 비용을 올려 그 구간만 늦게 밀리게 만든다.
 *    플레이어가 방향을 지정하지 않아도 돌출부가 자연스럽게 생긴다.
 *
 * 전투량(budget)과 전선 속도(visibleFrontSpeed)는 분리한다 (인수인계 8.8).
 * 큰 공격을 해도 영토가 순간이동하지 않는다.
 */
export class LandAttack {
  constructor(game, attackerId, defenderId, budget, seedCells = null) {
    // id 는 전선 노이즈 해시에 들어간다. 프로세스 전역 카운터를 쓰면 같은 seed 로
    // 다시 시작해도 결과가 달라지므로, 게임마다 1 부터 다시 센다.
    this.id = game.nextAttackId++;
    this.game = game;
    this.attackerId = attackerId;
    this.defenderId = defenderId;
    this.remainingBudget = budget;
    this.initialBudget = budget;
    this.status = 'active';
    this.maxDist = 0;
    this.capturedCount = 0;
    this.tickDensity = CONFIG.combat.minDefenseDensity;

    this.heap = new MinHeap(2048);
    this.bestDist = new Map();
    // 그 셀에 도달한 최선 경로가 참호선을 넘었는지. 점령 Balance 비용에 반영한다.
    this.crossedTrench = new Map();
    this.pending = [];
    this.fortCache = null;

    if (seedCells) this.seedFrom(seedCells);
    else this.seedSharedBorder();
  }

  get active() { return this.status === 'active'; }

  // ---- seed -------------------------------------------------------------

  /** 공격자와 수비자가 공유하는 모든 육상 국경 셀을 동시에 전선 시작점으로 넣는다 */
  seedSharedBorder() {
    const map = this.game.map;
    const n = map.width * map.height;
    this.refreshFortCache();
    for (let i = 0; i < n; i++) {
      if (map.terrain[i] !== LAND) continue;
      if (map.owner[i] !== this.defenderId) continue;
      if (!map.touchesOwner(i, this.attackerId)) continue;
      this.pushSeed(i);
    }
  }

  /** 상륙 교두보처럼 특정 셀 집합에서 시작하는 경우 */
  seedFrom(cells) {
    this.refreshFortCache();
    const map = this.game.map;
    for (const i of cells) {
      if (map.terrain[i] !== LAND) continue;
      if (map.owner[i] !== this.defenderId) continue;
      this.pushSeed(i);
    }
  }

  pushSeed(i) {
    const map = this.game.map;
    const x = map.xOf(i), y = map.yOf(i);
    // 국경을 넘어 들어오는 첫 걸음의 비용. 참호가 있으면 그 구간은 늦게 출발한다.
    let best = Infinity, bestTrench = 0;
    const jitter = 1 + (hash01(i * 2654435761 + this.id) - 0.5) * CONFIG.combat.frontNoise;
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!map.inBounds(nx, ny)) continue;
      const j = map.idx(nx, ny);
      if (map.terrain[j] !== LAND || map.owner[j] !== this.attackerId) continue;
      const s = this.stepCost(nx, ny, x, y, false, 1);
      const d = s.dist * jitter;
      if (d < best) { best = d; bestTrench = s.trench; }
    }
    if (best === Infinity) best = 1;
    const prev = this.bestDist.get(i);
    if (prev !== undefined && prev <= best) return;
    this.bestDist.set(i, best);
    this.crossedTrench.set(i, bestTrench);
    this.heap.push(best, i);
  }

  // ---- 비용 계산 ---------------------------------------------------------

  refreshFortCache() {
    const def = this.game.countries[this.defenderId];
    if (!def || !def.forts.length) { this.fortCache = null; return; }
    const map = this.game.map;
    const arr = new Float64Array(def.forts.length * 3);
    for (let k = 0; k < def.forts.length; k++) {
      const c = def.forts[k];
      arr[k * 3] = map.xOf(c);
      arr[k * 3 + 1] = map.yOf(c);
      arr[k * 3 + 2] = CONFIG.fort.radius * CONFIG.fort.radius;
    }
    this.fortCache = arr;
  }

  fortBonusAt(x, y) {
    const f = this.fortCache;
    if (!f) return 0;
    for (let k = 0; k < f.length; k += 3) {
      const dx = x - f[k], dy = y - f[k + 1];
      if (dx * dx + dy * dy <= f[k + 2]) return CONFIG.fort.defenseBonus;
    }
    return 0;
  }

  /**
   * (fx,fy) 에서 (tx,ty) 로 전선이 한 걸음 나아갈 때의 거리 비용.
   *
   * 방어기지는 영향권 전체에 걸쳐 step 을 무겁게 만든다 (면 효과).
   * 참호는 선 시설이므로 "그 edge 를 넘는 순간"에만 한 번 큰 지연을 준다 (선 효과).
   * 이렇게 나누면 참호 뒤로 들어간 뒤에도 보너스가 계속 붙는 오류가 생기지 않는다
   * (인수인계 6.3 이 셀 기반 참호를 거부한 이유).
   */
  stepCost(fx, fy, tx, ty, diagonal, base) {
    const map = this.game.map;
    const trench = diagonal
      ? map.trenchDiagonal(fx, fy, tx, ty)
      : map.trenchBetween(fx, fy, tx, ty);
    let dist = base * (1 + this.fortBonusAt(tx, ty));
    if (trench) dist += CONFIG.trench.frontDelay;
    return { dist, trench: trench ? 1 : 0 };
  }

  defenseDensity() {
    if (this.defenderId === NEUTRAL) return CONFIG.combat.neutralDefense;
    const def = this.game.countries[this.defenderId];
    return def ? def.defenseDensity() : CONFIG.combat.minDefenseDensity;
  }

  /**
   * 셀 하나를 점령하는 데 드는 공격 Balance.
   * captureCost = base * (1 + trenchBonus + fortBonus) — 중첩은 합산 (인수인계 9.4).
   */
  captureCost(cell, density) {
    const map = this.game.map;
    let mod = 1 + this.fortBonusAt(map.xOf(cell), map.yOf(cell));
    if (this.crossedTrench.get(cell)) mod += CONFIG.trench.defenseBonus;
    return CONFIG.combat.attackDefenseRatio * density * mod;
  }

  // ---- tick -------------------------------------------------------------

  /** 이번 tick 에 점령을 시도할 셀 목록(proposal)을 만든다. 실제 반영은 매니저가 한다. */
  step(dt) {
    this.pending.length = 0;
    if (!this.active) return this.pending;

    const map = this.game.map;
    const atk = this.game.countries[this.attackerId];
    if (!atk || !atk.alive) { this.finish('attacker-gone'); return this.pending; }
    if (this.game.atPeace(this.attackerId, this.defenderId)) { this.finish('peace'); return this.pending; }

    this.refreshFortCache();
    const density = this.defenseDensity();
    this.tickDensity = density;

    const minCost = CONFIG.combat.attackDefenseRatio * density;
    if (this.remainingBudget < minCost) { this.finish('spent'); return this.pending; }
    if (this.heap.length === 0) { this.finish('no-front'); return this.pending; }

    this.maxDist += CONFIG.combat.visibleFrontSpeed * dt;

    // 1) 허용 깊이 안의 유효한 후보를 모두 꺼낸다
    const items = [];
    const limit = CONFIG.combat.maxCellsPerTick;
    while (this.heap.length > 0 && this.heap.peekKey() <= this.maxDist && items.length < limit) {
      const d = this.heap.peekKey();
      const cell = this.heap.pop();
      const best = this.bestDist.get(cell);
      if (best === undefined || d > best + 1e-9) continue;   // 오래된 항목
      if (map.terrain[cell] !== LAND) continue;
      if (map.owner[cell] !== this.defenderId) continue;      // 이미 남의 손에 넘어감
      items.push({ d, cell });
    }
    if (items.length === 0) return this.pending;

    // 2) 같은 거리 밴드는 방향 순서 편향이 생기지 않도록 결정론적으로 섞는다 (8.7)
    const band = CONFIG.combat.band;
    items.sort((p, q) => {
      const ba = Math.floor(p.d / band), bb = Math.floor(q.d / band);
      if (ba !== bb) return ba - bb;
      return hash2(p.cell, this.id) - hash2(q.cell, this.id);
    });

    // 3) 예산이 허용하는 만큼만 제안. 비싼 셀은 큐로 되돌려 전선을 살려 둔다.
    let planned = 0;
    for (const it of items) {
      const cost = this.captureCost(it.cell, density);
      if (planned + cost > this.remainingBudget) {
        this.heap.push(it.d, it.cell);
        continue;
      }
      planned += cost;
      this.pending.push({ cell: it.cell, d: it.d, cost, attack: this });
    }
    return this.pending;
  }

  /** 매니저가 동시 공격 충돌을 정리한 뒤, 실제로 차지한 셀만 넘겨 준다. */
  commit(wonCells) {
    if (!this.active) return;
    const density = this.tickDensity;
    const def = this.defenderId !== NEUTRAL ? this.game.countries[this.defenderId] : null;

    for (const p of wonCells) {
      this.remainingBudget -= p.cost;
      if (def) def.balance = Math.max(0, def.balance - density);
      this.game.transferCell(p.cell, this.attackerId);
      this.capturedCount++;
      this.expand(p.cell, p.d);
    }
    if (this.remainingBudget <= 0) this.finish('spent');
  }

  /** 점령한 셀에서 이웃 수비 셀로 전선을 넓힌다 */
  expand(cell, d) {
    const map = this.game.map;
    const x = map.xOf(cell), y = map.yOf(cell);
    for (let k = 0; k < 8; k++) {
      const nx = x + DX8[k], ny = y + DY8[k];
      if (!map.inBounds(nx, ny)) continue;
      const j = map.idx(nx, ny);
      if (map.terrain[j] !== LAND) continue;
      if (map.owner[j] !== this.defenderId) continue;
      const diagonal = k >= 4;
      const base = diagonal ? SQRT2 : 1;
      const s = this.stepCost(x, y, nx, ny, diagonal, base);
      const jitter = 1 + (hash01(j * 2654435761 + this.id) - 0.5) * CONFIG.combat.frontNoise;
      const nd = d + s.dist * jitter;
      const prev = this.bestDist.get(j);
      if (prev !== undefined && prev <= nd) continue;
      this.bestDist.set(j, nd);
      this.crossedTrench.set(j, s.trench);
      this.heap.push(nd, j);
    }
  }

  finish(reason) {
    if (!this.active) return;
    this.status = 'done';
    this.endReason = reason;
    // 전선이 끊겨 끝난 경우 남은 예산은 돌려준다 (죽은 Balance 방지)
    if (reason !== 'spent' && this.remainingBudget > 0) {
      const atk = this.game.countries[this.attackerId];
      if (atk && atk.alive) atk.balance += this.remainingBudget;
    }
    this.remainingBudget = 0;
    this.heap.clear();
    this.bestDist.clear();
    this.crossedTrench.clear();
  }
}
