/**
 * 인수인계 문서 23장 "반드시 검증해야 할 테스트 케이스" 자동 검증.
 *
 *   node tests/front.test.mjs
 *
 * 렌더링/DOM 없이 엔진 모듈만 불러와 합성 지도 위에서 돌린다.
 * 전선 형상이 무너지면 다른 기능을 붙이기 전에 여기서 먼저 걸린다.
 */
import { MapGrid, LAND, WATER } from '../src/game/MapGrid.js';
import { Game } from '../src/game/Game.js';
import { CONFIG } from '../src/config.js';
import { findInvasionRoute } from '../src/combat/SeaRoutes.js';
import { Fleet } from '../src/combat/NavalFleet.js';
import { resolveNavalCombat } from '../src/combat/NavalCombat.js';

let passed = 0, failed = 0;
const results = [];

function check(name, ok, detail) {
  if (ok) { passed++; results.push(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; results.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function section(title) { results.push(`\n${title}`); }

// ---- 헬퍼 -------------------------------------------------------------------

function blankMap(W, H, isLand = () => true) {
  const map = new MapGrid(W, H);
  let land = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const l = isLand(x, y);
      map.terrain[map.idx(x, y)] = l ? LAND : WATER;
      if (l) land++;
    }
  }
  map.landCells = land;
  return map;
}

function newGame(map) {
  const g = new Game({ seed: 12345, map, manualSetup: true, aiEnabled: false });
  g.addCountry(1, 'A', [235, 84, 72], true);
  g.addCountry(2, 'B', [70, 150, 235]);
  g.addCountry(3, 'C', [246, 190, 60]);
  return g;
}

function paint(g, ownerId, pred) {
  const map = g.map;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const i = map.idx(x, y);
      if (map.terrain[i] !== LAND) continue;
      if (pred(x, y)) g.transferCell(i, ownerId);
    }
  }
}

/** 공격만 진행시킨다 (경제/AI 제외) */
function runAttack(g, seconds, dt = 1 / 30) {
  for (let t = 0; t < seconds; t += dt) g.attacks.tick(dt);
}

/** 각 행에서 공격자가 차지한 가장 오른쪽 x (왼쪽에서 오른쪽으로 미는 시나리오용) */
function frontierPerRow(g, ownerId) {
  const map = g.map, out = [];
  for (let y = 0; y < map.height; y++) {
    let f = -1;
    for (let x = 0; x < map.width; x++) {
      if (map.terrain[map.idx(x, y)] === LAND && map.owner[map.idx(x, y)] === ownerId) f = x;
    }
    out.push(f);
  }
  return out;
}

function stats(arr) {
  const v = arr.filter(n => Number.isFinite(n));
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return { mean, sd, min: Math.min(...v), max: Math.max(...v) };
}

function countOwned(g, ownerId) {
  let n = 0;
  for (let i = 0; i < g.map.owner.length; i++) {
    if (g.map.terrain[i] === LAND && g.map.owner[i] === ownerId) n++;
  }
  return n;
}

// ---- 23.1 전선 형상 ----------------------------------------------------------

section('23.1 전선 형상');

// Case A: 직선 국경이 균일하게 밀리는가
{
  const W = 100, H = 60, SPLIT = 40;
  const g = newGame(blankMap(W, H));
  paint(g, 1, (x) => x < SPLIT);
  paint(g, 2, (x) => x >= SPLIT);
  g.recomputeBorders();
  g.countries[1].balance = 900;
  g.countries[2].balance = g.countries[2].landCount * 1.0;

  const before = frontierPerRow(g, 1);
  g.launchAttack(1, 2, 1.0);
  runAttack(g, 8);
  const after = frontierPerRow(g, 1);

  const delta = after.map((v, i) => v - before[i]);
  const s = stats(delta);
  check('Case A 직선 국경 전진', s.mean > 3, `평균 ${s.mean.toFixed(1)}셀 전진`);
  check('Case A 균일성 (표준편차 < 평균의 35%)', s.sd < s.mean * 0.35,
    `sd ${s.sd.toFixed(2)} / mean ${s.mean.toFixed(2)}`);
}

