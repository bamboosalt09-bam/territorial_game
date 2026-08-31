import { CONFIG, DIFFICULTY_LABELS } from '../config.js';
import { WATER, NEUTRAL } from '../game/MapGrid.js';
import { incomeRate } from '../game/Economy.js';

const $ = (id) => document.getElementById(id);

/**
 * 화면 UI.
 *
 * 상대 일반 땅 : 공격 / 화친
 * 상대 해안   : 배 / 공격 / 화친
 * 적 함선     : 배(요격)
 * 육상 국경이 없으면 공격 버튼은 비활성화한다 (인수인계 10.3).
 */
export class HUD {
  constructor(game, ui, camera, actions) {
    this.game = game;
    this.ui = ui;
    this.camera = camera;
    this.actions = actions;

    this.panel = $('panel');
    this.panelTitle = $('panel-title');
    this.panelBody = $('panel-body');
    this.panelActions = $('panel-actions');
    this.ticker = $('ticker');
    this.lastEventCount = 0;

    $('panel-close').addEventListener('click', () => this.closePanel());

    this.ratioInput = $('ratio');
    this.ratioInput.value = String(Math.round(CONFIG.ui.defaultRatio * 100));
    this.ratioInput.addEventListener('input', () => {
      this.ui.ratio = Number(this.ratioInput.value) / 100;
      $('ratio-value').textContent = `${this.ratioInput.value}%`;
      this.refreshPanel();
    });
    $('ratio-value').textContent = `${this.ratioInput.value}%`;

    for (const btn of document.querySelectorAll('#buildbar button')) {
      btn.addEventListener('click', () => this.toggleBuild(btn.dataset.build));
    }

    $('btn-pause').addEventListener('click', () => {
      this.game.paused = !this.game.paused;
      $('btn-pause').textContent = this.game.paused ? '▶' : '❚❚';
    });
  }

  get player() { return this.game.countries[this.game.playerId]; }

  toggleBuild(mode) {
    this.ui.buildMode = this.ui.buildMode === mode ? null : mode;
    this.ui.trenchPreview = null;
    this.closePanel();
    this.syncBuildButtons();
  }

  syncBuildButtons() {
    for (const btn of document.querySelectorAll('#buildbar button')) {
      btn.classList.toggle('active', this.ui.buildMode === btn.dataset.build);
    }
    $('build-hint').textContent = {
      city: '자기 땅을 탭해 도시를 세웁니다',
      fort: '자기 땅을 탭해 방어기지를 세웁니다',
      trench: '자기 영토 위를 드래그해 참호선을 긋습니다',
    }[this.ui.buildMode] || '';
    $('build-hint').classList.toggle('hidden', !this.ui.buildMode);
  }

  // ---- 상단 정보 ---------------------------------------------------------

  update() {
    const p = this.player;
    if (!p) return;
    $('balance').textContent = Math.floor(p.balance).toLocaleString();
    $('territory').textContent = `${(this.game.landShare(p.id) * 100).toFixed(1)}%`;
    $('income').textContent = `+${incomeRate(p).toFixed(1)}/s`;
    $('cost-city').textContent = p.nextCityCost();
    $('cost-fort').textContent = p.fortCost();
    $('cost-trench').textContent = `${CONFIG.trench.costPerEdge}/칸`;

    for (const btn of document.querySelectorAll('#buildbar button')) {
      const need = btn.dataset.build === 'city' ? p.nextCityCost()
        : btn.dataset.build === 'fort' ? p.fortCost() : CONFIG.trench.costPerEdge * 4;
      btn.classList.toggle('poor', p.balance < need);
    }

    this.updateRanking();
    this.updateTicker();
    if (this.panel.classList.contains('open')) this.refreshPanel();
  }

  updateRanking() {
    const list = this.game.ranking().slice(0, 6);
    const total = this.game.map.landCells || 1;
    $('ranking').innerHTML = list.map(c => {
      const pct = (c.landCount / total * 100).toFixed(1);
      const peace = this.game.atPeace(this.game.playerId, c.id) ? ' <b class="peace">화친</b>' : '';
      return `<div class="rank-row${c.isPlayer ? ' me' : ''}">
        <i style="background:${c.cssColor()}"></i>
        <span class="rank-name">${c.name}${peace}</span>
        <span class="rank-pct">${pct}%</span>
      </div>`;
    }).join('');
  }

