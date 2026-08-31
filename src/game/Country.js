import { CONFIG } from '../config.js';

/**
 * 한 국가의 상태.
 * 별도 공격력/방어력/HP 스탯은 존재하지 않는다 (인수인계 2.4).
 * 전투 능력은 오직 balance 와 영토 면적에서 파생된다.
 */
export class Country {
  constructor(id, name, color, isPlayer) {
    this.id = id;
    this.name = name;
    this.color = color;          // [r,g,b]
    this.isPlayer = isPlayer;
    this.balance = 40;
    this.landCount = 0;
    this.cities = [];            // 셀 인덱스 (수도 포함)
    this.forts = [];             // 셀 인덱스
    this.capitalCell = -1;
    this.alive = true;
    this.difficulty = 'normal';
    this.thinkTimer = 0;
  }

  get hasCapital() {
    return this.capitalCell >= 0;
  }

  /** 다음 도시 건설 비용. 지을수록 오른다 (인수인계 4.3). */
  nextCityCost() {
    const extra = Math.max(0, this.cities.length - 1); // 수도는 건설한 것이 아님
    return Math.round(CONFIG.city.baseCost * Math.pow(CONFIG.city.costGrowth, extra));
  }

  fortCost() {
    return CONFIG.fort.cost;
  }

  /**
   * 셀당 수비 밀도.
   * 같은 balance 라도 영토가 넓으면 전선이 더 쉽게 밀린다 (인수인계 9.3).
   */
  defenseDensity() {
    if (this.landCount <= 0) return CONFIG.combat.minDefenseDensity;
    return Math.max(CONFIG.combat.minDefenseDensity, this.balance / this.landCount);
  }

  cssColor(alpha = 1) {
    const [r, g, b] = this.color;
    return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
  }
}

/** 국가 팔레트. 0번은 중립 자리 표시자. */
export const COUNTRY_COLORS = [
  [90, 100, 112],    // 중립 (사용되지 않음)
  [235, 84, 72],     // 플레이어 - 빨강
  [70, 150, 235],
  [246, 190, 60],
  [120, 205, 120],
  [190, 110, 225],
  [250, 145, 60],
  [60, 205, 200],
  [225, 110, 165],
  [150, 160, 90],
  [110, 120, 240],
];

export const COUNTRY_NAMES = [
  '중립', '플레이어', '청연', '금하', '녹평', '자운',
  '적양', '벽수', '홍매', '황사', '남천',
];
