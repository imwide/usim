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
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.shadowMap.enabled = false; // disable for performance

    // Camera
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);
    this.camera.position.set(0, 60, 0);

    // Fog for distance fade
    this.scene.fog = new THREE.FogExp2(0x87CEEB, 0.0025);

    // Day / night cycle - controlled by server
    this.dayTime = 0.27;   // 0 = midnight, 0.5 = noon (used as fallback)
    this.gameWorldStartTime = null; // Will be set by server
    this.timeCycleMs = 2 * 60 * 60 * 1000; // 2 real hours = 1 full day cycle

    // Sky, sun, moon, stars, lights
    this.setupSky();

    // Terrain
    this.noise = new PerlinNoise(42);
    this.terrain = new TerrainManager(this.scene, this.noise);

    // Water
    this.waterLevel = 0;
    this.terrain.setWaterLevel(this.waterLevel);
    this.waterTime = 0;
    this.waterBaseFogDensity = 0.0025;
    this.underwaterFogDensity = 0.012;
    this.isUnderwater = false;
    this.underwaterDepth = 0;
    this.setupWater();
    this.setupUnderwaterPostFX();

    // Player state
    this.position = new THREE.Vector3(0, 60, 0);
    this.velocity = new THREE.Vector3(0, 0, 0);
    this.euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.moveSpeed = 4;
    this.gravity = -50;
    this.jumpSpeed = 15;
    this.onGround = false;
    this.playerHeight = 3;

    // Movement states
    this.isRunning = false;
    this.isCrouching = false;
    this.isSwimming = false;
    this.isExhausted = false;   // set when stamina hits 0, cleared at recovery threshold
    this.stamina = 10;
    this.maxStamina = 10;
    this.staminaDrainRate = 1.2;
    this.staminaRegenRate = 0.5;
    this.staminaRecoveryThreshold = 2.0; // must regen to this before running again
    this.runSpeedMultiplier = 2.0;
    this.crouchCameraOffset = 0;       // current camera height offset (lerped)
    this.crouchSpeedMultiplier = 0.4;
    this.jumpAnimationTimer = 0;
    this.jumpAnimationDuration = 0.7;

    // Settings (loaded from localStorage)
    this.settings = Game.loadSettings();

    // Input
    this.keys = {};
    this.mouseLocked = false;
    this.paused = false;
    this.mouseSensitivity = this.settings.sensitivity;

    // Phone item / UI
    this.hasPhone = true;
    this.phoneOpen = false;
    this.phoneDocked = false;
    this.phoneActiveApp = null;
    this.phoneUI = null;
    this.phoneClockLabel = '';
    this.phoneMap = {
      zoomIndex: 11,
      followPlayer: true,
      centerX: this.position.x,
      centerZ: this.position.z,
      canvas: null,
      ctx: null,
      rangeLabel: null,
      detailLabel: null,
      coordsLabel: null,
      followBtn: null,
      zoomInBtn: null,
      zoomOutBtn: null,
      dragging: false,
      dragMoved: false,
      pointerId: null,
      dragStartX: 0,
      dragStartY: 0,
      dragCenterX: 0,
      dragCenterZ: 0,
      dirty: true,
      lastRenderTime: 0,
      lastRenderPlayerX: this.position.x,
      lastRenderPlayerZ: this.position.z,
      lastRenderHeading: this.euler.y,
    };
    this.phoneMapLightDir = new THREE.Vector3(-0.58, 0.72, 0.38).normalize();

    this.setupPhoneUI();

    // Multiplayer
    this.socket = null;
    this.otherPlayers = {};
    this.username = '';
    this.sendRate = 50; // ms between position updates
    this.lastSendTime = 0;

    // Resize
    window.addEventListener('resize', () => this.onResize());
  }

  static get CHARACTER_MODEL_URL() {
    return '/assets/character.glb';
  }

  static get CHARACTER_TARGET_HEIGHT() {
    return 0.00700;
  }

  static get CHARACTER_ROTATION_OFFSET() {
    return Math.PI;
  }

  static get PHONE_APPS() {
    return {
      messages: {
        title: 'Messages',
        subtitle: 'Inbox synced',
        body: `
          <div class="phone-card">
            <div class="phone-card-title">Recent Messages</div>
            <div class="phone-list-item">
              <strong>Dispatch</strong>
              <span>No new alerts in your area.</span>
            </div>
            <div class="phone-list-item">
              <strong>Contacts</strong>
              <span>Your chat list is empty for now.</span>
            </div>
            <div class="phone-list-item">
              <strong>System</strong>
              <span>Placeholder messaging app ready.</span>
            </div>
          </div>
        `,
      },
      maps: {
        title: 'Maps',
        subtitle: 'Multi-layer terrain scan',
        body: '',
      },
      calls: {
        title: 'Calls',
        subtitle: 'Signal available',
        body: `
          <div class="phone-card">
            <div class="phone-card-title">Quick Dial</div>
            <div class="phone-call-pill">Emergency Services</div>
            <div class="phone-call-pill">Mechanic</div>
            <div class="phone-call-pill">Taxi</div>
            <p>Voice calling is a placeholder for now.</p>
          </div>
        `,
      },
      shop: {
        title: 'Shop',
        subtitle: 'Storefront preview',
        body: `
          <div class="phone-card">
            <div class="phone-card-title">Featured Items</div>
            <div class="phone-shop-row"><span>Starter Snacks</span><strong>$4</strong></div>
            <div class="phone-shop-row"><span>Roadside Toolkit</span><strong>$18</strong></div>
            <div class="phone-shop-row"><span>Fuel Voucher</span><strong>$25</strong></div>
            <p>Purchasing is disabled until the real economy exists.</p>
          </div>
        `,
      },
    };
  }

  static formatKeyLabel(code) {
    if (!code) return 'Unbound';

    const map = {
      Space: 'Space',
      ShiftLeft: 'L.Shift',
      ShiftRight: 'R.Shift',
      ControlLeft: 'L.Ctrl',
      ControlRight: 'R.Ctrl',
      AltLeft: 'L.Alt',
      AltRight: 'R.Alt',
      ArrowUp: '↑',
      ArrowDown: '↓',
      ArrowLeft: '←',
      ArrowRight: '→',
    };

    if (map[code]) return map[code];
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return 'Num' + code.slice(6);
    return code;
  }

  static get MAP_ZOOM_LEVELS() {
    return [
      { label: '180 m', halfSpan: 90 },
      { label: '360 m', halfSpan: 180 },
      { label: '720 m', halfSpan: 360 },
      { label: '1.4 km', halfSpan: 720 },
      { label: '2.9 km', halfSpan: 1440 },
      { label: '5.8 km', halfSpan: 2880 },
      { label: '11.5 km', halfSpan: 5760 },
      { label: '23.0 km', halfSpan: 11520 },
      { label: '46.1 km', halfSpan: 23040 },
      { label: '92.2 km', halfSpan: 46080 },
      { label: '184.3 km', halfSpan: 92160 },
      { label: '368.6 km', halfSpan: 184320 },
      { label: '737.3 km', halfSpan: 368640 },
    ];
  }

  static preloadCharacterAsset() {
    if (Game._characterAssetPromise) return Game._characterAssetPromise;

    Game._characterAssetPromise = new Promise((resolve, reject) => {
      if (!THREE.GLTFLoader) {
        reject(new Error('THREE.GLTFLoader is not available'));
        return;
      }

      const loader = new THREE.GLTFLoader();
      loader.load(
        Game.CHARACTER_MODEL_URL,
        (gltf) => {
          try {
            const scene = Game.normalizeCharacterScene(gltf.scene);
            const animations = Array.isArray(gltf.animations) ? gltf.animations.slice() : [];
            const asset = {
              scene,
              animations,
              animationMap: Game.mapCharacterAnimations(animations),
              height: scene.userData.characterHeight || Game.CHARACTER_TARGET_HEIGHT,
              labelHeight: scene.userData.labelHeight || (Game.CHARACTER_TARGET_HEIGHT + 0.35),
            };
            Game._characterAsset = asset;
            resolve(asset);
          } catch (error) {
            reject(error);
          }
        },
        undefined,
        (error) => {
          reject(error);
        }
      );
    }).catch((error) => {
      console.error('Failed to load character model:', error);
      Game._characterAssetPromise = null;
      throw error;
    });

    return Game._characterAssetPromise;
  }

  static normalizeCharacterScene(scene) {
    scene.rotation.y += Game.CHARACTER_ROTATION_OFFSET;

    scene.traverse((child) => {
      if (child.isMesh || child.isSkinnedMesh) {
        child.frustumCulled = false;
      }
    });

    scene.updateMatrixWorld(true);

    let bounds = new THREE.Box3().setFromObject(scene);
    const initialSize = bounds.getSize(new THREE.Vector3());
    const height = Math.max(initialSize.y, 0.001);
    const scale = Game.CHARACTER_TARGET_HEIGHT / height;
    scene.scale.multiplyScalar(scale);
    scene.updateMatrixWorld(true);

    bounds = new THREE.Box3().setFromObject(scene);
    const center = bounds.getCenter(new THREE.Vector3());
    scene.position.x -= center.x;
    scene.position.y -= bounds.min.y;
    scene.position.z -= center.z;
    scene.updateMatrixWorld(true);

    bounds = new THREE.Box3().setFromObject(scene);
    const finalSize = bounds.getSize(new THREE.Vector3());
    scene.userData.characterHeight = finalSize.y;
    scene.userData.labelHeight = finalSize.y + 0.35;

    return scene;
  }

  static mapCharacterAnimations(animations) {
    const animationMap = {
      idle: Game.findCharacterClip(animations, ['idle', 'breathing', 'stand']),
      walk: Game.findCharacterClip(animations, ['walk', 'strafe']),
      run: Game.findCharacterClip(animations, ['run', 'jog', 'sprint']),
      jump: Game.findCharacterClip(animations, ['jump', 'fall', 'land']),
      crouch: Game.findCharacterClip(animations, ['crouch', 'sneak']),
      swim: Game.findCharacterClip(animations, ['swim']),
    };

    if (!animationMap.idle && Array.isArray(animations) && animations[0]) {
      animationMap.idle = animations[0];
    }

    return animationMap;
  }

  static findCharacterClip(animations, keywords) {
    if (!Array.isArray(animations) || animations.length === 0) return null;

    const searchable = animations.map((clip) => ({
      clip,
      name: String(clip.name || '').toLowerCase(),
    }));

    for (const keyword of keywords) {
      const match = searchable.find(({ name }) => name.includes(keyword));
      if (match) return match.clip;
    }

    return null;
  }

  static async createCharacterInstance() {
    const asset = await Game.preloadCharacterAsset();
    if (!THREE.SkeletonUtils || typeof THREE.SkeletonUtils.clone !== 'function') {
      throw new Error('THREE.SkeletonUtils is not available');
    }

    const model = THREE.SkeletonUtils.clone(asset.scene);
    model.userData.characterHeight = asset.height;
    model.userData.labelHeight = asset.labelHeight;

    const mixer = asset.animations.length ? new THREE.AnimationMixer(model) : null;
    const actions = {};
    if (mixer) {
      for (const [state, clip] of Object.entries(asset.animationMap)) {
        if (!clip || actions[state]) continue;
        const action = mixer.clipAction(clip);
        action.enabled = true;
        if (state === 'jump') {
          action.clampWhenFinished = true;
          action.setLoop(THREE.LoopOnce, 1);
        } else {
          action.clampWhenFinished = false;
          action.setLoop(THREE.LoopRepeat, Infinity);
        }
        actions[state] = action;
      }
    }

    return {
      model,
      mixer,
      actions,
      height: asset.height,
      labelHeight: asset.labelHeight,
    };
  }

  static createPlaceholderCharacterModel(color = 0x2299ff) {
    const group = new THREE.Group();

    const torsoMat = new THREE.MeshLambertMaterial({ color });
    const skinMat = new THREE.MeshLambertMaterial({ color: 0xffcc99 });
    const legMat = new THREE.MeshLambertMaterial({ color: 0x333366 });
    const hairMat = new THREE.MeshLambertMaterial({ color: 0x2b1b14 });

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.35, 0.48), torsoMat);
    torso.position.y = 1.82;
    group.add(torso);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.72, 0.72), skinMat);
    head.position.y = 2.93;
    group.add(head);

    const hair = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.2, 0.8), hairMat);
    hair.position.y = 3.25;
    group.add(hair);

    const armGeo = new THREE.BoxGeometry(0.26, 1.05, 0.26);
    const leftArm = new THREE.Mesh(armGeo, torsoMat);
    leftArm.position.set(-0.68, 1.85, 0);
    group.add(leftArm);
    const rightArm = new THREE.Mesh(armGeo, torsoMat);
    rightArm.position.set(0.68, 1.85, 0);
    group.add(rightArm);

    const legGeo = new THREE.BoxGeometry(0.32, 1.05, 0.32);
    const leftLeg = new THREE.Mesh(legGeo, legMat);
    leftLeg.position.set(-0.22, 0.52, 0);
    group.add(leftLeg);
    const rightLeg = new THREE.Mesh(legGeo, legMat);
    rightLeg.position.set(0.22, 0.52, 0);
    group.add(rightLeg);

    group.userData.disposeOnRemove = true;
    group.userData.characterHeight = 3.35;
    group.userData.labelHeight = 3.7;

    return group;
  }

  static playCharacterAnimation(target, state, fadeDuration = 0.2) {
    if (!target || !target.actions) return;

    const fallbacks = [state];
    if (state === 'run') fallbacks.push('walk');
    fallbacks.push('idle');

    let nextAction = null;
    for (const key of fallbacks) {
      if (target.actions[key]) {
        nextAction = target.actions[key];
        break;
      }
    }

    if (!nextAction) {
      nextAction = Object.values(target.actions)[0] || null;
    }
    if (!nextAction || target.currentAction === nextAction) return;

    const previousAction = target.currentAction;
    target.currentAction = nextAction;

    nextAction
      .reset()
      .setEffectiveTimeScale(1)
      .setEffectiveWeight(1)
      .fadeIn(fadeDuration)
      .play();

    if (previousAction && previousAction !== nextAction) {
      previousAction.fadeOut(fadeDuration);
    }
  }

  setupSky() {
    // ---- Sky dome with gradient shader ----
    const skyGeo = new THREE.SphereGeometry(900, 32, 15);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor:   { value: new THREE.Color(0x020215) },
        horizColor: { value: new THREE.Color(0x080830) },
      },
      vertexShader: `
        varying float vHeight;
        void main() {
          vHeight = normalize(position).y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 horizColor;
        varying float vHeight;
        void main() {
          float t = pow(max(vHeight, 0.0), 0.45);
          gl_FragColor = vec4(mix(horizColor, topColor, t), 1.0);
        }
      `
    });
    this.skyMesh = new THREE.Mesh(skyGeo, skyMat);
    this.skyMesh.frustumCulled = false;
    this.scene.add(this.skyMesh);

    // ---- Sun (bright white core) ----
    const sunGeo = new THREE.SphereGeometry(18, 16, 16);
    const sunMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
    this.sunMesh = new THREE.Mesh(sunGeo, sunMat);
    this.sunMesh.frustumCulled = false;
    this.scene.add(this.sunMesh);

    // ---- Sun glow layers (additive billboard sprites) ----
    const glowShader = {
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uFalloff;
        varying vec2 vUv;
        void main() {
          float d = distance(vUv, vec2(0.5));
          float glow = 1.0 - smoothstep(0.0, 0.5, pow(d, uFalloff));
          gl_FragColor = vec4(uColor, glow * uOpacity);
        }
      `
    };

    // Inner hot glow (tight white)
    const innerGlowMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(1.0, 1.0, 1.0) },
        uOpacity: { value: 0.9 },
        uFalloff: { value: 0.6 },
      },
      vertexShader: glowShader.vertexShader,
      fragmentShader: glowShader.fragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    });
    this.sunInnerGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), innerGlowMat);
    this.sunInnerGlow.scale.set(90, 90, 1);
    this.sunInnerGlow.frustumCulled = false;
    this.scene.add(this.sunInnerGlow);

    // Outer soft glow (warm tint, larger)
    const outerGlowMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(1.0, 0.95, 0.7) },
        uOpacity: { value: 0.45 },
        uFalloff: { value: 0.45 },
      },
      vertexShader: glowShader.vertexShader,
      fragmentShader: glowShader.fragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    });
    this.sunOuterGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), outerGlowMat);
    this.sunOuterGlow.scale.set(200, 200, 1);
    this.sunOuterGlow.frustumCulled = false;
    this.scene.add(this.sunOuterGlow);

    // Wide atmosphere scatter glow
    const scatterGlowMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(1.0, 0.85, 0.5) },
        uOpacity: { value: 0.15 },
        uFalloff: { value: 0.35 },
      },
      vertexShader: glowShader.vertexShader,
      fragmentShader: glowShader.fragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    });
    this.sunScatterGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), scatterGlowMat);
    this.sunScatterGlow.scale.set(400, 400, 1);
    this.sunScatterGlow.frustumCulled = false;
    this.scene.add(this.sunScatterGlow);

    // Keep reference for old code compatibility
    this.sunGlowMesh = this.sunInnerGlow;

    // ---- Lens flare system ----
    this.setupLensFlare();

    // ---- Moon ----
    const moonGeo = new THREE.SphereGeometry(11, 16, 16);
    const moonMat = new THREE.MeshBasicMaterial({ color: 0xddeeff, fog: false });
    this.moonMesh = new THREE.Mesh(moonGeo, moonMat);
    this.moonMesh.frustumCulled = false;
    this.scene.add(this.moonMesh);

    // ---- Stars ----
    const STAR_COUNT = 3000;
    const starPos = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      const r = 850;
      starPos[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      starPos[i * 3 + 2] = r * Math.cos(phi);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xffffff, size: 1.8,
      sizeAttenuation: false,
      transparent: true, opacity: 0,
      fog: false
    });
    this.starField = new THREE.Points(starGeo, starMat);
    this.starField.frustumCulled = false;
    this.scene.add(this.starField);

    // ---- Lights ----
    this.ambientLight = new THREE.AmbientLight(0x6688cc, 0.3);
    this.scene.add(this.ambientLight);


    this.hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x445533, 0.6);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xffffcc, 1.0);
    this.sunLight.position.set(0, 400, 0);
    this.scene.add(this.sunLight);

    this.moonLight = new THREE.DirectionalLight(0x8899cc, 0.0);
    this.moonLight.position.set(0, -400, 0);
    this.scene.add(this.moonLight);
  }

  setupLensFlare() {
    // Create a canvas-based texture for circular flare elements
    const makeFlareTexture = (size, innerR, outerR, color, ring) => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      if (ring) {
        // Ring/halo element
        const grad = ctx.createRadialGradient(size/2, size/2, innerR * size/2, size/2, size/2, outerR * size/2);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(0.4, color);
        grad.addColorStop(0.6, color);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
      } else {
        // Soft disc element
        const grad = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
        grad.addColorStop(0, color);
        grad.addColorStop(0.3, color);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
      }
      ctx.fillRect(0, 0, size, size);
      const tex = new THREE.CanvasTexture(c);
      tex.needsUpdate = true;
      return tex;
    };

    // Lens flare elements: { texture, size (screen px), dist along sun-center axis, color, opacity }
    this.lensFlareElements = [
      { tex: makeFlareTexture(128, 0, 0.5, 'rgba(255,255,255,0.6)', false), size: 0.25, dist: 0.3, opacity: 0.3 },
      { tex: makeFlareTexture(128, 0, 0.5, 'rgba(255,200,100,0.5)', false), size: 0.12, dist: 0.5, opacity: 0.25 },
      { tex: makeFlareTexture(128, 0.35, 0.5, 'rgba(120,180,255,0.4)', true), size: 0.35, dist: 0.7, opacity: 0.15 },
      { tex: makeFlareTexture(64, 0, 0.5, 'rgba(255,220,150,0.5)', false), size: 0.06, dist: 0.85, opacity: 0.35 },
      { tex: makeFlareTexture(128, 0.3, 0.45, 'rgba(200,150,255,0.3)', true), size: 0.18, dist: 1.2, opacity: 0.12 },
      { tex: makeFlareTexture(64, 0, 0.5, 'rgba(100,200,255,0.4)', false), size: 0.04, dist: 1.5, opacity: 0.3 },
      { tex: makeFlareTexture(128, 0, 0.5, 'rgba(255,180,80,0.3)', false), size: 0.15, dist: 1.8, opacity: 0.15 },
    ];

    // Build an overlay scene for lens flare (screen-space)
    this.lensFlareScene = new THREE.Scene();
    this.lensFlareCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.lensFlareSprites = [];

    for (const el of this.lensFlareElements) {
      const mat = new THREE.SpriteMaterial({
        map: el.tex,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        opacity: 0,
        fog: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(el.size, el.size, 1);
      sprite.renderOrder = 999;
      this.lensFlareScene.add(sprite);
      this.lensFlareSprites.push({ sprite, el });
    }

    // Main flare burst (bright center starburst)  
    const burstTex = makeFlareTexture(256, 0, 0.5, 'rgba(255,255,240,0.8)', false);
    const burstMat = new THREE.SpriteMaterial({
      map: burstTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      opacity: 0,
      fog: false,
    });
    this.lensFlareBurst = new THREE.Sprite(burstMat);
    this.lensFlareBurst.scale.set(0.4, 0.4, 1);
    this.lensFlareBurst.renderOrder = 999;
    this.lensFlareScene.add(this.lensFlareBurst);
  }

  updateLensFlare() {
    // Project sun position to screen space
    const sunWorldPos = this.sunMesh.position.clone();
    const projected = sunWorldPos.clone().project(this.camera);

    // Check if sun is in front of camera
    const sunDir = sunWorldPos.clone().sub(this.camera.position).normalize();
    const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const dot = sunDir.dot(camForward);

    // Sun must be visible and in front of camera
    const sunVisible = this.sunMesh.visible && dot > 0;
    const onScreen = Math.abs(projected.x) < 1.3 && Math.abs(projected.y) < 1.3 && projected.z < 1;

    // Calculate intensity based on how centered the sun is and its elevation
    let intensity = 0;
    if (sunVisible && onScreen) {
      const edgeDist = 1.0 - Math.max(Math.abs(projected.x), Math.abs(projected.y));
      intensity = Math.max(0, Math.min(1, edgeDist * 2.0)) * Math.max(0, Math.min(1, dot));
      intensity *= this.sunFlareStrength ?? 1;
    }

    // Sun screen position (NDC: -1 to 1)
    const sx = projected.x;
    const sy = projected.y;

    // Flare line goes from sun through screen center to opposite side
    for (const { sprite, el } of this.lensFlareSprites) {
      const fx = sx - sx * el.dist * 2;
      const fy = sy - sy * el.dist * 2;
      sprite.position.set(fx, fy, 0);
      sprite.material.opacity = el.opacity * intensity;
    }

    // Central burst on the sun itself
    this.lensFlareBurst.position.set(sx, sy, 0);
    this.lensFlareBurst.material.opacity = 0.5 * intensity;

    // Adjust aspect ratio for sprites
    const aspect = window.innerWidth / window.innerHeight;
    for (const { sprite, el } of this.lensFlareSprites) {
      sprite.scale.set(el.size, el.size * aspect, 1);
    }
    this.lensFlareBurst.scale.set(0.4, 0.4 * aspect, 1);
  }

  updateSky(dt) {
    // Calculate day time based on server's world start time
    if (this.gameWorldStartTime !== null) {
      const elapsedMs = Date.now() - this.gameWorldStartTime;
      this.dayTime = (elapsedMs / this.timeCycleMs) % 1.0;
    }
    const t = this.dayTime;

    // Sun orbit: 0=midnight (below), 0.5=noon (above)
    const angle  = t * Math.PI * 2;
    const ORBIT  = 800;
    const sunX   =  Math.sin(angle) * ORBIT;
    const sunY   = -Math.cos(angle) * ORBIT;

    // Follow camera so sky/sun always surrounds the player
    const cx = this.camera.position.x;
    const cy = this.camera.position.y;
    const cz = this.camera.position.z;

    this.skyMesh.position.set(cx, cy, cz);
    this.sunMesh.position.set(cx + sunX, cy + sunY, cz);
    // Position all glow layers at the sun
    this.sunInnerGlow.position.set(cx + sunX, cy + sunY, cz);
    this.sunOuterGlow.position.set(cx + sunX, cy + sunY, cz);
    this.sunScatterGlow.position.set(cx + sunX, cy + sunY, cz);
    // Billboard: make glow planes face the camera
    this.sunInnerGlow.lookAt(this.camera.position);
    this.sunOuterGlow.lookAt(this.camera.position);
    this.sunScatterGlow.lookAt(this.camera.position);
    this.moonMesh.position.set(cx - sunX, cy - sunY, cz);
    this.starField.position.set(cx, cy, cz);

    // Sun/moon light directions
    this.sunLight.position.set(sunX, sunY, 0);
    this.moonLight.position.set(-sunX, -sunY, 0);

    // -1 = sun at nadir (midnight), 0 = horizon, +1 = zenith (noon)
    const sunElev = sunY / ORBIT;
    const daylightFactor = Math.max(0, Math.min(1, (sunElev + 0.2) / 0.7));
    const horizonSoftness = Math.max(0, Math.min(1, (sunElev + 0.02) / 0.32));
    const aboveHorizonFade = Math.max(0, Math.min(1, sunElev / 0.18));

    // ---- Sky gradient keyframes [t, [topR,G,B], [horizR,G,B]] ----
    const phases = [
      { t: 0.00, top: [0.010, 0.010, 0.080], hor: [0.020, 0.020, 0.120] },
      { t: 0.22, top: [0.045, 0.045, 0.150], hor: [0.180, 0.080, 0.040] },
      { t: 0.27, top: [0.180, 0.230, 0.520], hor: [0.950, 0.380, 0.080] },
      { t: 0.35, top: [0.180, 0.430, 0.720], hor: [0.750, 0.820, 0.920] },
      { t: 0.50, top: [0.080, 0.390, 0.840], hor: [0.530, 0.780, 0.940] },
      { t: 0.65, top: [0.180, 0.430, 0.720], hor: [0.750, 0.820, 0.920] },
      { t: 0.73, top: [0.180, 0.230, 0.520], hor: [0.950, 0.220, 0.040] },
      { t: 0.78, top: [0.045, 0.045, 0.150], hor: [0.150, 0.060, 0.025] },
      { t: 1.00, top: [0.010, 0.010, 0.080], hor: [0.020, 0.020, 0.120] },
    ];

    let lo = phases[0], hi = phases[1];
    for (let i = 0; i < phases.length - 1; i++) {
      if (t >= phases[i].t && t < phases[i + 1].t) { lo = phases[i]; hi = phases[i + 1]; break; }
    }
    const f = (t - lo.t) / (hi.t - lo.t);
    const lerp3 = (a, b, f) => [a[0]+(b[0]-a[0])*f, a[1]+(b[1]-a[1])*f, a[2]+(b[2]-a[2])*f];

    const topC = lerp3(lo.top, hi.top, f);
    const horC = lerp3(lo.hor, hi.hor, f);

    this.skyMesh.material.uniforms.topColor.value.setRGB(...topC);
    this.skyMesh.material.uniforms.horizColor.value.setRGB(...horC);
    this.renderer.setClearColor(new THREE.Color().setRGB(...horC));
    this.scene.fog.color.setRGB(...horC);

    if (this.waterMesh) {
      this.waterTime += dt;
      this.waterUniforms.uTime.value = this.waterTime;
      this.waterUniforms.uSkyColor.value.setRGB(...horC);
      this.waterUniforms.uDayFactor.value = daylightFactor;
      this.updateWaterPatch();
    }

    // ---- Sun appearance (always bright white core) ----
    const sunVisible = sunY > -60;
    this.sunMesh.visible       = sunVisible;
    this.sunInnerGlow.visible  = sunVisible;
    this.sunOuterGlow.visible  = sunVisible;
    this.sunScatterGlow.visible = sunVisible;
    this.sunFlareStrength = sunVisible ? aboveHorizonFade * (0.18 + 0.82 * horizonSoftness) : 0;
    if (sunVisible) {
      const e = Math.max(0, sunElev);
      const glowStrength = aboveHorizonFade * (0.2 + 0.8 * horizonSoftness);
      const sunCoreStrength = 0.72 + 0.28 * horizonSoftness;
      // Keep sun warm at the horizon, but dimmer than midday
      this.sunMesh.material.color.setRGB(
        sunCoreStrength,
        (0.82 + 0.18 * e) * sunCoreStrength,
        (0.72 + 0.28 * e) * sunCoreStrength
      );
      // Glow intensities
      this.sunInnerGlow.material.uniforms.uOpacity.value = 0.9 * glowStrength;
      this.sunOuterGlow.material.uniforms.uOpacity.value = 0.45 * glowStrength;
      this.sunScatterGlow.material.uniforms.uOpacity.value = 0.15 * glowStrength;
      // Warm tint on outer glow near horizon
      const warmR = 1.0, warmG = 0.75 + 0.25 * e, warmB = 0.4 + 0.6 * e;
      this.sunOuterGlow.material.uniforms.uColor.value.setRGB(warmR, warmG, warmB);
      this.sunScatterGlow.material.uniforms.uColor.value.setRGB(warmR, warmG * 0.9, warmB * 0.7);
    }

    // ---- Lens flare update ----
    this.updateLensFlare();

    // ---- Moon appearance ----
    const moonElev = -sunElev;
    this.moonMesh.visible = moonElev > -0.1;

    // ---- Sun directional light ----
    const sunIntensity = Math.max(0, sunElev * 1.3);
    this.sunLight.intensity = sunIntensity;
    if (sunVisible) {
      const e = Math.max(0, sunElev);
      this.sunLight.color.setRGB(1.0, 0.88 + 0.12 * e, 0.65 + 0.35 * e);
    }

    // ---- Moon directional light ----
    this.moonLight.intensity = Math.max(0, moonElev * 0.18);

    // ---- Ambient + hemi lights ----
    const ambFactor = daylightFactor;
    this.ambientLight.color.setRGB(
      0.03 + 0.37 * ambFactor,
      0.04 + 0.41 * ambFactor,
      0.08 + 0.42 * ambFactor
    );
    this.ambientLight.intensity = 1.0;
    this.hemiLight.color.setRGB(...topC);
    this.hemiLight.groundColor.setRGB(
      0.20 * ambFactor + 0.02,
      0.28 * ambFactor + 0.02,
      0.12 * ambFactor + 0.01
    );
    this.hemiLight.intensity = 0.3 + 0.5 * ambFactor;

    // ---- Stars fade in at night ----
    this.starField.material.opacity = Math.max(0, Math.min(1, -sunElev * 4));
  }

  setupWater() {
    this.waterPatchSize = 800;
    this.waterPatchSnap = 48;
    this.waterPatchX = null;
    this.waterPatchZ = null;

    const waterGeo = new THREE.PlaneGeometry(this.waterPatchSize, this.waterPatchSize, 80, 80);
    waterGeo.rotateX(-Math.PI / 2);
    waterGeo.setAttribute('waveAmp', new THREE.BufferAttribute(new Float32Array(waterGeo.attributes.position.count), 1));

    this.waterUniforms = {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(0x2564a8) },
      uDeepColor: { value: new THREE.Color(0x103765) },
      uSkyColor: { value: new THREE.Color(0x87ceeb) },
      uDayFactor: { value: 1 }
    };

    const waterMat = new THREE.ShaderMaterial({
      uniforms: this.waterUniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      vertexShader: `
        uniform float uTime;
        attribute float waveAmp;
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying float vWaveAmp;

        void main() {
          vec4 worldP = modelMatrix * vec4(position, 1.0);

          float waveA = sin(worldP.x * 0.055 + uTime * 1.35) * 0.5;
          float waveB = cos(worldP.z * 0.07 - uTime * 1.1) * 0.35;
          float waveC = sin((worldP.x + worldP.z) * 0.03 + uTime * 1.6) * 0.15;
          float wave = (waveA + waveB + waveC) * waveAmp;
          worldP.y += wave;

          float dx = (
            0.055 * 0.5 * cos(worldP.x * 0.055 + uTime * 1.35) +
            0.03 * 0.15 * cos((worldP.x + worldP.z) * 0.03 + uTime * 1.6)
          ) * waveAmp;
          float dz = (
            -0.07 * 0.35 * sin(worldP.z * 0.07 - uTime * 1.1) +
            0.03 * 0.15 * cos((worldP.x + worldP.z) * 0.03 + uTime * 1.6)
          ) * waveAmp;

          vWorldPos = worldP.xyz;
          vNormal = normalize(vec3(-dx, 1.0, -dz));
          vWaveAmp = waveAmp;

          gl_Position = projectionMatrix * viewMatrix * worldP;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform vec3 uDeepColor;
        uniform vec3 uSkyColor;
        uniform float uDayFactor;
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying float vWaveAmp;

        void main() {
          vec3 viewDir = normalize(cameraPosition - vWorldPos);
          float fresnel = pow(clamp(1.0 - max(dot(viewDir, vNormal), 0.0), 0.0, 1.0), 3.0);
          float depthTint = clamp((vWaveAmp - 0.03) / 0.29, 0.0, 1.0);
          vec3 waterBase = mix(uColor, uDeepColor, depthTint);
          waterBase *= mix(0.35, 1.0, uDayFactor);

          vec3 reflectedSky = mix(uSkyColor * 0.2, uSkyColor, uDayFactor);
          float reflectionStrength = mix(0.18, 0.72, uDayFactor);
          vec3 finalColor = mix(waterBase, reflectedSky, fresnel * reflectionStrength);

          gl_FragColor = vec4(finalColor, mix(0.72, 0.82, uDayFactor));
        }
      `
    });

    this.waterMesh = new THREE.Mesh(waterGeo, waterMat);
    this.waterMesh.position.y = this.waterLevel;
    this.waterMesh.frustumCulled = false;
    this.scene.add(this.waterMesh);
    this.updateWaterPatch(true);
  }

  setupUnderwaterPostFX() {
    this.sceneRenderTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      depthBuffer: true,
    });

    this.postUniforms = {
      tDiffuse: { value: this.sceneRenderTarget.texture },
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
      uDistortion: { value: 0.6 },
      uDarkness: { value: 0.25 },
    };

    this.postScene = new THREE.Scene();
    this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const postMat = new THREE.ShaderMaterial({
      uniforms: this.postUniforms,
      depthTest: false,
      depthWrite: false,
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform vec2 uResolution;
        uniform float uTime;
        uniform float uDistortion;
        uniform float uDarkness;
        varying vec2 vUv;

        void main() {
          vec2 texel = 1.0 / uResolution;
          float rippleX = sin(vUv.y * 36.0 + uTime * 1.8) * 0.5 + cos((vUv.x + vUv.y) * 22.0 - uTime * 1.2) * 0.5;
          float rippleY = cos(vUv.x * 34.0 - uTime * 1.4) * 0.5 + sin((vUv.x - vUv.y) * 28.0 + uTime * 1.6) * 0.5;
          vec2 offset = vec2(rippleX, rippleY) * texel * 12.0 * uDistortion;

          vec3 c0 = texture2D(tDiffuse, vUv + offset).rgb;
          vec3 c1 = texture2D(tDiffuse, vUv + offset + vec2(texel.x * 2.0, 0.0)).rgb;
          vec3 c2 = texture2D(tDiffuse, vUv + offset - vec2(0.0, texel.y * 2.0)).rgb;
          vec3 color = c0 * 0.55 + c1 * 0.225 + c2 * 0.225;

          float vignette = smoothstep(0.9, 0.18, distance(vUv, vec2(0.5)));
          color = mix(color, color * vec3(0.12, 0.32, 0.48), 0.38 + uDarkness * 0.25);
          color *= mix(0.38, 0.78, vignette);
          color *= 1.0 - uDarkness;

          gl_FragColor = vec4(color, 1.0);
        }
      `
    });

    this.postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat);
    this.postScene.add(this.postQuad);
  }

  getWaterDepthFactor(worldX, worldZ) {
    const depth = Math.max(0, this.waterLevel - this.terrain.getHeight(worldX, worldZ));
    return Math.min(depth / 18, 1);
  }

  getWaterWaveAmplitude(worldX, worldZ) {
    const depthFactor = this.getWaterDepthFactor(worldX, worldZ);
    if (depthFactor <= 0.01) return 0.015;
    return Math.min(0.04 + depthFactor * 0.28, 0.32);
  }

  getWaterWaveOffset(worldX, worldZ) {
    const amp = this.getWaterWaveAmplitude(worldX, worldZ);
    const waveA = Math.sin(worldX * 0.055 + this.waterTime * 1.35) * 0.5;
    const waveB = Math.cos(worldZ * 0.07 - this.waterTime * 1.1) * 0.35;
    const waveC = Math.sin((worldX + worldZ) * 0.03 + this.waterTime * 1.6) * 0.15;
    return (waveA + waveB + waveC) * amp;
  }

  getWaterSurfaceHeight(worldX, worldZ) {
    return this.waterLevel + this.getWaterWaveOffset(worldX, worldZ);
  }

  updateWaterPatch(force = false) {
    if (!this.waterMesh) return;

    const centerX = this.position ? this.position.x : 0;
    const centerZ = this.position ? this.position.z : 0;
    const snappedX = Math.floor(centerX / this.waterPatchSnap) * this.waterPatchSnap;
    const snappedZ = Math.floor(centerZ / this.waterPatchSnap) * this.waterPatchSnap;

    if (!force && snappedX === this.waterPatchX && snappedZ === this.waterPatchZ) return;

    this.waterPatchX = snappedX;
    this.waterPatchZ = snappedZ;
    this.waterMesh.position.set(snappedX, this.waterLevel, snappedZ);

    const positions = this.waterMesh.geometry.attributes.position.array;
    const waveAmp = this.waterMesh.geometry.attributes.waveAmp;
    const ampArray = waveAmp.array;

    for (let i = 0, j = 0; i < ampArray.length; i++, j += 3) {
      const worldX = snappedX + positions[j];
      const worldZ = snappedZ + positions[j + 2];
      ampArray[i] = this.getWaterWaveAmplitude(worldX, worldZ);
    }

    waveAmp.needsUpdate = true;
  }

  createPlayerModel(color = 0x2299ff) {
    return Game.createPlaceholderCharacterModel(color);
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
    Game.preloadCharacterAsset().catch(() => {});

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
    this.setPhoneOpen(false, { skipPointerLock: true, immediate: true });
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }

    // Clean up other player labels
    for (const id in this.otherPlayers) {
      const player = this.otherPlayers[id];
      if (player.model) this.scene.remove(player.model);
      if (player.label) player.label.remove();
    }
    this.otherPlayers = {};

    // Remove event listeners
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    if (this._onCanvasClick) this.canvas.removeEventListener('click', this._onCanvasClick);
    document.exitPointerLock();
  }

  setupInput() {
    this._onKeyDown = (e) => {
      const kb = this.settings.keybinds;
      const phoneKey = kb.phone;

      // Escape toggles pause (only works when NOT pointer-locked; browser
      // intercepts Escape to kill pointer lock before keydown fires, so the
      // real pause trigger is pointerlockchange below).
      if (e.code === 'Escape') {
        e.preventDefault();
        if (this.phoneOpen || this.phoneDocked) {
          this.setPhoneOpen(false);
          return;
        }
        if (this.paused) this.togglePause(); // resume if already paused
        return;
      }
      if (this.paused) return;

      // Prevent default browser behavior for game control keys
      const gameKeys = [kb.forward, kb.backward, kb.left, kb.right, kb.jump, kb.run, kb.crouch, phoneKey].filter(Boolean);
      if (gameKeys.includes(e.code)) {
        e.preventDefault();
      }

      if (phoneKey && e.code === phoneKey) {
        if (this.phoneDocked) {
          this.setPhoneOpen(true);
        } else {
          this.setPhoneOpen(!this.phoneOpen);
        }
        return;
      }

      if (this.phoneOpen) return;

      this.keys[e.code] = true;
      if (e.code === kb.jump && this.onGround && !this.isSwimming) {
        this.velocity.y = this.jumpSpeed;
        this.onGround = false;
        this.jumpAnimationTimer = this.jumpAnimationDuration;
      }
    };
    this._onKeyUp = (e) => {
      this.keys[e.code] = false;
      const kb = this.settings.keybinds;
      if (e.code === kb.run)    this.isRunning   = false;
      if (e.code === kb.crouch) this.isCrouching = false;
    };
    this._onMouseMove = (e) => {
      if (!this.mouseLocked || this.paused) return;
      this.euler.y -= e.movementX * this.mouseSensitivity;
      this.euler.x -= e.movementY * this.mouseSensitivity;
      this.euler.x = Math.max(-Math.PI / 2.1, Math.min(Math.PI / 2.1, this.euler.x));
    };

    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('mousemove', this._onMouseMove);

    // Click canvas to (re)acquire pointer lock when not paused
    this._onCanvasClick = () => {
      if (!this.paused && !this.phoneOpen) this.canvas.requestPointerLock();
    };
    this.canvas.addEventListener('click', this._onCanvasClick);

    // Primary pause trigger: browser kills pointer lock with Escape BEFORE
    // keydown fires, so we detect the lock loss here instead.
    this._onPointerLockChange = () => {
      this.mouseLocked = document.pointerLockElement === this.canvas;
      const prompt = document.getElementById('lock-prompt');
      if (this.mouseLocked) {
        // Lock acquired — hide the "click to play" prompt
        prompt.style.display = 'none';
      } else if (!this.paused && this.running) {
        if (this.phoneOpen) return;
        if (this.phoneDocked) {
          this.setPhoneOpen(false, { skipPointerLock: true, immediate: true });
          prompt.style.display = 'block';
          return;
        }
        // Lock lost (user pressed Escape) — pause the game
        this.togglePause();
      }
    };
    document.addEventListener('pointerlockchange', this._onPointerLockChange);

    // Show prompt initially
    document.getElementById('lock-prompt').style.display = 'block';
  }

  togglePause() {
    if (this.phoneOpen || this.phoneDocked) {
      this.setPhoneOpen(false, { skipPointerLock: true, immediate: true });
    }

    this.paused = !this.paused;
    const menu   = document.getElementById('pause-menu');
    const hud    = document.getElementById('hud');
    const prompt = document.getElementById('lock-prompt');
    if (this.paused) {
      // exitPointerLock already happened (browser did it via Escape), but call
      // it anyway in case togglePause is called programmatically.
      document.exitPointerLock();
      menu.style.display = 'flex';
      hud.style.visibility = 'hidden';
      prompt.style.display = 'none';
      // Clear held keys so nothing keeps moving
      this.keys = {};
      this.isRunning = false;
      this.isCrouching = false;
    } else {
      menu.style.display = 'none';
      hud.style.visibility = 'visible';
      document.getElementById('settings-menu').style.display = 'none';
      // Re-acquire pointer lock; prompt will hide once lock is granted
      prompt.style.display = 'block';
      this.canvas.requestPointerLock();
    }
  }

  // Apply settings live (called from settings UI)
  applySettings(settings) {
    this.settings = settings;
    this.mouseSensitivity = settings.sensitivity;
    Game.saveSettings(settings);
    this.updatePhoneKeyHint();
  }

  static defaultSettings() {
    return {
      sensitivity: 0.001,
      keybinds: {
        forward:  'KeyW',
        backward: 'KeyS',
        left:     'KeyA',
        right:    'KeyD',
        jump:     'Space',
        run:      'ControlLeft',
        crouch:   'ShiftLeft',
        phone:    'KeyP',
      },
    };
  }

  static loadSettings() {
    try {
      const raw = localStorage.getItem('usim_settings');
      if (raw) {
        const saved = JSON.parse(raw);
        const def = Game.defaultSettings();
        // Merge so new defaults appear if not present
        return {
          sensitivity: saved.sensitivity ?? def.sensitivity,
          keybinds: Object.assign({}, def.keybinds, saved.keybinds),
        };
      }
    } catch (e) {}
    return Game.defaultSettings();
  }

  static saveSettings(settings) {
    localStorage.setItem('usim_settings', JSON.stringify(settings));
  }

  setupPhoneUI() {
    const root = document.getElementById('phone-root');
    if (!root) return;

    this.phoneUI = {
      root,
      clock: document.getElementById('phone-time'),
      keyHint: document.getElementById('phone-keybind-hint'),
      dockBtn: document.getElementById('phone-dock'),
      home: document.getElementById('phone-home'),
      appView: document.getElementById('phone-app-view'),
      appTitle: document.getElementById('phone-app-title'),
      appSubtitle: document.getElementById('phone-app-subtitle'),
      appBody: document.getElementById('phone-app-body'),
      closeBtn: document.getElementById('phone-close'),
      backBtn: document.getElementById('phone-back'),
      homeBtn: document.getElementById('phone-home-btn'),
      apps: Array.from(document.querySelectorAll('.phone-app')),
    };

    this.phoneUI.apps.forEach((button) => {
      button.onclick = () => this.openPhoneApp(button.dataset.app);
    });

    if (this.phoneUI.closeBtn) {
      this.phoneUI.closeBtn.onclick = () => this.setPhoneOpen(false);
    }
    if (this.phoneUI.dockBtn) {
      this.phoneUI.dockBtn.onclick = () => this.setPhoneOpen('docked');
    }
    if (this.phoneUI.backBtn) {
      this.phoneUI.backBtn.onclick = () => this.openPhoneApp(null);
    }
    if (this.phoneUI.homeBtn) {
      this.phoneUI.homeBtn.onclick = () => this.openPhoneApp(null);
    }

    this.openPhoneApp(null);
    this.updatePhoneClock(true);
    this.updatePhoneKeyHint();
    this.syncPhoneUI(true);
  }

  updatePhoneKeyHint() {
    if (!this.phoneUI || !this.phoneUI.keyHint) return;
    this.phoneUI.keyHint.textContent = Game.formatKeyLabel(this.settings.keybinds.phone);
  }

  updatePhoneClock(force = false) {
    if (!this.phoneUI || !this.phoneUI.clock) return;

    const clockText = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });

    if (!force && clockText === this.phoneClockLabel) return;
    this.phoneClockLabel = clockText;
    this.phoneUI.clock.textContent = clockText;
  }

  openPhoneApp(appId) {
    if (!this.phoneUI) return;

    if (this.phoneMap) {
      this.phoneMap.dragging = false;
      this.phoneMap.pointerId = null;
    }

    this.phoneActiveApp = appId || null;
    const isHome = !this.phoneActiveApp;
    this.phoneUI.home.style.display = isHome ? 'flex' : 'none';
    this.phoneUI.appView.style.display = isHome ? 'none' : 'flex';

    if (isHome) return;

    const app = Game.PHONE_APPS[this.phoneActiveApp] || Game.PHONE_APPS.messages;
    this.phoneUI.appTitle.textContent = app.title;
    this.phoneUI.appSubtitle.textContent = app.subtitle;

    if (this.phoneActiveApp === 'maps') {
      this.phoneUI.appBody.innerHTML = this.getPhoneMapMarkup();
      this.setupPhoneMapApp();
      this.markPhoneMapDirty();
      this.renderPhoneMap(true);
      return;
    }

    this.phoneUI.appBody.innerHTML = app.body;
  }

  getPhoneMapMarkup() {
    return `
      <div class="phone-map-panel">
        <div class="phone-map-toolbar">
          <div class="phone-map-toolbar-meta">
            <div id="phone-map-range" class="phone-map-range">Range</div>
            <div id="phone-map-detail" class="phone-map-detail">Loading map…</div>
          </div>
          <div class="phone-map-toolbar-actions">
            <button id="phone-map-follow" class="phone-map-tool-btn follow" type="button">Following</button>
            <button id="phone-map-zoom-out" class="phone-map-tool-btn" type="button" aria-label="Zoom out">−</button>
            <button id="phone-map-zoom-in" class="phone-map-tool-btn" type="button" aria-label="Zoom in">+</button>
          </div>
        </div>

        <div class="phone-map-canvas-wrap">
          <canvas id="phone-map-canvas"></canvas>
          <div class="phone-map-compass">N</div>
        </div>

        <div class="phone-map-readout">
          <div id="phone-map-coords" class="phone-map-coords">X 0 • Z 0 • Alt 0</div>
          <div class="phone-map-legend">
            <span class="phone-map-legend-item"><span class="phone-map-swatch water"></span>Water</span>
            <span class="phone-map-legend-item"><span class="phone-map-swatch road"></span>Roads</span>
            <span class="phone-map-legend-item"><span class="phone-map-swatch player"></span>You</span>
          </div>
        </div>
      </div>
    `;
  }

  setupPhoneMapApp() {
    const map = this.phoneMap;
    if (!map || !this.phoneUI) return;

    map.canvas = document.getElementById('phone-map-canvas');
    map.ctx = map.canvas ? map.canvas.getContext('2d', { alpha: false }) : null;
    map.rangeLabel = document.getElementById('phone-map-range');
    map.detailLabel = document.getElementById('phone-map-detail');
    map.coordsLabel = document.getElementById('phone-map-coords');
    map.followBtn = document.getElementById('phone-map-follow');
    map.zoomInBtn = document.getElementById('phone-map-zoom-in');
    map.zoomOutBtn = document.getElementById('phone-map-zoom-out');

    if (!map.canvas || !map.ctx) return;

    map.canvas.onwheel = (event) => {
      event.preventDefault();
      this.zoomPhoneMap(event.deltaY < 0 ? 1 : -1);
    };

    map.canvas.onpointerdown = (event) => {
      event.preventDefault();
      map.dragging = true;
      map.dragMoved = false;
      map.pointerId = event.pointerId;
      map.dragStartX = event.clientX;
      map.dragStartY = event.clientY;
      map.dragCenterX = map.followPlayer ? this.position.x : map.centerX;
      map.dragCenterZ = map.followPlayer ? this.position.z : map.centerZ;
      if (map.canvas.setPointerCapture) {
        map.canvas.setPointerCapture(event.pointerId);
      }
    };

    map.canvas.onpointermove = (event) => {
      if (!map.dragging || map.pointerId !== event.pointerId) return;
      const rect = map.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const zoom = Game.MAP_ZOOM_LEVELS[map.zoomIndex];
      const span = zoom.halfSpan * 2;
      const worldPerPixel = span / rect.width;
      const pixelDx = event.clientX - map.dragStartX;
      const pixelDz = event.clientY - map.dragStartY;

      if (!map.dragMoved && Math.hypot(pixelDx, pixelDz) > 2) {
        map.dragMoved = true;
        map.followPlayer = false;
        this.updatePhoneMapMeta();
      }

      if (!map.dragMoved) return;

      const dx = pixelDx * worldPerPixel;
      const dz = pixelDz * worldPerPixel;

      map.centerX = map.dragCenterX - dx;
      map.centerZ = map.dragCenterZ - dz;
      this.markPhoneMapDirty();
      this.renderPhoneMap(true);
    };

    const endDrag = (event) => {
      if (map.pointerId !== null && event.pointerId !== undefined && map.pointerId !== event.pointerId) return;
      if (map.canvas.releasePointerCapture && map.pointerId !== null) {
        try { map.canvas.releasePointerCapture(map.pointerId); } catch (e) {}
      }
      map.dragging = false;
      map.dragMoved = false;
      map.pointerId = null;
    };

    map.canvas.onpointerup = endDrag;
    map.canvas.onpointercancel = endDrag;
    map.canvas.onpointerleave = (event) => {
      if (map.dragging && (event.buttons & 1) === 0) {
        endDrag(event);
      }
    };

    if (map.followBtn) {
      map.followBtn.onclick = () => {
        map.followPlayer = true;
        map.centerX = this.position.x;
        map.centerZ = this.position.z;
        this.updatePhoneMapMeta();
        this.markPhoneMapDirty();
        this.renderPhoneMap(true);
      };
    }

    if (map.zoomInBtn) map.zoomInBtn.onclick = () => this.zoomPhoneMap(1);
    if (map.zoomOutBtn) map.zoomOutBtn.onclick = () => this.zoomPhoneMap(-1);

    this.updatePhoneMapMeta();
    this.syncPhoneMapCanvasSize();
  }

  updatePhoneMapMeta() {
    const map = this.phoneMap;
    if (!map) return;

    const zoom = Game.MAP_ZOOM_LEVELS[map.zoomIndex];

    if (map.rangeLabel) map.rangeLabel.textContent = `Range ${zoom.label}`;
    if (map.detailLabel) map.detailLabel.textContent = 'Noise terrain • Drag to pan • Wheel to zoom';

    if (map.followBtn) {
      map.followBtn.textContent = map.followPlayer ? 'Following' : 'Recenter';
      map.followBtn.classList.toggle('active', map.followPlayer);
    }

    if (map.zoomInBtn) map.zoomInBtn.disabled = map.zoomIndex === 0;
    if (map.zoomOutBtn) map.zoomOutBtn.disabled = map.zoomIndex === Game.MAP_ZOOM_LEVELS.length - 1;
  }

  zoomPhoneMap(direction) {
    const map = this.phoneMap;
    if (!map) return;

    const nextIndex = Math.max(0, Math.min(Game.MAP_ZOOM_LEVELS.length - 1, map.zoomIndex - direction));
    if (nextIndex === map.zoomIndex) return;

    map.zoomIndex = nextIndex;
    this.updatePhoneMapMeta();
    this.markPhoneMapDirty();
    this.renderPhoneMap(true);
  }

  markPhoneMapDirty() {
    if (this.phoneMap) this.phoneMap.dirty = true;
  }

  syncPhoneMapCanvasSize() {
    const map = this.phoneMap;
    if (!map || !map.canvas) return false;

    const rect = map.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(220, Math.round(rect.width * dpr));
    const height = Math.max(220, Math.round(rect.height * dpr));

    if (map.canvas.width !== width || map.canvas.height !== height) {
      map.canvas.width = width;
      map.canvas.height = height;
      map.dirty = true;
    }

    return true;
  }

  renderPhoneMap(force = false) {
    const map = this.phoneMap;
    if (!map || this.phoneActiveApp !== 'maps' || (!this.phoneOpen && !this.phoneDocked) || !map.canvas || !map.ctx) return;
    if (!this.syncPhoneMapCanvasSize()) return;

    const now = performance.now();
    const zoom = Game.MAP_ZOOM_LEVELS[map.zoomIndex];
    const playerMoved = Math.hypot(this.position.x - map.lastRenderPlayerX, this.position.z - map.lastRenderPlayerZ);
    const headingChanged = Math.abs(this.euler.y - map.lastRenderHeading) > 0.03;

    if (map.followPlayer) {
      const centerShift = Math.hypot(this.position.x - map.centerX, this.position.z - map.centerZ);
      map.centerX = this.position.x;
      map.centerZ = this.position.z;
      if (centerShift > 0.25) map.dirty = true;
    }

    if (!force && !map.dirty && now - map.lastRenderTime < 90 && playerMoved < zoom.halfSpan * 0.01 && !headingChanged) {
      return;
    }

    const ctx = map.ctx;
    const width = map.canvas.width;
    const height = map.canvas.height;
    const centerX = map.centerX;
    const centerZ = map.centerZ;
    const halfSpan = zoom.halfSpan;

    ctx.clearRect(0, 0, width, height);

    const bg = ctx.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, '#edf4e8');
    bg.addColorStop(1, '#d8e5d1');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    this.drawPhoneMapTerrainLayer(
      ctx,
      width,
      height,
      centerX,
      centerZ,
      halfSpan
    );
    this.drawPhoneMapRoads(ctx, width, height, centerX, centerZ, halfSpan);
    this.drawPhoneMapTracker(ctx, width, height, centerX, centerZ, halfSpan);

    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = Math.max(1, Math.round(width / 220));
    ctx.strokeRect(0.5, 0.5, width - 1, height - 1);

    if (map.coordsLabel) {
      const groundHeight = this.terrain.getHeight(this.position.x, this.position.z);
      map.coordsLabel.textContent = `X ${Math.round(this.position.x)} • Z ${Math.round(this.position.z)} • Alt ${Math.round(groundHeight)}`;
    }

    map.lastRenderTime = now;
    map.lastRenderPlayerX = this.position.x;
    map.lastRenderPlayerZ = this.position.z;
    map.lastRenderHeading = this.euler.y;
    map.dirty = false;
  }

  drawPhoneMapTerrainLayer(ctx, width, height, centerX, centerZ, halfSpan) {
    const raster = this.getPhoneMapTerrainRaster(width, height);
    const imageData = raster.ctx.createImageData(raster.width, raster.height);
    const pixels = imageData.data;
    const heights = new Float32Array(raster.width * raster.height);
    const span = halfSpan * 2;
    const minX = centerX - halfSpan;
    const minZ = centerZ - halfSpan;
    const stepX = span / Math.max(1, raster.width - 1);
    const stepZ = span / Math.max(1, raster.height - 1);
    const waterLevel = this.waterLevel;
    const lightX = this.phoneMapLightDir.x;
    const lightY = this.phoneMapLightDir.y;
    const lightZ = this.phoneMapLightDir.z;

    for (let y = 0; y < raster.height; y++) {
      const worldZ = minZ + y * stepZ;

      for (let x = 0; x < raster.width; x++) {
        const worldX = minX + x * stepX;
        heights[y * raster.width + x] = this.terrain.getBaseHeight(worldX, worldZ);
      }
    }

    for (let y = 0; y < raster.height; y++) {
      const worldZ = minZ + y * stepZ;
      const upY = Math.max(0, y - 1);
      const downY = Math.min(raster.height - 1, y + 1);

      for (let x = 0; x < raster.width; x++) {
        const worldX = minX + x * stepX;
        const index = y * raster.width + x;
        const leftX = Math.max(0, x - 1);
        const rightX = Math.min(raster.width - 1, x + 1);
        const heightValue = heights[index];
        const leftHeight = heights[y * raster.width + leftX];
        const rightHeight = heights[y * raster.width + rightX];
        const upHeight = heights[upY * raster.width + x];
        const downHeight = heights[downY * raster.width + x];
        const dx = -(rightHeight - leftHeight) / Math.max(stepX * (rightX - leftX || 1), 1e-4);
        const dz = -(downHeight - upHeight) / Math.max(stepZ * (downY - upY || 1), 1e-4);
        const invLength = 1 / Math.max(1e-4, Math.hypot(dx, 1.15, dz));
        const light = Math.max(0, (dx * lightX + 1.15 * lightY + dz * lightZ) * invLength);
        const shade = heightValue <= waterLevel ? 0.9 + light * 0.18 : 0.76 + light * 0.38;
        const rgb = this.getPhoneMapNoiseColor(heightValue, worldX, worldZ, shade);
        const offset = index * 4;

        pixels[offset] = rgb[0];
        pixels[offset + 1] = rgb[1];
        pixels[offset + 2] = rgb[2];
        pixels[offset + 3] = 255;
      }
    }

    raster.ctx.putImageData(imageData, 0, 0);

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(raster.canvas, 0, 0, width, height);
    ctx.restore();
  }

  getPhoneMapTerrainRaster(width, height) {
    const map = this.phoneMap;
    if (!map.terrainRasterCanvas) {
      map.terrainRasterCanvas = document.createElement('canvas');
      map.terrainRasterCtx = map.terrainRasterCanvas.getContext('2d', { alpha: false });
    }

    const sampleWidth = Math.max(96, Math.min(192, Math.round(width * 0.34)));
    const sampleHeight = Math.max(96, Math.min(192, Math.round(height * 0.34)));

    if (map.terrainRasterCanvas.width !== sampleWidth || map.terrainRasterCanvas.height !== sampleHeight) {
      map.terrainRasterCanvas.width = sampleWidth;
      map.terrainRasterCanvas.height = sampleHeight;
    }

    return {
      canvas: map.terrainRasterCanvas,
      ctx: map.terrainRasterCtx,
      width: sampleWidth,
      height: sampleHeight,
    };
  }

  getPhoneMapNoiseColor(height, worldX, worldZ, shade) {
    const waterLevel = this.waterLevel;

    if (height <= waterLevel) {
      const depth = Math.max(0, Math.min(1, (waterLevel - height) / 16));
      return this.getPhoneMapShadedRgb([
        72 - depth * 14,
        142 + depth * 10,
        214 + depth * 18,
      ], shade);
    }

    if (height <= waterLevel + 5) {
      const shoreBlend = Math.max(0, Math.min(1, (height - waterLevel) / 5));
      return this.getPhoneMapShadedRgb([
        214 - shoreBlend * 14,
        203 - shoreBlend * 10,
        164 - shoreBlend * 18,
      ], 0.94 + shade * 0.06);
    }

    const terrainColor = this.terrain.getTerrainColor(height, worldX, worldZ);
    return this.getPhoneMapShadedRgb([
      terrainColor[0] * 255,
      terrainColor[1] * 255,
      terrainColor[2] * 255,
    ], shade);
  }

  getPhoneMapShadedRgb(rgb, shade) {
    const clamp = (value) => Math.max(0, Math.min(255, Math.round(value * shade)));
    return [clamp(rgb[0]), clamp(rgb[1]), clamp(rgb[2])];
  }

  drawPhoneMapRoads(ctx, width, height, centerX, centerZ, halfSpan) {
    const minX = centerX - halfSpan;
    const minZ = centerZ - halfSpan;
    const maxX = centerX + halfSpan;
    const maxZ = centerZ + halfSpan;
    const curves = this.terrain.getHighwayCurvesInBounds(minX, minZ, maxX, maxZ, halfSpan * 0.15);
    const span = halfSpan * 2;
    const projectX = (worldX) => ((worldX - minX) / span) * width;
    const projectY = (worldZ) => ((worldZ - minZ) / span) * height;
    const roadWidth = Math.max(2, Math.min(width * 0.09, (this.terrain.highwayHalfWidth * width) / halfSpan));

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.clip();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const strokeCurves = (strokeStyle, lineWidth, dashed = false) => {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = lineWidth;
      ctx.setLineDash(dashed ? [lineWidth * 2.4, lineWidth * 2.1] : []);

      for (const curve of curves) {
        const points = curve.points;
        if (!points || points.length < 2) continue;

        ctx.beginPath();
        ctx.moveTo(projectX(points[0].x), projectY(points[0].z));
        for (let i = 1; i < points.length; i++) {
          ctx.lineTo(projectX(points[i].x), projectY(points[i].z));
        }
        ctx.stroke();
      }
    };

    strokeCurves('rgba(108, 114, 120, 0.26)', roadWidth + 5);
    strokeCurves('rgba(246, 244, 240, 0.97)', roadWidth);

    if (roadWidth >= 3.5) {
      strokeCurves('rgba(235, 192, 74, 0.85)', Math.max(1.2, roadWidth * 0.16), true);
    }

    ctx.restore();
  }

  drawPhoneMapTracker(ctx, width, height, centerX, centerZ, halfSpan) {
    const span = halfSpan * 2;
    const px = ((this.position.x - (centerX - halfSpan)) / span) * width;
    const py = ((this.position.z - (centerZ - halfSpan)) / span) * height;
    const margin = Math.max(12, width * 0.04);
    const inside = px >= margin && px <= width - margin && py >= margin && py <= height - margin;
    const drawX = Math.max(margin, Math.min(width - margin, px));
    const drawY = Math.max(margin, Math.min(height - margin, py));

    ctx.save();
    ctx.translate(drawX, drawY);

    if (inside) {
      ctx.fillStyle = 'rgba(255, 108, 108, 0.15)';
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(10, width * 0.03), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.rotate(-this.euler.y);
    ctx.fillStyle = '#ff6c6c';
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = Math.max(1.5, width * 0.006);
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(8, 10);
    ctx.lineTo(0, 6);
    ctx.lineTo(-8, 10);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    if (!inside) {
      ctx.save();
      ctx.fillStyle = 'rgba(10, 12, 18, 0.72)';
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = Math.max(1, width * 0.004);
      ctx.beginPath();
      ctx.rect(drawX - 18, drawY + 12, 36, 16);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = `${Math.max(10, width * 0.028)}px Segoe UI`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('YOU', drawX, drawY + 20);
      ctx.restore();
    }
  }

  syncPhoneUI(immediate = false) {
    if (!this.phoneUI) return;

    const { root } = this.phoneUI;
    const phoneVisible = this.phoneOpen || this.phoneDocked;
    if (immediate) root.classList.add('no-anim');
    root.classList.toggle('open', this.phoneOpen);
    root.classList.toggle('docked', this.phoneDocked);
    root.setAttribute('aria-hidden', phoneVisible ? 'false' : 'true');

    const crosshair = document.getElementById('crosshair');
    if (crosshair) crosshair.style.display = this.phoneOpen ? 'none' : 'block';

    if (immediate) {
      requestAnimationFrame(() => {
        if (this.phoneUI && this.phoneUI.root) this.phoneUI.root.classList.remove('no-anim');
      });
    }
  }

  setPhoneOpen(open, options = {}) {
    if (!this.hasPhone || !this.phoneUI) return;

    const { skipPointerLock = false, immediate = false } = options;
    const nextState = typeof open === 'string'
      ? open
      : (open ? 'open' : 'hidden');
    const nextPhoneOpen = nextState === 'open';
    const nextPhoneDocked = nextState === 'docked';

    if (this.phoneOpen === nextPhoneOpen && this.phoneDocked === nextPhoneDocked && !immediate) return;

    this.phoneOpen = nextPhoneOpen;
    this.phoneDocked = nextPhoneDocked;

    if (this.phoneMap) {
      if (this.phoneMap.canvas && this.phoneMap.pointerId !== null && this.phoneMap.canvas.releasePointerCapture) {
        try { this.phoneMap.canvas.releasePointerCapture(this.phoneMap.pointerId); } catch (e) {}
      }
      this.phoneMap.dragging = false;
      this.phoneMap.dragMoved = false;
      this.phoneMap.pointerId = null;
      this.phoneMap.dirty = true;
    }

    if (this.phoneOpen) {
      this.keys = {};
      this.isRunning = false;
      this.isCrouching = false;
      this.mouseLocked = false;
      this.openPhoneApp(this.phoneActiveApp);
      this.updatePhoneClock(true);

      const prompt = document.getElementById('lock-prompt');
      if (prompt) prompt.style.display = 'none';
      document.exitPointerLock();
    } else if (!skipPointerLock && this.running && !this.paused) {
      const prompt = document.getElementById('lock-prompt');
      if (prompt) prompt.style.display = this.phoneDocked ? 'none' : 'block';
      this.canvas.requestPointerLock();
    }

    this.syncPhoneUI(immediate);
  }

  connectMultiplayer(token) {
    this.socket = io({
      auth: { token }
    });

    this.socket.on('connect', () => {
      console.log('Connected to server');
    });

    this.socket.on('gameWorldTime', (data) => {
      this.gameWorldStartTime = data.worldStartTime;
      console.log('Synchronized with server time');
    });

    this.socket.on('gameTimeUpdate', (data) => {
      // Periodic resync with server (optional, helps prevent drift)
      // The client calculates time locally, but this confirms server thinking
      const serverTime = data.currentTime;
      const clientTime = (Date.now() - this.gameWorldStartTime) / this.timeCycleMs % 1.0;
      // Only resync if drift is significant (more than 1 game hour = 1/24th of cycle)
      const drift = Math.abs(serverTime - clientTime);
      if (drift > 1/24 && drift < 0.5) { // Check drift is not wrapping around
        console.warn('Time drift detected, minor adjustment made');
        // Small adjustment to compensate for client/server clock differences
        this.gameWorldStartTime = Date.now() - (serverTime * this.timeCycleMs);
      }
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
        player.targetY = data.y - this.playerHeight;
        player.targetZ = data.z;
        player.targetRY = data.ry;
        player.isSwimming = !!data.isSwimming;
        player.isJumping = !!data.isJumping;
        player.isRunning = !!data.isRunning;
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

  async addOtherPlayer(socketId, data) {
    let player = this.otherPlayers[socketId];
    const footY = data.y - this.playerHeight;

    if (player) {
      player.username = data.username;
      player.targetX = data.x;
      player.targetY = footY;
      player.targetZ = data.z;
      player.targetRY = data.ry || 0;
      player.isSwimming = !!data.isSwimming;
      player.isJumping = !!data.isJumping;
      player.isRunning = !!data.isRunning;
      if (player.label) player.label.textContent = data.username;
      return;
    }

    const label = this.createNameLabel(data.username);

    player = this.otherPlayers[socketId] = {
      model: null,
      mixer: null,
      actions: null,
      currentAction: null,
      label,
      username: data.username,
      targetX: data.x,
      targetY: footY,
      targetZ: data.z,
      targetRY: data.ry || 0,
      isSwimming: !!data.isSwimming,
      isJumping: !!data.isJumping,
      isRunning: !!data.isRunning,
      labelHeight: Game.CHARACTER_TARGET_HEIGHT + 0.35,
      loading: true,
    };

    try {
      const character = await Game.createCharacterInstance();
      if (!this.otherPlayers[socketId] || this.otherPlayers[socketId] !== player) return;

      player.model = character.model;
      player.mixer = character.mixer;
      player.actions = character.actions;
      player.labelHeight = character.labelHeight;
    } catch (error) {
      console.warn('Using placeholder character model for remote player:', error);
      if (!this.otherPlayers[socketId] || this.otherPlayers[socketId] !== player) return;

      player.model = this.createPlayerModel(0xff6633);
      player.labelHeight = player.model.userData.labelHeight || 3.7;
    }

    player.loading = false;
    if (!player.model) return;

    player.model.position.set(player.targetX, player.targetY, player.targetZ);
    player.model.rotation.y = player.targetRY;
    this.scene.add(player.model);
    Game.playCharacterAnimation(player, 'idle');
  }

  removeOtherPlayer(socketId) {
    const player = this.otherPlayers[socketId];
    if (player) {
      if (player.model) {
        this.scene.remove(player.model);
        if (player.model.userData.disposeOnRemove) {
          player.model.traverse((child) => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
          });
        }
      }
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
      if (!p.model) {
        if (p.label) p.label.style.display = 'none';
        continue;
      }

      const prevX = p.model.position.x;
      const prevY = p.model.position.y;
      const prevZ = p.model.position.z;

      // Smooth interpolation
      p.model.position.x += (p.targetX - p.model.position.x) * lerpFactor;
      p.model.position.y += (p.targetY - p.model.position.y) * lerpFactor;
      p.model.position.z += (p.targetZ - p.model.position.z) * lerpFactor;
      p.model.rotation.y = p.targetRY + Game.CHARACTER_ROTATION_OFFSET + 180;

      const horizontalSpeed = Math.hypot(
        p.model.position.x - prevX,
        p.model.position.z - prevZ
      ) / Math.max(dt, 0.0001);

      let animationState = 'idle';
      if (p.isSwimming && p.actions && p.actions.swim) {
        animationState = 'swim';
      } else if (p.isJumping && p.actions && p.actions.jump) {
        animationState = 'jump';
      } else if (p.isRunning && (p.actions && (p.actions.run || p.actions.walk))) {
        animationState = 'run';
      } else if (horizontalSpeed > 0.35) {
        animationState = (p.actions && p.actions.walk) ? 'walk' : 'run';
      }

      Game.playCharacterAnimation(p, animationState);
      if (p.mixer) {
        p.mixer.update(dt);
      }

      // Update name label screen position
      const pos = p.model.position.clone();
      pos.y += p.labelHeight || 3.7;
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

    this.updateSky(dt);
    this.updateMovement(dt);
    this.updateCamera();
    this.updateOtherPlayers(dt);

    // Update terrain around player
    this.terrain.update(this.position.x, this.position.z);

    // Update HUD
    document.getElementById('coords').textContent =
      `X: ${Math.floor(this.position.x)} Y: ${Math.floor(this.position.y)} Z: ${Math.floor(this.position.z)}`;
    
    // Update stamina bar
    const staminaBar = document.getElementById('stamina-bar');
    const staminaPct = (this.stamina / this.maxStamina) * 100;
    staminaBar.style.width = staminaPct + '%';
    // Turn bar red when exhausted
    staminaBar.style.background = this.isExhausted
      ? 'linear-gradient(90deg, #ff4444, #ff8800)'
      : 'linear-gradient(90deg, #00d2ff, #7b2ff7)';
    
    // Update crouch indicator — only toggle display when state actually changes
    const crouchInd = document.getElementById('crouch-indicator');
    crouchInd.style.display = this.isCrouching ? 'block' : 'none';

    if (this.phoneOpen || this.phoneDocked) {
      this.updatePhoneClock();
    }

    if ((this.phoneOpen || this.phoneDocked) && this.phoneActiveApp === 'maps') {
      this.renderPhoneMap();
    }

    // Send position to server
    const now = Date.now();
    if (this.socket && now - this.lastSendTime > this.sendRate) {
      this.socket.emit('playerMove', {
        x: this.position.x,
        y: this.position.y,
        z: this.position.z,
        rx: this.euler.x,
        ry: this.euler.y,
        isSwimming: this.isSwimming,
        isJumping: this.jumpAnimationTimer > 0 && !this.isSwimming,
        isRunning: this.isRunning,
      });
      this.lastSendTime = now;
    }

    this.renderFrame();
  }

  renderFrame() {
    const targetFogDensity = this.isUnderwater ? this.underwaterFogDensity : this.waterBaseFogDensity;
    this.scene.fog.density += (targetFogDensity - this.scene.fog.density) * 0.16;

    if (this.isUnderwater && this.sceneRenderTarget) {
      const depthFactor = Math.min(this.underwaterDepth / 2.5, 1);
      this.postUniforms.uTime.value = this.waterTime;
      this.postUniforms.uDistortion.value = 0.55 + depthFactor * 0.85;
      this.postUniforms.uDarkness.value = 0.18 + depthFactor * 0.3;

      this.renderer.setRenderTarget(this.sceneRenderTarget);
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.postScene, this.postCamera);
    } else {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
    }

    // Render lens flare overlay (additive, on top)
    if (this.lensFlareScene) {
      this.renderer.autoClear = false;
      this.renderer.render(this.lensFlareScene, this.lensFlareCamera);
      this.renderer.autoClear = true;
    }
  }

  updateMovement(dt) {
    const kb = this.settings.keybinds;
    this.jumpAnimationTimer = Math.max(0, this.jumpAnimationTimer - dt);
    const hasMoveInput = !!(this.keys[kb.forward] || this.keys[kb.backward] || this.keys[kb.left] || this.keys[kb.right]);

    // --- Swimming State ---
    const initialWaterSurfaceY = this.getWaterSurfaceHeight(this.position.x, this.position.z);
    const initialBottomY = this.position.y - this.playerHeight;
    const initialWaterDepth = initialWaterSurfaceY - initialBottomY;
    const inWater = initialWaterDepth > 0.05;
    const swimmingNow = initialWaterDepth > this.playerHeight * 0.5;

    // --- Stamina / Running ---
    const wantsRun = this.keys[kb.run] && hasMoveInput && !inWater && !swimmingNow;
    if (wantsRun && !this.isExhausted && this.stamina > 0) {
      this.isRunning = true;
      this.stamina -= this.staminaDrainRate * dt;
      if (this.stamina <= 0) {
        this.stamina = 0;
        this.isRunning = false;
        this.isExhausted = true;  // blocked until recovered
      }
    } else {
      this.isRunning = false;
      this.stamina += this.staminaRegenRate * dt;
      if (this.stamina > this.maxStamina) this.stamina = this.maxStamina;
      // Clear exhausted state once enough stamina is recovered
      if (this.isExhausted && this.stamina >= this.staminaRecoveryThreshold) {
        this.isExhausted = false;
      }
    }

    // --- Crouching ---
    // Depends only on key state — no onGround check to avoid feedback loop.
    // Crouch lowers the camera only; physics height stays constant.
    const wantsCrouch = this.keys[kb.crouch];
    this.isCrouching = wantsCrouch;
    const crouchTarget = wantsCrouch ? -1.4 : 0;  // how many units to drop camera
    this.crouchCameraOffset += (crouchTarget - this.crouchCameraOffset) * Math.min(1, dt * 12);

    // --- Movement direction ---
    const forward = new THREE.Vector3(0, 0, -1);
    forward.applyEuler(new THREE.Euler(0, this.euler.y, 0));
    const right = new THREE.Vector3(1, 0, 0);
    right.applyEuler(new THREE.Euler(0, this.euler.y, 0));

    const moveDir = new THREE.Vector3(0, 0, 0);
    if (this.keys[kb.forward])  moveDir.add(forward);
    if (this.keys[kb.backward]) moveDir.sub(forward);
    if (this.keys[kb.right])    moveDir.add(right);
    if (this.keys[kb.left])     moveDir.sub(right);

    if (moveDir.lengthSq() > 0) {
      moveDir.normalize();
      let speed = this.moveSpeed;
      if (this.isRunning) speed *= this.runSpeedMultiplier;
      if (this.isCrouching) speed *= this.crouchSpeedMultiplier;

      // Slow down in water
      if (inWater) speed *= (swimmingNow ? 0.4 : 0.6);

      const newX = this.position.x + moveDir.x * speed * dt;
      const newZ = this.position.z + moveDir.z * speed * dt;

      // Check slope angle at new position
      const normal = this.terrain.getSurfaceNormal(newX, newZ);
      // For 50 degree slope: cos(50°) ≈ 0.6428
      // Only allow movement if slope is not too steep
      const MAX_SLOPE_ANGLE = 50 * Math.PI / 180; // 50 degrees in radians
      const minNormalY = Math.cos(MAX_SLOPE_ANGLE); // ~0.6428
      
      // If moving upward, check if slope is walkable
      const currentGroundY = this.terrain.getHeight(this.position.x, this.position.z);
      const newGroundY = this.terrain.getHeight(newX, newZ);
      const isMovingUpward = newGroundY > currentGroundY;
      
      if (!isMovingUpward || normal.y >= minNormalY) {
        // Slope is walkable or moving downward
        this.position.x = newX;
        this.position.z = newZ;
      }
      // else: don't move (too steep)
    }

    // --- Gravity & Swimming ---
    if (swimmingNow) {
      // Buoyancy / slow vertical movement
      this.velocity.y -= 15 * dt; // much slower gravity

      // terminal sink velocity
      if (this.velocity.y < -4) this.velocity.y = -4;

      // swim up
      if (this.keys[kb.jump]) {
        this.velocity.y += 30 * dt;
        if (this.velocity.y > 6) this.velocity.y = 6;
      }

      // vertical drag
      this.velocity.y *= Math.pow(0.5, dt);

      this.position.y += this.velocity.y * dt;
    } else {
      // Normal gravity
      this.velocity.y += this.gravity * dt;
      this.position.y += this.velocity.y * dt;
    }

    // --- Ground collision (physics height is always playerHeight) ---
    const groundY = this.terrain.getHeight(this.position.x, this.position.z) + this.playerHeight;
    if (this.position.y <= groundY) {
      this.position.y = groundY;
      this.velocity.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    const waterSurfaceY = this.getWaterSurfaceHeight(this.position.x, this.position.z);
    const waterDepth = waterSurfaceY - (this.position.y - this.playerHeight);
    this.isSwimming = waterDepth > this.playerHeight * 0.5;
    this.isUnderwater = (this.position.y + this.crouchCameraOffset) < waterSurfaceY - 0.05;
    this.underwaterDepth = Math.max(0, waterSurfaceY - (this.position.y + this.crouchCameraOffset));
  }

  updateCamera() {
    this.camera.position.copy(this.position);
    this.camera.position.y += this.crouchCameraOffset;
    this.camera.quaternion.setFromEuler(this.euler);
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (this.sceneRenderTarget) {
      this.sceneRenderTarget.setSize(window.innerWidth, window.innerHeight);
      this.postUniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
    }
  }
}

window.Game = Game;