  updateTicker() {
    const events = this.game.events;
    if (events.length === this.lastEventCount) return;
    this.lastEventCount = events.length;
    const recent = events.slice(-3).reverse();
    this.ticker.innerHTML = recent.map(e => `<div>${e.text}</div>`).join('');
  }

  // ---- 선택 패널 ---------------------------------------------------------

  closePanel() {
    this.panel.classList.remove('open');
    this.ui.selectedCell = -1;
    this.ui.selectedFleet = null;
    this.selection = null;
  }

  /** 화면 탭 결과로 무엇을 선택했는지 정하고 패널을 연다 */
  handleTap(px, py) {
    const map = this.game.map;
    const m = this.camera.screenToMap(px, py);

    // 1) 함선 먼저 (작아서 먼저 잡아 줘야 조작이 편하다)
    const radiusCells = CONFIG.ui.fleetHitRadius / this.camera.scale;
    const fleet = this.game.fleetAt(m.x, m.y, Math.max(1.2, radiusCells));
    if (fleet) {
      this.ui.selectedFleet = fleet;
      this.ui.selectedCell = -1;
      this.selection = { type: 'fleet', fleet };
      this.refreshPanel();
      return;
    }

    const cell = this.camera.cellAt(px, py);
    if (cell < 0 || map.terrain[cell] === WATER) { this.closePanel(); return; }

    // 2) 건설 모드면 선택 대신 건설
    if (this.ui.buildMode === 'city' || this.ui.buildMode === 'fort') {
      this.actions.build(this.ui.buildMode, cell);
      return;
    }

    this.ui.selectedCell = cell;
    this.ui.selectedFleet = null;
    this.selection = { type: 'cell', cell };
    this.refreshPanel();
  }

  refreshPanel() {
    if (!this.selection) return;
    if (this.selection.type === 'fleet') this.renderFleetPanel(this.selection.fleet);
    else this.renderCellPanel(this.selection.cell);
    this.panel.classList.add('open');
  }

  renderFleetPanel(fleet) {
    if (!fleet.alive) { this.closePanel(); return; }
    const g = this.game;
    const mine = fleet.ownerId === g.playerId;
    const owner = g.countries[fleet.ownerId];
    this.panelTitle.innerHTML = `<i style="background:${owner.cssColor()}"></i> ${owner.name} 함대`;

    const missionText = { invade: '상륙 항해 중', intercept: '요격 중', return: '귀환 중' }[fleet.mission.type] || '항해 중';
    this.panelBody.innerHTML = `
      <div class="kv"><span>병력</span><b>${Math.round(fleet.troops)}</b></div>
      <div class="kv"><span>임무</span><b>${missionText}</b></div>`;

    this.panelActions.innerHTML = '';
    if (!mine) {
      const peace = g.atPeace(g.playerId, fleet.ownerId);
      const reachable = g.canReachWaterBySea(g.playerId, fleet.currentCell(g.map));
      this.addAction('배', '요격함 출항',
        reachable && !peace && this.affordable(CONFIG.fleet.minLaunch),
        peace ? '화친 중' : (reachable ? '' : '해상 경로 없음'),
        () => this.actions.intercept(fleet));
    } else {
      this.panelActions.innerHTML = '<div class="hint">내 함대입니다</div>';
    }
  }

