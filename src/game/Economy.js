import { CONFIG } from '../config.js';

/**
 * Balance 성장.
 * 영토와 도시가 정하는 상한을 향해 점근하도록 만들어서
 * 무한 축적 대신 "확장해야 성장한다"는 압력을 만든다.
 */
export function balanceCap(country) {
  const e = CONFIG.economy;
  return e.capBase + e.capPerCell * country.landCount + e.capPerCity * country.cities.length;
}

export function incomeRate(country) {
  const e = CONFIG.economy;
  let rate = e.baseIncome
    + e.incomePerCell * country.landCount
    + e.incomePerCity * country.cities.length;
  if (country.hasCapital) rate *= (1 + e.capitalIncomeBonus);
  return rate;
}

export function tickEconomy(country, dt) {
  if (!country.alive) return;
  const cap = balanceCap(country);
  const room = Math.max(0, 1 - country.balance / cap);
  country.balance += incomeRate(country) * room * dt;
  if (country.balance > cap) country.balance = cap;
  if (country.balance < 0) country.balance = 0;
}
