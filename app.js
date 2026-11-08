/**
 * Rummy Scoreboard - Core Application Logic
 * Supports:
 * 1. Pool Full Rummy (200 pool, drops, full count, +1 rejoin, 201 out)
 * 2. Best of 7 Game (7 rounds, manual points, R1 & R7 2x double, lowest score wins)
 */

(function () {
  'use strict';

  // --- Sound Effects using Web Audio API ---
  const AudioEngine = {
    ctx: null,
    init() {
      if (!this.ctx && (window.AudioContext || window.webkitAudioContext)) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioCtx();
      }
    },
    playTone(freq, duration = 0.15, type = 'sine', gainVal = 0.1) {
      try {
        this.init();
        if (!this.ctx) return;
        if (this.ctx.state === 'suspended') {
          this.ctx.resume();
        }
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
        gain.gain.setValueAtTime(gainVal, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + duration);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start();
        osc.stop(this.ctx.currentTime + duration);
      } catch (e) {
        // Audio may be blocked before gesture
      }
    },
    win() {
      setTimeout(() => this.playTone(523.25, 0.12), 0);
      setTimeout(() => this.playTone(659.25, 0.12), 120);
      setTimeout(() => this.playTone(783.99, 0.25), 240);
    },
    drop() {
      this.playTone(329.63, 0.2, 'triangle', 0.08);
    },
    out() {
      setTimeout(() => this.playTone(220, 0.2, 'sawtooth', 0.1), 0);
      setTimeout(() => this.playTone(164.81, 0.35, 'sawtooth', 0.12), 200);
    },
    rejoin() {
      setTimeout(() => this.playTone(392, 0.15, 'sine', 0.1), 0);
      setTimeout(() => this.playTone(587.33, 0.2, 'sine', 0.1), 150);
    },
    fanfare() {
      const notes = [
        { freq: 523.25, time: 0, dur: 0.14 },
        { freq: 659.25, time: 130, dur: 0.14 },
        { freq: 783.99, time: 260, dur: 0.2 },
        { freq: 1046.50, time: 420, dur: 0.5 }
      ];
      notes.forEach(n => {
        setTimeout(() => this.playTone(n.freq, n.dur, 'sine', 0.15), n.time);
      });
    }
  };

  // --- Default State & Storage ---
  const STORAGE_KEY = 'rummy_scoreboard_app_state_v3';
  const LEGACY_STORAGE_KEY_V2 = 'rummy_scoreboard_app_state_v2';
  const LEGACY_STORAGE_KEY_V1 = 'rummy_scorer_app_state_v1';

  const defaultSettings = {
    firstDrop: 20,
    middleDrop: 40,
    fullPoints: 80,
    totalPoints: 200, // Displayed pool limit: 200
    soundEnabled: true
  };

  let state = {
    gameMode: 'pool', // 'pool' or 'best_of_7'
    matrixViewMode: 'table', // 'table' or 'wrapped'
    settings: { ...defaultSettings },
    roster: [], // Master player list: [ { id, name } ]
    selectedPlayerIds: [], // IDs participating in current game
    players: [], // Active game players: [ { id, name, score: 0, isOut: false, rejoinHistory: [], isFirstDealer: false } ]
    rounds: [],  // [ { roundNum, dealerId, scores: { [playerId]: points }, cumulative: { [playerId]: total }, rawScores?: {} } ]
    firstDealerId: null,
    currentDealerId: null,
    gameStarted: false,
    historyStack: [] // For undo support
  };

  function isBestOf7() {
    return state.gameMode === 'best_of_7';
  }

  function getEliminationThreshold() {
    if (isBestOf7()) return Infinity; // No elimination in Best of 7
    const configured = Number(state.settings.totalPoints);
    if (configured % 100 === 0) {
      return configured + 1; // 200 -> 201
    }
    return configured;
  }

  function getMaxRejoinLimit() {
    const threshold = getEliminationThreshold();
    const formulaLimit = threshold - state.settings.firstDrop - 1;
    return Math.min(180, formulaLimit);
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error('Failed to save to localStorage:', e);
    }
  }

  function recalculateAllScores() {
    const latestRoundNum = state.rounds.length > 0 ?
      (state.rounds[state.rounds.length - 1].roundNum || state.rounds.length) : 0;
    const eliminationScore = getEliminationThreshold();

    state.players.forEach(player => {
      let currentScore = 0;
      let isCurrentlyOut = false;

      // Replay rounds sequentially
      for (let i = 0; i < state.rounds.length; i++) {
        const roundData = state.rounds[i];
        const rNum = roundData.roundNum || (i + 1);

        // Check if player rejoined before or at this round (Pool mode only)
        if (!isBestOf7() && player.rejoinHistory && player.rejoinHistory.length > 0) {
          const rejoinEvent = player.rejoinHistory.find(h => h.roundNum === rNum);
          if (rejoinEvent) {
            currentScore = Number(rejoinEvent.rejoinScore);
            isCurrentlyOut = currentScore >= eliminationScore;
          }
        }

        if (!roundData.cumulative) {
          roundData.cumulative = {};
        }

        if (roundData.scores && roundData.scores[player.id] !== undefined) {
          const roundPts = Number(roundData.scores[player.id]);
          currentScore += roundPts;
          roundData.cumulative[player.id] = currentScore;
          isCurrentlyOut = !isBestOf7() && (currentScore >= eliminationScore);
        }
      }

      // Check pending rejoin (Pool mode only)
      if (!isBestOf7() && player.rejoinHistory && player.rejoinHistory.length > 0) {
        const pendingRejoin = player.rejoinHistory.find(h => h.roundNum > latestRoundNum);
        if (pendingRejoin) {
          currentScore = Number(pendingRejoin.rejoinScore);
          isCurrentlyOut = currentScore >= eliminationScore;
        }
      }

      player.score = currentScore;
      player.isOut = isCurrentlyOut;
    });
  }

  function loadState() {
    try {
      let saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) saved = localStorage.getItem(LEGACY_STORAGE_KEY_V2);
      if (!saved) saved = localStorage.getItem(LEGACY_STORAGE_KEY_V1);

      if (saved) {
        const parsed = JSON.parse(saved);
        state = {
          ...state,
          ...parsed,
          settings: { ...defaultSettings, ...(parsed.settings || {}) }
        };

        // Initialize roster if not present or clean malformed items
        if (!state.roster || !Array.isArray(state.roster) || state.roster.length === 0) {
          state.roster = (state.players || [])
            .filter(p => p && (p.name || p.id))
            .map(p => ({
              id: String(p.id || 'p_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4)),
              name: String(p.name || 'Player').trim()
            }))
            .filter(p => p.name.length > 0);
        } else {
          state.roster = state.roster
            .filter(p => p && typeof p === 'object' && (p.name || p.id))
            .map(p => ({
              id: String(p.id || 'p_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4)),
              name: String(p.name || '').trim()
            }))
            .filter(p => p.name.length > 0);
        }

        if (!state.selectedPlayerIds || !Array.isArray(state.selectedPlayerIds) || state.selectedPlayerIds.length === 0) {
          state.selectedPlayerIds = state.roster.map(p => p.id);
        } else {
          const rosterIdSet = new Set(state.roster.map(p => p.id));
          state.selectedPlayerIds = state.selectedPlayerIds.filter(id => rosterIdSet.has(id));
          if (state.selectedPlayerIds.length === 0 && state.roster.length > 0) {
            state.selectedPlayerIds = state.roster.map(p => p.id);
          }
        }

        // Migrate player rejoinHistory
        state.players.forEach(p => {
          if (!p.rejoinHistory) p.rejoinHistory = [];
        });

        recalculateAllScores();
      }
    } catch (e) {
      console.error('Failed to load state:', e);
    }
  }

  function pushHistory() {
    const snapshot = JSON.stringify({
      gameMode: state.gameMode,
      players: JSON.parse(JSON.stringify(state.players)),
      rounds: JSON.parse(JSON.stringify(state.rounds)),
      currentDealerId: state.currentDealerId,
      firstDealerId: state.firstDealerId,
      gameStarted: state.gameStarted
    });
    state.historyStack.push(snapshot);
    if (state.historyStack.length > 25) {
      state.historyStack.shift();
    }
  }

  function undoLastAction() {
    if (state.historyStack.length === 0) {
      showToast('No actions to undo', 'danger');
      return;
    }
    const previous = JSON.parse(state.historyStack.pop());
    state.gameMode = previous.gameMode || state.gameMode;
    state.players = previous.players;
    state.rounds = previous.rounds;
    state.currentDealerId = previous.currentDealerId;
    state.firstDealerId = previous.firstDealerId;
    state.gameStarted = previous.gameStarted;
    recalculateAllScores();
    saveState();
    renderApp();
    showToast('Last action undone', 'success');
  }

  // --- Winner Detection ---
  function checkGameWinner(suppressModal = false) {
    if (state.players.length < 2 || state.rounds.length === 0) return null;

    if (isBestOf7()) {
      // Best of 7: Game completes after 7 rounds! Winner is player with LEAST score
      if (state.rounds.length >= 7) {
        const sorted = [...state.players].sort((a, b) => a.score - b.score);
        const winner = sorted[0];
        if (!suppressModal) {
          showWinnerDeclaration(winner, true, sorted);
        }
        return winner;
      }
      return null;
    } else {
      // Pool Full Rummy: Winner is the single active player left
      const active = getActivePlayers();
      if (active.length === 1) {
        const winner = active[0];
        if (!suppressModal) {
          const eliminated = getEliminatedPlayers().sort((a, b) => a.score - b.score);
          showWinnerDeclaration(winner, false, eliminated);
        }
        return winner;
      }
      return null;
    }
  }

  function showWinnerDeclaration(winner, isBest7Mode, sortedStandings) {
    els.winnerNameBanner.textContent = `👑 ${winner.name} Won the Game!`;

    if (isBest7Mode) {
      els.winnerStatsSummary.textContent = `Lowest Cumulative Score: ${winner.score} pts in 7 rounds!`;
      els.winnerBadgePill.textContent = 'BEST OF 7 COMPLETE • LOWEST SCORE WINS';
      els.winnerRunnersUpBox.innerHTML = `
        <div style="font-weight: 700; color: var(--accent-gold); margin-bottom: 6px;">Final Standings (Least Score Wins):</div>
        ${sortedStandings.map((p, idx) => `
          <div style="display:flex; justify-content:space-between; padding: 3px 0; color: ${idx === 0 ? '#34d399' : 'var(--text-muted)'}; font-weight: ${idx === 0 ? '700' : 'normal'};">
            <span>${idx === 0 ? '🥇 Winner: ' : `#${idx + 1}: `}${escapeHtml(p.name)}</span>
            <span style="color: ${idx === 0 ? '#34d399' : '#fff'};">${p.score} pts</span>
          </div>
        `).join('')}
      `;
    } else {
      els.winnerStatsSummary.textContent = `Final Score: ${winner.score} pts • Completed in ${state.rounds.length} rounds`;
      els.winnerBadgePill.textContent = 'GAME OVER • ALL OTHER PLAYERS ELIMINATED';
      els.winnerRunnersUpBox.innerHTML = `
        <div style="font-weight: 700; color: var(--accent-gold); margin-bottom: 6px;">Final Standings:</div>
        <div style="display:flex; justify-content:space-between; padding: 3px 0; color:#34d399; font-weight:700;">
          <span>🥇 1st Place (Winner): ${escapeHtml(winner.name)}</span>
          <span>${winner.score} pts</span>
        </div>
        ${sortedStandings.map((p, idx) => `
          <div style="display:flex; justify-content:space-between; padding: 3px 0; color:var(--text-muted);">
            <span>#${idx + 2}: ${escapeHtml(p.name)}</span>
            <span style="color:#ef4444;">${p.score} pts (OUT)</span>
          </div>
        `).join('')}
      `;
    }

    openModal(els.winnerModal);
  }

  // --- DOM Elements ---
  const els = {
    // Views
    setupView: document.getElementById('setup-view'),
    dashboardView: document.getElementById('dashboard-view'),
    headerModeSubtitle: document.getElementById('header-mode-subtitle'),
    headerSetupBtn: document.getElementById('header-setup-btn'),

    // Setup View Elements
    modeCardPool: document.getElementById('mode-card-pool'),
    modeCardBest7: document.getElementById('mode-card-best7'),
    badgeModePool: document.getElementById('badge-mode-pool'),
    badgeModeBest7: document.getElementById('badge-mode-best7'),
    setupPlayerNameInput: document.getElementById('setup-player-name-input'),
    setupAddPlayerForm: document.getElementById('setup-add-player-form'),
    setupPlayerList: document.getElementById('setup-player-list'),
    setupPlayerCountLabel: document.getElementById('setup-player-count-label'),
    setupModeSummaryBox: document.getElementById('setup-mode-summary-box'),
    startGameBtn: document.getElementById('start-game-btn'),

    // Dashboard Elements
    dashboardRulesLabel: document.getElementById('dashboard-rules-label'),
    rulesDisplay: document.getElementById('rules-chips-container'),
    editSettingsBtn: document.getElementById('edit-settings-btn'),
    gameInfoCard: document.getElementById('game-info-card'),

    // Navigation Tabs
    tabCardsBtn: document.getElementById('tab-cards-btn'),
    tabTableBtn: document.getElementById('tab-table-btn'),
    tabStatsBtn: document.getElementById('tab-stats-btn'),
    cardsView: document.getElementById('cards-view'),
    tableView: document.getElementById('table-view'),
    statsView: document.getElementById('stats-view'),

    // Round Entry & Buttons
    recordRoundBtn: document.getElementById('record-round-btn'),
    editLastRoundBtn: document.getElementById('edit-last-round-btn'),
    editLastRoundTableBtn: document.getElementById('edit-last-round-table-btn'),
    toggleMatrixViewBtn: document.getElementById('toggle-matrix-view-btn'),
    matrixViewIcon: document.getElementById('matrix-view-icon'),
    matrixViewLabel: document.getElementById('matrix-view-label'),
    realignDealersTableBtn: document.getElementById('realign-dealers-table-btn'),
    realignDealersCardsBtn: document.getElementById('realign-dealers-cards-btn'),
    undoBtn: document.getElementById('undo-btn'),
    newGameBtn: document.getElementById('new-game-btn'),
    shareScorecardBtn: document.getElementById('share-scorecard-btn'),

    // Modals
    dealerOrderModal: document.getElementById('dealer-order-modal'),
    closeDealerOrderModal: document.getElementById('close-dealer-order-modal'),
    closeDealerOrderDoneBtn: document.getElementById('close-dealer-order-done-btn'),
    dealerOrderList: document.getElementById('dealer-order-list'),
    settingsModal: document.getElementById('settings-modal'),
    settingsForm: document.getElementById('settings-form'),
    closeSettingsModal: document.getElementById('close-settings-modal'),
    cancelSettingsModal: document.getElementById('cancel-settings-modal'),

    firstDealerModal: document.getElementById('first-dealer-modal'),
    firstDealerSelect: document.getElementById('first-dealer-select'),
    saveFirstDealerBtn: document.getElementById('save-first-dealer-btn'),
    closeFirstDealerModal: document.getElementById('close-first-dealer-modal'),

    rejoinModal: document.getElementById('rejoin-modal'),
    rejoinForm: document.getElementById('rejoin-form'),
    closeRejoinModal: document.getElementById('close-rejoin-modal'),
    rejoinPlayerName: document.getElementById('rejoin-player-name'),
    rejoinSuggestedScore: document.getElementById('rejoin-suggested-score'),
    rejoinScoreInput: document.getElementById('rejoin-score-input'),
    rejoinPlayerIdInput: document.getElementById('rejoin-player-id'),
    confirmRejoinBtn: document.getElementById('confirm-rejoin-btn'),

    recordRoundModal: document.getElementById('record-round-modal'),
    recordRoundForm: document.getElementById('record-round-form'),
    closeRecordRoundModal: document.getElementById('close-record-round-modal'),
    recordRoundEntries: document.getElementById('record-round-entries'),
    currentDealerLabel: document.getElementById('current-dealer-label'),
    roundNumberHeading: document.getElementById('round-number-heading'),
    recordDoubleWarning: document.getElementById('record-double-warning'),
    recordRoundInstruction: document.getElementById('record-round-instruction'),

    editRoundModal: document.getElementById('edit-round-modal'),
    editRoundForm: document.getElementById('edit-round-form'),
    closeEditRoundModal: document.getElementById('close-edit-round-modal'),
    cancelEditRoundModal: document.getElementById('cancel-edit-round-modal'),
    editRoundHeading: document.getElementById('edit-round-heading'),
    editRoundSubheading: document.getElementById('edit-round-subheading'),
    editRoundEntries: document.getElementById('edit-round-entries'),
    editDoubleWarning: document.getElementById('edit-double-warning'),
    editRoundInstruction: document.getElementById('edit-round-instruction'),

    winnerModal: document.getElementById('winner-modal'),
    closeWinnerModal: document.getElementById('close-winner-modal'),
    winnerBadgePill: document.getElementById('winner-badge-pill'),
    winnerNameBanner: document.getElementById('winner-name-banner'),
    winnerStatsSummary: document.getElementById('winner-stats-summary'),
    winnerRunnersUpBox: document.getElementById('winner-runners-up-box'),
    winnerNewGameBtn: document.getElementById('winner-new-game-btn'),
    winnerEditLastBtn: document.getElementById('winner-edit-last-btn'),

    playersGrid: document.getElementById('players-grid'),
    tableContainer: document.getElementById('table-container'),
    statsContainer: document.getElementById('stats-container'),
    toastContainer: document.getElementById('toast-container')
  };

  // --- Toasts & Modals ---
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'danger') icon = '⚠️';
    toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    els.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 2800);
  }

  function openModal(modalEl) {
    modalEl.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeModal(modalEl) {
    modalEl.classList.remove('active');
    document.body.style.overflow = '';
  }

  function getActivePlayers() {
    return state.players.filter(p => !p.isOut);
  }

  function getEliminatedPlayers() {
    return state.players.filter(p => p.isOut);
  }

  function getHighestActiveScore() {
    const active = getActivePlayers();
    if (active.length === 0) return 0;
    return Math.max(...active.map(p => p.score));
  }

  function calculateRejoinScore() {
    const highest = getHighestActiveScore();
    return highest + 1;
  }

  function rotateDealer() {
    if (state.players.length === 0) return;
    const activePlayers = getActivePlayers();
    if (activePlayers.length <= 1) return;

    const currentIndex = state.players.findIndex(p => p.id === state.currentDealerId);
    let nextIndex = (currentIndex + 1) % state.players.length;

    let tries = 0;
    while (state.players[nextIndex].isOut && tries < state.players.length) {
      nextIndex = (nextIndex + 1) % state.players.length;
      tries++;
    }

    state.currentDealerId = state.players[nextIndex].id;
  }

  // --- Setup View Logic ---
  function selectGameMode(mode) {
    state.gameMode = mode;
    saveState();
    renderSetupView();
  }

  function togglePlayerSelection(playerId) {
    if (state.selectedPlayerIds.includes(playerId)) {
      state.selectedPlayerIds = state.selectedPlayerIds.filter(id => id !== playerId);
      if (state.firstDealerId === playerId) {
        state.firstDealerId = state.selectedPlayerIds[0] || null;
      }
    } else {
      state.selectedPlayerIds.push(playerId);
      if (!state.firstDealerId) {
        state.firstDealerId = playerId;
      }
    }
    saveState();
    renderSetupView();
  }

  function setSetupFirstDealer(playerId) {
    if (!state.selectedPlayerIds.includes(playerId)) {
      state.selectedPlayerIds.push(playerId);
    }
    state.firstDealerId = playerId;
    saveState();
    renderSetupView();
  }

  function removePlayerFromRoster(playerId) {
    const player = state.roster.find(p => p.id === playerId);
    if (!player) return;
    if (!confirm(`Remove player "${player.name}"?`)) return;

    state.roster = state.roster.filter(p => p.id !== playerId);
    state.selectedPlayerIds = state.selectedPlayerIds.filter(id => id !== playerId);
    if (state.firstDealerId === playerId) {
      state.firstDealerId = state.selectedPlayerIds[0] || null;
    }
    saveState();
    renderSetupView();
    showToast(`Player "${player.name}" removed`, 'info');
  }

  function addPlayerToRoster(name) {
    if (!name || typeof name !== 'string') return;
    const cleanName = name.trim();
    if (!cleanName) return;

    if (!Array.isArray(state.roster)) {
      state.roster = [];
    }

    const alreadyExists = state.roster.some(
      p => p && p.name && p.name.trim().toLowerCase() === cleanName.toLowerCase()
    );
    if (alreadyExists) {
      showToast(`Player "${cleanName}" already exists`, 'danger');
      return;
    }

    const newId = 'p_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    const newEntry = { id: newId, name: cleanName };

    state.roster.push(newEntry);
    if (!Array.isArray(state.selectedPlayerIds)) {
      state.selectedPlayerIds = [];
    }
    state.selectedPlayerIds.push(newId);

    if (!state.firstDealerId) {
      state.firstDealerId = newId;
    }

    saveState();
    renderSetupView();
    showToast(`Player "${cleanName}" added!`, 'success');
  }

  function handleAddPlayer(e) {
    if (e) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
    }
    const input = document.getElementById('setup-player-name-input');
    if (!input) return false;
    const val = input.value;
    if (!val || !val.trim()) {
      input.focus();
      return false;
    }
    addPlayerToRoster(val);
    input.value = '';
    input.focus();
    return false;
  }

  function moveRosterPlayer(playerId, direction) {
    const idx = state.roster.findIndex(p => p.id === playerId);
    if (idx < 0) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= state.roster.length) return;

    const temp = state.roster[idx];
    state.roster[idx] = state.roster[targetIdx];
    state.roster[targetIdx] = temp;

    // Preserve order of selected IDs based on new roster order
    state.selectedPlayerIds = state.roster
      .filter(p => state.selectedPlayerIds.includes(p.id))
      .map(p => p.id);

    saveState();
    renderSetupView();
  }

  function renderSetupView() {
    // 1. Mode Cards
    const isPool = state.gameMode === 'pool';
    els.modeCardPool.classList.toggle('selected', isPool);
    els.modeCardBest7.classList.toggle('selected', !isPool);
    els.badgeModePool.style.display = isPool ? 'block' : 'none';
    els.badgeModeBest7.style.display = !isPool ? 'block' : 'none';

    // 2. Roster List
    if (state.roster.length === 0) {
      els.setupPlayerList.innerHTML = `
        <div style="text-align: center; padding: 24px 12px; color: var(--text-muted);">
          No players added yet. Enter names above to build your table roster.
        </div>
      `;
    } else {
      els.setupPlayerList.innerHTML = state.roster.map((p, index) => {
        const isSelected = state.selectedPlayerIds.includes(p.id);
        const isFirstDealer = state.firstDealerId === p.id && isSelected;
        const initial = p.name.trim().charAt(0).toUpperCase();

        return `
          <div class="setup-player-item ${isSelected ? 'selected' : ''}">
            <div class="setup-player-header">
              <div class="setup-player-left">
                <input type="checkbox"
                       class="player-checkbox"
                       id="chk-${p.id}"
                       ${isSelected ? 'checked' : ''}
                       onchange="window.RummyApp.togglePlayerSelection('${p.id}')">
                <div class="player-avatar" style="width: 32px; height: 32px; font-size: 0.9rem;">${initial}</div>
                <label for="chk-${p.id}" class="setup-player-name-label">
                  ${escapeHtml(p.name)}
                </label>
              </div>
              <button type="button"
                      class="btn-remove-player"
                      onclick="window.RummyApp.removePlayerFromRoster('${p.id}')"
                      title="Delete player from roster">
                🗑️
              </button>
            </div>
            <div class="setup-player-actions">
              ${isSelected ? `
                <button type="button"
                        class="btn-dealer-pick ${isFirstDealer ? 'selected' : ''}"
                        onclick="window.RummyApp.setSetupFirstDealer('${p.id}')"
                        title="Click to select as 1st Dealer">
                  ${isFirstDealer ? '🃏 1st Dealer' : 'Make 1st Dealer'}
                </button>
              ` : '<span style="font-size:0.75rem; color:var(--text-dim);">Not in this game</span>'}
              <div class="reorder-btn-group">
                <button type="button" class="btn-reorder" onclick="window.RummyApp.moveRosterPlayer('${p.id}', 'up')" title="Move up in dealer order" ${index === 0 ? 'disabled' : ''}>⬆️</button>
                <button type="button" class="btn-reorder" onclick="window.RummyApp.moveRosterPlayer('${p.id}', 'down')" title="Move down in dealer order" ${index === state.roster.length - 1 ? 'disabled' : ''}>⬇️</button>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }

    const selectedCount = state.selectedPlayerIds.length;
    els.setupPlayerCountLabel.textContent = `${selectedCount} Player${selectedCount === 1 ? '' : 's'} Selected`;

    // 3. Mode summary preview
    if (isPool) {
      els.setupModeSummaryBox.innerHTML = `
        <div class="summary-card-inner">
          <div class="summary-header-row">
            <div class="summary-title">
              <span>🎴</span>
              <strong style="color: var(--accent-gold);">Pool Full Rummy Rules</strong>
            </div>
            <button type="button" class="btn btn-outline btn-sm btn-rules-edit" onclick="window.RummyApp.openSettingsModal()" title="Customize drops, full count, or total limit">
              <span>⚙️</span> Edit Rules
            </button>
          </div>
          <div class="summary-chips-wrap">
            <span class="rule-chip"><span class="label">Total Limit:</span> <span class="val">${state.settings.totalPoints} (Out at ${state.settings.totalPoints + 1}+)</span></span>
            <span class="rule-chip"><span class="label">Drops:</span> <span class="val">${state.settings.firstDrop} / ${state.settings.middleDrop}</span></span>
            <span class="rule-chip"><span class="label">Full:</span> <span class="val">${state.settings.fullPoints}</span></span>
            <span class="rule-chip"><span class="label">Re-join:</span> <span class="val">&le;${getMaxRejoinLimit()} (+1 rule)</span></span>
          </div>
        </div>
      `;
    } else {
      els.setupModeSummaryBox.innerHTML = `
        <div class="summary-card-inner">
          <div class="summary-header-row">
            <div class="summary-title">
              <span>🎲</span>
              <strong style="color: #fbbf24;">Best of 7 Rules</strong>
            </div>
            <span class="badge" style="background:rgba(245, 158, 11, 0.2); color:#fbbf24; border:1px solid rgba(245, 158, 11, 0.4);">
              Fixed 7 Rounds
            </span>
          </div>
          <div class="summary-chips-wrap">
            <span class="rule-chip"><span class="label">Rounds:</span> <span class="val">7 Fixed</span></span>
            <span class="rule-chip"><span class="label">Double Score:</span> <span class="val" style="color:#fbbf24;">R1 &amp; R7 (2x)</span></span>
            <span class="rule-chip"><span class="label">Win Rule:</span> <span class="val" style="color:#34d399;">Least Score</span></span>
            <span class="rule-chip"><span class="label">Drops:</span> <span class="val">None (Manual)</span></span>
          </div>
        </div>
      `;
    }

    // 4. Start Game Button state
    const canStart = selectedCount >= 2;
    els.startGameBtn.disabled = !canStart;
    if (canStart) {
      els.startGameBtn.textContent = `🚀 Start ${isPool ? 'Pool Full Rummy' : 'Best of 7'} (${selectedCount} Players)`;
    } else {
      els.startGameBtn.textContent = `🚀 Start Game (Select at least 2 players)`;
    }
  }

  function startGame() {
    const selectedPlayers = state.roster.filter(p => state.selectedPlayerIds.includes(p.id));
    if (selectedPlayers.length < 2) {
      showToast('Please select at least 2 players to start', 'danger');
      return;
    }

    pushHistory();

    state.players = selectedPlayers.map(p => ({
      id: p.id,
      name: p.name,
      score: 0,
      isOut: false,
      rejoinHistory: [],
      isFirstDealer: p.id === state.firstDealerId
    }));

    if (!state.firstDealerId || !selectedPlayers.some(p => p.id === state.firstDealerId)) {
      state.firstDealerId = selectedPlayers[0].id;
      state.players[0].isFirstDealer = true;
    }

    state.currentDealerId = state.firstDealerId;
    state.rounds = [];
    state.gameStarted = true;

    saveState();
    renderApp();
    switchTab('table');
    showToast(`Game started in ${isBestOf7() ? 'Best of 7' : 'Pool Full Rummy'} mode!`, 'success');
  }

  function returnToSetup() {
    state.gameStarted = false;
    saveState();
    renderApp();
  }

  // --- Render Dashboard Views ---
  function renderRulesBar() {
    if (isBestOf7()) {
      els.dashboardRulesLabel.textContent = 'Best of 7:';
      els.rulesDisplay.innerHTML = `
        <div class="rule-chip" title="Total rounds">
          <span class="label">Rounds:</span>
          <span class="val">7 Fixed</span>
        </div>
        <div class="rule-chip" style="border-color:#f59e0b;" title="1st and 7th games are 2x Double Score">
          <span class="label">Double Score:</span>
          <span class="val" style="color:#fbbf24;">R1 &amp; R7 (2x)</span>
        </div>
        <div class="rule-chip" title="Winner determination">
          <span class="label">Win Rule:</span>
          <span class="val" style="color:#34d399;">Least Score</span>
        </div>
      `;
      els.editSettingsBtn.style.display = 'none';
    } else {
      els.dashboardRulesLabel.textContent = 'Pool Rules:';
      els.rulesDisplay.innerHTML = `
        <div class="rule-chip" title="Points assigned for dropping on the first turn">
          <span class="label">1st Drop:</span>
          <span class="val">${state.settings.firstDrop}</span>
        </div>
        <div class="rule-chip" title="Points assigned for dropping after 1st turn">
          <span class="label">Mid Drop:</span>
          <span class="val">${state.settings.middleDrop}</span>
        </div>
        <div class="rule-chip" title="Maximum points loss for wrong show or no show">
          <span class="label">Full Count:</span>
          <span class="val">${state.settings.fullPoints}</span>
        </div>
        <div class="rule-chip total-pts" title="Pool elimination limit">
          <span class="label">Total Limit:</span>
          <span class="val">${state.settings.totalPoints}</span>
        </div>
      `;
      els.editSettingsBtn.style.display = 'inline-flex';
    }
  }

  function renderGameInfo() {
    const currentDealer = state.players.find(p => p.id === state.currentDealerId);
    const roundNumber = state.rounds.length + 1;
    const activeCount = getActivePlayers().length;
    const hasRounds = state.rounds.length > 0;
    const winner = checkGameWinner(true);

    if (winner) {
      els.gameInfoCard.innerHTML = `
        <div style="background: linear-gradient(135deg, rgba(245, 197, 24, 0.22), rgba(212, 154, 0, 0.12)); border: 1px solid var(--accent-gold); border-radius: var(--radius-md); padding: 12px 18px; width: 100%; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <span style="font-size: 2.2rem; line-height: 1;">🏆</span>
            <div>
              <div style="font-weight: 800; font-size: 1.15rem; color: #ffd700;">
                Game Over — ${escapeHtml(winner.name)} Won the Game!
              </div>
              <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 2px;">
                ${isBestOf7() ? `Lowest cumulative score: <strong>${winner.score} pts</strong> in 7 rounds` : `All other players eliminated • Final Score: <strong>${winner.score} pts</strong>`}
              </div>
            </div>
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <button class="btn btn-primary btn-sm" id="btn-banner-new-game">
              🏆 Start New Game
            </button>
            <button class="btn btn-outline btn-sm" id="btn-banner-edit-last">
              ✏️ Edit Last Score
            </button>
          </div>
        </div>
      `;

      const bannerNewGameBtn = document.getElementById('btn-banner-new-game');
      if (bannerNewGameBtn) bannerNewGameBtn.onclick = handleNewGame;

      const bannerEditLastBtn = document.getElementById('btn-banner-edit-last');
      if (bannerEditLastBtn) bannerEditLastBtn.onclick = openEditLastRoundModal;

      return;
    }

    let dealerHtml = '';
    if (currentDealer) {
      dealerHtml = `
        <div class="dealer-indicator">
          <span class="title">Current Dealer</span>
          <span class="name">🃏 ${escapeHtml(currentDealer.name)}</span>
        </div>
      `;
    } else {
      dealerHtml = `
        <div class="dealer-indicator">
          <span class="title">Current Dealer</span>
          <span class="name" style="color: var(--accent-gold); cursor: pointer;" id="setup-dealer-quick-btn">⚙️ Select First Dealer</span>
        </div>
      `;
    }

    const roundDisplay = isBestOf7() ? `${Math.min(7, roundNumber)} / 7` : (state.rounds.length === 0 ? 1 : roundNumber);

    els.gameInfoCard.innerHTML = `
      <div class="round-status">
        <div class="round-badge">
          <div class="num">${roundDisplay}</div>
          <div class="lbl">Round</div>
        </div>
        ${dealerHtml}
      </div>
      <div style="display:flex; align-items:center; gap: 10px; flex-wrap: wrap;">
        <div style="font-size: 0.85rem; color: var(--text-muted);">
          ${isBestOf7() ? `Mode: <strong style="color:#fbbf24;">Best of 7</strong>` : `Active: <strong style="color:#10b981;">${activeCount}</strong> / Total: <strong>${state.players.length}</strong>`}
        </div>
        ${hasRounds ? `
          <button class="btn btn-outline btn-sm" id="btn-quick-edit-last-round" title="Edit the last round score">
            <span>✏️</span> Edit R${state.rounds.length} Score
          </button>
        ` : ''}
        <button class="btn btn-emerald btn-sm" id="btn-quick-record-round" ${state.players.length < 2 ? 'disabled' : ''}>
          <span>➕</span> Record Round ${roundNumber}
        </button>
      </div>
    `;

    const quickRecordBtn = document.getElementById('btn-quick-record-round');
    if (quickRecordBtn) {
      quickRecordBtn.onclick = () => openRecordRoundModal();
    }
    const quickEditBtn = document.getElementById('btn-quick-edit-last-round');
    if (quickEditBtn) {
      quickEditBtn.onclick = () => openEditLastRoundModal();
    }
    const setupDealerBtn = document.getElementById('setup-dealer-quick-btn');
    if (setupDealerBtn) {
      setupDealerBtn.onclick = () => openFirstDealerModal();
    }
  }

  function renderPlayerCards() {
    if (state.players.length === 0) {
      els.playersGrid.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <div class="empty-state-icon">🃏</div>
          <h3>No Active Players</h3>
          <p style="color: var(--text-muted); max-width: 400px; font-size: 0.9rem;">
            Go to Setup to choose players and launch the game.
          </p>
          <button class="btn btn-primary" onclick="window.RummyApp.returnToSetup()">
            ⚙️ Go to Setup
          </button>
        </div>
      `;
      return;
    }

    const maxPts = state.settings.totalPoints;
    const eliminationScore = getEliminationThreshold();
    const maxRejoinLimit = getMaxRejoinLimit();
    const suggestedRejoinScore = calculateRejoinScore();
    const canAnyRejoin = !isBestOf7() && (suggestedRejoinScore <= maxRejoinLimit);

    // In Best of 7, calculate relative standing
    const minScore = Math.min(...state.players.map(p => p.score));

    els.playersGrid.innerHTML = state.players.map((player) => {
      const isDealer = player.id === state.currentDealerId;
      const isFirstDealer = player.id === state.firstDealerId;
      const isOut = player.isOut;
      const initial = player.name.trim().charAt(0).toUpperCase();

      let cardClasses = ['player-card'];
      if (isDealer) cardClasses.push('is-dealer');
      if (isOut) cardClasses.push('is-out');
      if (player.rejoinHistory && player.rejoinHistory.length > 0) cardClasses.push('is-rejoined');

      if (isBestOf7()) {
        const isLeading = player.score === minScore && state.rounds.length > 0;
        return `
          <div class="${cardClasses.join(' ')}" data-id="${player.id}">
            <!-- Header Row -->
            <div class="card-header-row">
              <div class="player-profile">
                <div class="player-avatar">${initial}</div>
                <div class="player-meta">
                  <div class="player-name" title="${escapeHtml(player.name)}">${escapeHtml(player.name)}</div>
                  <div class="player-tags">
                    ${isFirstDealer ? '<span class="tag tag-first-dealer">1st Dealer</span>' : ''}
                    ${isLeading ? '<span class="tag" style="background:#10b981; color:#fff;">Leading 👑</span>' : ''}
                  </div>
                </div>
              </div>
              <div class="player-dealer-action">
                ${isDealer ?
                  `<span class="dealer-badge active">🃏 Dealer</span>` :
                  `<button class="btn-make-dealer" title="Set this player as active dealer" onclick="window.RummyApp.setDealer('${player.id}')">🃏 Make Dealer</button>`
                }
              </div>
            </div>

            <!-- Score Box -->
            <div class="card-score-box">
              <div class="score-main">
                <div class="score-value safe">${player.score}</div>
                <div class="score-subtext">Total Points Scored</div>
              </div>
              <div class="score-status-col">
                <span class="pill-status safe">
                  Round ${state.rounds.length}/7
                </span>
                <div class="drop-status-text" style="color:var(--text-muted);">
                  Least score wins
                </div>
              </div>
            </div>

            <!-- Progress Bar (completed rounds) -->
            <div class="card-progress-track">
              <div class="card-progress-fill safe" style="width: ${(state.rounds.length / 7) * 100}%;"></div>
            </div>

            <!-- Bottom Row -->
            <div class="card-footer-action">
              <div class="card-active-footer">
                <span>Status: <strong class="text-active">In Game</strong></span>
                <span>Best of 7</span>
              </div>
            </div>
          </div>
        `;
      }

      // Pool Full Rummy Card
      const pct = Math.min(100, Math.round((player.score / eliminationScore) * 100));
      let scoreColorClass = 'safe';
      if (player.score >= eliminationScore) {
        scoreColorClass = 'danger';
      } else if (player.score >= maxPts * 0.75) {
        scoreColorClass = 'warning';
      }

      return `
        <div class="${cardClasses.join(' ')}" data-id="${player.id}">
          <!-- Header Row -->
          <div class="card-header-row">
            <div class="player-profile">
              <div class="player-avatar">${initial}</div>
              <div class="player-meta">
                <div class="player-name" title="${escapeHtml(player.name)}">${escapeHtml(player.name)}</div>
                <div class="player-tags">
                  ${isFirstDealer ? '<span class="tag tag-first-dealer">1st Dealer</span>' : ''}
                  ${player.rejoinHistory && player.rejoinHistory.length > 0 ? `<span class="tag tag-rejoin">Re-joined (${player.rejoinHistory.length})</span>` : ''}
                  ${isOut ? '<span class="tag tag-out">OUT</span>' : ''}
                </div>
              </div>
            </div>
            <div class="player-dealer-action">
              ${!isOut ? (
                isDealer ?
                  `<span class="dealer-badge active">🃏 Dealer</span>` :
                  `<button class="btn-make-dealer" title="Set this player as active dealer" onclick="window.RummyApp.setDealer('${player.id}')">🃏 Make Dealer</button>`
              ) : ''}
            </div>
          </div>

          <!-- Middle Row -->
          <div class="card-score-box">
            <div class="score-main">
              <div class="score-value ${scoreColorClass}">${player.score}</div>
              <div class="score-subtext">/ ${maxPts} pts limit</div>
            </div>
            <div class="score-status-col">
              ${isOut ?
                '<span class="pill-status out">OUT</span>' :
                `<span class="pill-status ${player.score <= 180 ? 'safe' : 'danger'}">
                   <strong>${eliminationScore - player.score}</strong> pts to out
                 </span>`
              }
              <div class="drop-status-text">
                ${isOut ?
                  '<span class="text-danger">Eliminated</span>' :
                  (player.score <= 180 ?
                    '<span class="text-safe">✓ Drop safe</span>' :
                    '<span class="text-danger">⚠️ No drop left</span>')
                }
              </div>
            </div>
          </div>

          <!-- Progress Bar -->
          <div class="card-progress-track">
            <div class="card-progress-fill ${scoreColorClass}" style="width: ${pct}%;"></div>
          </div>

          <!-- Bottom Row -->
          <div class="card-footer-action">
            ${isOut ? (
              canAnyRejoin ?
                `<button class="btn btn-purple btn-sm" style="width: 100%;" onclick="window.RummyApp.openRejoinModal('${player.id}')">
                   🔄 Re-join Game (@ ${suggestedRejoinScore} pts)
                 </button>` :
                `<div class="rejoin-closed-banner">
                   🚫 Re-join Closed (&gt;${maxRejoinLimit} pts: no drop left)
                 </div>`
            ) : `
              <div class="card-active-footer">
                <span>Status: <strong class="text-active">Active</strong></span>
                <span>Round ${state.rounds.length + 1}</span>
              </div>
            `}
          </div>
        </div>
      `;
    }).join('');
  }

  function renderTableView() {
    if (state.players.length === 0) {
      els.tableContainer.innerHTML = `
        <div class="empty-state">
          <p>Add players and record rounds to view the complete scoreboard.</p>
        </div>
      `;
      return;
    }

    // Update toggle button text & icon
    if (els.toggleMatrixViewBtn) {
      const isWrapped = state.matrixViewMode === 'wrapped';
      if (els.matrixViewIcon) els.matrixViewIcon.textContent = isWrapped ? '📊' : '🎴';
      if (els.matrixViewLabel) els.matrixViewLabel.textContent = isWrapped ? 'Table Matrix' : 'Wrapped Cards';
    }

    // OPTION 1: WRAPPED CARDS MATRIX (Zero horizontal scroll, rounds wrap players into 3x2 grid)
    if (state.matrixViewMode === 'wrapped') {
      if (state.rounds.length === 0) {
        els.tableContainer.innerHTML = `
          <div class="empty-state">
            <p>No rounds played yet. Click "Record Round" to add the first round scores.</p>
          </div>
        `;
        return;
      }

      const wrappedCardsHtml = state.rounds.map((round) => {
        const dealerPlayer = state.players.find(p => p.id === round.dealerId);
        const dealerName = dealerPlayer ? dealerPlayer.name : '-';
        const isDoubleRound = isBestOf7() && (round.roundNum === 1 || round.roundNum === 7);

        return `
          <div class="wrapped-round-card">
            <div class="wrapped-round-header">
              <div style="display:flex; align-items:center; gap:8px;">
                <span class="badge" style="background:var(--accent-gold); color:#081d13; font-weight:800; font-family:var(--font-mono); font-size:0.75rem;">
                  Round ${round.roundNum}
                </span>
                ${isDoubleRound ? '<span class="badge" style="background:#f59e0b; color:#fff; font-size:0.65rem;">⚡ 2x Double</span>' : ''}
              </div>
              <span style="font-size:0.775rem; color:var(--text-muted);">
                Dealer: <strong style="color:var(--text-gold);">${escapeHtml(dealerName)}</strong> 🃏
              </span>
            </div>
            <div class="wrapped-round-grid">
              ${state.players.map(p => {
                const isDealerThisRound = p.id === round.dealerId;
                const pts = round.scores ? round.scores[p.id] : undefined;
                const cumulativeScore = round.cumulative ? round.cumulative[p.id] : undefined;
                const rawPts = round.rawScores ? round.rawScores[p.id] : undefined;
                const rejoinEvent = p.rejoinHistory ? p.rejoinHistory.find(h => h.roundNum === round.roundNum) : null;

                if (pts === undefined || pts === null) {
                  return `
                    <div class="wrapped-player-tile is-out">
                      <div class="wrapped-tile-name-row">
                        <span class="wrapped-player-name">${escapeHtml(p.name)}</span>
                        <span class="badge badge-out" style="font-size:0.55rem;">OUT</span>
                      </div>
                      <div class="wrapped-tile-score-row">
                        <span style="color:#ef4444; font-size:0.75rem; font-weight:700;">Eliminated</span>
                      </div>
                    </div>
                  `;
                }

                let valClass = '';
                let badge = '';
                if (pts === 0) {
                  valClass = 'win';
                  badge = 'Show 0';
                } else if (!isBestOf7() && pts === state.settings.firstDrop) {
                  valClass = 'first-drop';
                  badge = `Drop ${pts}`;
                } else if (!isBestOf7() && pts === state.settings.middleDrop) {
                  valClass = 'mid-drop';
                  badge = `Mid ${pts}`;
                } else if (!isBestOf7() && pts === state.settings.fullPoints) {
                  valClass = 'full';
                  badge = `Full ${pts}`;
                } else if (isDoubleRound && rawPts !== undefined) {
                  badge = `${pts} (${rawPts}x2)`;
                } else {
                  badge = `${pts}`;
                }

                const displayTotal = cumulativeScore !== undefined ? cumulativeScore : '-';

                return `
                  <div class="wrapped-player-tile ${isDealerThisRound ? 'is-dealer' : ''}">
                    <div class="wrapped-tile-name-row">
                      <span class="wrapped-player-name">${escapeHtml(p.name)}</span>
                      ${isDealerThisRound ? '<span class="cell-dealer-icon" title="Dealer">🃏</span>' : ''}
                    </div>
                    <div class="wrapped-tile-score-row">
                      <span class="cell-val ${valClass}">${badge}</span>
                      <span class="wrapped-cumulative" title="Running score">Tot: ${displayTotal}</span>
                    </div>
                    ${rejoinEvent ? `<span class="badge badge-rejoined" style="font-size:0.55rem; margin-top:2px;">Re-joined @ ${rejoinEvent.rejoinScore}</span>` : ''}
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        `;
      }).join('');

      const wrappedStandingsHtml = `
        <div class="wrapped-standings-card">
          <div style="font-size:0.8rem; font-weight:800; color:var(--accent-gold); text-transform:uppercase; letter-spacing:0.04em;">
            🏆 Current Table Standings
          </div>
          <div class="wrapped-standings-grid">
            ${state.players.map(p => {
              let color = '#34d399';
              if (p.isOut) color = '#ef4444';
              else if (!isBestOf7() && p.score >= state.settings.totalPoints * 0.75) color = '#f59e0b';
              return `
                <div class="wrapped-standing-item">
                  <div class="wrapped-standing-name">${escapeHtml(p.name)}</div>
                  <div class="wrapped-standing-score" style="color:${color}; font-weight:800; font-family:var(--font-mono);">
                    ${p.score} ${p.isOut ? '<span style="font-size:0.6rem; color:#ef4444;">OUT</span>' : 'pts'}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;

      els.tableContainer.innerHTML = `
        <div class="wrapped-matrix-container">
          ${wrappedCardsHtml}
          ${wrappedStandingsHtml}
        </div>
      `;
      return;
    }

    // OPTION 2: AUTO-FIT TABLE MATRIX (All columns fit side-by-side with zero horizontal scroll up to 6 players)
    const fitsScreen = state.players.length <= 6;

    let headHtml = `
      <tr>
        <th class="col-rnd">#</th>
        ${state.players.map(p => {
          const isCurrentDealer = state.currentDealerId === p.id;
          return `
            <th class="player-header">
              <div class="th-player-wrap">
                ${isCurrentDealer ? '<span class="th-dealer-badge" title="Current Dealer">🃏</span>' : ''}
                <span class="th-player-name">${escapeHtml(p.name)}</span>
              </div>
              ${p.isOut ? '<span class="badge badge-out th-out-badge">OUT</span>' : ''}
            </th>
          `;
        }).join('')}
      </tr>
    `;

    let rowsHtml = '';
    if (state.rounds.length === 0) {
      rowsHtml = `
        <tr>
          <td colspan="100" style="padding: 24px; color: var(--text-muted);">
            No rounds played yet. Click "Record Round" to add the first round scores.
          </td>
        </tr>
      `;
    } else {
      rowsHtml = state.rounds.map((round) => {
        const isDoubleRound = isBestOf7() && (round.roundNum === 1 || round.roundNum === 7);

        return `
          <tr>
            <td class="col-rnd" style="font-weight: 800; color: var(--accent-gold);">
              <div>${round.roundNum}</div>
              ${isDoubleRound ? '<div style="font-size:0.55rem; color:#fbbf24; line-height:1;">2x</div>' : ''}
            </td>
            ${state.players.map(p => {
              const isDealerThisRound = p.id === round.dealerId;
              const pts = round.scores ? round.scores[p.id] : undefined;
              const cumulativeScore = round.cumulative ? round.cumulative[p.id] : undefined;
              const rawPts = round.rawScores ? round.rawScores[p.id] : undefined;
              const rejoinEvent = p.rejoinHistory ? p.rejoinHistory.find(h => h.roundNum === round.roundNum) : null;

              if (pts === undefined || pts === null) {
                return `<td><span class="cell-out-tag">OUT</span></td>`;
              }

              let valClass = '';
              let typeLabel = '';
              if (pts === 0) {
                valClass = 'win';
                typeLabel = 'Show';
              } else if (!isBestOf7() && pts === state.settings.firstDrop) {
                valClass = 'first-drop';
                typeLabel = 'Drop';
              } else if (!isBestOf7() && pts === state.settings.middleDrop) {
                valClass = 'mid-drop';
                typeLabel = 'Mid';
              } else if (!isBestOf7() && pts === state.settings.fullPoints) {
                valClass = 'full';
                typeLabel = 'Full';
              } else if (isDoubleRound && rawPts !== undefined) {
                valClass = 'double';
                typeLabel = '2x';
              }

              const displayTotal = cumulativeScore !== undefined ? cumulativeScore : '-';

              return `
                <td>
                  <div class="round-cell ${isDealerThisRound ? 'is-dealer-cell' : ''}">
                    <div class="cell-top-line">
                      ${isDealerThisRound ? '<span class="cell-dealer-icon" title="Dealer this round">🃏</span>' : ''}
                      <span class="cell-score-val ${valClass}">${pts}</span>
                    </div>
                    ${typeLabel ? `<span class="cell-sub-type ${valClass}">${typeLabel}</span>` : ''}
                    <span class="cell-running" title="Running score after Round ${round.roundNum}">Tot ${displayTotal}</span>
                    ${rejoinEvent ? `<span class="badge badge-rejoined" style="font-size:0.5rem; margin-top:1px;">+${rejoinEvent.rejoinScore}</span>` : ''}
                  </div>
                </td>
              `;
            }).join('')}
          </tr>
        `;
      }).join('');
    }

    const totalRowHtml = `
      <tr class="total-row">
        <td class="col-rnd total-label" style="text-align: center; font-size: 0.72rem; font-weight: 800; letter-spacing: 0.05em;">TOT:</td>
        ${state.players.map(p => {
          let color = '#34d399';
          if (p.isOut) color = '#ef4444';
          else if (!isBestOf7() && p.score >= state.settings.totalPoints * 0.75) color = '#f59e0b';
          return `
            <td class="total-cell" style="color: ${color};">
              <div class="total-score-val">${p.score}</div>
              ${p.isOut ? '<div class="total-out-label">OUT</div>' : ''}
            </td>
          `;
        }).join('')}
      </tr>
    `;

    els.tableContainer.innerHTML = `
      <div class="table-wrapper fit-matrix-wrapper ${fitsScreen ? 'fit-no-scroll' : 'can-scroll'}">
        <table class="score-table ${fitsScreen ? 'fit-matrix-dense' : ''}">
          <thead>${headHtml}</thead>
          <tbody>${rowsHtml}</tbody>
          <tfoot>${totalRowHtml}</tfoot>
        </table>
      </div>
    `;
  }

  function renderStatsView() {
    if (state.players.length === 0) {
      els.statsContainer.innerHTML = `
        <div class="empty-state">
          <p>Stats will appear here once players and rounds are recorded.</p>
        </div>
      `;
      return;
    }

    const stats = state.players.map(p => {
      let shows = 0;
      let firstDrops = 0;
      let midDrops = 0;
      let fullCounts = 0;
      let roundsPlayed = 0;

      state.rounds.forEach(r => {
        if (r.scores && r.scores[p.id] !== undefined) {
          roundsPlayed++;
          const pts = r.scores[p.id];
          if (pts === 0) shows++;
          else if (!isBestOf7() && pts === state.settings.firstDrop) firstDrops++;
          else if (!isBestOf7() && pts === state.settings.middleDrop) midDrops++;
          else if (!isBestOf7() && pts === state.settings.fullPoints) fullCounts++;
        }
      });

      return {
        ...p,
        shows,
        firstDrops,
        midDrops,
        fullCounts,
        roundsPlayed
      };
    });

    // Best of 7: sorted by lowest score ascending. Pool: active first, lowest score
    stats.sort((a, b) => {
      if (!isBestOf7() && a.isOut !== b.isOut) return a.isOut ? 1 : -1;
      return a.score - b.score;
    });

    els.statsContainer.innerHTML = `
      <div class="table-wrapper">
        <table class="score-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th style="text-align: left; padding-left: 20px;">Player</th>
              <th>Status</th>
              <th>Score</th>
              <th>Shows (0) ✨</th>
              ${!isBestOf7() ? `
                <th>1st Drop</th>
                <th>Mid Drop</th>
                <th>Full Count</th>
                <th>Re-joins</th>
              ` : `
                <th>Rounds Played</th>
              `}
            </tr>
          </thead>
          <tbody>
            ${stats.map((s, idx) => `
              <tr>
                <td style="font-weight:800; color:var(--accent-gold);">#${idx + 1}</td>
                <td style="text-align: left; padding-left: 20px; font-weight:700;">${escapeHtml(s.name)}</td>
                <td>
                  ${s.isOut ? '<span class="badge badge-out">OUT</span>' : '<span class="badge" style="background:#10b981; color:#fff;">Active</span>'}
                </td>
                <td style="font-size: 1.1rem; font-weight:800; color: ${s.isOut ? '#ef4444' : '#34d399'};">${s.score}</td>
                <td style="color:#10b981; font-weight:700;">${s.shows}</td>
                ${!isBestOf7() ? `
                  <td style="color:#60a5fa;">${s.firstDrops}</td>
                  <td style="color:#f59e0b;">${s.midDrops}</td>
                  <td style="color:#ef4444;">${s.fullCounts}</td>
                  <td>${s.rejoinHistory ? s.rejoinHistory.length : 0}</td>
                ` : `
                  <td>${s.roundsPlayed} / 7</td>
                `}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderApp() {
    // 1. Toggle between Setup View and Dashboard View
    if (!state.gameStarted) {
      els.setupView.style.display = 'block';
      els.dashboardView.style.display = 'none';
      els.headerModeSubtitle.textContent = 'Player Management & Mode Selection';
      if (els.headerSetupBtn) els.headerSetupBtn.style.display = 'none';
      renderSetupView();
      return;
    }

    els.setupView.style.display = 'none';
    els.dashboardView.style.display = 'flex';
    if (els.headerSetupBtn) els.headerSetupBtn.style.display = 'inline-flex';
    els.headerModeSubtitle.textContent = isBestOf7() ? 'Best of 7 Game Mode' : 'Pool Full Rummy Mode';

    renderRulesBar();
    renderGameInfo();
    renderPlayerCards();
    renderTableView();
    renderStatsView();

    // Enable/disable undo
    els.undoBtn.disabled = state.historyStack.length === 0;
    els.undoBtn.style.opacity = state.historyStack.length === 0 ? '0.5' : '1';

    // Show/hide Edit Last Round buttons
    const hasRounds = state.rounds.length > 0;
    if (els.editLastRoundBtn) {
      els.editLastRoundBtn.style.display = hasRounds ? 'inline-flex' : 'none';
      if (hasRounds) {
        els.editLastRoundBtn.innerHTML = `<span>✏️</span> Edit R${state.rounds.length} Score`;
      }
    }
    if (els.editLastRoundTableBtn) {
      els.editLastRoundTableBtn.style.display = hasRounds ? 'inline-flex' : 'none';
      if (hasRounds) {
        els.editLastRoundTableBtn.innerHTML = `<span>✏️</span> Edit R${state.rounds.length} Score`;
      }
    }

    // Record Round button status
    const winner = checkGameWinner(true);
    let canRecord = false;
    if (isBestOf7()) {
      canRecord = state.rounds.length < 7 && !winner;
    } else {
      canRecord = state.players.length >= 2 && getActivePlayers().length >= 2 && !winner;
    }

    els.recordRoundBtn.disabled = !canRecord;
    if (winner) {
      els.recordRoundBtn.title = `Game Over — ${winner.name} won! Start a new game to play again.`;
    } else if (isBestOf7() && state.rounds.length >= 7) {
      els.recordRoundBtn.title = 'Best of 7 completed! All 7 rounds played.';
    } else {
      els.recordRoundBtn.title = 'Record scores for the current round';
    }
  }

  // --- Handlers: Settings (Pool mode) ---
  function openSettingsModal() {
    document.getElementById('input-first-drop').value = state.settings.firstDrop;
    document.getElementById('input-middle-drop').value = state.settings.middleDrop;
    document.getElementById('input-full-points').value = state.settings.fullPoints;
    document.getElementById('input-total-points').value = state.settings.totalPoints;
    openModal(els.settingsModal);
  }

  function saveSettings(e) {
    e.preventDefault();
    const firstDrop = parseInt(document.getElementById('input-first-drop').value, 10);
    const middleDrop = parseInt(document.getElementById('input-middle-drop').value, 10);
    const fullPoints = parseInt(document.getElementById('input-full-points').value, 10);
    const totalPoints = parseInt(document.getElementById('input-total-points').value, 10);

    if (isNaN(firstDrop) || isNaN(middleDrop) || isNaN(fullPoints) || isNaN(totalPoints)) {
      showToast('Please enter valid numeric point values', 'danger');
      return;
    }

    pushHistory();
    state.settings.firstDrop = firstDrop;
    state.settings.middleDrop = middleDrop;
    state.settings.fullPoints = fullPoints;
    state.settings.totalPoints = totalPoints;

    recalculateAllScores();
    saveState();
    closeModal(els.settingsModal);
    renderApp();
    showToast('Game points configuration updated', 'success');
  }

  function setDealer(playerId) {
    const player = state.players.find(p => p.id === playerId);
    if (!player) return;
    if (player.isOut) {
      showToast('Eliminated player cannot be selected as dealer', 'danger');
      return;
    }
    pushHistory();
    state.currentDealerId = playerId;
    saveState();
    renderApp();
    showToast(`🃏 Dealer set to ${player.name}`, 'info');
  }

  function openFirstDealerModal() {
    if (state.players.length === 0) {
      showToast('No active players', 'danger');
      return;
    }

    els.firstDealerSelect.innerHTML = state.players.map(p => `
      <option value="${p.id}" ${p.id === state.firstDealerId ? 'selected' : ''}>
        ${escapeHtml(p.name)}
      </option>
    `).join('');

    openModal(els.firstDealerModal);
  }

  function saveFirstDealer() {
    const selectedId = els.firstDealerSelect.value;
    if (!selectedId) return;

    pushHistory();
    state.firstDealerId = selectedId;
    state.currentDealerId = selectedId;

    state.players.forEach(p => {
      p.isFirstDealer = p.id === selectedId;
    });

    saveState();
    closeModal(els.firstDealerModal);
    renderApp();
    showToast(`First dealer set to ${state.players.find(p => p.id === selectedId)?.name}`, 'success');
  }

  // --- Handlers: Realign Dealer Order (Seating & Rotation) ---
  function movePlayerInGame(playerId, direction) {
    const idx = state.players.findIndex(p => p.id === playerId);
    if (idx < 0) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= state.players.length) return;

    pushHistory();
    const temp = state.players[idx];
    state.players[idx] = state.players[targetIdx];
    state.players[targetIdx] = temp;

    saveState();
    renderApp();
    renderDealerOrderModalList();
  }

  function toggleMatrixViewMode() {
    state.matrixViewMode = state.matrixViewMode === 'wrapped' ? 'table' : 'wrapped';
    saveState();
    renderTableView();
    showToast(state.matrixViewMode === 'wrapped' ? '🎴 Switched to Wrapped Cards View' : '📊 Switched to Auto-fit Table Matrix', 'info');
  }

  function setDealerFromModal(playerId) {
    const player = state.players.find(p => p.id === playerId);
    if (!player || player.isOut) return;
    pushHistory();
    state.currentDealerId = playerId;
    saveState();
    renderApp();
    renderDealerOrderModalList();
    showToast(`🃏 Dealer set to ${player.name}`, 'info');
  }

  function renderDealerOrderModalList() {
    if (!els.dealerOrderList) return;
    if (state.players.length === 0) {
      els.dealerOrderList.innerHTML = `<p style="color:var(--text-muted); text-align:center;">No players at the table.</p>`;
      return;
    }

    els.dealerOrderList.innerHTML = state.players.map((p, index) => {
      const isCurrentDealer = state.currentDealerId === p.id;
      return `
        <div class="dealer-order-item ${isCurrentDealer ? 'is-current-dealer' : ''} ${p.isOut ? 'is-out' : ''}">
          <div class="dealer-order-left">
            <span class="dealer-order-num">${index + 1}.</span>
            <span class="dealer-order-name">${escapeHtml(p.name)}</span>
            ${isCurrentDealer ? '<span class="badge badge-dealer" style="font-size:0.65rem;">🃏 Dealing</span>' : ''}
            ${p.isOut ? '<span class="badge badge-out" style="font-size:0.6rem;">OUT</span>' : ''}
          </div>
          <div class="dealer-order-actions">
            ${!isCurrentDealer && !p.isOut ? `
              <button type="button" class="btn btn-outline btn-sm" style="padding:4px 8px; font-size:0.75rem;" onclick="window.RummyApp.setDealerFromModal('${p.id}')" title="Make active dealer">
                Deal
              </button>
            ` : ''}
            <div class="reorder-btn-group">
              <button type="button" class="btn-reorder" onclick="window.RummyApp.movePlayerInGame('${p.id}', 'up')" title="Move earlier in dealer order" ${index === 0 ? 'disabled' : ''}>⬆️</button>
              <button type="button" class="btn-reorder" onclick="window.RummyApp.movePlayerInGame('${p.id}', 'down')" title="Move later in dealer order" ${index === state.players.length - 1 ? 'disabled' : ''}>⬇️</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  function openDealerOrderModal() {
    if (state.players.length === 0) {
      showToast('No active players to reorder', 'danger');
      return;
    }
    renderDealerOrderModalList();
    openModal(els.dealerOrderModal);
  }

  function closeDealerOrderModalFunc() {
    closeModal(els.dealerOrderModal);
  }

  // --- Handlers: Re-join (Pool mode only) ---
  function openRejoinModal(playerId) {
    if (isBestOf7()) return;
    const player = state.players.find(p => p.id === playerId);
    if (!player) return;

    const suggested = calculateRejoinScore();
    const highestActive = getHighestActiveScore();
    const maxLimit = getMaxRejoinLimit();

    if (suggested > maxLimit) {
      showToast(`Cannot re-join: Re-join score (${suggested}) exceeds ${maxLimit} (no drop left)`, 'danger');
      return;
    }

    els.rejoinPlayerIdInput.value = player.id;
    els.rejoinPlayerName.textContent = player.name;
    els.rejoinSuggestedScore.innerHTML = `
      <strong>Highest active score:</strong> ${highestActive} pts.<br>
      Standard Re-join rule: <strong>Highest active + 1 = ${suggested} pts</strong>.<br>
      <span style="font-size:0.8rem; color:#34d399;">✓ Drop safe: Score is ${suggested} &le; ${maxLimit} (at least one ${state.settings.firstDrop}-pt drop left).</span>
    `;

    els.rejoinScoreInput.value = suggested;
    els.rejoinScoreInput.max = maxLimit;
    els.confirmRejoinBtn.disabled = false;

    openModal(els.rejoinModal);
  }

  function processRejoin(e) {
    e.preventDefault();
    if (isBestOf7()) return;

    const playerId = els.rejoinPlayerIdInput.value;
    const newScore = parseInt(els.rejoinScoreInput.value, 10);
    const maxLimit = getMaxRejoinLimit();

    const player = state.players.find(p => p.id === playerId);
    if (!player) return;

    if (isNaN(newScore) || newScore < 0) {
      showToast('Please enter a valid rejoin score', 'danger');
      return;
    }

    if (newScore > maxLimit) {
      showToast(`Re-join score cannot exceed ${maxLimit} points (no drop left)`, 'danger');
      return;
    }

    pushHistory();

    if (!player.rejoinHistory) player.rejoinHistory = [];
    player.rejoinHistory.push({
      roundNum: state.rounds.length + 1,
      rejoinScore: newScore
    });

    recalculateAllScores();
    AudioEngine.rejoin();
    saveState();
    closeModal(els.rejoinModal);
    renderApp();
    showToast(`🎉 ${player.name} re-joined the game with ${newScore} points!`, 'success');
  }

  // --- Handlers: Record Round ---
  function openRecordRoundModal() {
    const activePlayers = isBestOf7() ? state.players : getActivePlayers();
    if (activePlayers.length < 2) {
      showToast('At least 2 players needed to record a round', 'danger');
      return;
    }

    const nextRoundNum = state.rounds.length + 1;
    if (isBestOf7() && nextRoundNum > 7) {
      showToast('All 7 rounds in Best of 7 are already completed!', 'danger');
      return;
    }

    const currentDealer = state.players.find(p => p.id === state.currentDealerId);
    els.currentDealerLabel.textContent = currentDealer ? currentDealer.name : 'Not set';
    els.roundNumberHeading.textContent = `Record Round ${nextRoundNum}${isBestOf7() ? ' of 7' : ''}`;

    // Best of 7 Double Score Warning (Round 1 & 7)
    const isDoubleRound = isBestOf7() && (nextRoundNum === 1 || nextRoundNum === 7);
    els.recordDoubleWarning.style.display = isDoubleRound ? 'flex' : 'none';

    if (isBestOf7()) {
      els.recordRoundInstruction.textContent = isDoubleRound ?
        'Round 1 and 7 are DOUBLE POINTS (2x). Enter raw points scored (e.g., 100); the app will automatically record double (200).' :
        'Manual score entry. Enter exact points scored by each player (or tap Show 0).';
    } else {
      els.recordRoundInstruction.textContent = 'Tap a quick button (✨ Show, 1st Drop, Mid Drop, Full Count) or enter custom card penalty points.';
    }

    const submitBtn = document.getElementById('record-round-submit-btn');
    if (submitBtn) {
      if (isBestOf7()) {
        submitBtn.innerHTML = nextRoundNum === 7 ?
          '🏆 Save Final Round 7 Scores &amp; Declare Winner' :
          `💾 Save Round ${nextRoundNum} Scores`;
      } else {
        submitBtn.innerHTML = '💾 Save Round &amp; Rotate Dealer';
      }
    }

    els.recordRoundEntries.innerHTML = activePlayers.map(p => {
      const isDealer = p.id === state.currentDealerId;

      if (isBestOf7()) {
        return `
          <div class="round-entry-row" data-player-id="${p.id}">
            <div class="entry-player-header">
              <div class="entry-player-name">
                <span>${escapeHtml(p.name)}</span>
                ${isDealer ? '<span class="badge badge-dealer">🃏 Dealer</span>' : ''}
                <span style="font-size: 0.75rem; color: var(--text-muted);">(Total: ${p.score})</span>
              </div>
              <div class="entry-input-wrap">
                <button type="button" class="entry-chip-btn chip-win" onclick="window.RummyApp.selectChip('${p.id}', 0, this, 'score-input-', ${isDoubleRound})" style="padding: 5px 9px;">
                  ✨ Show (0)
                </button>
                <input type="number"
                       min="0"
                       max="400"
                       class="form-input entry-score-input"
                       id="score-input-${p.id}"
                       placeholder="Pts"
                       value=""
                       oninput="window.RummyApp.handleLiveDoublePreview('${p.id}', this.value, ${isDoubleRound})"
                       required>
              </div>
            </div>
            ${isDoubleRound ? `
              <div id="double-preview-${p.id}" class="live-doubled-calc" style="text-align: right; font-size: 0.75rem; color: #fbbf24; font-weight: 600;">
                ⚡ Will record: 0 pts
              </div>
            ` : ''}
          </div>
        `;
      }

      return `
        <div class="round-entry-row" data-player-id="${p.id}">
          <div class="entry-player-header">
            <div class="entry-player-name">
              <span>${escapeHtml(p.name)}</span>
              ${isDealer ? '<span class="badge badge-dealer">🃏 Dealer</span>' : ''}
              <span style="font-size: 0.75rem; color: var(--text-muted);">(Total: ${p.score})</span>
            </div>
            <div class="entry-input-wrap">
              <input type="number"
                     min="0"
                     max="400"
                     class="form-input entry-score-input"
                     id="score-input-${p.id}"
                     placeholder="Pts"
                     value=""
                     required>
            </div>
          </div>
          <div class="entry-chips">
            <button type="button" class="entry-chip-btn chip-win" onclick="window.RummyApp.selectChip('${p.id}', 0, this, 'score-input-', false)">
              ✨ Show (0)
            </button>
            <button type="button" class="entry-chip-btn" onclick="window.RummyApp.selectChip('${p.id}', ${state.settings.firstDrop}, this, 'score-input-', false)">
              1st Drop (${state.settings.firstDrop})
            </button>
            <button type="button" class="entry-chip-btn" onclick="window.RummyApp.selectChip('${p.id}', ${state.settings.middleDrop}, this, 'score-input-', false)">
              Mid Drop (${state.settings.middleDrop})
            </button>
            <button type="button" class="entry-chip-btn" onclick="window.RummyApp.selectChip('${p.id}', ${state.settings.fullPoints}, this, 'score-input-', false)">
              Full (${state.settings.fullPoints})
            </button>
          </div>
        </div>
      `;
    }).join('');

    openModal(els.recordRoundModal);
  }

  function handleLiveDoublePreview(playerId, value, isDoubleRound, prefix = 'double-preview-') {
    if (!isDoubleRound) return;
    const previewEl = document.getElementById(`${prefix}${playerId}`);
    if (!previewEl) return;
    const raw = parseInt(value, 10);
    if (!isNaN(raw) && raw >= 0) {
      previewEl.textContent = `⚡ Will record: ${raw * 2} pts (doubled)`;
    } else {
      previewEl.textContent = `⚡ Will record: 0 pts`;
    }
  }

  function selectChip(playerId, score, chipBtn, inputPrefix = 'score-input-', isDoubleRound = false) {
    const input = document.getElementById(`${inputPrefix}${playerId}`);
    if (!input) return;

    input.value = score;
    handleLiveDoublePreview(playerId, score, isDoubleRound, inputPrefix === 'edit-score-input-' ? 'edit-double-preview-' : 'double-preview-');

    const row = chipBtn.closest('.round-entry-row');
    row.querySelectorAll('.entry-chip-btn').forEach(btn => btn.classList.remove('selected'));
    chipBtn.classList.add('selected');

    if (score === 0) {
      AudioEngine.win();
    } else if (score === state.settings.firstDrop || score === state.settings.middleDrop) {
      AudioEngine.drop();
    }
  }

  function submitRound(e) {
    e.preventDefault();
    const activePlayers = isBestOf7() ? state.players : getActivePlayers();
    const nextRoundNum = state.rounds.length + 1;
    const isDoubleRound = isBestOf7() && (nextRoundNum === 1 || nextRoundNum === 7);

    const roundScores = {};
    const rawScores = {};
    let showCount = 0;
    let hasEmpty = false;

    for (const player of activePlayers) {
      const input = document.getElementById(`score-input-${player.id}`);
      if (!input || input.value === '') {
        hasEmpty = true;
        break;
      }
      const rawVal = parseInt(input.value, 10);
      if (isNaN(rawVal) || rawVal < 0) {
        showToast(`Invalid score for ${player.name}`, 'danger');
        return;
      }
      rawScores[player.id] = rawVal;
      // In Best of 7 (R1 and R7), points are doubled!
      const recordedVal = isDoubleRound ? (rawVal * 2) : rawVal;
      roundScores[player.id] = recordedVal;
      if (rawVal === 0) showCount++;
    }

    if (hasEmpty) {
      showToast('Please enter scores for all players', 'danger');
      return;
    }

    if (showCount === 0) {
      if (!confirm('No player was given 0 points (Show). Are you sure you want to proceed?')) {
        return;
      }
    } else if (showCount > 1) {
      if (!confirm('Multiple players have 0 points (Show). Are you sure you want to proceed?')) {
        return;
      }
    }

    pushHistory();

    const roundData = {
      roundNum: nextRoundNum,
      dealerId: state.currentDealerId,
      scores: roundScores,
      rawScores: rawScores,
      cumulative: {},
      timestamp: Date.now()
    };

    state.rounds.push(roundData);
    state.gameStarted = true;

    // Recalculate all scores
    recalculateAllScores();

    // Rotate dealer for next round
    rotateDealer();

    saveState();
    closeModal(els.recordRoundModal);
    renderApp();

    // Check winner
    const winner = checkGameWinner(false);
    if (winner) {
      AudioEngine.fanfare();
      showToast(`🏆 Game Over! ${winner.name} won!`, 'success');
    } else {
      AudioEngine.win();
      showToast(`Round ${roundData.roundNum} scores saved!`, 'success');
    }
  }

  // --- Handlers: Edit Last Round ---
  function openEditLastRoundModal() {
    if (state.rounds.length === 0) {
      showToast('No rounds have been recorded yet', 'danger');
      return;
    }

    const lastRound = state.rounds[state.rounds.length - 1];
    const isDoubleRound = isBestOf7() && (lastRound.roundNum === 1 || lastRound.roundNum === 7);

    els.editRoundHeading.innerHTML = `<span>✏️</span> Edit Round ${lastRound.roundNum} Score`;
    els.editRoundSubheading.textContent = `Modify the scores recorded for Round ${lastRound.roundNum} and save.`;
    els.editDoubleWarning.style.display = isDoubleRound ? 'flex' : 'none';

    if (isBestOf7()) {
      els.editRoundInstruction.textContent = isDoubleRound ?
        'Round 1 and 7 are DOUBLE POINTS (2x). Enter raw points scored; app will automatically record double.' :
        'Manual score entry. Enter exact points scored by each player.';
    } else {
      els.editRoundInstruction.textContent = 'Update scores for any player below. Points, totals, and standings will automatically recalculate.';
    }

    const participants = state.players.filter(p => lastRound.scores && lastRound.scores[p.id] !== undefined);

    const editSubmitBtn = document.getElementById('edit-round-submit-btn');
    if (editSubmitBtn) {
      editSubmitBtn.innerHTML = `💾 Update Round ${lastRound.roundNum} Scores`;
    }

    els.editRoundEntries.innerHTML = participants.map(p => {
      const currentScore = lastRound.scores[p.id];
      const rawScore = (lastRound.rawScores && lastRound.rawScores[p.id] !== undefined) ?
        lastRound.rawScores[p.id] :
        (isDoubleRound ? Math.round(currentScore / 2) : currentScore);

      const isShow = rawScore === 0;
      const isFirstDrop = !isBestOf7() && currentScore === state.settings.firstDrop;
      const isMidDrop = !isBestOf7() && currentScore === state.settings.middleDrop;
      const isFull = !isBestOf7() && currentScore === state.settings.fullPoints;

      if (isBestOf7()) {
        return `
          <div class="round-entry-row" data-player-id="${p.id}">
            <div class="entry-player-header">
              <div class="entry-player-name">
                <span>${escapeHtml(p.name)}</span>
                <span style="font-size: 0.75rem; color: var(--text-muted);">(Recorded: ${currentScore})</span>
              </div>
              <div class="entry-input-wrap">
                <button type="button" class="entry-chip-btn chip-win ${isShow ? 'selected' : ''}" onclick="window.RummyApp.selectChip('${p.id}', 0, this, 'edit-score-input-', ${isDoubleRound})" style="padding: 5px 9px;">
                  ✨ Show (0)
                </button>
                <input type="number"
                       min="0"
                       max="400"
                       class="form-input entry-score-input"
                       id="edit-score-input-${p.id}"
                       placeholder="Pts"
                       value="${rawScore}"
                       oninput="window.RummyApp.handleLiveDoublePreview('${p.id}', this.value, ${isDoubleRound}, 'edit-double-preview-')"
                       required>
              </div>
            </div>
            ${isDoubleRound ? `
              <div id="edit-double-preview-${p.id}" class="live-doubled-calc" style="text-align: right; font-size: 0.75rem; color: #fbbf24; font-weight: 600;">
                ⚡ Will record: ${rawScore * 2} pts (doubled)
              </div>
            ` : ''}
          </div>
        `;
      }

      return `
        <div class="round-entry-row" data-player-id="${p.id}">
          <div class="entry-player-header">
            <div class="entry-player-name">
              <span>${escapeHtml(p.name)}</span>
              <span style="font-size: 0.75rem; color: var(--text-muted);">(Recorded: ${currentScore})</span>
            </div>
            <div class="entry-input-wrap">
              <input type="number"
                     min="0"
                     max="400"
                     class="form-input entry-score-input"
                     id="edit-score-input-${p.id}"
                     placeholder="Pts"
                     value="${rawScore}"
                     required>
            </div>
          </div>
          <div class="entry-chips">
            <button type="button" class="entry-chip-btn chip-win ${isShow ? 'selected' : ''}" onclick="window.RummyApp.selectChip('${p.id}', 0, this, 'edit-score-input-', false)">
              ✨ Show (0)
            </button>
            <button type="button" class="entry-chip-btn ${isFirstDrop ? 'selected' : ''}" onclick="window.RummyApp.selectChip('${p.id}', ${state.settings.firstDrop}, this, 'edit-score-input-', false)">
              1st Drop (${state.settings.firstDrop})
            </button>
            <button type="button" class="entry-chip-btn ${isMidDrop ? 'selected' : ''}" onclick="window.RummyApp.selectChip('${p.id}', ${state.settings.middleDrop}, this, 'edit-score-input-', false)">
              Mid Drop (${state.settings.middleDrop})
            </button>
            <button type="button" class="entry-chip-btn ${isFull ? 'selected' : ''}" onclick="window.RummyApp.selectChip('${p.id}', ${state.settings.fullPoints}, this, 'edit-score-input-', false)">
              Full (${state.settings.fullPoints})
            </button>
          </div>
        </div>
      `;
    }).join('');

    openModal(els.editRoundModal);
  }

  function submitEditLastRound(e) {
    e.preventDefault();
    if (state.rounds.length === 0) return;

    const lastRound = state.rounds[state.rounds.length - 1];
    const isDoubleRound = isBestOf7() && (lastRound.roundNum === 1 || lastRound.roundNum === 7);
    const participants = state.players.filter(p => lastRound.scores && lastRound.scores[p.id] !== undefined);
    const updatedScores = {};
    const updatedRawScores = {};
    let showCount = 0;

    for (const player of participants) {
      const input = document.getElementById(`edit-score-input-${player.id}`);
      if (!input || input.value === '') {
        showToast(`Please enter score for ${player.name}`, 'danger');
        return;
      }
      const rawVal = parseInt(input.value, 10);
      if (isNaN(rawVal) || rawVal < 0) {
        showToast(`Invalid score for ${player.name}`, 'danger');
        return;
      }
      updatedRawScores[player.id] = rawVal;
      updatedScores[player.id] = isDoubleRound ? (rawVal * 2) : rawVal;
      if (rawVal === 0) showCount++;
    }

    if (showCount === 0) {
      if (!confirm('No player was given 0 points (Show). Are you sure you want to proceed?')) {
        return;
      }
    } else if (showCount > 1) {
      if (!confirm('Multiple players have 0 points (Show). Are you sure you want to proceed?')) {
        return;
      }
    }

    pushHistory();

    lastRound.scores = updatedScores;
    lastRound.rawScores = updatedRawScores;

    recalculateAllScores();

    saveState();
    closeModal(els.editRoundModal);
    renderApp();
    showToast(`Round ${lastRound.roundNum} score updated!`, 'success');

    // Check winner
    checkGameWinner(false);
  }

  // --- Reset & New Game ---
  function handleNewGame() {
    if (confirm('Start a new game?\n\n- Click OK to reset scores and return to Setup/Player Selection.\n- Click Cancel to keep current game.')) {
      pushHistory();
      state.rounds = [];
      state.gameStarted = false;
      state.players.forEach(p => {
        p.score = 0;
        p.isOut = false;
        p.rejoinHistory = [];
      });
      saveState();
      renderApp();
      showToast('Game reset. Select players/mode for new game.', 'info');
    }
  }

  function handleShareScorecard() {
    if (state.players.length === 0) {
      showToast('No game data to share', 'danger');
      return;
    }

    const lines = [
      `🃏 *RUMMY SCOREBOARD (${isBestOf7() ? 'Best of 7' : 'Pool Full Rummy'})* 🃏`,
      `Rounds Completed: ${state.rounds.length}${isBestOf7() ? '/7' : ''}`,
      `-----------------------------`
    ];

    state.players.forEach(p => {
      const status = p.isOut ? '❌ OUT' : '✅ Active';
      lines.push(`${p.name}: ${p.score} pts (${isBestOf7() ? 'Active' : status})`);
    });

    lines.push(`-----------------------------`);
    lines.push(`Generated by Rummy Scoreboard`);

    const text = lines.join('\n');

    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        showToast('📋 Scoreboard copied to clipboard for WhatsApp/sharing!', 'success');
      }).catch(() => {
        prompt('Copy your scoreboard summary below:', text);
      });
    } else {
      prompt('Copy your scoreboard summary below:', text);
    }
  }

  function switchTab(activeTab) {
    [els.tabCardsBtn, els.tabTableBtn, els.tabStatsBtn].forEach(b => b.classList.remove('active'));
    [els.cardsView, els.tableView, els.statsView].forEach(v => v.style.display = 'none');

    if (activeTab === 'cards') {
      els.tabCardsBtn.classList.add('active');
      els.cardsView.style.display = 'block';
    } else if (activeTab === 'table') {
      els.tabTableBtn.classList.add('active');
      els.tableView.style.display = 'block';
    } else if (activeTab === 'stats') {
      els.tabStatsBtn.classList.add('active');
      els.statsView.style.display = 'block';
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // --- Attach Event Listeners ---
  function initEvents() {
    // Header Setup Button (Switch to Setup / Players)
    if (els.headerSetupBtn) {
      els.headerSetupBtn.onclick = returnToSetup;
    }

    // Setup Form & Buttons
    if (els.setupAddPlayerForm) {
      els.setupAddPlayerForm.onsubmit = handleAddPlayer;
    }
    if (els.startGameBtn) {
      els.startGameBtn.onclick = startGame;
    }

    // Settings
    els.editSettingsBtn.onclick = openSettingsModal;
    els.closeSettingsModal.onclick = () => closeModal(els.settingsModal);
    els.cancelSettingsModal.onclick = () => closeModal(els.settingsModal);
    els.settingsForm.onsubmit = saveSettings;

    // Dealer & Rejoin
    els.closeFirstDealerModal.onclick = () => closeModal(els.firstDealerModal);
    els.saveFirstDealerBtn.onclick = saveFirstDealer;
    els.closeRejoinModal.onclick = () => closeModal(els.rejoinModal);
    els.rejoinForm.onsubmit = processRejoin;

    // Round Entry
    els.recordRoundBtn.onclick = openRecordRoundModal;
    els.closeRecordRoundModal.onclick = () => closeModal(els.recordRoundModal);
    els.recordRoundForm.onsubmit = submitRound;

    // Edit Last Round
    if (els.editLastRoundBtn) {
      els.editLastRoundBtn.onclick = openEditLastRoundModal;
    }
    if (els.editLastRoundTableBtn) {
      els.editLastRoundTableBtn.onclick = openEditLastRoundModal;
    }
    els.closeEditRoundModal.onclick = () => closeModal(els.editRoundModal);
    els.cancelEditRoundModal.onclick = () => closeModal(els.editRoundModal);
    els.editRoundForm.onsubmit = submitEditLastRound;

    // Winner Modal Events
    if (els.winnerNewGameBtn) {
      els.winnerNewGameBtn.onclick = () => {
        closeModal(els.winnerModal);
        handleNewGame();
      };
    }
    if (els.winnerEditLastBtn) {
      els.winnerEditLastBtn.onclick = () => {
        closeModal(els.winnerModal);
        openEditLastRoundModal();
      };
    }
    if (els.closeWinnerModal) {
      els.closeWinnerModal.onclick = () => closeModal(els.winnerModal);
    }

    // General Actions
    els.undoBtn.onclick = undoLastAction;
    els.newGameBtn.onclick = handleNewGame;
    els.shareScorecardBtn.onclick = handleShareScorecard;

    // Matrix View Mode Toggle
    if (els.toggleMatrixViewBtn) {
      els.toggleMatrixViewBtn.onclick = toggleMatrixViewMode;
    }

    // Dealer Order Realign
    if (els.realignDealersTableBtn) {
      els.realignDealersTableBtn.onclick = openDealerOrderModal;
    }
    if (els.realignDealersCardsBtn) {
      els.realignDealersCardsBtn.onclick = openDealerOrderModal;
    }
    if (els.closeDealerOrderModal) {
      els.closeDealerOrderModal.onclick = closeDealerOrderModalFunc;
    }
    if (els.closeDealerOrderDoneBtn) {
      els.closeDealerOrderDoneBtn.onclick = closeDealerOrderModalFunc;
    }

    // Tabs
    els.tabCardsBtn.onclick = () => switchTab('cards');
    els.tabTableBtn.onclick = () => switchTab('table');
    els.tabStatsBtn.onclick = () => switchTab('stats');

    // Backdrop dismissal
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          closeModal(overlay);
        }
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay.active').forEach(m => closeModal(m));
      }
    });
  }

  // --- Expose Public API for inline HTML handlers ---
  window.RummyApp = {
    handleAddPlayer,
    addPlayerToRoster,
    selectGameMode,
    togglePlayerSelection,
    setSetupFirstDealer,
    removePlayerFromRoster,
    moveRosterPlayer,
    movePlayerInGame,
    setDealerFromModal,
    openDealerOrderModal,
    toggleMatrixViewMode,
    returnToSetup,
    openRejoinModal,
    openFirstDealerModal,
    openEditLastRoundModal,
    openSettingsModal,
    setDealer,
    selectChip,
    handleLiveDoublePreview
  };

  // --- App Initialization ---
  function init() {
    loadState();
    initEvents();
    renderApp();
    if (state.gameStarted) {
      switchTab('table');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
