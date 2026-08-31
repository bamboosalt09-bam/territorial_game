/** 결정론적 난수 및 해시 유틸. 같은 seed 면 같은 지도/같은 전선 노이즈가 나온다. */

/** mulberry32 PRNG */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 정수 하나를 0..1 실수로 흩뿌리는 해시. 전선 노이즈용. */
export function hash01(n) {
  let x = (n | 0) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
}

/** 두 정수를 섞는 해시. 동시 공격 tie-break 용. */
export function hash2(a, b) {
  return hash01(Math.imul(a | 0, 0x27d4eb2d) ^ ((b | 0) + 0x9e3779b9));
}

/** seed 문자열을 32bit 정수로 */
export function seedFromString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
