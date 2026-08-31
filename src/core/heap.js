/**
 * 숫자 키 최소 힙.
 * 셀 인덱스와 거리(cost)를 병렬 배열로 들고 있어 객체 할당을 피한다.
 * wavefront 전선 큐와 해상 Dijkstra 양쪽에서 쓴다.
 */
export class MinHeap {
  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
    this.size = 0;
  }

  get length() { return this.size; }

  clear() { this.size = 0; }

  _grow() {
    const k = new Float64Array(this.keys.length * 2);
    const v = new Int32Array(this.vals.length * 2);
    k.set(this.keys); v.set(this.vals);
    this.keys = k; this.vals = v;
  }

  push(key, val) {
    if (this.size === this.keys.length) this._grow();
    let i = this.size++;
    this.keys[i] = key; this.vals[i] = val;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this._swap(p, i);
      i = p;
    }
  }

  peekKey() { return this.size > 0 ? this.keys[0] : Infinity; }
  peekVal() { return this.vals[0]; }

  pop() {
    const top = this.vals[0];
    this.size--;
    if (this.size > 0) {
      this.keys[0] = this.keys[this.size];
      this.vals[0] = this.vals[this.size];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.size && this.keys[l] < this.keys[m]) m = l;
        if (r < this.size && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this._swap(m, i);
        i = m;
      }
    }
    return top;
  }

  _swap(a, b) {
    const k = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = k;
    const v = this.vals[a]; this.vals[a] = this.vals[b]; this.vals[b] = v;
  }
}