// Case B: 굽은 국경이 곡률을 유지하며 이동하는가
{
  const W = 100, H = 60;
  const shape = (y) => 40 + Math.round(7 * Math.sin(y / 5));
  const g = newGame(blankMap(W, H));
  paint(g, 1, (x, y) => x < shape(y));
  paint(g, 2, (x, y) => x >= shape(y));
  g.recomputeBorders();
  g.countries[1].balance = 900;
  g.countries[2].balance = g.countries[2].landCount * 1.0;

  const before = frontierPerRow(g, 1);
  g.launchAttack(1, 2, 1.0);
  runAttack(g, 8);
  const after = frontierPerRow(g, 1);

  const delta = after.map((v, i) => v - before[i]);
  const s = stats(delta);
  // 전진량이 행마다 거의 같다 = 원래 굽은 형상이 그대로 평행 이동했다는 뜻
  check('Case B 굽은 국경 전진', s.mean > 3, `평균 ${s.mean.toFixed(1)}셀 전진`);
  check('Case B 곡률 보존 (전진량 sd < 평균의 40%)', s.sd < s.mean * 0.40,
    `sd ${s.sd.toFixed(2)} / mean ${s.mean.toFixed(2)}`);
}

// Case C / D: 좁은 전선은 깊게, 넓은 전선은 얕게
{
  function depthFor(corridorHeight) {
    const W = 120, H = 60, SPLIT = 40;
    const y0 = (H - corridorHeight) >> 1, y1 = y0 + corridorHeight;
    const g = newGame(blankMap(W, H, (x, y) => y >= y0 && y < y1));
    paint(g, 1, (x) => x < SPLIT);
    paint(g, 2, (x) => x >= SPLIT);
    g.recomputeBorders();
    g.countries[1].balance = 400;
    g.countries[2].balance = g.countries[2].landCount * 1.0;  // 밀도를 양쪽 동일하게
    const before = frontierPerRow(g, 1);
    g.launchAttack(1, 2, 1.0);
    runAttack(g, 20);
    const after = frontierPerRow(g, 1);
    const delta = after.map((v, i) => v - before[i]).filter((v, i) => before[i] >= 0);
    return stats(delta).mean;
  }
  const narrow = depthFor(6);
  const wide = depthFor(60);
  check('Case C/D 좁은 전선이 더 깊게 파고든다', narrow > wide * 2.5,
    `좁음 ${narrow.toFixed(1)}셀 vs 넓음 ${wide.toFixed(1)}셀`);
}

// Case E: 포위된 영토가 사방에서 압축되는가 (별도 포위 보너스 없이)
{
  const W = 90, H = 90, CX = 45, CY = 45, R = 18;
  const g = newGame(blankMap(W, H));
  paint(g, 1, () => true);
  paint(g, 2, (x, y) => (x - CX) ** 2 + (y - CY) ** 2 <= R * R);
  g.recomputeBorders();
  g.countries[1].balance = 2000;
  g.countries[2].balance = g.countries[2].landCount * 1.0;

  const beforeArea = countOwned(g, 2);
  g.launchAttack(1, 2, 1.0);
  runAttack(g, 6);
  const afterArea = countOwned(g, 2);

  // 남은 영토의 사방 여유가 고르게 줄었는지 (원형 유지)
  const map = g.map;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const radii = dirs.map(([dx, dy]) => {
    let r = 0;
    while (r < 60) {
      const x = CX + dx * r, y = CY + dy * r;
      if (!map.inBounds(x, y) || map.owner[map.idx(x, y)] !== 2) break;
      r++;
    }
    return r;
  });
  const rs = stats(radii);
  check('Case E 포위 시 면적 감소', afterArea < beforeArea * 0.75,
    `${beforeArea} → ${afterArea} 셀`);
  check('Case E 사방 균등 압축 (반경 sd < 평균의 25%)', rs.sd < rs.mean * 0.25,
    `반경 ${radii.join('/')} (sd ${rs.sd.toFixed(2)})`);
}

