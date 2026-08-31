/**
 * 밸런스 상수 모음.
 * 인수인계 문서 32장 지침에 따라 모든 수치를 한 곳에 모아 둔다.
 * 코드 안에 숫자를 흩뿌리지 말 것.
 */
export const CONFIG = {
  map: {
    width: 384,
    height: 240,
    landRatio: 0.42,      // 전체 셀 중 목표 육지 비율
    noiseScale: 0.018,    // 값이 작을수록 대륙이 커진다
    octaves: 5,
    edgeFalloff: 0.30,    // 지도 가장자리를 바다로 만드는 정도
    minIslandCells: 12,   // 이보다 작은 육지 덩어리는 제거
  },

  match: {
    aiCount: 6,
    startBlobRadius: 4,
    victoryLandShare: 0.70,
  },

  economy: {
    // Balance 는 영토/도시가 정하는 상한을 향해 점근한다.
    baseIncome: 2.5,
    incomePerCell: 0.035,
    incomePerCity: 3.0,
    capBase: 300,
    capPerCell: 1.8,
    capPerCity: 160,
    capitalIncomeBonus: 0.20,   // 수도 보유 중 소득 +20%
  },

  combat: {
    attackDefenseRatio: 2.0,   // 수비 Balance 1 을 깎는 데 공격 Balance 2
    minDefenseDensity: 1.0,    // Balance 0 인 나라도 중립 땅만큼은 비싸게 (죽음의 나선 방지)
    neutralDefense: 0.85,      // 중립 땅의 고정 수비 밀도
    visibleFrontSpeed: 5.5,    // 초당 전선 진행 깊이(셀). 전투량과 분리된 값
    // 8방향 거리 근사는 본질적으로 팔각형 ball 을 만든다 (22.5도 방향이 약 8% 눌린다).
    // 중립 확장처럼 한 덩어리에서 사방으로 퍼질 때 그 각진 면이 눈에 띈다.
    // step 마다 섞는 결정론적 노이즈를 키우면 그 면이 무너져 원에 가까워진다.
    // 실측: 0.14 -> 방사 확장 fill 0.733, 0.40 -> 0.764 (완전한 원 = 0.785).
    // 직선 국경의 균일성은 그대로다 (전진량 sd 0.50셀, 평균의 7%).
    frontNoise: 0.40,
    band: 0.35,                // 이 거리 밴드 안의 셀은 같은 tick 에 동시 처리
    maxCellsPerTick: 1200,     // 모바일 안전판
    minAttackBalance: 4,
  },

  city:   { baseCost: 90,  costGrowth: 1.22 },
  fort:   { cost: 130, defenseBonus: 0.45, radius: 7 },
  trench: {
    costPerEdge: 2.0,
    defenseBonus: 0.30,   // 참호선을 넘는 셀의 점령 Balance 비용 +30% (인수인계 6.4)
    frontDelay: 2.6,      // 참호선을 넘을 때 전선 거리에 더해지는 값 = 눈에 보이는 지연 깊이(셀)
    maxEdgesPerLine: 260,
  },

  fleet: {
    speed: 13,                 // 초당 셀
    attritionPerSecond: 0.006, // 아주 작은 지수 감쇠
    minTroops: 1,              // 자연 감쇠로는 절대 이 아래로 내려가지 않음
    contactRadius: 2.0,
    retargetInterval: 0.35,
    minLaunch: 6,
  },

  peace: {
    duration: 60,              // 초
    aiBaseAccept: 0.35,
  },

  ai: {
    easy:   { interval: [1.6, 2.6], noise: 0.55, ratioError: 0.40, naval: 0.15, intercept: 0.10, structures: 0.20, exposure: false, lookahead: false },
    normal: { interval: [1.0, 1.6], noise: 0.28, ratioError: 0.18, naval: 0.50, intercept: 0.40, structures: 0.60, exposure: false, lookahead: false },
    hard:   { interval: [0.6, 1.0], noise: 0.10, ratioError: 0.07, naval: 0.85, intercept: 0.80, structures: 0.90, exposure: true,  lookahead: false },
    brutal: { interval: [0.35, 0.6], noise: 0.03, ratioError: 0.02, naval: 1.00, intercept: 1.00, structures: 1.00, exposure: true,  lookahead: true },
  },

  ui: {
    defaultRatio: 0.5,
    tapSlopPx: 22,      // 손가락 탭은 마우스보다 훨씬 많이 흔들린다
    tapMaxMs: 1200,     // 길게 눌러도 탭. 이 게임에는 롱프레스 제스처가 없다
    fleetHitRadius: 9,   // 화면 픽셀 기준
    minZoom: 0.5,
    maxZoom: 14,
  },
};

export const DIFFICULTY_LABELS = {
  easy: '쉬움',
  normal: '보통',
  hard: '어려움',
  brutal: '매우 어려움',
};
