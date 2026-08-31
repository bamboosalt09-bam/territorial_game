import { CONFIG } from '../config.js';
import { NEUTRAL, LAND } from '../game/MapGrid.js';
import { fortifyBorderAround } from '../structures/TrenchEdges.js';
import { balanceCap } from '../game/Economy.js';

/**
 * Utility AI (인수인계 14.3).
 *
 * 머신러닝은 쓰지 않는다. 행동 후보마다 휴리스틱 점수를 매기고 가장 높은 것을 고른다.
 * 난이도는 자원 치트가 아니라 "판단 품질"로만 차등화한다 (인수인계 14.2).
 *   - 판단 주기
 *   - 점수에 섞이는 노이즈
 *   - 공격 비율 오차
 *   - 해상 공격/요격/시설을 쓰는 빈도
 *   - 노출 위험 평가 여부, 짧은 lookahead 여부
 */
export class AIController {
  constructor(game) {
    this.game = game;
    this.rngState = (game.seed ^ 0x9e3779b9) >>> 0;
  }

  rand() {
    let x = this.rngState;
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    this.rngState = x;
    return x / 4294967296;
  }

  params(country) {
    return CONFIG.ai[country.difficulty] || CONFIG.ai.normal;
  }

  tick(dt) {
    const g = this.game;
    for (let id = 2; id < g.countries.length; id++) {
      const c = g.countries[id];
      if (!c || !c.alive) continue;
      c.thinkTimer -= dt;
      if (c.thinkTimer > 0) continue;
      const p = this.params(c);
      // 모든 AI 가 같은 프레임에 몰리지 않도록 jitter (인수인계 14.4)
      c.thinkTimer = p.interval[0] + this.rand() * (p.interval[1] - p.interval[0]);
      this.think(c, p);
    }
  }

  think(country, p) {
    const g = this.game;
    const candidates = [];

    this.considerExpand(country, p, candidates);
    this.considerAttacks(country, p, candidates);
    this.considerStructures(country, p, candidates);
    this.considerNaval(country, p, candidates);
    this.considerIntercept(country, p, candidates);

    if (candidates.length === 0) return;

    for (const c of candidates) {
      c.score += (this.rand() - 0.5) * 2 * p.noise;
    }
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (best.score <= 0) return;
    best.run();
    void g;
  }

  /** 실제 투입 비율. 난이도가 낮을수록 과소/과다 투자한다. */
  ratio(ideal, p) {
    const err = (this.rand() - 0.5) * 2 * p.ratioError;
    return Math.max(0.08, Math.min(1, ideal + err));
  }

  /** balance 여유도 0..1 */
  fullness(country) {
    return Math.min(1, country.balance / Math.max(1, balanceCap(country)));
  }

  // ---- 후보 --------------------------------------------------------------

  considerExpand(country, p, out) {
    const g = this.game;
    const neutralBorder = g.borderLength(country.id, NEUTRAL);
    if (neutralBorder <= 0) return;
    const full = this.fullness(country);
    // 중립 땅은 싸다. balance 가 차 있을수록 우선순위가 높다.
    const score = 0.55 + full * 0.9 + Math.min(0.4, neutralBorder / 400);
    const ratio = this.ratio(0.45 + full * 0.3, p);
    out.push({
      kind: 'expand', score,
      run: () => g.launchExpansion(country.id, ratio),
    });
  }

