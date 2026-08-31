import { CONFIG } from '../config.js';
import { generateMap, pickStartCells } from './MapGenerator.js';
import { Country, COUNTRY_COLORS, COUNTRY_NAMES } from './Country.js';
import { tickEconomy } from './Economy.js';
import { LAND, WATER, NEUTRAL, DX4, DY4 } from './MapGrid.js';
import { LandAttack } from '../combat/Wavefront.js';
import { AttackManager } from '../combat/AttackManager.js';
import { Fleet, FleetManager } from '../combat/NavalFleet.js';
import { resolveNavalCombat } from '../combat/NavalCombat.js';
import { findInvasionRoute, findRouteToWater } from '../combat/SeaRoutes.js';
import { planTrench, commitTrench } from '../structures/TrenchEdges.js';
import { AIController } from '../ai/AIController.js';

const BORDER_REFRESH = 0.2;

export class Game {
  constructor(options = {}) {
    this.seed = options.seed >>> 0;
    this.difficulty = options.difficulty || 'normal';
    this.aiCount = options.aiCount ?? CONFIG.match.aiCount;

    this.time = 0;
    this.paused = false;
    this.over = null;               // 'win' | 'lose' | null
    this.events = [];

    // options.map / options.manualSetup 은 테스트 하네스가 합성 지도를 넣을 때 쓴다
    this.map = options.map || generateMap(this.seed);
    this.countries = [null];        // index 0 = 중립 자리
    this.attacks = new AttackManager(this);
    this.fleets = new FleetManager(this);
    this.ai = new AIController(this);
    this.aiEnabled = options.aiEnabled !== false;

    this.borderCount = new Map();   // "a,b" 공유 국경 길이 (a < b, 0 = 중립)
    this.borderTimer = 0;

    this.nextAttackId = 1;   // 전선 노이즈가 seed 에만 의존하도록 게임별로 센다
    this.playerId = 1;
    if (!options.manualSetup) this.setupCountries();
    this.recomputeBorders();
  }

  /** 시작 블롭 없이 국가만 만든다 (테스트/커스텀 시나리오용) */
  addCountry(id, name, color, isPlayer = false) {
    while (this.countries.length <= id) this.countries.push(null);
    const c = new Country(id, name, color, isPlayer);
    c.difficulty = this.difficulty;
    this.countries[id] = c;
    return c;
  }

  // ---- 초기화 ------------------------------------------------------------

  setupCountries() {
    const total = this.aiCount + 1;
    const starts = pickStartCells(this.map, total, this.seed);
    for (let k = 0; k < starts.length; k++) {
      const id = k + 1;
      const c = new Country(
        id,
        COUNTRY_NAMES[id] || `국가 ${id}`,
        COUNTRY_COLORS[id % COUNTRY_COLORS.length],
        id === 1
      );
      c.difficulty = this.difficulty;
      this.countries[id] = c;
      this.claimStartBlob(c, starts[k]);
    }
  }

