import { CONFIG } from '../config.js';

/** 지도 좌표(셀) <-> 화면 좌표(CSS 픽셀) 변환 및 팬/줌 */
export class Camera {
  constructor(map) {
    this.map = map;
    this.scale = 2;
    this.x = 0;   // 화면 좌상단이 가리키는 지도 좌표
    this.y = 0;
    this.viewW = 1;
    this.viewH = 1;
  }

  resize(w, h) {
    this.viewW = w;
    this.viewH = h;
    this.clamp();
  }

  fit() {
    const s = Math.min(this.viewW / this.map.width, this.viewH / this.map.height);
    this.scale = Math.max(CONFIG.ui.minZoom, s);
    this.x = (this.map.width - this.viewW / this.scale) / 2;
    this.y = (this.map.height - this.viewH / this.scale) / 2;
    this.clamp();
  }

  /** 지도의 특정 지점을 화면 중앙에 둔다 */
  centerOn(mx, my, scale) {
    if (scale) this.scale = Math.max(CONFIG.ui.minZoom, Math.min(CONFIG.ui.maxZoom, scale));
    this.x = mx - this.viewW / this.scale / 2;
    this.y = my - this.viewH / this.scale / 2;
    this.clamp();
  }

  clamp() {
    const visW = this.viewW / this.scale;
    const visH = this.viewH / this.scale;
    if (visW >= this.map.width) this.x = (this.map.width - visW) / 2;
    else this.x = Math.max(0, Math.min(this.map.width - visW, this.x));
    if (visH >= this.map.height) this.y = (this.map.height - visH) / 2;
    else this.y = Math.max(0, Math.min(this.map.height - visH, this.y));
  }

  panByScreen(dxPx, dyPx) {
    this.x -= dxPx / this.scale;
    this.y -= dyPx / this.scale;
    this.clamp();
  }

  /** 화면상의 한 점을 고정한 채 확대/축소 */
  zoomAt(px, py, factor) {
    const before = this.screenToMap(px, py);
    this.scale = Math.max(CONFIG.ui.minZoom, Math.min(CONFIG.ui.maxZoom, this.scale * factor));
    const after = this.screenToMap(px, py);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.clamp();
  }

  screenToMap(px, py) {
    return { x: this.x + px / this.scale, y: this.y + py / this.scale };
  }

  mapToScreen(mx, my) {
    return { x: (mx - this.x) * this.scale, y: (my - this.y) * this.scale };
  }

  /** 화면 좌표에 해당하는 셀 인덱스. 지도 밖이면 -1 */
  cellAt(px, py) {
    const m = this.screenToMap(px, py);
    const x = Math.floor(m.x), y = Math.floor(m.y);
    if (!this.map.inBounds(x, y)) return -1;
    return this.map.idx(x, y);
  }
}
