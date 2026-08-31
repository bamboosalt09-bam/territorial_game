import { CONFIG } from '../config.js';

/**
 * 해상전 (인수인계 12.4).
 *
 * 함선 공격력/장갑/함종 같은 시스템은 만들지 않는다.
 * 두 함대가 접촉하면 서로 같은 양만큼 병력을 소모하고, 남은 쪽이 살아남는다.
 *   loss = min(A, B); A -= loss; B -= loss;
 *
 * 항해 자연 감쇠의 "절대 0 이 되지 않는다" 규칙은 여기에 적용하지 않는다.
 * 전투로는 전멸할 수 있다.
 */
export function resolveNavalCombat(game, dt) {
  const fleets = game.fleets.fleets;
  const r = CONFIG.fleet.contactRadius;
  const r2 = r * r;

  for (let i = 0; i < fleets.length; i++) {
    const a = fleets[i];
    if (!a.alive || a.troops <= 0) continue;
    for (let j = i + 1; j < fleets.length; j++) {
      const b = fleets[j];
      if (!b.alive || b.troops <= 0) continue;
      if (a.ownerId === b.ownerId) continue;
      if (game.atPeace(a.ownerId, b.ownerId)) continue;

      const dx = a.x - b.x, dy = a.y - b.y;
      if (dx * dx + dy * dy > r2) continue;

      const loss = Math.min(a.troops, b.troops);
      a.troops -= loss;
      b.troops -= loss;
      game.pushEvent(`해상전: ${game.nameOf(a.ownerId)} vs ${game.nameOf(b.ownerId)}`);

      if (a.troops <= 0.5) a.alive = false;
      if (b.troops <= 0.5) b.alive = false;

      // 요격 임무였다면 목표가 사라졌으니 귀환시킨다
      if (a.alive && a.mission.type === 'intercept' && !b.alive) game.fleets.sendHome(a);
      if (b.alive && b.mission.type === 'intercept' && !a.alive) game.fleets.sendHome(b);
      if (!a.alive) break;
    }
  }
  game.fleets.prune();
}