  considerAttacks(country, p, out) {
    const g = this.game;
    const neighbors = g.landNeighbors(country.id);
    for (const eid of neighbors) {
      const enemy = g.countries[eid];
      if (!enemy || !enemy.alive) continue;
      if (g.atPeace(country.id, eid)) continue;

      const border = g.borderLength(country.id, eid);
      const density = enemy.defenseDensity();
      // 이 국경 폭에서 의미 있는 진격을 하려면 필요한 대략적인 Balance
      const needed = CONFIG.combat.attackDefenseRatio * density * border * 1.2;
      const power = country.balance / Math.max(1, needed);

      let score = -0.4 + power * 0.85;
      score += Math.min(0.5, g.attacks.countActiveWars(eid) * 0.2);       // 이미 다면전 중이면 기회
      score += Math.min(0.35, enemy.cities.length * 0.05);                 // 고가치 목표
      if (enemy.capitalCell >= 0 && border > 12) score += 0.12;
      score -= Math.min(0.4, enemy.balance / Math.max(1, country.balance) * 0.25);

      if (p.exposure) {
        // 공격에 balance 를 쓰면 다른 이웃에게 노출된다
        let threat = 0;
        for (const other of neighbors) {
          if (other === eid) continue;
          const oc = g.countries[other];
          if (!oc || !oc.alive || g.atPeace(country.id, other)) continue;
          threat += oc.balance / Math.max(1, country.balance);
        }
        score -= Math.min(0.7, threat * 0.28);
      }

      let ratio = this.ratio(Math.min(0.85, 0.35 + power * 0.25), p);

      if (p.lookahead) {
        // 짧은 lookahead: 이번 투자로 몇 셀을 얻고, 그 뒤 내 balance 여유가 어떻게 되는지
        const budget = country.balance * ratio;
        const gain = budget / Math.max(0.01, CONFIG.combat.attackDefenseRatio * density);
        const after = country.balance - budget;
        const survivable = after / Math.max(1, enemy.balance);
        score += Math.min(0.6, gain / Math.max(20, border * 4)) * 0.8;
        score -= survivable < 0.4 ? 0.45 : 0;
        if (survivable < 0.25) ratio = Math.max(0.15, ratio * 0.6);
      }

      out.push({
        kind: 'attack', score,
        run: () => g.launchAttack(country.id, eid, ratio),
      });

      // 압도적으로 밀리면 화친을 시도한다
      if (country.balance * 1.6 < enemy.balance && g.attacks.activeAttackOf(eid, country.id)) {
        out.push({
          kind: 'peace', score: 0.35 + this.rand() * 0.2,
          run: () => g.requestPeace(country.id, eid),
        });
      }
    }
  }

  considerStructures(country, p, out) {
    const g = this.game;
    if (this.rand() > p.structures) return;

    const contested = g.contested?.[country.id] || [];
    const underAttack = g.attacks.attacks.some(a => a.active && a.defenderId === country.id);

    // 도시: 안전하고 여유 있을 때
    const cityCost = country.nextCityCost();
    if (country.balance > cityCost * 2.2) {
      const safety = underAttack ? 0.35 : 1;
      const score = (0.5 + this.fullness(country) * 0.6) * safety
        - Math.min(0.5, country.cities.length * 0.05);
      const cell = this.pickInteriorCell(country);
      if (cell >= 0) out.push({ kind: 'city', score, run: () => g.buildCity(country.id, cell) });
    }

    // 방어기지: 압박받는 국경 근처
    if (contested.length > 0 && country.balance > country.fortCost() * 2.4) {
      const cell = contested[(this.rand() * contested.length) | 0];
      const nearFort = country.forts.some(f => {
        const dx = g.map.xOf(f) - g.map.xOf(cell), dy = g.map.yOf(f) - g.map.yOf(cell);
        return dx * dx + dy * dy < (CONFIG.fort.radius * 1.4) ** 2;
      });
      if (!nearFort && g.canBuildOn(country.id, cell)) {
        const score = (underAttack ? 0.85 : 0.35) + Math.min(0.3, contested.length / 600);
        out.push({ kind: 'fort', score, run: () => g.buildFort(country.id, cell) });
      }
    }

    // 참호: 위험한 국경을 따라 실제 국경 edge 를 막는다
    if (contested.length > 0) {
      const edges = 40;
      const cost = edges * CONFIG.trench.costPerEdge;
      if (country.balance > cost * 2.5) {
        const cell = contested[(this.rand() * contested.length) | 0];
        const score = (underAttack ? 0.7 : 0.28) + Math.min(0.25, contested.length / 800);
        out.push({
          kind: 'trench', score,
          run: () => fortifyBorderAround(g.map, country, cell, 6, edges),
        });
      }
    }
  }

