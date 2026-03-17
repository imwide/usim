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
  const lobbyStatus  = document.getElementById('lobby-status');
  const playBtn      = document.getElementById('play-btn');
  const lobbyLogout  = document.getElementById('lobby-logout');
  const hudLogout    = document.getElementById('hud-logout');
  const loadingScreen = document.getElementById('loading-screen');
  const loadingStatus = document.getElementById('loading-status');
  const loadingProgressFill = document.getElementById('loading-progress-fill');
  const loadingProgressValue = document.getElementById('loading-progress-value');

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
  const renderSlider    = document.getElementById('render-distance-slider');
  const renderVal       = document.getElementById('render-distance-val');
  const grassToggle     = document.getElementById('grass-toggle');
  const settingsReset   = document.getElementById('settings-reset');
  const settingsClose   = document.getElementById('settings-close');
  const keybindBtns     = document.querySelectorAll('.keybind-btn');

  let currentTab  = 'login';
  let currentUser = null;
  let authToken   = null;
  let game        = null;
  let characterPreview = null;
  let characterPreviewLoad = null;
  let isStartingGame = false;

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

  function waitForNextPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  function setLobbyStatus(message = '') {
    if (lobbyStatus) {
      lobbyStatus.textContent = message;
    }
  }

  function updateLoadingScreen(message, progress = 0) {
    if (loadingStatus) {
      loadingStatus.textContent = message || 'Preparing world…';
    }

    const safeProgress = Math.max(0, Math.min(100, Math.round(Number(progress) || 0)));
    if (loadingProgressFill) {
      loadingProgressFill.style.width = `${safeProgress}%`;
    }
    if (loadingProgressValue) {
      loadingProgressValue.textContent = `${safeProgress}%`;
    }
  }

  function showLoadingScreen(message = 'Preparing world…', progress = 0) {
    updateLoadingScreen(message, progress);
    if (loadingScreen) {
      loadingScreen.classList.add('visible');
      loadingScreen.setAttribute('aria-hidden', 'false');
    }
  }

  function hideLoadingScreen() {
    if (loadingScreen) {
      loadingScreen.classList.remove('visible');
      loadingScreen.setAttribute('aria-hidden', 'true');
    }
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
    stopCharacterPreview();
    hideLoadingScreen();
    authScreen.style.display  = 'flex';
    lobbyScreen.style.display = 'none';
    gameScreen.style.display  = 'none';
    authError.textContent = '';
    setLobbyStatus('');
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
  }

  function showLobby() {
    hideLoadingScreen();
    authScreen.style.display  = 'none';
    lobbyScreen.style.display = 'flex';
    gameScreen.style.display  = 'none';
    lobbyUsername.textContent = currentUser.username;
    setLobbyStatus('');
    drawCharacterPreview();
  }

  function showGame() {
    stopCharacterPreview();
    authScreen.style.display  = 'none';
    lobbyScreen.style.display = 'none';
    gameScreen.style.display  = 'block';
  }

  // ---- Lobby character preview -------------------------------------------------

  function ensureCharacterPreview() {
    if (characterPreview) return characterPreview;

    const canvas = document.getElementById('character-canvas');
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(canvas.width, canvas.height, false);
    renderer.setClearColor(0x000000, 0);
    renderer.outputEncoding = THREE.sRGBEncoding;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(28, canvas.width / canvas.height, 0.1, 100);
    camera.position.set(0, 1.75, 6.1);
    camera.lookAt(0, 1.6, 0);

    const clock = new THREE.Clock(false);
    const turntable = new THREE.Group();
    scene.add(turntable);

    const hemiLight = new THREE.HemisphereLight(0xaed9ff, 0x243044, 1.2);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
    keyLight.position.set(4, 7, 6);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x7b2ff7, 0.55);
    rimLight.position.set(-5, 3, -4);
    scene.add(rimLight);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(2.35, 40),
      new THREE.MeshBasicMaterial({
        color: 0x7b2ff7,
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.01;
    scene.add(floor);

    characterPreview = {
      renderer,
      scene,
      camera,
      clock,
      turntable,
      model: null,
      mixer: null,
      actions: null,
      currentAction: null,
      running: false,
      rafId: 0,
    };

    return characterPreview;
  }

  function attachCharacterPreview(character, isPlaceholder = false) {
    const preview = ensureCharacterPreview();

    if (preview.model) {
      preview.turntable.remove(preview.model);
      if (preview.model.userData && preview.model.userData.disposeOnRemove) {
        preview.model.traverse((child) => {
          if (child.geometry) child.geometry.dispose();
          if (child.material) child.material.dispose();
        });
      }
    }

    preview.model = character.model;
    preview.mixer = character.mixer || null;
    preview.actions = character.actions || null;
    preview.currentAction = null;
    preview.isPlaceholder = isPlaceholder;
    preview.turntable.add(preview.model);
    preview.model.position.y = 0;
    preview.turntable.rotation.y = 0;

    Game.playCharacterAnimation(preview, 'idle', 0.12);
  }

  function renderCharacterPreview() {
    if (!characterPreview || !characterPreview.running) return;

    characterPreview.rafId = requestAnimationFrame(renderCharacterPreview);
    const dt = Math.min(characterPreview.clock.getDelta(), 0.1);

    if (characterPreview.mixer) {
      characterPreview.mixer.update(dt);
    }
    characterPreview.turntable.rotation.y += dt * 0.45;
    characterPreview.renderer.render(characterPreview.scene, characterPreview.camera);
  }

  function stopCharacterPreview() {
    if (!characterPreview) return;
    characterPreview.running = false;
    if (characterPreview.rafId) {
      cancelAnimationFrame(characterPreview.rafId);
      characterPreview.rafId = 0;
    }
    characterPreview.clock.stop();
  }

  function drawCharacterPreview() {
    const preview = ensureCharacterPreview();
    preview.running = true;

    if (!preview.rafId) {
      preview.clock.start();
      preview.clock.getDelta();
      renderCharacterPreview();
    }

    if (preview.model) {
      Game.playCharacterAnimation(preview, 'idle', 0.12);
      return;
    }

    if (characterPreviewLoad) return;

    characterPreviewLoad = Game.createCharacterInstance()
      .then((character) => {
        attachCharacterPreview(character);
      })
      .catch((error) => {
        console.warn('Falling back to placeholder lobby preview:', error);
        attachCharacterPreview({
          model: Game.createPlaceholderCharacterModel(0x2299ff),
          mixer: null,
          actions: null,
        }, true);
      })
      .finally(() => {
        characterPreviewLoad = null;
      });
  }

  // ---- Play / Leave -----------------------------------------------------------

  playBtn.addEventListener('click', async () => {
    if (isStartingGame || !currentUser) return;

    isStartingGame = true;
    playBtn.disabled = true;
    lobbyLogout.disabled = true;
    setLobbyStatus('');
    showLoadingScreen('Preparing world…', 6);

    try {
      await waitForNextPaint();
      showGame();

      updateLoadingScreen('Creating renderer…', 18);
      await waitForNextPaint();

      game = new Game();

      updateLoadingScreen('Building world systems…', 42);
      await waitForNextPaint();

      await game.start(currentUser.username, authToken, currentUser.id, async (message, progress) => {
        updateLoadingScreen(message, progress);
        await waitForNextPaint();
      });

      updateLoadingScreen('Entering world…', 100);
      await waitForNextPaint();
    } catch (error) {
      console.error('Failed to enter world:', error);
      if (game) {
        game.stop();
        game = null;
      }
      showLobby();
      setLobbyStatus('Unable to enter the world right now. Please try again.');
    } finally {
      hideLoadingScreen();
      playBtn.disabled = false;
      lobbyLogout.disabled = false;
      isStartingGame = false;
    }
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
      renderDistance: game.settings.renderDistance,
      renderGrassBlades: game.settings.renderGrassBlades,
      keybinds: { ...game.settings.keybinds },
    };

    // Populate slider
    sensSlider.value = pendingSettings.sensitivity;
    updateSensLabel(pendingSettings.sensitivity);
    renderSlider.value = pendingSettings.renderDistance;
    updateRenderDistanceLabel(pendingSettings.renderDistance);
    if (grassToggle) {
      grassToggle.checked = pendingSettings.renderGrassBlades !== false;
    }

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

  function updateRenderDistanceLabel(val) {
    const distance = Game.normalizeRenderDistance(val);
    const diameter = distance * 2 + 1;
    renderVal.textContent = `${diameter}×${diameter} chunks`;
  }

  sensSlider.addEventListener('input', () => {
    const v = parseFloat(sensSlider.value);
    pendingSettings.sensitivity = v;
    updateSensLabel(v);
  });

  renderSlider.addEventListener('input', () => {
    const v = Game.normalizeRenderDistance(renderSlider.value);
    pendingSettings.renderDistance = v;
    updateRenderDistanceLabel(v);
  });

  if (grassToggle) {
    grassToggle.addEventListener('change', () => {
      if (!pendingSettings) return;
      pendingSettings.renderGrassBlades = !!grassToggle.checked;
    });
  }

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
    pendingSettings.renderDistance = def.renderDistance;
    pendingSettings.renderGrassBlades = def.renderGrassBlades;
    pendingSettings.keybinds    = { ...def.keybinds };

    sensSlider.value = pendingSettings.sensitivity;
    updateSensLabel(pendingSettings.sensitivity);
    renderSlider.value = pendingSettings.renderDistance;
    updateRenderDistanceLabel(pendingSettings.renderDistance);
    if (grassToggle) {
      grassToggle.checked = pendingSettings.renderGrassBlades;
    }
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
