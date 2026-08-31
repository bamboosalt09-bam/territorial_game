import { CONFIG } from '../config.js';
import { LAND, WATER, NEUTRAL, DX4, DY4 } from '../game/MapGrid.js';

const WATER_RGB = [22, 42, 66];
const WATER_DEEP = [15, 30, 50];
const NEUTRAL_RGB = [88, 95, 90];

/**
 * 지도는 셀 1개 = 픽셀 1개인 오프스크린 캔버스에 그린 뒤 확대해서 붙인다.
 * 소유권이 바뀐 셀만 패치하므로 모바일에서도 전체 맵을 매 프레임 다시 칠하지 않는다.
 */
export class Renderer {
  constructor(canvas, game, camera) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = game;
    this.camera = camera;

    const map = game.map;
    this.off = document.createElement('canvas');
    this.off.width = map.width;
    this.off.height = map.height;
    this.offCtx = this.off.getContext('2d');
    this.image = this.offCtx.createImageData(map.width, map.height);

    this.paintAll();
  }

  colorOf(i, out) {
    const map = this.game.map;
    if (map.terrain[i] === WATER) {
      // 육지에 가까운 물은 조금 밝게 해서 해안선이 읽히게 한다
      const x = map.xOf(i), y = map.yOf(i);
      let nearLand = false;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX4[k], ny = y + DY4[k];
        if (!map.inBounds(nx, ny)) continue;
        if (map.terrain[map.idx(nx, ny)] === LAND) { nearLand = true; break; }
      }
      const c = nearLand ? WATER_RGB : WATER_DEEP;
      out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
      return;
    }

    const owner = map.owner[i];
    let base;
    if (owner === NEUTRAL) base = NEUTRAL_RGB;
    else {
      const c = this.game.countries[owner];
      base = c ? c.color : NEUTRAL_RGB;
    }

    // 국경/해안은 어둡게 칠해 윤곽을 만든다
    const x = map.xOf(i), y = map.yOf(i);
    let edge = false;
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!map.inBounds(nx, ny)) { edge = true; break; }
      const j = map.idx(nx, ny);
      if (map.terrain[j] === WATER || map.owner[j] !== owner) { edge = true; break; }
    }
    if (edge && owner === this.game.playerId) {
      // 내 나라만 테두리를 밝게 빼서, 여러 색이 섞인 지도에서도 즉시 구분되게 한다
      out[0] = base[0] * 0.6 + 255 * 0.4;
      out[1] = base[1] * 0.6 + 255 * 0.4;
      out[2] = base[2] * 0.6 + 255 * 0.4;
      return;
    }
    const f = edge ? 0.58 : 1;
    out[0] = base[0] * f; out[1] = base[1] * f; out[2] = base[2] * f;
  }

  paintCell(i, rgb) {
    this.colorOf(i, rgb);
    const p = i * 4;
    const d = this.image.data;
    d[p] = rgb[0]; d[p + 1] = rgb[1]; d[p + 2] = rgb[2]; d[p + 3] = 255;
  }

  paintAll() {
    const n = this.game.map.width * this.game.map.height;
    const rgb = [0, 0, 0];
    for (let i = 0; i < n; i++) this.paintCell(i, rgb);
    this.offCtx.putImageData(this.image, 0, 0);
    this.game.map.dirty.length = 0;
    this.game.map.dirtyAll = false;
  }

  syncMap() {
    const map = this.game.map;
    if (map.dirtyAll) { this.paintAll(); return; }
    if (map.dirty.length === 0) return;
    const rgb = [0, 0, 0];
    for (const i of map.dirty) this.paintCell(i, rgb);
    map.dirty.length = 0;
    this.offCtx.putImageData(this.image, 0, 0);
  }

  render(ui) {
    const ctx = this.ctx;
    const cam = this.camera;
    const map = this.game.map;
    const dpr = this.dpr || 1;

    this.syncMap();

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b1622';
    ctx.fillRect(0, 0, cam.viewW, cam.viewH);

    ctx.imageSmoothingEnabled = false;
    const o = cam.mapToScreen(0, 0);
    ctx.drawImage(this.off, o.x, o.y, map.width * cam.scale, map.height * cam.scale);

    this.drawTrenches(ctx, cam);
    this.drawStructures(ctx, cam);
    this.drawFleets(ctx, cam);
    this.drawPlayerMarker(ctx, cam);
    if (ui) this.drawOverlay(ctx, cam, ui);

    ctx.restore();
  }

  visibleRect(cam) {
    return {
      x0: cam.x - 2, y0: cam.y - 2,
      x1: cam.x + cam.viewW / cam.scale + 2,
      y1: cam.y + cam.viewH / cam.scale + 2,
    };
  }

  drawTrenches(ctx, cam) {
    const edges = this.game.map.trenchEdges;
    if (edges.length === 0) return;
    const r = this.visibleRect(cam);
    const w = Math.max(1.5, cam.scale * 0.55);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(20,16,12,0.85)';
    ctx.lineWidth = w + Math.max(1, cam.scale * 0.25);
    ctx.beginPath();
    for (const e of edges) {
      if (e.lx < r.x0 || e.lx > r.x1 || e.ly < r.y0 || e.ly > r.y1) continue;
      const a = cam.mapToScreen(e.lx, e.ly);
      const b = e.horizontal
        ? cam.mapToScreen(e.lx + 1, e.ly)
        : cam.mapToScreen(e.lx, e.ly + 1);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(226,206,160,0.9)';
    ctx.lineWidth = w;
    ctx.setLineDash([Math.max(2, cam.scale * 0.5), Math.max(2, cam.scale * 0.35)]);
    ctx.beginPath();
    for (const e of edges) {
      if (e.lx < r.x0 || e.lx > r.x1 || e.ly < r.y0 || e.ly > r.y1) continue;
      const a = cam.mapToScreen(e.lx, e.ly);
      const b = e.horizontal
        ? cam.mapToScreen(e.lx + 1, e.ly)
        : cam.mapToScreen(e.lx, e.ly + 1);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawStructures(ctx, cam) {
    const map = this.game.map;
    const r = this.visibleRect(cam);
    const size = Math.max(4, Math.min(16, cam.scale * 2.2));

    for (let id = 1; id < this.game.countries.length; id++) {
      const c = this.game.countries[id];
      if (!c) continue;

      // 방어기지: 사각형 + 영향권 원
      for (const cell of c.forts) {
        const x = map.xOf(cell) + 0.5, y = map.yOf(cell) + 0.5;
        if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
        const s = cam.mapToScreen(x, y);
        if (cam.scale > 2.5) {
          ctx.strokeStyle = 'rgba(255,255,255,0.13)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(s.x, s.y, CONFIG.fort.radius * cam.scale, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(15,20,26,0.9)';
        ctx.fillRect(s.x - size * 0.5, s.y - size * 0.5, size, size);
        ctx.fillStyle = c.cssColor();
        ctx.fillRect(s.x - size * 0.32, s.y - size * 0.32, size * 0.64, size * 0.64);
      }

      // 도시 / 수도
      for (const cell of c.cities) {
        const x = map.xOf(cell) + 0.5, y = map.yOf(cell) + 0.5;
        if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
        const s = cam.mapToScreen(x, y);
        const isCapital = map.capital[cell] === 1;
        if (isCapital) this.star(ctx, s.x, s.y, size * 0.95, size * 0.42);
        else {
          ctx.beginPath();
          ctx.arc(s.x, s.y, size * 0.42, 0, Math.PI * 2);
        }
        ctx.fillStyle = isCapital ? '#fff3c4' : '#f2f4f6';
        ctx.fill();
        ctx.lineWidth = Math.max(1, size * 0.14);
        ctx.strokeStyle = 'rgba(10,14,20,0.85)';
        ctx.stroke();
      }
    }
  }

  star(ctx, cx, cy, outer, inner) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 === 0 ? outer : inner;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const px = cx + Math.cos(a) * rad, py = cy + Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  drawFleets(ctx, cam) {
    const size = Math.max(5, Math.min(14, cam.scale * 1.8));
    for (const f of this.game.fleets.fleets) {
      if (!f.alive) continue;
      const s = cam.mapToScreen(f.x, f.y);
      if (s.x < -30 || s.y < -30 || s.x > cam.viewW + 30 || s.y > cam.viewH + 30) continue;
      const c = this.game.countries[f.ownerId];
      const color = c ? c.cssColor() : '#ccc';

      // 진행 방향
      let ang = 0;
      const next = f.path[f.pathIndex];
      if (next !== undefined) {
        ang = Math.atan2(this.game.map.yOf(next) + 0.5 - f.y, this.game.map.xOf(next) + 0.5 - f.x);
      }
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(size, 0);
      ctx.lineTo(-size * 0.7, size * 0.62);
      ctx.lineTo(-size * 0.35, 0);
      ctx.lineTo(-size * 0.7, -size * 0.62);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = Math.max(1, size * 0.16);
      ctx.strokeStyle = 'rgba(8,12,18,0.9)';
      ctx.stroke();
      ctx.restore();

      if (cam.scale > 2) {
        ctx.font = `${Math.max(9, Math.min(14, cam.scale * 1.4))}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 3;
        const label = Math.round(f.troops).toString();
        ctx.strokeText(label, s.x, s.y - size - 3);
        ctx.fillText(label, s.x, s.y - size - 3);
      }
    }
  }


  /**
   * "내 나라가 여기" 표식.
   * 시작 영토는 화면에서 점 하나만 하기 때문에, 초반에는 수도에 고리를 띄우고
   * 내 영토가 화면 밖으로 나가면 가장자리에 방향 화살표를 그린다.
   */
  drawPlayerMarker(ctx, cam) {
    const g = this.game;
    const player = g.countries[g.playerId];
    if (!player || !player.alive) return;
    const anchor = g.playerAnchor();
    if (anchor < 0) return;

    const map = g.map;
    const s = cam.mapToScreen(map.xOf(anchor) + 0.5, map.yOf(anchor) + 0.5);
    const pulse = 0.5 + 0.5 * Math.sin(g.time * 2.6);
    const color = player.cssColor();
    const margin = 26;
    const onScreen = s.x > margin && s.y > margin
      && s.x < cam.viewW - margin && s.y < cam.viewH - margin;

    if (onScreen) {
      // 영토가 충분히 커지면 굳이 안내하지 않는다
      if (player.landCount > 600) return;
      const r = Math.max(16, cam.scale * 7) * (0.9 + 0.1 * pulse);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.35 + 0.35 * pulse;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = 3;
      ctx.strokeText('내 나라', s.x, s.y - r - 6);
      ctx.fillText('내 나라', s.x, s.y - r - 6);
      ctx.restore();
      return;
    }

    // 화면 밖 -> 가장자리에서 방향을 가리킨다
    const cx = cam.viewW / 2, cy = cam.viewH / 2;
    const dx = s.x - cx, dy = s.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const halfW = cam.viewW / 2 - margin, halfH = cam.viewH / 2 - margin;
    const scale = Math.min(halfW / Math.abs(dx || 1e-6), halfH / Math.abs(dy || 1e-6));
    const ex = cx + dx * scale, ey = cy + dy * scale;

    ctx.save();
    ctx.translate(ex, ey);
    ctx.rotate(Math.atan2(dy, dx));
    ctx.beginPath();
    ctx.moveTo(13, 0); ctx.lineTo(-9, 8); ctx.lineTo(-9, -8);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(8,12,18,0.9)';
    ctx.stroke();
    ctx.restore();
  }

  /** 선택 표시, 참호 미리보기, 건설 커서 */
  drawOverlay(ctx, cam, ui) {
    const map = this.game.map;

    if (ui.selectedCell >= 0) {
      const x = map.xOf(ui.selectedCell), y = map.yOf(ui.selectedCell);
      const s = cam.mapToScreen(x, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2;
      ctx.strokeRect(s.x - 1, s.y - 1, cam.scale + 2, cam.scale + 2);
    }

    if (ui.selectedFleet && ui.selectedFleet.alive) {
      const s = cam.mapToScreen(ui.selectedFleet.x, ui.selectedFleet.y);
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(12, cam.scale * 2.6), 0, Math.PI * 2);
      ctx.stroke();
    }

    if (ui.trenchPreview) {
      const { plan } = ui.trenchPreview;
      ctx.lineWidth = Math.max(2, cam.scale * 0.6);
      ctx.lineCap = 'round';
      for (const e of plan.segments) {
        const a = cam.mapToScreen(e.lx, e.ly);
        const b = e.horizontal ? cam.mapToScreen(e.lx + 1, e.ly) : cam.mapToScreen(e.lx, e.ly + 1);
        ctx.strokeStyle = e.buildable ? 'rgba(255,230,140,0.95)'
          : (e.already ? 'rgba(200,200,200,0.5)' : 'rgba(255,90,80,0.85)');
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    if (ui.buildMode === 'city' || ui.buildMode === 'fort') {
      if (ui.hoverCell >= 0) {
        const x = map.xOf(ui.hoverCell), y = map.yOf(ui.hoverCell);
        const s = cam.mapToScreen(x + 0.5, y + 0.5);
        const ok = this.game.canBuildOn(this.game.playerId, ui.hoverCell);
        ctx.strokeStyle = ok ? 'rgba(140,255,170,0.9)' : 'rgba(255,90,80,0.9)';
        ctx.lineWidth = 2;
        if (ui.buildMode === 'fort') {
          ctx.beginPath();
          ctx.arc(s.x, s.y, CONFIG.fort.radius * cam.scale, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.strokeRect(s.x - cam.scale * 1.5, s.y - cam.scale * 1.5, cam.scale * 3, cam.scale * 3);
      }
    }
  }
}