  renderCellPanel(cell) {
    const g = this.game;
    const map = g.map;
    const ownerId = map.owner[cell];
    const isCoast = map.isCoast(cell);

    if (ownerId === g.playerId) {
      const c = g.countries[ownerId];
      this.panelTitle.innerHTML = `<i style="background:${c.cssColor()}"></i> ${c.name} (나)`;
      this.panelBody.innerHTML = `
        <div class="kv"><span>Balance</span><b>${Math.floor(c.balance)}</b></div>
        <div class="kv"><span>영토</span><b>${c.landCount.toLocaleString()} 셀</b></div>
        <div class="kv"><span>도시</span><b>${c.cities.length}</b></div>`;
      this.panelActions.innerHTML = '<div class="hint">아래 건설 버튼으로 시설을 지을 수 있습니다</div>';
      return;
    }

    if (ownerId === NEUTRAL) {
      this.panelTitle.innerHTML = '<i style="background:#747c76"></i> 중립 지대';
      const canExpand = g.sharesLandBorder(g.playerId, NEUTRAL);
      const budget = this.budget();
      this.panelBody.innerHTML = `
        <div class="kv"><span>점령 비용</span><b>${(CONFIG.combat.attackDefenseRatio * CONFIG.combat.neutralDefense).toFixed(1)}/셀</b></div>
        <div class="kv"><span>투입</span><b>${Math.floor(budget)}</b></div>`;
      this.panelActions.innerHTML = '';
      this.addAction('확장', '중립 지대 점령', canExpand && budget >= CONFIG.combat.minAttackBalance,
        canExpand ? '' : '접한 중립 땅이 없습니다',
        () => this.actions.expand());
      return;
    }

    const enemy = g.countries[ownerId];
    const border = g.borderLength(g.playerId, ownerId);
    const peace = g.atPeace(g.playerId, ownerId);
    const budget = this.budget();
    const canAttack = border > 0 && !peace && budget >= CONFIG.combat.minAttackBalance;
    const seaOk = isCoast && g.canReachBySea(g.playerId, cell);
    const canShip = seaOk && !peace && budget >= CONFIG.fleet.minLaunch;

    this.panelTitle.innerHTML = `<i style="background:${enemy.cssColor()}"></i> ${enemy.name}`;
    this.panelBody.innerHTML = `
      <div class="kv"><span>Balance</span><b>${Math.floor(enemy.balance)}</b></div>
      <div class="kv"><span>영토</span><b>${enemy.landCount.toLocaleString()} 셀</b></div>
      <div class="kv"><span>수비 밀도</span><b>${enemy.defenseDensity().toFixed(2)}/셀</b></div>
      <div class="kv"><span>공유 국경</span><b>${border > 0 ? `${border} 칸` : '없음'}</b></div>
      ${peace ? '<div class="kv peace-row"><span>상태</span><b>화친 중</b></div>' : ''}`;

    this.panelActions.innerHTML = '';

    // 해안 셀에서만 배 버튼이 나온다 (인수인계 10.2)
    if (isCoast) {
      this.addAction('배', '상륙 함대 출항', canShip,
        peace ? '화친 중' : (seaOk ? '' : '해상 경로 없음'),
        () => this.actions.invade(cell));
    }
    this.addAction('공격', '육상 공격', canAttack,
      peace ? '화친 중' : (border > 0 ? '' : '육상 국경 없음'),
      () => this.actions.attack(ownerId));
    this.addAction('화친', '휴전 요청', !peace,
      peace ? '이미 화친 중' : '',
      () => this.actions.peace(ownerId));
  }

  budget() {
    const p = this.player;
    return p ? p.balance * this.ui.ratio : 0;
  }

  affordable(min) {
    return this.budget() >= min;
  }

  addAction(label, sub, enabled, disabledReason, onClick) {
    const b = document.createElement('button');
    b.className = 'action' + (enabled ? '' : ' disabled');
    b.innerHTML = `<strong>${label}</strong><em>${enabled ? sub : (disabledReason || sub)}</em>`;
    if (enabled) b.addEventListener('click', onClick);
    else b.disabled = true;
    this.panelActions.appendChild(b);
  }

  toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  showResult(kind) {
    const el = $('result');
    const p = this.player;
    $('result-title').textContent = kind === 'win' ? '승리' : '패배';
    $('result-body').textContent = kind === 'win'
      ? `${DIFFICULTY_LABELS[this.game.difficulty]} 난이도에서 지도의 ${(this.game.landShare(p.id) * 100).toFixed(1)}% 를 차지했습니다.`
      : '모든 영토를 잃었습니다.';
    el.classList.remove('hidden');
  }
}
