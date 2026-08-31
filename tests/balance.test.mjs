/**
 * 밸런스 / AI 회귀 테스트.
 *
 *   node tests/balance.test.mjs
 *
 * front.test.mjs 가 "전선 알고리즘이 맞는가"를 본다면, 여기서는
 * "실제로 한 판이 성립하는가"를 본다. 전체 시뮬레이션을 돌리므로 조금 느리다.
 */
import { Game } from '../src/game/Game.js';
import { seedFromString } from '../src/core/rng.js';
import { MapGrid, LAND, WATER } from '../src/game/MapGrid.js';
import { CONFIG } from '../src/config.js';
import { NEUTRAL } from '../src/game/MapGrid.js';

let passed = 0, failed = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { passed++; results.push(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; results.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { results.push(`\n${t}`); }

const SEEDS = ['live', 'demo1', 'a', 'b', 'hello', 'kim', 'zzz', 'q1'];

function run(seed, difficulty, seconds, onTick) {
  const g = new Game({ seed: seedFromString(seed), difficulty, aiCount: 6 });
  for (let t = 0; t < seconds && !g.over; t += 1 / 30) {
    g.tick(1 / 30);
    if (onTick) onTick(g);
  }
  return g;
}

// ---- 초반 안정성 --------------------------------------------------------------

section('초반 안정성');

{
  // 아무 것도 하지 않는 플레이어가 개전 45초 만에 지워지면 게임이 성립하지 않는다.
  let earlyDeaths = 0, playerDeaths = 0;
  for (const s of SEEDS) {
    const g = run(s, 'normal', 45);
    if (g.events.some(e => e.text.includes('멸망'))) earlyDeaths++;
    if (!g.countries[1].alive) playerDeaths++;
  }
  check('45초 안에 멸망하는 국가 없음', earlyDeaths === 0, `${earlyDeaths}/${SEEDS.length} 시드에서 발생`);
  check('45초 안에 플레이어가 죽지 않음', playerDeaths === 0, `${playerDeaths}/${SEEDS.length} 시드`);
}

{
  // 해상 원정은 중반 옵션이어야 한다. 초반엔 아무도 육상 접경이 없어서
  // 모든 나라가 "비접경 약한 적"으로 잡히는데, 그때 원정을 나가면 안 된다.
  let earlyLandings = 0;
  for (const s of SEEDS) {
    const g = run(s, 'normal', 40);
    earlyLandings += g.events.filter(e => e.text.includes('상륙')).length;
  }
  check('개전 40초 안에는 AI 해상 원정이 없다', earlyLandings === 0, `상륙 이벤트 ${earlyLandings}건`);
}

// ---- 죽음의 나선 방지 ----------------------------------------------------------

section('죽음의 나선 방지');

{
  // Balance 를 다 써 버린 나라도 최소한 중립 땅만큼은 비싸야 한다.
  // 그렇지 않으면 작은 상륙 하나가 대국을 통째로 쓸어버린다.
  const W = 120, H = 60, SPLIT = 40;
  const map = new MapGrid(W, H);
  map.terrain.fill(LAND);
  map.landCells = W * H;
  const g = new Game({ seed: 1, map, manualSetup: true, aiEnabled: false });
  g.addCountry(1, 'A', [255, 0, 0], true);
  g.addCountry(2, 'B', [0, 0, 255]);
  for (let i = 0; i < W * H; i++) g.transferCell(i, map.xOf(i) < SPLIT ? 1 : 2);
  g.recomputeBorders();

  g.countries[1].balance = 400;
  g.countries[2].balance = 0;          // 완전히 파산한 수비국
  const before = g.countries[2].landCount;
  g.launchAttack(1, 2, 1.0);
  for (let t = 0; t < 25; t += 1 / 30) g.attacks.tick(1 / 30);
  const taken = before - g.countries[2].landCount;
  const perCell = 400 / Math.max(1, taken);

  check('파산한 나라도 셀당 최소 비용을 요구한다',
    perCell >= CONFIG.combat.attackDefenseRatio * CONFIG.combat.minDefenseDensity * 0.95,
    `${taken}셀 점령, 셀당 ${perCell.toFixed(2)}`);
  check('파산한 나라가 한 번에 전멸하지 않는다', g.countries[2].landCount > 0,
    `${before} → ${g.countries[2].landCount}셀`);
}

// ---- 난이도 격차 ---------------------------------------------------------------

section('난이도 격차');

{
  // 방치된 플레이어를 기준선으로 두고, AI 가 180초 동안 지도를 얼마나 먹는지 본다.
  const share = {};
  for (const diff of ['easy', 'normal', 'hard', 'brutal']) {
    let sum = 0;
    for (const s of SEEDS) {
      const g = run(s, diff, 180);
      let ai = 0;
      for (let id = 2; id < g.countries.length; id++) {
        const c = g.countries[id];
        if (c && c.alive) ai += c.landCount;
      }
      sum += ai / g.map.landCells;
    }
    share[diff] = sum / SEEDS.length;
  }
  const fmt = (d) => `${(share[d] * 100).toFixed(1)}%`;
  check('쉬움 < 보통', share.easy < share.normal, `${fmt('easy')} < ${fmt('normal')}`);
  check('보통 < 어려움', share.normal < share.hard, `${fmt('normal')} < ${fmt('hard')}`);
  check('어려움 < 매우 어려움', share.hard < share.brutal, `${fmt('hard')} < ${fmt('brutal')}`);
  check('쉬움과 매우 어려움의 차이가 체감 가능 (15%p 이상)',
    share.brutal - share.easy >= 0.15,
    `차이 ${((share.brutal - share.easy) * 100).toFixed(1)}%p`);
}

// ---- 재현성 -------------------------------------------------------------------

section('재현성');

{
  // 같은 seed 는 항상 같은 판이어야 한다.
  // 전선 노이즈 해시에 공격 id 가 들어가므로, 그 카운터가 프로세스 전역이면
  // "앞에서 몇 판을 돌렸는지" 에 따라 결과가 달라진다.
  const play = (seed, secs) => {
    const g = new Game({ seed: seedFromString(seed), difficulty: 'hard', aiCount: 6 });
    for (let t = 0; t < secs && !g.over; t += 1 / 30) g.tick(1 / 30);
    return g.countries.filter(Boolean).map(c => `${c.name}:${c.landCount}:${Math.round(c.balance)}`).join('|');
  };
  const first = play('live', 90);
  const again = play('live', 90);
  play('hello', 30);                 // 사이에 다른 판을 끼워 넣는다
  const afterOther = play('live', 90);

  check('같은 seed 를 다시 돌리면 같은 결과', first === again);
  check('다른 판을 먼저 돌려도 결과가 같다', first === afterOther);
}

// ---- 자원 치트 없음 -------------------------------------------------------------

section('자원 치트 없음');

{
  // 난이도는 판단 품질로만 차등화한다 (인수인계 14.2). 소득 공식은 모두 같아야 한다.
  const { incomeRate, balanceCap } = await import('../src/game/Economy.js');
  const g1 = new Game({ seed: seedFromString('a'), difficulty: 'easy', aiCount: 6 });
  const g2 = new Game({ seed: seedFromString('a'), difficulty: 'brutal', aiCount: 6 });
  const same = incomeRate(g1.countries[2]) === incomeRate(g2.countries[2])
    && balanceCap(g1.countries[2]) === balanceCap(g2.countries[2])
    && g1.countries[2].balance === g2.countries[2].balance;
  check('난이도가 AI 소득/상한/시작 Balance 를 바꾸지 않는다', same,
    `소득 ${incomeRate(g1.countries[2]).toFixed(2)} 동일`);
}

// ---- 한 판이 끝나는가 -----------------------------------------------------------

section('게임 진행');

{
  // 승자가 나오거나 최소한 지도가 실제로 채워져야 한다 (교착 상태로 멈추지 않는다).
  let filled = 0;
  const cover = [];
  for (const s of SEEDS) {
    const g = run(s, 'hard', 240);
    let owned = 0;
    for (let i = 0; i < g.map.owner.length; i++) {
      if (g.map.terrain[i] === LAND && g.map.owner[i] !== NEUTRAL) owned++;
    }
    cover.push(owned / g.map.landCells);
    if (owned / g.map.landCells > 0.85) filled++;
  }
  cover.sort((a, b) => a - b);
  check('240초 안에 지도 대부분이 점유된다', filled >= SEEDS.length - 2,
    `${filled}/${SEEDS.length} 시드에서 85% 이상 (최저 ${(cover[0] * 100).toFixed(0)}%)`);
  check('가장 느린 시드도 240초에 80% 는 넘는다', cover[0] > 0.80,
    `최저 ${(cover[0] * 100).toFixed(0)}%`);
}

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
