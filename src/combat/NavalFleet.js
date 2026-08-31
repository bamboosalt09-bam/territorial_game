import { CONFIG } from '../config.js';
import { WATER } from '../game/MapGrid.js';
import { findRouteBetweenWater, findRouteToWater } from './SeaRoutes.js';

/**
 * 함대.
 *
 * 별도의 해군 경제는 없다 (인수인계 11.4). "배" 는 공격 Balance 를 바다로 나르는 수단이다.
 * 함선 종류, 생산소, 유지비 같은 것은 만들지 않는다.
 *
 * 항해 중 병력은 아주 작은 비율로 감소하지만, 자연 감쇠만으로는 절대 0 이 되지 않는다
 * (인수인계 2.7 / 11.6). 전투로 0 이 되는 것은 별개다.
 */
export class Fleet {
  static nextId = 1;

  constructor(ownerId, troops, path, mission) {
    this.id = Fleet.nextId++;
    this.ownerId = ownerId;
    this.troops = troops;
    this.mission = mission;          // { type: 'invade', targetCell } | { type: 'intercept', targetFleetId } | { type: 'return' }
    this.setPath(path);
    this.alive = true;
    this.retargetTimer = 0;
    this.landed = false;
  }

  setPath(path) {
    this.path = path || [];
    this.pathIndex = 0;
  }

  /** 지도 좌표계에서의 현재 위치를 셀 단위 실수로 보관 */
  placeAt(map, cell) {
    this.x = map.xOf(cell) + 0.5;
    this.y = map.yOf(cell) + 0.5;
  }

  currentCell(map) {
    const x = Math.max(0, Math.min(map.width - 1, Math.floor(this.x)));
    const y = Math.max(0, Math.min(map.height - 1, Math.floor(this.y)));
    return map.idx(x, y);
  }

  /** 시간에 따른 미세 지수 감쇠. floor 아래로는 내려가지 않는다. */
  applyAttrition(dt) {
    const f = CONFIG.fleet;
    this.troops *= Math.exp(-f.attritionPerSecond * dt);
    if (this.troops < f.minTroops) this.troops = f.minTroops;
  }

  /** 경로를 따라 이동. 경로 끝에 도달하면 true 반환 */
  advance(map, dt) {
    let budget = CONFIG.fleet.speed * dt;
    while (budget > 0) {
      if (this.pathIndex >= this.path.length) return true;
      const cell = this.path[this.pathIndex];
      const tx = map.xOf(cell) + 0.5, ty = map.yOf(cell) + 0.5;
      const dx = tx - this.x, dy = ty - this.y;
      const d = Math.hypot(dx, dy);
      if (d <= budget) {
        this.x = tx; this.y = ty;
        budget -= d;
        this.pathIndex++;
      } else {
        this.x += (dx / d) * budget;
        this.y += (dy / d) * budget;
        budget = 0;
      }
    }
    return this.pathIndex >= this.path.length;
  }
}

/**
 * 함대 전체 관리.
 * 요격은 목표 함선이 움직이므로 주기적으로 경로를 다시 계산한다 (인수인계 12.3).
 * 매 프레임 전체 A* 를 돌리지는 않는다.
 */
export class FleetManager {
  constructor(game) {
    this.game = game;
    this.fleets = [];
  }

  add(fleet) { this.fleets.push(fleet); return fleet; }

  byId(id) { return this.fleets.find(f => f.alive && f.id === id); }

  ownedBy(ownerId) { return this.fleets.filter(f => f.alive && f.ownerId === ownerId); }

  hostileTo(ownerId) {
    return this.fleets.filter(f => f.alive && f.ownerId !== ownerId);
  }

  tick(dt) {
    const map = this.game.map;
    for (const f of this.fleets) {
      if (!f.alive) continue;
      f.applyAttrition(dt);

      if (f.mission.type === 'intercept') this.updateIntercept(f, dt);

      const arrived = f.advance(map, dt);
      if (!arrived) continue;

      if (f.mission.type === 'invade') {
        this.game.resolveLanding(f);
      } else if (f.mission.type === 'return') {
        this.game.resolveReturn(f);
      } else if (f.mission.type === 'intercept') {
        // 목표를 놓쳤다. 다음 재계산까지 제자리 대기.
        const target = this.byId(f.mission.targetFleetId);
        if (!target) this.sendHome(f);
      }
    }
    this.prune();
  }

  /** 이동하는 목표를 향해 주기적으로 경로 갱신 */
  updateIntercept(f, dt) {
    f.retargetTimer -= dt;
    if (f.retargetTimer > 0) return;
    f.retargetTimer = CONFIG.fleet.retargetInterval;

    const map = this.game.map;
    const target = this.byId(f.mission.targetFleetId);
    if (!target) { this.sendHome(f); return; }

    const from = f.currentCell(map);
    const goal = target.currentCell(map);
    if (map.terrain[from] !== WATER || map.terrain[goal] !== WATER) return;
    const route = findRouteBetweenWater(map, from, goal);
    if (route) f.setPath(route.path);
  }

  /** 임무가 끝난 함대를 가장 가까운 자국 해안으로 돌려보낸다 (인수인계 12.5 단순안) */
  sendHome(f) {
    const map = this.game.map;
    const here = f.currentCell(map);
    if (map.terrain[here] !== WATER) { f.alive = false; return; }
    const route = findRouteToWater(map, f.ownerId, here);
    if (!route || route.path.length === 0) { f.alive = false; return; }
    // 자국 해안 -> 현재 위치 경로이므로 뒤집어서 귀환 경로로 쓴다
    const back = route.path.slice().reverse();
    f.mission = { type: 'return', homeCell: route.startCoast };
    f.setPath(back);
  }

  prune() {
    let write = 0;
    for (let i = 0; i < this.fleets.length; i++) {
      if (this.fleets[i].alive) this.fleets[write++] = this.fleets[i];
    }
    this.fleets.length = write;
  }
}