// Case F: 한 덩어리에서 사방으로 퍼질 때 둥글게 자라는가 (중립 확장 = 초반 내내 보는 화면)
//
// 문서 8.1 "잘못된 방식 B" 가 경고한 마름모/계단 현상을 잡는 케이스다.
// 직선 국경 테스트만으로는 격자 이방성이 드러나지 않는다.
// 지표: 점유 셀 수 / 바운딩 박스 넓이.  원 = 0.785, 팔각형 = 0.707, 마름모 = 0.50
{
  const W = 200, H = 200, CX = 100, CY = 100;
  const g = newGame(blankMap(W, H));
  paint(g, 1, (x, y) => (x - CX) ** 2 + (y - CY) ** 2 <= 9);
  g.recomputeBorders();
  g.countries[1].balance = 6000;
  g.launchExpansion(1, 1.0);
  runAttack(g, 40);

  const map = g.map;
  let n = 0, minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
  for (let i = 0; i < map.owner.length; i++) {
    if (map.owner[i] !== 1) continue;
    n++;
    const x = map.xOf(i), y = map.yOf(i);
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  const fill = n / ((maxx - minx + 1) * (maxy - miny + 1));
  check('Case F 중립 확장이 마름모가 아니다', fill > 0.62,
    `bbox 충전율 ${fill.toFixed(3)} (마름모 0.50)`);
  check('Case F 중립 확장이 원에 가깝다', fill > 0.73,
    `bbox 충전율 ${fill.toFixed(3)} (팔각형 0.707, 원 0.785)`);

  const wide = maxx - minx + 1, tall = maxy - miny + 1;
  check('Case F 가로세로가 대칭이다', Math.abs(wide - tall) <= Math.max(3, wide * 0.06),
    `${wide} x ${tall}`);
}

// ---- 23.2 참호 --------------------------------------------------------------

section('23.2 참호');

// Case A: 국경 절반에만 참호 → 참호 없는 쪽이 먼저 밀린다
{
  const W = 100, H = 60, SPLIT = 40;
  const g = newGame(blankMap(W, H));
  paint(g, 1, (x) => x < SPLIT);
  paint(g, 2, (x) => x >= SPLIT);

  // 위쪽 절반의 국경 edge(세로 edge x=SPLIT)만 참호로 막는다
  for (let y = 0; y < H / 2; y++) g.map.setEdge({ horizontal: false, key: y * W + SPLIT, lx: SPLIT, ly: y });

  g.recomputeBorders();
  g.countries[1].balance = 900;
  g.countries[2].balance = g.countries[2].landCount * 1.0;

  const before = frontierPerRow(g, 1);
  g.launchAttack(1, 2, 1.0);
  runAttack(g, 8);
  const after = frontierPerRow(g, 1);
  const delta = after.map((v, i) => v - before[i]);

  const trenched = stats(delta.slice(2, H / 2 - 2));
  const open = stats(delta.slice(H / 2 + 2, H - 2));
  check('참호 Case A 참호 구간이 더 늦게 밀린다', trenched.mean < open.mean * 0.85,
    `참호 ${trenched.mean.toFixed(1)}셀 vs 무참호 ${open.mean.toFixed(1)}셀`);
  check('참호 Case A 돌출부 형성 (차이 1셀 이상)', open.mean - trenched.mean >= 1,
    `차이 ${(open.mean - trenched.mean).toFixed(2)}셀`);
}

// Case B: 참호 양 끝을 우회할 수 있으면 전선이 옆으로 돈다
{
  const W = 100, H = 60, SPLIT = 40;
  const g = newGame(blankMap(W, H));
  paint(g, 1, (x) => x < SPLIT);
  paint(g, 2, (x) => x >= SPLIT);
  // 가운데 20칸만 참호
  for (let y = 20; y < 40; y++) g.map.setEdge({ horizontal: false, key: y * W + SPLIT, lx: SPLIT, ly: y });
  g.recomputeBorders();
  g.countries[1].balance = 900;
  g.countries[2].balance = g.countries[2].landCount * 1.0;

  g.launchAttack(1, 2, 1.0);
  runAttack(g, 10);
  const after = frontierPerRow(g, 1);
  const mid = stats(after.slice(24, 36));
  const side = stats([...after.slice(4, 16), ...after.slice(44, 56)]);
  check('참호 Case B 측면 우회가 더 빠르다', side.mean > mid.mean,
    `측면 x=${side.mean.toFixed(1)} vs 중앙 x=${mid.mean.toFixed(1)}`);
}

// 참호가 edge 배열에만 저장되는지 (셀 속성으로 새지 않는지)
{
  const g = newGame(blankMap(20, 20));
  paint(g, 1, (x) => x < 10);
  paint(g, 2, (x) => x >= 10);
  const before = g.map.trenchEdges.length;
  g.buildTrench(1, { x: 10, y: 4 }, { x: 10, y: 12 });
  const built = g.map.trenchEdges.length - before;
  const cellLayerTouched = g.map.city.some(v => v) || g.map.fort.some(v => v);
  check('참호는 edge 레이어에만 기록된다', built === 8 && !cellLayerTouched,
    `edge ${built}개 설치, 시설 레이어 변화 없음`);
}

// ---- 23.3 방어기지 ------------------------------------------------------------

section('23.3 방어기지');

{
  const W = 100, H = 60, SPLIT = 40;
  const g = newGame(blankMap(W, H));
  paint(g, 1, (x) => x < SPLIT);
  paint(g, 2, (x) => x >= SPLIT);
  g.recomputeBorders();
  g.countries[1].balance = 900;
  g.countries[2].balance = g.countries[2].landCount * 1.0;

  // 수비측 국경 한가운데에 방어기지
  const fortCell = g.map.idx(SPLIT + 2, 30);
  g.map.fort[fortCell] = 1;
  g.countries[2].forts.push(fortCell);

  const before = frontierPerRow(g, 1);
  g.launchAttack(1, 2, 1.0);
  runAttack(g, 8);
  const after = frontierPerRow(g, 1);
  const delta = after.map((v, i) => v - before[i]);

  const near = stats(delta.slice(27, 34));                       // 기지 영향권 안
  const far = stats([...delta.slice(2, 15), ...delta.slice(45, 58)]); // 영향권 밖
  check('기지 영향권 안이 더 느리게 밀린다', near.mean < far.mean,
    `기지 근처 ${near.mean.toFixed(1)}셀 vs 먼 곳 ${far.mean.toFixed(1)}셀`);

  // 기지가 점령되면 보너스가 사라진다
  g.transferCell(fortCell, 1);
  check('기지 점령 시 수비 보너스 이전', g.countries[2].forts.length === 0 && g.countries[1].forts.length === 1,
    '기지 소유권이 공격자에게 넘어감');
}

// ---- 23.4 해상 공격 ------------------------------------------------------------

section('23.4 해상 공격');

// Case A: 가장 가까운 자국 해안이 자동 선택되는가
{
  const W = 120, H = 60;
  // 왼쪽 대륙(x<20)과 오른쪽 대륙(x>=100), 사이는 바다
  const g = newGame(blankMap(W, H, (x) => x < 20 || x >= 100));
  paint(g, 1, (x) => x < 20);
  paint(g, 2, (x) => x >= 100);
  g.recomputeBorders();

  const target = g.map.idx(100, 30);          // 상대 해안
  const route = findInvasionRoute(g.map, 1, target);
  check('Case A 해상 경로 발견', !!route, route ? `${route.path.length}칸 항로` : '없음');
  if (route) {
    const sx = g.map.xOf(route.startCoast), sy = g.map.yOf(route.startCoast);
    check('Case A 가장 가까운 자국 해안에서 출항', sx === 19 && Math.abs(sy - 30) <= 2,
      `출항지 (${sx}, ${sy}) — 목표 정면`);
  }
}

// Case B: 섬 장애물을 우회하는가 (육지를 관통하지 않는가)
{
  const W = 120, H = 60;
  const island = (x, y) => x >= 55 && x < 68 && y >= 18 && y < 42;
  const g = newGame(blankMap(W, H, (x, y) => x < 20 || x >= 100 || island(x, y)));
  paint(g, 1, (x) => x < 20);
  paint(g, 2, (x) => x >= 100);
  g.recomputeBorders();

  const route = findInvasionRoute(g.map, 1, g.map.idx(100, 30));
  const crossesLand = route ? route.path.some(c => g.map.terrain[c] === LAND) : true;
  check('Case B 섬 우회 (경로가 육지를 통과하지 않음)', !!route && !crossesLand,
    route ? `${route.path.length}칸, 육지 통과 ${crossesLand}` : '경로 없음');
}

// Case C: 경로가 없으면 실패해야 한다
{
  const W = 60, H = 40;
  // 목표가 내륙 호수에 둘러싸인 형태: 자국은 완전히 육지에 갇혀 있음
  const g = newGame(blankMap(W, H, () => true));   // 전부 육지 = 바다 없음
  paint(g, 1, (x) => x < 20);
  paint(g, 2, (x) => x >= 40);
  g.recomputeBorders();
  const route = findInvasionRoute(g.map, 1, g.map.idx(40, 20));
  check('Case C 해상 경로 없음이 올바르게 실패', route === null, '배 버튼 비활성 조건 성립');
}

// Case D: 장거리 항해 감쇠는 0 이 되지 않는다
{
  const fleet = new Fleet(1, 100, [], { type: 'return' });
  for (let t = 0; t < 3600; t++) fleet.applyAttrition(1);   // 1시간 항해
  check('Case D 자연 감쇠는 0 이 되지 않는다',
    fleet.troops >= CONFIG.fleet.minTroops && fleet.troops < 100,
    `1시간 뒤 병력 ${fleet.troops.toFixed(2)} (floor ${CONFIG.fleet.minTroops})`);

  const short = new Fleet(1, 100, [], { type: 'return' });
  short.applyAttrition(30);
  check('Case D 짧은 항해 손실은 미미하다', short.troops > 80,
    `30초 뒤 ${short.troops.toFixed(1)} / 100`);
}

// Case E: 상륙에 추가 페널티가 없는가 (육상과 같은 식)
{
  const W = 60, H = 40;
  const g = newGame(blankMap(W, H, (x) => x < 10 || x >= 40));
  paint(g, 1, (x) => x < 10);
  paint(g, 2, (x) => x >= 40);
  g.recomputeBorders();
  g.countries[2].balance = g.countries[2].landCount * 1.0;   // 밀도 1.0

  const target = g.map.idx(40, 20);
  const expected = CONFIG.combat.attackDefenseRatio * 1.0;    // 육상과 동일한 식
  const fleet = new Fleet(1, expected + 0.5, [], { type: 'invade', targetCell: target });
  g.fleets.add(fleet);
  g.resolveLanding(fleet);
  check('Case E 상륙 비용 = 육상 비용 (추가 페널티 없음)',
    g.map.owner[target] === 1,
    `병력 ${(expected + 0.5).toFixed(2)} 로 비용 ${expected.toFixed(2)} 셀 점령 성공`);
}

// ---- 23.5 요격 / 해상전 ---------------------------------------------------------

section('23.5 요격 / 해상전');

{
  const W = 60, H = 40;
  const g = newGame(blankMap(W, H, (x) => x < 10 || x >= 50));
  paint(g, 1, (x) => x < 10);
  paint(g, 2, (x) => x >= 50);
  g.recomputeBorders();

  const big = new Fleet(1, 100, [], { type: 'intercept', targetFleetId: 0 });
  const small = new Fleet(2, 40, [], { type: 'invade', targetCell: g.map.idx(9, 20) });
  big.x = 30; big.y = 20;
  small.x = 30.5; small.y = 20;
  big.mission.targetFleetId = small.id;
  g.fleets.add(big); g.fleets.add(small);
  resolveNavalCombat(g, 1 / 30);

  check('해상전 loss = min(A,B)', Math.round(big.troops) === 60 && small.troops <= 0,
    `100 vs 40 → ${Math.round(big.troops)} vs ${Math.round(small.troops)}`);
  check('패배한 함대는 제거된다', small.alive === false, '작은 함대 소멸');
  check('요격 승리 후 귀환 임무로 전환', big.alive && big.mission.type === 'return',
    `임무 ${big.mission.type}`);

  // 귀환 완료 시 남은 병력이 Balance 로 돌아온다
  const before = g.countries[1].balance;
  const troops = big.troops;
  g.resolveReturn(big);
  check('귀환한 함대 병력은 Balance 로 복귀',
    Math.abs(g.countries[1].balance - (before + troops)) < 1e-6,
    `${Math.round(before)} → ${Math.round(g.countries[1].balance)}`);
}

// 요격 대상이 도달 불가한 물에 있으면 출항하지 않는다
{
  const W = 60, H = 40;
  // 왼쪽 바다와 오른쪽 내륙 호수가 서로 이어지지 않는 지형
  const g = newGame(blankMap(W, H, (x, y) => !(x < 10 || (x > 30 && x < 40 && y > 10 && y < 30))));
  paint(g, 1, (x) => x >= 10 && x < 25);
  g.recomputeBorders();
  g.countries[1].balance = 500;

  const lakeFleet = new Fleet(2, 50, [], { type: 'return' });
  lakeFleet.placeAt(g.map, g.map.idx(35, 20));
  g.fleets.add(lakeFleet);

  const res = g.launchIntercept(1, lakeFleet, 0.5);
  check('도달 불가한 함대는 요격 출항 불가', res.error === 'no-route', `error=${res.error}`);
  check('요격 실패 시 Balance 미소모', g.countries[1].balance === 500,
    `balance ${g.countries[1].balance}`);
}

// ---- 23.6 UI 규칙 (엔진 레벨 판정) ---------------------------------------------

section('23.6 UI 규칙');

{
  const W = 80, H = 40;
  const g = newGame(blankMap(W, H, (x) => x < 20 || x >= 60));
  paint(g, 1, (x) => x < 20);
  paint(g, 2, (x) => x >= 60);
  g.recomputeBorders();
  g.countries[1].balance = 500;

  const res = g.launchAttack(1, 2, 0.5);
  check('비접경 국가는 육상 공격 불가', res.error === 'no-border', `error=${res.error}`);
  check('비접경이어도 Balance 는 소모되지 않는다', g.countries[1].balance === 500,
    `balance ${g.countries[1].balance}`);

  // 해안 판정
  check('해안 셀 판정', g.map.isCoast(g.map.idx(60, 20)) && !g.map.isCoast(g.map.idx(70, 20)),
    'x=60 은 해안, x=70 은 내륙');
}

// 동시 공격이 처리 순서에 따라 편향되지 않는가 (18.5)
{
  const W = 90, H = 60;
  const g = newGame(blankMap(W, H));
  paint(g, 2, () => true);
  paint(g, 1, (x) => x < 20);
  paint(g, 3, (x) => x >= 70);
  g.recomputeBorders();
  g.countries[1].balance = 600;
  g.countries[3].balance = 600;
  g.countries[2].balance = g.countries[2].landCount * 1.0;

  const before1 = countOwned(g, 1), before3 = countOwned(g, 3);
  g.launchAttack(1, 2, 1.0);
  g.launchAttack(3, 2, 1.0);
  runAttack(g, 8);
  const gain1 = countOwned(g, 1) - before1;
  const gain3 = countOwned(g, 3) - before3;
  const ratio = Math.min(gain1, gain3) / Math.max(gain1, gain3);
  check('동시 공격이 대칭적으로 진행된다 (편향 < 15%)', ratio > 0.85,
    `A ${gain1}셀 vs C ${gain3}셀 (비 ${(ratio * 100).toFixed(1)}%)`);
}

// 전선 속도와 전투량이 분리되어 있는가 (8.8)
{
  const W = 120, H = 40, SPLIT = 30;
  const g = newGame(blankMap(W, H));
  paint(g, 1, (x) => x < SPLIT);
  paint(g, 2, (x) => x >= SPLIT);
  g.recomputeBorders();
  g.countries[1].balance = 100000;              // 압도적 물량
  g.countries[2].balance = g.countries[2].landCount * 1.0;

  const before = frontierPerRow(g, 1);
  g.launchAttack(1, 2, 1.0);
  runAttack(g, 1.0);                            // 1초만
  const after = frontierPerRow(g, 1);
  const s = stats(after.map((v, i) => v - before[i]));
  const cap = CONFIG.combat.visibleFrontSpeed * 1.0 + 2;
  check('큰 공격도 1초에 전선 속도 제한을 넘지 않는다', s.max <= cap,
    `최대 ${s.max}셀 (제한 ~${cap.toFixed(1)}셀)`);
}

// ---- 결과 -------------------------------------------------------------------

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
