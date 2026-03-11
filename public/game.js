/**
 * Main game engine - handles rendering, controls, and multiplayer
 */
class Game {
  constructor() {
    this.canvas = document.getElementById('game-canvas');
    this.scene = new THREE.Scene();
    this.clock = new THREE.Clock();

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x87CEEB); // sky blue
    this.renderer.shadowMap.enabled = false; // disable for performance

    // Camera
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);
    this.camera.position.set(0, 60, 0);

    // Fog for distance fade
    this.scene.fog = new THREE.FogExp2(0x87CEEB, 0.0025);

    // Lighting
    this.setupLighting();

    // Terrain
    this.noise = new PerlinNoise(42);
    this.terrain = new TerrainManager(this.scene, this.noise);

    // Player state
    this.position = new THREE.Vector3(0, 60, 0);
    this.velocity = new THREE.Vector3(0, 0, 0);
    this.euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.moveSpeed = 30;
    this.gravity = -50;
    this.jumpSpeed = 15;
    this.onGround = false;
    this.playerHeight = 3;

    // Input
    this.keys = {};
    this.mouseLocked = false;
    this.mouseSensitivity = 0.002;

    // Multiplayer
    this.socket = null;
    this.otherPlayers = {};
    this.username = '';
    this.sendRate = 50; // ms between position updates
    this.lastSendTime = 0;

    // Resize
    window.addEventListener('resize', () => this.onResize());
  }

  setupLighting() {
    // Ambient light
    const ambient = new THREE.AmbientLight(0x6688cc, 0.5);
    this.scene.add(ambient);

    // Hemisphere light for sky/ground coloring
    const hemi = new THREE.HemisphereLight(0x87CEEB, 0x556633, 0.6);
    this.scene.add(hemi);

    // Directional sunlight
    const sun = new THREE.DirectionalLight(0xffffcc, 0.8);
    sun.position.set(100, 200, 100);
    this.scene.add(sun);
  }

  createPlayerModel(color = 0x2299ff) {
    const group = new THREE.Group();

    // Body
    const bodyGeo = new THREE.BoxGeometry(1.2, 1.8, 0.8);
    const bodyMat = new THREE.MeshLambertMaterial({ color: color });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.9;
    group.add(body);

    // Head
    const headGeo = new THREE.BoxGeometry(0.8, 0.8, 0.8);
    const headMat = new THREE.MeshLambertMaterial({ color: 0xffcc99 });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = 2.2;
    group.add(head);

    // Arms
    const armGeo = new THREE.BoxGeometry(0.35, 1.4, 0.35);
    const armMat = new THREE.MeshLambertMaterial({ color: color });
    const leftArm = new THREE.Mesh(armGeo, armMat);
    leftArm.position.set(-0.95, 1.0, 0);
    group.add(leftArm);
    const rightArm = new THREE.Mesh(armGeo, armMat);
    rightArm.position.set(0.95, 1.0, 0);
    group.add(rightArm);

    // Legs
    const legGeo = new THREE.BoxGeometry(0.4, 1.2, 0.4);
    const legMat = new THREE.MeshLambertMaterial({ color: 0x333366 });
    const leftLeg = new THREE.Mesh(legGeo, legMat);
    leftLeg.position.set(-0.3, -0.6, 0);
    group.add(leftLeg);
    const rightLeg = new THREE.Mesh(legGeo, legMat);
    rightLeg.position.set(0.3, -0.6, 0);
    group.add(rightLeg);

    return group;
  }

  createNameLabel(text) {
    const div = document.createElement('div');
    div.className = 'player-label';
    div.textContent = text;
    document.getElementById('player-names').appendChild(div);
    return div;
  }

  start(username, token) {
    this.username = username;

    // Setup input
    this.setupInput();

    // Connect to multiplayer
    this.connectMultiplayer(token);

    // Initial terrain
    this.terrain.update(this.position.x, this.position.z);

    // Place player on terrain
    const groundY = this.terrain.getHeight(this.position.x, this.position.z);
    this.position.y = groundY + this.playerHeight;

    // Start game loop
    this.running = true;
    this.animate();
  }

  stop() {
    this.running = false;
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }

    // Clean up other player labels
    for (const id in this.otherPlayers) {
      if (this.otherPlayers[id].label) {
        this.otherPlayers[id].label.remove();
      }
    }
    this.otherPlayers = {};

    // Remove event listeners
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.exitPointerLock();
  }

  setupInput() {
    this._onKeyDown = (e) => {
      this.keys[e.code] = true;
      if (e.code === 'Space' && this.onGround) {
        this.velocity.y = this.jumpSpeed;
        this.onGround = false;
      }
    };
    this._onKeyUp = (e) => { this.keys[e.code] = false; };
    this._onMouseMove = (e) => {
      if (!this.mouseLocked) return;
      this.euler.y -= e.movementX * this.mouseSensitivity;
      this.euler.x -= e.movementY * this.mouseSensitivity;
      this.euler.x = Math.max(-Math.PI / 2.1, Math.min(Math.PI / 2.1, this.euler.x));
    };

    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('mousemove', this._onMouseMove);

    // Pointer lock
    this.canvas.addEventListener('click', () => {
      this.canvas.requestPointerLock();
    });

    document.addEventListener('pointerlockchange', () => {
      this.mouseLocked = document.pointerLockElement === this.canvas;
      const prompt = document.getElementById('lock-prompt');
      prompt.style.display = this.mouseLocked ? 'none' : 'block';
    });

    // Show prompt initially
    document.getElementById('lock-prompt').style.display = 'block';
  }

  connectMultiplayer(token) {
    this.socket = io({
      auth: { token }
    });

    this.socket.on('connect', () => {
      console.log('Connected to server');
    });

    this.socket.on('currentPlayers', (players) => {
      for (const [socketId, data] of Object.entries(players)) {
        if (socketId === this.socket.id) continue;
        this.addOtherPlayer(socketId, data);
      }
      this.updatePlayerCount();
    });

    this.socket.on('playerJoined', (data) => {
      this.addOtherPlayer(data.socketId, data);
      this.updatePlayerCount();
    });

    this.socket.on('playerMoved', (data) => {
      const player = this.otherPlayers[data.socketId];
      if (player) {
        player.targetX = data.x;
        player.targetY = data.y;
        player.targetZ = data.z;
        player.targetRY = data.ry;
      }
    });

    this.socket.on('playerLeft', (socketId) => {
      this.removeOtherPlayer(socketId);
      this.updatePlayerCount();
    });

    this.socket.on('connect_error', (err) => {
      console.error('Connection error:', err.message);
    });
  }

  addOtherPlayer(socketId, data) {
    const model = this.createPlayerModel(0xff6633);
    model.position.set(data.x, data.y, data.z);
    this.scene.add(model);

    const label = this.createNameLabel(data.username);

    this.otherPlayers[socketId] = {
      model,
      label,
      username: data.username,
      targetX: data.x,
      targetY: data.y,
      targetZ: data.z,
      targetRY: data.ry || 0,
    };
  }

  removeOtherPlayer(socketId) {
    const player = this.otherPlayers[socketId];
    if (player) {
      this.scene.remove(player.model);
      player.model.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
      if (player.label) player.label.remove();
      delete this.otherPlayers[socketId];
    }
  }

  updatePlayerCount() {
    const count = Object.keys(this.otherPlayers).length + 1;
    document.getElementById('player-count').textContent = `Players: ${count}`;
  }

  updateOtherPlayers(dt) {
    const lerpFactor = 1 - Math.pow(0.001, dt);

    for (const id in this.otherPlayers) {
      const p = this.otherPlayers[id];
      // Smooth interpolation
      p.model.position.x += (p.targetX - p.model.position.x) * lerpFactor;
      p.model.position.y += (p.targetY - p.model.position.y) * lerpFactor;
      p.model.position.z += (p.targetZ - p.model.position.z) * lerpFactor;
      p.model.rotation.y = p.targetRY;

      // Update name label screen position
      const pos = p.model.position.clone();
      pos.y += 3.5;
      pos.project(this.camera);

      if (pos.z < 1) {
        const x = (pos.x * 0.5 + 0.5) * window.innerWidth;
        const y = (-pos.y * 0.5 + 0.5) * window.innerHeight;
        p.label.style.left = x + 'px';
        p.label.style.top = y + 'px';
        p.label.style.display = 'block';
      } else {
        p.label.style.display = 'none';
      }
    }
  }

  animate() {
    if (!this.running) return;
    requestAnimationFrame(() => this.animate());

    const dt = Math.min(this.clock.getDelta(), 0.1);

    this.updateMovement(dt);
    this.updateCamera();
    this.updateOtherPlayers(dt);

    // Update terrain around player
    this.terrain.update(this.position.x, this.position.z);

    // Update HUD
    document.getElementById('coords').textContent =
      `X: ${Math.floor(this.position.x)} Y: ${Math.floor(this.position.y)} Z: ${Math.floor(this.position.z)}`;

    // Send position to server
    const now = Date.now();
    if (this.socket && now - this.lastSendTime > this.sendRate) {
      this.socket.emit('playerMove', {
        x: this.position.x,
        y: this.position.y,
        z: this.position.z,
        rx: this.euler.x,
        ry: this.euler.y,
      });
      this.lastSendTime = now;
    }

    this.renderer.render(this.scene, this.camera);
  }

  updateMovement(dt) {
    // Movement direction
    const forward = new THREE.Vector3(0, 0, -1);
    forward.applyEuler(new THREE.Euler(0, this.euler.y, 0));
    const right = new THREE.Vector3(1, 0, 0);
    right.applyEuler(new THREE.Euler(0, this.euler.y, 0));

    const moveDir = new THREE.Vector3(0, 0, 0);

    if (this.keys['KeyW']) moveDir.add(forward);
    if (this.keys['KeyS']) moveDir.sub(forward);
    if (this.keys['KeyD']) moveDir.add(right);
    if (this.keys['KeyA']) moveDir.sub(right);

    if (moveDir.lengthSq() > 0) {
      moveDir.normalize();
      // Sprint with shift
      const speed = this.keys['ShiftLeft'] ? this.moveSpeed * 2 : this.moveSpeed;
      this.position.x += moveDir.x * speed * dt;
      this.position.z += moveDir.z * speed * dt;
    }

    // Gravity
    this.velocity.y += this.gravity * dt;
    this.position.y += this.velocity.y * dt;

    // Ground collision
    const groundY = this.terrain.getHeight(this.position.x, this.position.z) + this.playerHeight;
    if (this.position.y <= groundY) {
      this.position.y = groundY;
      this.velocity.y = 0;
      this.onGround = true;
    }
  }

  updateCamera() {
    this.camera.position.copy(this.position);
    this.camera.quaternion.setFromEuler(this.euler);
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}

window.Game = Game;
