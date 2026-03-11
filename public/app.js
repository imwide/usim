/**
 * App controller - handles auth UI, lobby, and game lifecycle
 */
(function () {
  // DOM elements
  const authScreen = document.getElementById('auth-screen');
  const lobbyScreen = document.getElementById('lobby-screen');
  const gameScreen = document.getElementById('game-screen');
  const authForm = document.getElementById('auth-form');
  const authError = document.getElementById('auth-error');
  const authSubmit = document.getElementById('auth-submit');
  const tabs = document.querySelectorAll('.auth-tab');
  const lobbyUsername = document.getElementById('lobby-username');
  const playBtn = document.getElementById('play-btn');
  const lobbyLogout = document.getElementById('lobby-logout');
  const hudLogout = document.getElementById('hud-logout');

  let currentTab = 'login';
  let currentUser = null;
  let authToken = null;
  let game = null;

  // Tab switching
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      currentTab = tab.dataset.tab;
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      authSubmit.textContent = currentTab === 'login' ? 'Login' : 'Create Account';
      authError.textContent = '';
    });
  });

  // Auth form submit
  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    authError.textContent = '';

    const endpoint = currentTab === 'login' ? '/api/auth/login' : '/api/auth/register';

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();
      if (!res.ok) {
        authError.textContent = data.error || 'Something went wrong';
        return;
      }

      currentUser = data;
      authToken = data.token;
      showLobby();
    } catch (err) {
      authError.textContent = 'Network error';
    }
  });

  // Check if already logged in
  async function checkSession() {
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        currentUser = await res.json();
        authToken = currentUser.token;
        showLobby();
      }
    } catch (e) {
      // Not logged in, show auth screen
    }
  }

  function showAuth() {
    authScreen.style.display = 'flex';
    lobbyScreen.style.display = 'none';
    gameScreen.style.display = 'none';
    authError.textContent = '';
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
  }

  function showLobby() {
    authScreen.style.display = 'none';
    lobbyScreen.style.display = 'flex';
    gameScreen.style.display = 'none';
    lobbyUsername.textContent = currentUser.username;
    drawCharacterPreview();
  }

  function showGame() {
    authScreen.style.display = 'none';
    lobbyScreen.style.display = 'none';
    gameScreen.style.display = 'block';
  }

  // Draw a simple character preview on the lobby canvas
  function drawCharacterPreview() {
    const canvas = document.getElementById('character-canvas');
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const scale = 2.5;

    // Head
    ctx.fillStyle = '#ffcc99';
    ctx.fillRect(cx - 15 * scale, 30, 30 * scale, 30 * scale);

    // Body
    ctx.fillStyle = '#2299ff';
    ctx.fillRect(cx - 20 * scale, 30 + 30 * scale, 40 * scale, 50 * scale);

    // Arms
    ctx.fillRect(cx - 30 * scale, 30 + 32 * scale, 8 * scale, 40 * scale);
    ctx.fillRect(cx + 22 * scale, 30 + 32 * scale, 8 * scale, 40 * scale);

    // Legs
    ctx.fillStyle = '#333366';
    ctx.fillRect(cx - 15 * scale, 30 + 80 * scale, 12 * scale, 35 * scale);
    ctx.fillRect(cx + 3 * scale, 30 + 80 * scale, 12 * scale, 35 * scale);

    // Eyes
    ctx.fillStyle = '#333';
    ctx.fillRect(cx - 8 * scale, 30 + 10 * scale, 5 * scale, 5 * scale);
    ctx.fillRect(cx + 3 * scale, 30 + 10 * scale, 5 * scale, 5 * scale);
  }

  // Play button
  playBtn.addEventListener('click', () => {
    showGame();
    game = new Game();
    game.start(currentUser.username, authToken);
  });

  // Logout
  async function logout() {
    if (game) {
      game.stop();
      game = null;
    }
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (e) {}
    currentUser = null;
    authToken = null;
    showAuth();
  }

  lobbyLogout.addEventListener('click', logout);
  hudLogout.addEventListener('click', () => {
    if (game) {
      game.stop();
      game = null;
    }
    showLobby();
  });

  // Init
  checkSession();
})();