  /** 시작 영토 블롭과 수도를 놓는다. 최초 도시 = 수도 (인수인계 4.1). */
  claimStartBlob(country, centerCell) {
    const map = this.map;
    const cx = map.xOf(centerCell), cy = map.yOf(centerCell);
    const r = CONFIG.match.startBlobRadius;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const x = cx + dx, y = cy + dy;
        if (!map.inBounds(x, y)) continue;
        const i = map.idx(x, y);
        if (map.terrain[i] !== LAND || map.owner[i] !== NEUTRAL) continue;
        this.transferCell(i, country.id);
      }
    }
    map.capital[centerCell] = 1;
    map.city[centerCell] = 1;
    country.capitalCell = centerCell;
    country.cities.push(centerCell);
    map.markDirty(centerCell);
  }

  // ---- 소유권 ------------------------------------------------------------

  /** 셀 하나의 소유권을 옮기고, 그 위의 시설도 함께 넘긴다. */
  transferCell(cell, newOwner) {
    const map = this.map;
    const old = map.owner[cell];
    if (old === newOwner) return;

    if (old !== NEUTRAL) {
      const oc = this.countries[old];
      if (oc) {
        oc.landCount--;
        if (map.city[cell]) removeFrom(oc.cities, cell);
        if (map.fort[cell]) removeFrom(oc.forts, cell);
        if (map.capital[cell]) {
          oc.capitalCell = -1;
          map.capital[cell] = 0;
          this.pushEvent(`${oc.name} 수도 함락`);
        }
      }
    }

    map.owner[cell] = newOwner;
    map.ownerVersion++;

    if (newOwner !== NEUTRAL) {
      const nc = this.countries[newOwner];
      nc.landCount++;
      if (map.city[cell]) nc.cities.push(cell);
      if (map.fort[cell]) nc.forts.push(cell);
    }
    map.markDirty(cell);
  }

  // ---- 국경 --------------------------------------------------------------

  /**
   * 어떤 나라들이 서로 육상 국경을 맞대고 있는지 다시 센다.
   * 국가 접경 판정은 4방향이다 (인수인계 8.6).
   * 매 프레임이 아니라 짧은 주기로만 돈다.
   */
  recomputeBorders(force = true) {
    const map = this.map;
    // 소유권이 하나도 안 바뀌었으면 전체 맵을 다시 훑을 이유가 없다
    if (!force && this.borderVersion === map.ownerVersion) return;
    this.borderVersion = map.ownerVersion;
    const W = map.width, H = map.height;
    const n = W * H;
    const nc = this.countries.length;
    const comp = map.ensureWaterComponents();
    this.borderCount.clear();

    // AI 와 UI 가 쓰는 샘플. 매번 전체 맵을 다시 훑지 않도록 여기서 같이 모은다.
    this.contested = Array.from({ length: nc }, () => []);
    this.coastSample = Array.from({ length: nc }, () => []);
    this.coastComp = Array.from({ length: nc }, () => new Set());
    this.anyCell = new Int32Array(nc).fill(-1);
    const CAP = 500;

    const terrain = map.terrain, owner = map.owner;
    for (let i = 0; i < n; i++) {
      if (terrain[i] !== LAND) continue;
      const a = owner[i];
      if (a !== NEUTRAL && this.anyCell[a] < 0) this.anyCell[a] = i;
      const x = i % W, y = (i / W) | 0;

      // 오른쪽 이웃
      if (x + 1 < W) {
        const j = i + 1;
        if (terrain[j] === LAND && owner[j] !== a) this.addBorder(a, owner[j], i, j, CAP);
        else if (terrain[j] !== LAND && a !== NEUTRAL) this.addCoast(a, i, comp[j], CAP);
      }
      // 아래 이웃
      if (y + 1 < H) {
        const j = i + W;
        if (terrain[j] === LAND && owner[j] !== a) this.addBorder(a, owner[j], i, j, CAP);
        else if (terrain[j] !== LAND && a !== NEUTRAL) this.addCoast(a, i, comp[j], CAP);
      }
      // 왼쪽/위는 해안 판정에만 필요하다 (국경은 위에서 한 번씩 이미 셌다)
      if (a !== NEUTRAL) {
        if (x > 0 && terrain[i - 1] !== LAND) this.addCoast(a, i, comp[i - 1], CAP);
        if (y > 0 && terrain[i - W] !== LAND) this.addCoast(a, i, comp[i - W], CAP);
      }
    }
  }

  addBorder(a, b, ia, ib, cap) {
    const key = a < b ? a * 512 + b : b * 512 + a;
    this.borderCount.set(key, (this.borderCount.get(key) || 0) + 1);
    if (a !== NEUTRAL && b !== NEUTRAL) {
      if (this.contested[a].length < cap) this.contested[a].push(ia);
      if (this.contested[b].length < cap) this.contested[b].push(ib);
    }
  }

  /** 화면에서 "내 나라가 여기" 를 가리킬 기준 셀. 수도를 잃었으면 아무 자국 셀이나. */
  playerAnchor() {
    const map = this.map;
    const p = this.countries[this.playerId];
    if (!p) return -1;
    if (p.capitalCell >= 0 && map.owner[p.capitalCell] === this.playerId) return p.capitalCell;
    if (p.cities.length) return p.cities[0];
    if (this.anyCell && this.anyCell[this.playerId] >= 0) return this.anyCell[this.playerId];
    return -1;
  }

  addCoast(ownerId, cell, waterComp, cap) {
    const list = this.coastSample[ownerId];
    if (list.length < cap && list[list.length - 1] !== cell) list.push(cell);
    if (waterComp >= 0) this.coastComp[ownerId].add(waterComp);
  }

  borderLength(a, b) {
    return this.borderCount.get(a < b ? a * 512 + b : b * 512 + a) || 0;
  }

  /**
   * 해상 경로 존재 여부를 O(1) 로 판정한다.
   * 실제 항로는 출항할 때만 Dijkstra 로 구한다 (UI 가 매 프레임 경로를 계산하지 않게).
   */
  canReachBySea(ownerId, targetLandCell) {
    const map = this.map;
    if (map.terrain[targetLandCell] !== LAND) return false;
    const comp = map.ensureWaterComponents();
    const mine = this.coastComp?.[ownerId];
    if (!mine || mine.size === 0) return false;
    const x = map.xOf(targetLandCell), y = map.yOf(targetLandCell);
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!map.inBounds(nx, ny)) continue;
      const j = map.idx(nx, ny);
      if (map.terrain[j] === LAND) continue;
      if (mine.has(comp[j])) return true;
    }
    return false;
  }

  /** 물 위의 지점(적 함선 위치)까지 배가 갈 수 있는가. 역시 성분 비교만으로 판정한다. */
  canReachWaterBySea(ownerId, waterCell) {
    const map = this.map;
    if (map.terrain[waterCell] === LAND) return false;
    const comp = map.ensureWaterComponents();
    const mine = this.coastComp?.[ownerId];
    return !!mine && mine.has(comp[waterCell]);
  }

  sharesLandBorder(a, b) {
    return this.borderLength(a, b) > 0;
  }

  /** 육상으로 접한 상대 국가 id 목록 (중립 제외) */
  landNeighbors(id) {
    const out = [];
    for (const key of this.borderCount.keys()) {
      const a = (key / 512) | 0, b = key % 512;
      if (a === id && b !== NEUTRAL) out.push(b);
      else if (b === id && a !== NEUTRAL) out.push(a);
    }
    return out;
  }

  // ---- 화친 --------------------------------------------------------------

  peaceKey(a, b) { return a < b ? `${a},${b}` : `${b},${a}`; }

  atPeace(a, b) {
    if (a === NEUTRAL || b === NEUTRAL) return false;
    if (!this.peace) return false;
    const until = this.peace.get(this.peaceKey(a, b));
    return until !== undefined && until > this.time;
  }

  makePeace(a, b) {
    if (!this.peace) this.peace = new Map();
    this.peace.set(this.peaceKey(a, b), this.time + CONFIG.peace.duration);
    this.attacks.cancelBetween(a, b);
    this.pushEvent(`${this.nameOf(a)} - ${this.nameOf(b)} 화친`);
  }

  /**
   * 화친 요청. 최소 구현만 둔다 (인수인계 13장: 외교를 크게 키우지 않는다).
   * 상대가 약할수록 거절하고, 여러 전쟁에 물려 있을수록 받아들인다.
   */
  requestPeace(fromId, toId) {
    if (this.atPeace(fromId, toId)) return { ok: false, reason: 'already' };
    const me = this.countries[fromId], other = this.countries[toId];
    if (!me || !other || !other.alive) return { ok: false, reason: 'gone' };

    const strength = (me.balance + me.landCount * 1.5) / Math.max(1, other.balance + other.landCount * 1.5);
    const wars = this.attacks.countActiveWars(toId);
    let p = CONFIG.peace.aiBaseAccept + 0.22 * Math.min(3, wars) + 0.30 * Math.min(2, strength - 1);
    p = Math.max(0.03, Math.min(0.95, p));

    if (mixRoll(fromId, toId, this.time) < p) {
      this.makePeace(fromId, toId);
      return { ok: true };
    }
    this.pushEvent(`${other.name} 이 화친을 거절`);
    return { ok: false, reason: 'refused' };
  }

  // ---- 공격 --------------------------------------------------------------

  /**
   * 육상 공격. 플레이어는 대상 국가만 고르고 방향은 고르지 않는다 (인수인계 2.5).
   * 전선 seed 는 두 나라가 공유하는 국경 전체다.
   */
  launchAttack(attackerId, defenderId, ratio) {
    const atk = this.countries[attackerId];
    if (!atk || !atk.alive) return { error: 'gone' };
    if (attackerId === defenderId) return { error: 'self' };
    if (this.atPeace(attackerId, defenderId)) return { error: 'peace' };
    if (!this.sharesLandBorder(attackerId, defenderId)) return { error: 'no-border' };

    const budget = atk.balance * ratio;
    if (budget < CONFIG.combat.minAttackBalance) return { error: 'no-balance' };
    atk.balance -= budget;

    const existing = this.attacks.activeAttackOf(attackerId, defenderId);
    if (existing) {
      existing.remainingBudget += budget;   // 증원
      return { attack: existing };
    }
    const a = this.attacks.add(new LandAttack(this, attackerId, defenderId, budget));
    return { attack: a };
  }

  /** 중립 확장도 같은 wavefront 를 쓴다 (인수인계 19장) */
  launchExpansion(ownerId, ratio) {
    return this.launchAttack(ownerId, NEUTRAL, ratio);
  }

  // ---- 해상 --------------------------------------------------------------

  /** 목표 적 해안만 지정하면 가장 가까운 자국 해안에서 자동 출항한다 (인수인계 11.2) */
  launchInvasion(ownerId, targetCell, ratio) {
    const map = this.map;
    const me = this.countries[ownerId];
    if (!me || !me.alive) return { error: 'gone' };
    const defender = map.owner[targetCell];
    if (defender === ownerId) return { error: 'own' };
    if (this.atPeace(ownerId, defender)) return { error: 'peace' };
    if (!map.isCoast(targetCell)) return { error: 'not-coast' };
    if (!this.canReachBySea(ownerId, targetCell)) return { error: 'no-route' };

    const route = findInvasionRoute(map, ownerId, targetCell);
    if (!route) return { error: 'no-route' };

    const troops = me.balance * ratio;
    if (troops < CONFIG.fleet.minLaunch) return { error: 'no-balance' };
    me.balance -= troops;

    const path = route.path.slice();
    path.push(targetCell);   // 마지막 한 걸음으로 상륙
    const fleet = new Fleet(ownerId, troops, path, { type: 'invade', targetCell });
    fleet.placeAt(map, route.startCoast);
    this.fleets.add(fleet);
    return { fleet };
  }

  /** 적 함선을 클릭하고 배를 누르면 가장 가까운 자국 해안에서 요격함이 나간다 (인수인계 12.2) */
  launchIntercept(ownerId, targetFleet, ratio) {
    const map = this.map;
    const me = this.countries[ownerId];
    if (!me || !me.alive) return { error: 'gone' };
    if (!targetFleet || !targetFleet.alive) return { error: 'gone' };
    if (targetFleet.ownerId === ownerId) return { error: 'own' };
    if (this.atPeace(ownerId, targetFleet.ownerId)) return { error: 'peace' };

    const goal = targetFleet.currentCell(map);
    if (!this.canReachWaterBySea(ownerId, goal)) return { error: 'no-route' };
    const route = findRouteToWater(map, ownerId, goal);
    if (!route) return { error: 'no-route' };

    const troops = me.balance * ratio;
    if (troops < CONFIG.fleet.minLaunch) return { error: 'no-balance' };
    me.balance -= troops;

    const fleet = new Fleet(ownerId, troops, route.path.slice(), {
      type: 'intercept', targetFleetId: targetFleet.id,
    });
    fleet.placeAt(map, route.startCoast);
    this.fleets.add(fleet);
    return { fleet };
  }

  /**
   * 상륙 처리.
   * 상륙 추가 페널티는 없다 (인수인계 2.6 / 11.7). 육상 전투와 같은 식을 쓴다.
   */
  resolveLanding(fleet) {
    const map = this.map;
    const me = this.countries[fleet.ownerId];
    const target = fleet.mission.targetCell;
    fleet.alive = false;
    if (!me || !me.alive) return;

    if (map.terrain[target] !== LAND) { me.balance += fleet.troops; return; }
    const defenderId = map.owner[target];
    if (defenderId === fleet.ownerId) { me.balance += fleet.troops; return; }
    if (this.atPeace(fleet.ownerId, defenderId)) { me.balance += fleet.troops; return; }

    const def = defenderId !== NEUTRAL ? this.countries[defenderId] : null;
    const density = def ? def.defenseDensity() : CONFIG.combat.neutralDefense;
    const fortMod = this.fortBonusFor(defenderId, target);
    const cost = CONFIG.combat.attackDefenseRatio * density * (1 + fortMod);

    if (fleet.troops < cost) {
      // 상륙 실패. 수비측도 그만큼 손실을 본다.
      if (def) def.balance = Math.max(0, def.balance - fleet.troops / CONFIG.combat.attackDefenseRatio);
      this.pushEvent(`${me.name} 상륙 실패`);
      return;
    }

    this.transferCell(target, fleet.ownerId);
    if (def) def.balance = Math.max(0, def.balance - density);
    const remaining = fleet.troops - cost;
    this.pushEvent(`${me.name} 상륙 성공`);

    // 교두보에서 이어지는 일반 육상 공격으로 전환한다
    if (remaining >= CONFIG.combat.minAttackBalance) {
      const seeds = [];
      const x = map.xOf(target), y = map.yOf(target);
      for (let k = 0; k < 4; k++) {
        const nx = x + DX4[k], ny = y + DY4[k];
        if (!map.inBounds(nx, ny)) continue;
        const j = map.idx(nx, ny);
        if (map.terrain[j] === LAND && map.owner[j] === defenderId) seeds.push(j);
      }
      if (seeds.length) {
        this.attacks.add(new LandAttack(this, fleet.ownerId, defenderId, remaining, seeds));
      } else {
        me.balance += remaining;
      }
    } else {
      me.balance += remaining;
    }
    this.recomputeBorders();
  }

  resolveReturn(fleet) {
    fleet.alive = false;
    const me = this.countries[fleet.ownerId];
    if (me && me.alive) me.balance += fleet.troops;
  }

  fortBonusFor(ownerId, cell) {
    if (ownerId === NEUTRAL) return 0;
    const c = this.countries[ownerId];
    if (!c || !c.forts.length) return 0;
    const map = this.map;
    const x = map.xOf(cell), y = map.yOf(cell);
    const r2 = CONFIG.fort.radius * CONFIG.fort.radius;
    for (const f of c.forts) {
      const dx = x - map.xOf(f), dy = y - map.yOf(f);
      if (dx * dx + dy * dy <= r2) return CONFIG.fort.defenseBonus;
    }
    return 0;
  }

  // ---- 건설 --------------------------------------------------------------

  canBuildOn(ownerId, cell) {
    const map = this.map;
    return map.terrain[cell] === LAND
      && map.owner[cell] === ownerId
      && !map.city[cell]
      && !map.fort[cell];
  }

  buildCity(ownerId, cell) {
    const c = this.countries[ownerId];
    if (!c || !this.canBuildOn(ownerId, cell)) return { error: 'invalid' };
    const cost = c.nextCityCost();
    if (c.balance < cost) return { error: 'no-balance', cost };
    c.balance -= cost;
    this.map.city[cell] = 1;
    c.cities.push(cell);
    this.map.markDirty(cell);
    return { ok: true, cost };
  }

  buildFort(ownerId, cell) {
    const c = this.countries[ownerId];
    if (!c || !this.canBuildOn(ownerId, cell)) return { error: 'invalid' };
    const cost = c.fortCost();
    if (c.balance < cost) return { error: 'no-balance', cost };
    c.balance -= cost;
    this.map.fort[cell] = 1;
    c.forts.push(cell);
    this.map.markDirty(cell);
    return { ok: true, cost };
  }

  buildTrench(ownerId, from, to) {
    const c = this.countries[ownerId];
    if (!c) return { error: 'invalid' };
    const plan = planTrench(this.map, ownerId, from, to);
    if (plan.buildableCount === 0) return { error: 'invalid' };
    if (c.balance < plan.cost) return { error: 'no-balance', cost: plan.cost };
    const built = commitTrench(this.map, c, plan);
    this.map.dirtyAll = true;
    return { ok: true, built, cost: Math.round(built * CONFIG.trench.costPerEdge) };
  }

  // ---- 루프 --------------------------------------------------------------

  tick(dt) {
    if (this.paused || this.over) return;
    this.time += dt;

    for (let id = 1; id < this.countries.length; id++) {
      const c = this.countries[id];
      if (c && c.alive) tickEconomy(c, dt);
    }

    this.attacks.tick(dt);
    this.fleets.tick(dt);
    resolveNavalCombat(this, dt);

    this.borderTimer -= dt;
    if (this.borderTimer <= 0) {
      this.borderTimer = BORDER_REFRESH;
      this.recomputeBorders(false);
      this.checkElimination();
    }

    if (this.aiEnabled) this.ai.tick(dt);
    this.checkVictory();
  }

  checkElimination() {
    for (let id = 1; id < this.countries.length; id++) {
      const c = this.countries[id];
      if (!c || !c.alive) continue;
      if (c.landCount > 0) continue;
      // 바다에 함대가 남아 있으면 아직 기회가 있다
      if (this.fleets.ownedBy(id).length > 0) continue;
      c.alive = false;
      c.balance = 0;
      this.attacks.cancelAllBy(id);
      this.pushEvent(`${c.name} 멸망`);
    }
  }

  checkVictory() {
    const player = this.countries[this.playerId];
    if (!player) return;
    if (!player.alive) { this.over = 'lose'; return; }
    const totalLand = this.map.landCells || 1;
    if (player.landCount / totalLand >= CONFIG.match.victoryLandShare) { this.over = 'win'; return; }
    const others = this.countries.filter((c, i) => i > 0 && c && c.alive && c.id !== this.playerId);
    if (others.length === 0) this.over = 'win';
  }

  // ---- 유틸 --------------------------------------------------------------

  nameOf(id) {
    if (id === NEUTRAL) return '중립';
    const c = this.countries[id];
    return c ? c.name : `국가 ${id}`;
  }

  pushEvent(text) {
    this.events.push({ t: this.time, text });
    if (this.events.length > 40) this.events.shift();
  }

  landShare(id) {
    return this.countries[id] ? this.countries[id].landCount / (this.map.landCells || 1) : 0;
  }

  ranking() {
    return this.countries
      .filter((c, i) => i > 0 && c && c.alive)
      .sort((a, b) => b.landCount - a.landCount);
  }

  /** 화면 좌표(셀 실수)에 가장 가까운 함대 찾기 */
  fleetAt(fx, fy, radiusCells) {
    let best = null, bestD = radiusCells * radiusCells;
    for (const f of this.fleets.fleets) {
      if (!f.alive) continue;
      const dx = f.x - fx, dy = f.y - fy;
      const d = dx * dx + dy * dy;
      if (d <= bestD) { bestD = d; best = f; }
    }
    return best;
  }
}

function removeFrom(arr, value) {
  const i = arr.indexOf(value);
  if (i >= 0) arr.splice(i, 1);
}

/** 화친 판정용 결정론적 난수 */
function mixRoll(a, b, t) {
  let x = Math.imul(a * 73856093 ^ b * 19349663 ^ ((t * 1000) | 0), 0x27d4eb2d) >>> 0;
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}
