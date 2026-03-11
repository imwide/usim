/**
 * App controller - handles auth UI, lobby, game lifecycle, pause menu & settings
 */
(function () {
  // --- DOM references ---
  const authScreen   = document.getElementById('auth-screen');
  const lobbyScreen  = document.getElementById('lobby-screen');
  const gameScreen   = document.getElementById('game-screen');
  const authForm     = document.getElementById('auth-form');
  const authError    = document.getElementById('auth-error');
  const authSubmit   = document.getElementById('auth-submit');
  const tabs         = document.querySelectorAll('.auth-tab');
  const lobbyUsername= document.getElementById('lobby-username');
  const playBtn      = document.getElementById('play-btn');
  const lobbyLogout  = document.getElementById('lobby-logout');
  const hudLogout    = document.getElementById('hud-logout');

  // Pause menu
  const pauseMenu       = document.getElementById('pause-menu');
  const pauseResume     = document.getElementById('pause-resume');
  const pauseSettings   = document.getElementById('pause-settings');
  const pauseLobby      = document.getElementById('pause-lobby');
  const pauseLogout     = document.getElementById('pause-logout');

  // Settings menu
  const settingsMenu    = document.getElementById('settings-menu');
  const sensSlider      = document.getElementById('sens-slider');
  const sensVal         = document.getElementById('sens-val');
  const settingsReset   = document.getElementById('settings-reset');
  const settingsClose   = document.getElementById('settings-close');
  const keybindBtns     = document.querySelectorAll('.keybind-btn');

  let currentTab  = 'login';
  let currentUser = null;
  let authToken   = null;
  let game        = null;

  // ---- Helpers ----------------------------------------------------------------

  // Convert a KeyboardEvent.code to a short readable label
  function codeToLabel(code) {
    if (!code) return '?';
    const map = {
      Space: 'Space', ShiftLeft: 'L.Shift', ShiftRight: 'R.Shift',
      ControlLeft: 'L.Ctrl', ControlRight: 'R.Ctrl',
      AltLeft: 'L.Alt', AltRight: 'R.Alt',
      ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    };
    if (map[code]) return map[code];
    // KeyA → A, Digit1 → 1, etc.
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return 'Num' + code.slice(6);
    return code;
  }

  // ---- Auth -------------------------------------------------------------------

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      currentTab = tab.dataset.tab;
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      authSubmit.textContent = currentTab === 'login' ? 'Login' : 'Create Account';
      authError.textContent = '';
    });
  });

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    authError.textContent = '';

    const endpoint = currentTab === 'login' ? '/api/auth/login' : '/api/auth/register';
    try {
      const res  = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) { authError.textContent = data.error || 'Something went wrong'; return; }
      currentUser = data;
      authToken   = data.token;
      showLobby();
    } catch (err) {
      authError.textContent = 'Network error';
    }
  });

  async function checkSession() {
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        currentUser = await res.json();
        authToken   = currentUser.token;
        showLobby();
      }
    } catch (e) {}
  }

  // ---- Screen transitions -----------------------------------------------------

  function showAuth() {
    authScreen.style.display  = 'flex';
    lobbyScreen.style.display = 'none';
    gameScreen.style.display  = 'none';
    authError.textContent = '';
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
  }

  function showLobby() {
    authScreen.style.display  = 'none';
    lobbyScreen.style.display = 'flex';
    gameScreen.style.display  = 'none';
    lobbyUsername.textContent = currentUser.username;
    drawCharacterPreview();
  }

  function showGame() {
    authScreen.style.display  = 'none';
    lobbyScreen.style.display = 'none';
    gameScreen.style.display  = 'block';
  }

  // ---- Lobby character preview -------------------------------------------------

  function drawCharacterPreview() {
    const canvas = document.getElementById('character-canvas');
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, s = 2.5;
    ctx.fillStyle = '#ffcc99';
    ctx.fillRect(cx - 15*s, 30, 30*s, 30*s);
    ctx.fillStyle = '#2299ff';
    ctx.fillRect(cx - 20*s, 30 + 30*s, 40*s, 50*s);
    ctx.fillRect(cx - 30*s, 30 + 32*s, 8*s, 40*s);
    ctx.fillRect(cx + 22*s, 30 + 32*s, 8*s, 40*s);
    ctx.fillStyle = '#333366';
    ctx.fillRect(cx - 15*s, 30 + 80*s, 12*s, 35*s);
    ctx.fillRect(cx +  3*s, 30 + 80*s, 12*s, 35*s);
    ctx.fillStyle = '#333';
    ctx.fillRect(cx -  8*s, 30 + 10*s, 5*s, 5*s);
    ctx.fillRect(cx +  3*s, 30 + 10*s, 5*s, 5*s);
  }

  // ---- Play / Leave -----------------------------------------------------------

  playBtn.addEventListener('click', () => {
    showGame();
    game = new Game();
    game.start(currentUser.username, authToken);
  });

  async function logout() {
    if (game) { game.stop(); game = null; }
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
    currentUser = null;
    authToken   = null;
    showAuth();
  }

  lobbyLogout.addEventListener('click', logout);

  hudLogout.addEventListener('click', () => {
    if (game) { game.stop(); game = null; }
    showLobby();
  });

  // ---- Pause menu wiring ------------------------------------------------------

  pauseResume.addEventListener('click', () => {
    if (game) game.togglePause();
  });

  pauseSettings.addEventListener('click', () => {
    openSettings();
  });

  pauseLobby.addEventListener('click', () => {
    // Close pause menu first, then leave world
    pauseMenu.style.display = 'none';
    if (game) { game.running = false; game.stop(); game = null; }
    showLobby();
  });

  pauseLogout.addEventListener('click', () => {
    pauseMenu.style.display = 'none';
    logout();
  });

  // ---- Settings panel ---------------------------------------------------------

  let listeningBtn    = null;   // keybind button currently waiting for a key
  let pendingSettings = null;   // working copy while settings panel is open

  function openSettings() {
    if (!game) return;

    // Deep-copy current settings as working copy
    pendingSettings = {
      sensitivity: game.settings.sensitivity,
      keybinds: { ...game.settings.keybinds },
    };

    // Populate slider
    sensSlider.value = pendingSettings.sensitivity;
    updateSensLabel(pendingSettings.sensitivity);

    // Populate keybind buttons
    keybindBtns.forEach(btn => {
      const action = btn.dataset.action;
      btn.textContent = codeToLabel(pendingSettings.keybinds[action]);
      btn.classList.remove('listening');
    });

    settingsMenu.style.display = 'flex';
  }

  function updateSensLabel(val) {
    // Display as a 0–100 percentage scale (0.001 = 1.0x baseline)
    sensVal.textContent = (val / 0.001).toFixed(2) + 'x';
  }

  sensSlider.addEventListener('input', () => {
    const v = parseFloat(sensSlider.value);
    pendingSettings.sensitivity = v;
    updateSensLabel(v);
  });

  // Keybind rebinding
  keybindBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (listeningBtn === btn) {
        // Cancel listening
        listeningBtn.classList.remove('listening');
        listeningBtn.textContent = codeToLabel(pendingSettings.keybinds[btn.dataset.action]);
        listeningBtn = null;
        return;
      }
      // Stop any previous listener
      if (listeningBtn) {
        listeningBtn.classList.remove('listening');
        listeningBtn.textContent = codeToLabel(pendingSettings.keybinds[listeningBtn.dataset.action]);
      }
      listeningBtn = btn;
      btn.classList.add('listening');
      btn.textContent = 'Press a key…';
    });
  });

  // Global keydown while settings are open — captures rebind
  document.addEventListener('keydown', (e) => {
    if (!listeningBtn) return;
    if (settingsMenu.style.display === 'none') return;
    e.preventDefault();
    e.stopPropagation();

    const action  = listeningBtn.dataset.action;
    const newCode = e.code;

    // Block Escape — reserved for pause
    if (newCode === 'Escape') {
      listeningBtn.classList.remove('listening');
      listeningBtn.textContent = codeToLabel(pendingSettings.keybinds[action]);
      listeningBtn = null;
      return;
    }

    // Update pending keybinds (unmap any other action that used this key)
    for (const a in pendingSettings.keybinds) {
      if (pendingSettings.keybinds[a] === newCode && a !== action) {
        pendingSettings.keybinds[a] = '';
      }
    }
    pendingSettings.keybinds[action] = newCode;

    // Refresh all button labels
    keybindBtns.forEach(b => {
      b.classList.remove('listening');
      b.textContent = codeToLabel(pendingSettings.keybinds[b.dataset.action]);
    });
    listeningBtn = null;
  }, true /* capture so it fires before game keydown */);

  settingsReset.addEventListener('click', () => {
    listeningBtn = null;
    const def = Game.defaultSettings();
    pendingSettings.sensitivity = def.sensitivity;
    pendingSettings.keybinds    = { ...def.keybinds };

    sensSlider.value = pendingSettings.sensitivity;
    updateSensLabel(pendingSettings.sensitivity);
    keybindBtns.forEach(btn => {
      btn.classList.remove('listening');
      btn.textContent = codeToLabel(pendingSettings.keybinds[btn.dataset.action]);
    });
  });

  settingsClose.addEventListener('click', () => {
    listeningBtn = null;
    if (game && pendingSettings) {
      game.applySettings(pendingSettings);
    }
    settingsMenu.style.display = 'none';
    // Stay in pause menu
  });

  // ---- Init -------------------------------------------------------------------
  checkSession();
})();