  considerNaval(country, p, out) {
    const g = this.game;
    if (this.rand() > p.naval) return;
    // 해상 원정은 중반 옵션이다.
    // 초반에는 아무도 육상 접경이 없어서 모든 나라가 "비접경 약한 적"으로 잡히는데,
    // 그 시점에 원정을 나가면 근처 중립 땅을 놔두고 훨씬 비싼 선택을 하는 셈이 된다.
    if (g.borderLength(country.id, NEUTRAL) > 30) return;
    if (country.balance < CONFIG.fleet.minLaunch * 25) return;

    // 육상으로 닿지 않는 약한 적을 고른다
    const landNeighbors = new Set(g.landNeighbors(country.id));
    let bestTarget = -1, bestScore = 0;
    for (let id = 1; id < g.countries.length; id++) {
      if (id === country.id) continue;
      const e = g.countries[id];
      if (!e || !e.alive) continue;
      if (landNeighbors.has(id)) continue;
      if (g.atPeace(country.id, id)) continue;

      const coasts = g.coastSample?.[id] || [];
      if (coasts.length === 0) continue;
      const cell = coasts[(this.rand() * coasts.length) | 0];
      const weakness = country.balance / Math.max(1, e.balance);
      let score = -0.55 + Math.min(0.9, weakness * 0.45);
      if (e.landCount < country.landCount * 0.5) score += 0.25;
      if (score > bestScore) {
        // 실제로 항로가 있는지는 비싸니 최종 후보에서만 확인한다
        if (g.canReachBySea(country.id, cell)) {
          bestScore = score;
          bestTarget = cell;
        }
      }
    }
    if (bestTarget < 0) return;
    const ratio = this.ratio(0.4, p);
    out.push({
      kind: 'invade', score: bestScore,
      run: () => g.launchInvasion(country.id, bestTarget, ratio),
    });
  }

  considerIntercept(country, p, out) {
    const g = this.game;
    if (this.rand() > p.intercept) return;
    if (country.balance < CONFIG.fleet.minLaunch * 3) return;

    const coasts = g.coastSample?.[country.id] || [];
    if (coasts.length === 0) return;

    let best = null, bestD = Infinity;
    for (const f of g.fleets.fleets) {
      if (!f.alive || f.ownerId === country.id) continue;
      if (g.atPeace(country.id, f.ownerId)) continue;
      // 내 해안에 가까운 적 함선만
      for (let k = 0; k < coasts.length; k += 7) {
        const c = coasts[k];
        const dx = g.map.xOf(c) - f.x, dy = g.map.yOf(c) - f.y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = f; }
      }
    }
    if (!best) return;
    const dist = Math.sqrt(bestD);
    if (dist > 70) return;
    const ratio = this.ratio(Math.min(0.5, (best.troops * 1.3) / Math.max(1, country.balance)), p);
    const score = 0.45 + Math.max(0, (70 - dist) / 70) * 0.5;
    out.push({
      kind: 'intercept', score,
      run: () => g.launchIntercept(country.id, best, ratio),
    });
  }

  /** 국경에서 멀고 시설이 없는 자국 셀을 고른다 (도시 자리) */
  pickInteriorCell(country) {
    const g = this.game;
    const map = g.map;
    const contested = new Set(g.contested?.[country.id] || []);
    let best = -1, bestScore = -Infinity;
    const cities = country.cities;
    for (let tries = 0; tries < 24; tries++) {
      const cell = this.randomOwnedCell(country);
      if (cell < 0) continue;
      if (!g.canBuildOn(country.id, cell)) continue;
      if (contested.has(cell)) continue;
      let s = 0;
      let nearest = Infinity;
      for (const c of cities) {
        const dx = map.xOf(c) - map.xOf(cell), dy = map.yOf(c) - map.yOf(cell);
        nearest = Math.min(nearest, dx * dx + dy * dy);
      }
      s += Math.min(400, nearest) / 400;
      if (s > bestScore) { bestScore = s; best = cell; }
    }
    return best;
  }

  randomOwnedCell(country) {
    const map = this.game.map;
    const n = map.width * map.height;
    for (let i = 0; i < 40; i++) {
      const c = (this.rand() * n) | 0;
      if (map.terrain[c] === LAND && map.owner[c] === country.id) return c;
    }
    return -1;
  }
}
