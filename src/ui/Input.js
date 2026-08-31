import { CONFIG } from '../config.js';
import { planTrench, snapToLattice } from '../structures/TrenchEdges.js';

/**
 * 포인터 입력.
 * 모바일 기준: 한 손가락 드래그 = 지도 이동, 두 손가락 = 핀치 줌, 짧은 탭 = 선택.
 * 참호 모드에서만 한 손가락 드래그가 선 그리기로 바뀐다 (인수인계 15.3).
 */
export class Input {
  constructor(canvas, camera, game, ui, callbacks) {
    this.canvas = canvas;
    this.camera = camera;
    this.game = game;
    this.ui = ui;
    this.cb = callbacks;

    this.pointers = new Map();
    this.dragging = false;
    this.moved = 0;
    this.downTime = 0;
    this.pinchDist = 0;
    this.trenchStart = null;

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('pointerleave', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  onDown = (e) => {
    this.canvas.setPointerCapture?.(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.trenchStart = null;
      this.ui.trenchPreview = null;
      return;
    }

    this.dragging = true;
    this.moved = 0;
    this.downTime = performance.now();
    this.last = p;

    if (this.ui.buildMode === 'trench') {
      const m = this.camera.screenToMap(p.x, p.y);
      this.trenchStart = snapToLattice(this.game.map, m.x, m.y);
    }
  };

  onMove = (e) => {
    const p = this.local(e);
    if (!this.pointers.has(e.pointerId)) {
      // 마우스 hover: 건설 커서 위치만 갱신
      this.ui.hoverCell = this.camera.cellAt(p.x, p.y);
      return;
    }
    this.pointers.set(e.pointerId, p);

    if (this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchDist > 0 && d > 0) {
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.camera.zoomAt(mid.x, mid.y, d / this.pinchDist);
      }
      this.pinchDist = d;
      return;
    }

    if (!this.dragging) return;
    const dx = p.x - this.last.x, dy = p.y - this.last.y;
    this.moved += Math.hypot(dx, dy);
    this.last = p;
    this.ui.hoverCell = this.camera.cellAt(p.x, p.y);

    if (this.ui.buildMode === 'trench' && this.trenchStart) {
      const m = this.camera.screenToMap(p.x, p.y);
      const end = snapToLattice(this.game.map, m.x, m.y);
      const plan = planTrench(this.game.map, this.game.playerId, this.trenchStart, end);
      this.ui.trenchPreview = { from: this.trenchStart, to: end, plan };
      this.cb.onTrenchPreview?.(plan);
      return;
    }

    this.camera.panByScreen(dx, dy);
  };

  onUp = (e) => {
    const had = this.pointers.delete(e.pointerId);
    if (!had) return;

    if (this.pointers.size >= 1) { this.pinchDist = 0; return; }

    const wasTrench = this.ui.buildMode === 'trench' && this.trenchStart;
    const elapsed = performance.now() - this.downTime;
    const tapped = this.moved < CONFIG.ui.tapSlopPx && elapsed < CONFIG.ui.tapMaxMs;

    if (wasTrench) {
      const preview = this.ui.trenchPreview;
      this.trenchStart = null;
      this.ui.trenchPreview = null;
      if (preview && preview.plan.buildableCount > 0) {
        this.cb.onTrenchCommit?.(preview);
      } else {
        this.cb.onTrenchCancel?.();
      }
    } else if (tapped && this.last) {
      this.cb.onTap?.(this.last.x, this.last.y);
    }

    this.dragging = false;
    this.pinchDist = 0;
  };

  onWheel = (e) => {
    e.preventDefault();
    const p = this.local(e);
    this.camera.zoomAt(p.x, p.y, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  };
}
