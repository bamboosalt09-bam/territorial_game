import { hash2 } from '../core/rng.js';

/**
 * 동시 공격 조정자 (인수인계 18.5).
 *
 * A 를 처리하고 지도를 갱신한 뒤 C 를 처리하면, 프레임 처리 순서 때문에
 * 먼저 도는 나라가 항상 유리해진다. 그래서 한 tick 안에서는
 *   1) 모든 공격이 제안(proposal)만 만들고
 *   2) 같은 셀을 노린 제안끼리 승자를 가린 뒤
 *   3) 한 batch 로 소유권을 반영한다.
 */
export class AttackManager {
  constructor(game) {
    this.game = game;
    this.attacks = [];
  }

  add(attack) {
    this.attacks.push(attack);
    return attack;
  }

  /** 특정 두 나라 사이의 진행 중인 공격을 취소 (화친 등) */
  cancelBetween(a, b) {
    for (const atk of this.attacks) {
      if (!atk.active) continue;
      if ((atk.attackerId === a && atk.defenderId === b) ||
          (atk.attackerId === b && atk.defenderId === a)) {
        atk.finish('cancelled');
      }
    }
  }

  cancelAllBy(ownerId) {
    for (const atk of this.attacks) {
      if (atk.active && atk.attackerId === ownerId) atk.finish('cancelled');
    }
  }

  activeAttackOf(attackerId, defenderId) {
    return this.attacks.find(a => a.active && a.attackerId === attackerId && a.defenderId === defenderId);
  }

  countActiveWars(ownerId) {
    let n = 0;
    for (const a of this.attacks) {
      if (!a.active) continue;
      if (a.attackerId === ownerId || a.defenderId === ownerId) n++;
    }
    return n;
  }

  tick(dt) {
    // 1) 제안 수집
    const byCell = new Map();
    for (const atk of this.attacks) {
      if (!atk.active) continue;
      const proposals = atk.step(dt);
      for (const p of proposals) {
        const prev = byCell.get(p.cell);
        if (prev === undefined) byCell.set(p.cell, p);
        else if (this.beats(p, prev)) byCell.set(p.cell, p);
      }
    }

    if (byCell.size === 0) {
      this.prune();
      return;
    }

    // 2) 공격별 승리 셀 묶기
    const wins = new Map();
    for (const p of byCell.values()) {
      let list = wins.get(p.attack);
      if (!list) { list = []; wins.set(p.attack, list); }
      list.push(p);
    }

    // 3) 일괄 반영
    for (const [atk, cells] of wins) atk.commit(cells);
    this.prune();
  }

  /**
   * 같은 셀을 두 공격이 노렸을 때의 우선순위.
   *  1) 전선 도달 거리가 더 가까운 쪽
   *  2) 남은 투자량이 더 큰 쪽
   *  3) 결정론적 해시
   */
  beats(a, b) {
    if (Math.abs(a.d - b.d) > 1e-6) return a.d < b.d;
    const ba = a.attack.remainingBudget, bb = b.attack.remainingBudget;
    if (Math.abs(ba - bb) > 1e-6) return ba > bb;
    return hash2(a.cell, a.attack.id) > hash2(b.cell, b.attack.id);
  }

  prune() {
    if (this.attacks.length === 0) return;
    let write = 0;
    for (let i = 0; i < this.attacks.length; i++) {
      if (this.attacks[i].active) this.attacks[write++] = this.attacks[i];
    }
    this.attacks.length = write;
  }
}
