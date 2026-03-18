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
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 10000);
    this.camera.position.set(0, 60, 0);

    // Fog for distance fade – actual density set by syncDistanceRendering()
    this.scene.fog = new THREE.FogExp2(0x87CEEB, 0.0004);

    // Day / night cycle - controlled by server
    this.dayTime = 0.27;   // 0 = midnight, 0.5 = noon (used as fallback)
    this.gameWorldStartTime = null; // Will be set by server
    this.defaultTimeCycleMs = 2 * 60 * 60 * 1000;
    this.timeCycleMs = this.defaultTimeCycleMs; // 2 real hours = 1 full day cycle
    this.lastServerTimeSample = null;
    this.debugMenuOpen = false;
    this.debugMenu = {
      root: null,
      sourceLabel: null,
      timeSlider: null,
      timeValue: null,
      speedSlider: null,
      speedValue: null,
      lodContainer: null,
      lodControls: [],
      closeBtn: null,
      resetBtn: null,
      timeScrubbing: false,
      speedScrubbing: false,
    };
    this.debugTimeOverride = {
      active: false,
      anchorDayTime: this.dayTime,
      anchorRealTime: Date.now(),
      speedMultiplier: 1,
    };

    // Sky, sun, moon, stars, lights
    this.setupSky();

    // Sun occlusion state
    this.sunOcclusionFactor = 1.0;
    this.sunOcclusionFrame = 0;
    this.sunOcclusionRaycaster = new THREE.Raycaster();

    // Terrain
    this.noise = new PerlinNoise(42);
    this.terrain = new TerrainManager(this.scene, this.noise);

    // Trees
    this.trees = new TreeManager(this.scene, this.terrain, this.noise, this.camera);

    // Water
    this.waterLevel = 0;
    this.terrain.setWaterLevel(this.waterLevel);
    this.waterTime = 0;
    this.waterBaseFogDensity = 0.0008; // overridden by syncDistanceRendering()
    this.underwaterFogDensity = 0.012;
    this.isUnderwater = false;
    this.underwaterDepth = 0;
    this.setupWater();
    this.setupUnderwaterPostFX();

    // Player state
    this.position = new THREE.Vector3(0, 60, 0);
    this.velocity = new THREE.Vector3(0, 0, 0);
    this.euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.moveSpeed = 4; //4 is default
    this.gravity = -50;
    this.jumpSpeed = 15;
    this.onGround = false;
    this.playerHeight = 3;

    // Movement states
    this.isRunning = false;
    this.isCrouching = false;
    this.isSwimming = false;
    this.isFlying = false;
    this.isExhausted = false;   // set when stamina hits 0, cleared at recovery threshold
    this.stamina = 10;
    this.maxStamina = 10;
    this.staminaDrainRate = 1.2;
    this.staminaRegenRate = 0.5;
    this.staminaRecoveryThreshold = 2.0; // must regen to this before running again
    this.runSpeedMultiplier = 2.0;
    this.flightSpeedMultiplier = 20.0;
    this.flightToggleWindowMs = 300;
    this.lastJumpTapTime = -Infinity;
    this.crouchCameraOffset = 0;       // current camera height offset (lerped)
    this.crouchSpeedMultiplier = 0.4;
    this.jumpAnimationTimer = 0;
    this.jumpAnimationDuration = 0.7;

    // Settings (loaded from localStorage)
    this.settings = Game.loadSettings();
    this.terrain.setViewDistance(this.settings.renderDistance);
    this.terrain.setGrassBladesEnabled(this.settings.renderGrassBlades);
    this.syncDistanceRendering(true);

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
      backgroundCenterX: this.position.x,
      backgroundCenterZ: this.position.z,
      backgroundCanvas: null,
      backgroundCtx: null,
      backgroundKey: '',
      terrainRasterCanvas: null,
      terrainRasterCtx: null,
      terrainRasterHeights: null,
      terrainRasterImageData: null,
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
    this.setupDebugMenu();

    // Multiplayer
    this.socket = null;
    this.otherPlayers = {};
    this.username = '';
    this.userId = null;
    this.sendRate = 50; // ms between position updates
    this.lastSendTime = 0;

    // FPS counter
    this.fps = 0;
    this.frameCount = 0;
    this.fpsUpdateTime = 0;

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
    this.currentSkyTopColor = new THREE.Color(0x020215);
    this.currentSkyHorizonColor = new THREE.Color(0x080830);
    this.currentOceanHorizonColor = new THREE.Color(0x225b8a);
    this.currentOceanDeepColor = new THREE.Color(0x08192a);
    this.currentOceanLineColor = new THREE.Color(0x7fc2e8);
    this.currentUnderwaterFogColor = new THREE.Color(0x0b2136);

    // ---- Sky dome with gradient shader ----
    const skyGeo = new THREE.SphereGeometry(900, 32, 15);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        topColor:   { value: this.currentSkyTopColor },
        horizColor: { value: this.currentSkyHorizonColor },
        oceanHorizonColor: { value: this.currentOceanHorizonColor },
        oceanDeepColor: { value: this.currentOceanDeepColor },
        oceanLineColor: { value: this.currentOceanLineColor },
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
        uniform vec3 oceanHorizonColor;
        uniform vec3 oceanDeepColor;
        uniform vec3 oceanLineColor;
        varying float vHeight;
        void main() {
          float skyT = pow(max(vHeight, 0.0), 0.45);
          vec3 skyColor = mix(horizColor, topColor, skyT);

          float oceanBlend = 1.0 - smoothstep(-0.18, 0.08, vHeight);
          float oceanT = smoothstep(-1.0, -0.02, vHeight);
          vec3 oceanColor = mix(oceanDeepColor, oceanHorizonColor, oceanT);
          vec3 finalColor = mix(skyColor, oceanColor, oceanBlend);

          float horizonBand = 1.0 - smoothstep(0.0, 0.065, abs(vHeight + 0.012));
          finalColor = mix(finalColor, oceanLineColor, horizonBand * 0.9);

          gl_FragColor = vec4(finalColor, 1.0);
        }
      `
    });
    this.skyMesh = new THREE.Mesh(skyGeo, skyMat);
    this.skyMesh.frustumCulled = false;
    this.skyMesh.renderOrder = -1000;
    this.scene.add(this.skyMesh);

    // ---- Sun (bright white core) ----
    const sunGeo = new THREE.SphereGeometry(18, 16, 16);
    const sunMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      fog: false,
      depthTest: false,
      depthWrite: false,
    });
    this.sunMesh = new THREE.Mesh(sunGeo, sunMat);
    this.sunMesh.frustumCulled = false;
    this.sunMesh.renderOrder = -998;
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
      depthTest: true,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    });
    this.sunInnerGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), innerGlowMat);
    this.sunInnerGlow.scale.set(90, 90, 1);
    this.sunInnerGlow.frustumCulled = false;
    this.sunInnerGlow.renderOrder = -997;
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
      depthTest: true,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    });
    this.sunOuterGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), outerGlowMat);
    this.sunOuterGlow.scale.set(200, 200, 1);
    this.sunOuterGlow.frustumCulled = false;
    this.sunOuterGlow.renderOrder = -997;
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
      depthTest: true,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    });
    this.sunScatterGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), scatterGlowMat);
    this.sunScatterGlow.scale.set(400, 400, 1);
    this.sunScatterGlow.frustumCulled = false;
    this.sunScatterGlow.renderOrder = -997;
    this.scene.add(this.sunScatterGlow);

    // Keep reference for old code compatibility
    this.sunGlowMesh = this.sunInnerGlow;

    // ---- Lens flare system ----
    this.setupLensFlare();

    // ---- Moon ----
    const moonGeo = new THREE.SphereGeometry(11, 16, 16);
    const moonMat = new THREE.MeshBasicMaterial({
      color: 0xddeeff,
      fog: false,
      depthTest: false,
      depthWrite: false,
    });
    this.moonMesh = new THREE.Mesh(moonGeo, moonMat);
    this.moonMesh.frustumCulled = false;
    this.moonMesh.renderOrder = -998;
    this.scene.add(this.moonMesh);

    // ---- Stars ----
    const STAR_COUNT = 3000;
    const STAR_RADIUS = 850;
    const starPos = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      const r = STAR_RADIUS;
      starPos[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      starPos[i * 3 + 2] = r * Math.cos(phi);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xffffff, size: 1.8,
      sizeAttenuation: false,
      depthTest: false,
      depthWrite: false,
      fog: false
    });
    this.starField = new THREE.Points(starGeo, starMat);
    this.starField.frustumCulled = false;
    this.starField.renderOrder = -999;
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

  updateSunOcclusion() {
    // Run every 4 frames to amortize raycasting cost
    this.sunOcclusionFrame = (this.sunOcclusionFrame + 1) % 4;
    if (this.sunOcclusionFrame !== 0) return;

    // Sun position (already updated this frame by updateSky)
    const sunPos = this.sunMesh.position;
    const camPos = this.camera.position;

    // If sun is below horizon, keep fully occluded
    if (!this.sunMesh.visible) {
      this.sunOcclusionFactor = 0;
      return;
    }

    const dir = new THREE.Vector3().subVectors(sunPos, camPos).normalize();
    const distToSun = camPos.distanceTo(sunPos);

    this.sunOcclusionRaycaster.set(camPos, dir);
    this.sunOcclusionRaycaster.near = 1;
    this.sunOcclusionRaycaster.far = distToSun;

    // Build occluder list: nearby terrain chunks + tree trunks
    const occluders = [];
    const { cx: pcx, cz: pcz } = this.terrain.worldToChunk(camPos.x, camPos.z);
    for (const [, chunk] of this.terrain.chunks) {
      if (
        Math.abs(chunk.cx - pcx) <= 4 &&
        Math.abs(chunk.cz - pcz) <= 4 &&
        chunk.terrainMesh &&
        chunk.terrainMesh.visible
      ) {
        occluders.push(chunk.terrainMesh);
      }
    }
    if (this.trees) {
      for (const [, treeChunk] of this.trees.treeChunks) {
        if (!treeChunk.meshGroup) continue;
        if (treeChunk.meshGroup.isGroup) {
          treeChunk.meshGroup.traverse((child) => {
            if (child.isInstancedMesh && child.userData.isTreeTrunk) {
              occluders.push(child);
            }
          });
        } else if (treeChunk.meshGroup.isInstancedMesh && treeChunk.meshGroup.userData.isTreeTrunk) {
          occluders.push(treeChunk.meshGroup);
        }
      }
    }

    const hits = this.sunOcclusionRaycaster.intersectObjects(occluders, false);
    const occluded = hits.length > 0;

    // Smooth transition (~0.15 lerp factor per check = ~4*0.15≈0.6 per second fade)
    const target = occluded ? 0.0 : 1.0;
    this.sunOcclusionFactor += (target - this.sunOcclusionFactor) * 0.25;
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
    this.dayTime = this.getCurrentDayTime();
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
    const smoothstep = (edge0, edge1, x) => {
      const span = Math.max(edge1 - edge0, 0.0001);
      const v = Math.max(0, Math.min(1, (x - edge0) / span));
      return v * v * (3 - 2 * v);
    };
    const peakDayWindow = smoothstep(8 / 24, 9 / 24, t) * (1 - smoothstep(15.5 / 24, 16 / 24, t));
    const peakTerrainDayFactor = peakDayWindow;

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

    const oceanHorizonC = lerp3(
      [0.018, 0.05, 0.10],
      [0.09, 0.27, 0.46],
      daylightFactor
    );
    const oceanHorizonTint = lerp3(oceanHorizonC, horC, 0.22 + daylightFactor * 0.18);
    const oceanDeepC = lerp3(
      [0.004, 0.012, 0.03],
      [0.02, 0.07, 0.16],
      daylightFactor
    );
    const oceanLineC = lerp3(
      oceanHorizonTint,
      lerp3(horC, [0.9, 0.96, 1.0], 0.35),
      0.38 + horizonSoftness * 0.18
    );
    const underwaterFogC = lerp3(oceanDeepC, oceanHorizonTint, 0.28);

    this.currentSkyTopColor.setRGB(...topC);
    this.currentSkyHorizonColor.setRGB(...horC);
    this.currentOceanHorizonColor.setRGB(...oceanHorizonTint);
    this.currentOceanDeepColor.setRGB(...oceanDeepC);
    this.currentOceanLineColor.setRGB(...oceanLineC);
    this.currentUnderwaterFogColor.setRGB(...underwaterFogC);
    this.syncDistanceFadeEnvironment();

    if (this.waterMesh) {
      this.waterTime += dt;
      this.waterUniforms.uTime.value = this.waterTime;
      this.waterUniforms.uDayFactor.value = daylightFactor;
      this.updateWaterPatch();
    }

    if (this.terrain && this.terrain.terrainUniforms && this.terrain.terrainUniforms.uDayFactor) {
      this.terrain.terrainUniforms.uDayFactor.value = daylightFactor;
      if (this.terrain.terrainUniforms.uPeakDayFactor) {
        this.terrain.terrainUniforms.uPeakDayFactor.value = peakTerrainDayFactor;
      }
    }

    // ---- Sun appearance (always bright white core) ----
    const sunVisible = sunY > -60;
    this.sunMesh.visible       = sunVisible;
    this.sunInnerGlow.visible  = sunVisible;
    this.sunOuterGlow.visible  = sunVisible;
    this.sunScatterGlow.visible = sunVisible;
    this.updateSunOcclusion();
    const occ = this.sunOcclusionFactor;
    this.sunFlareStrength = sunVisible ? aboveHorizonFade * (0.18 + 0.82 * horizonSoftness) * occ : 0;
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
      // Glow intensities – faded by occlusion
      this.sunInnerGlow.material.uniforms.uOpacity.value = 0.9 * glowStrength * occ;
      this.sunOuterGlow.material.uniforms.uOpacity.value = 0.45 * glowStrength * occ;
      this.sunScatterGlow.material.uniforms.uOpacity.value = 0.15 * glowStrength * occ;
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
    const starFade = Math.max(0, Math.min(1, -sunElev * 4));
    this.starField.visible = starFade > 0.001;
    this.starField.material.color.setScalar(starFade);
  }

  getRenderDistanceWorldSpan() {
    return (this.terrain.viewDistance * 2 + 3) * this.terrain.chunkWorldSize;
  }

  syncDistanceFadeEnvironment() {
    const visibleSpan = this.getRenderDistanceWorldSpan();
    const diagonalRadius = visibleSpan * Math.SQRT2 * 0.5;
    const fogColor = this.isUnderwater ? this.currentUnderwaterFogColor : this.currentSkyHorizonColor;
    const waterFadeStart = Math.max(260, diagonalRadius * 0.52);
    const waterFadeRange = Math.max(180, diagonalRadius * 0.36);
    const terrainFadeStart = Math.max(220, diagonalRadius * 0.46);
    const terrainFadeRange = Math.max(220, diagonalRadius * 0.42);
    const underwaterFactor = this.isUnderwater ? 1 : 0;

    this.renderer.setClearColor(fogColor);
    if (this.scene.fog) {
      this.scene.fog.color.copy(fogColor);
    }

    if (this.waterUniforms) {
      this.waterUniforms.uSkyColor.value.copy(this.currentSkyHorizonColor);
      this.waterUniforms.uHorizonColor.value.copy(this.currentOceanHorizonColor);
      this.waterUniforms.uDeepHorizonColor.value.copy(this.currentOceanDeepColor);
      this.waterUniforms.uFadeStart.value = waterFadeStart;
      this.waterUniforms.uFadeRange.value = waterFadeRange;
      this.waterUniforms.uCameraUnderwater.value = underwaterFactor;
    }

    if (this.terrain && this.terrain.terrainUniforms) {
      const terrainUniforms = this.terrain.terrainUniforms;
      if (terrainUniforms.uWaterLevel) terrainUniforms.uWaterLevel.value = this.waterLevel;
      if (terrainUniforms.uUnderwaterFadeStart) terrainUniforms.uUnderwaterFadeStart.value = terrainFadeStart;
      if (terrainUniforms.uUnderwaterFadeRange) terrainUniforms.uUnderwaterFadeRange.value = terrainFadeRange;
      if (terrainUniforms.uHorizonColor) terrainUniforms.uHorizonColor.value.copy(this.currentOceanHorizonColor);
      if (terrainUniforms.uHorizonDeepColor) terrainUniforms.uHorizonDeepColor.value.copy(this.currentOceanDeepColor);
      if (terrainUniforms.uCameraUnderwater) terrainUniforms.uCameraUnderwater.value = underwaterFactor;
    }
  }

  syncDistanceRendering(forceWaterRebuild = false) {
    const visibleSpan = this.getRenderDistanceWorldSpan();
    const diagonalRadius = visibleSpan * Math.SQRT2 * 0.5;
    const desiredFar = Math.max(4500, diagonalRadius + 2600);

    if (Math.abs(this.camera.far - desiredFar) > 1) {
      this.camera.far = desiredFar;
      this.camera.updateProjectionMatrix();
    }

    // Scale fog density inversely with render distance so fog only
    // fades terrain near the very edge, preventing the "transparent" look.
    // FogExp2 visibility at distance d: v = exp(-(density*d)^2)
    // With K ≈ 0.7 the fog is ~10% at edge, ~85% visibility at midrange.
    this.waterBaseFogDensity = 0.7 / Math.max(diagonalRadius, 500);

    this.rebuildWaterMeshes(forceWaterRebuild);
    this.syncDistanceFadeEnvironment();
  }

  setupWater() {
    this.waterLods = [];
    this.waterLodSignature = '';
    this.waterUniforms = {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(0x2564a8) },
      uDeepColor: { value: new THREE.Color(0x103765) },
      uSkyColor: { value: this.currentSkyHorizonColor.clone() },
      uHorizonColor: { value: this.currentOceanHorizonColor.clone() },
      uDeepHorizonColor: { value: this.currentOceanDeepColor.clone() },
      uFadeStart: { value: 540 },
      uFadeRange: { value: 420 },
      uCameraUnderwater: { value: 0 },
      uDayFactor: { value: 1 }
    };

    const waterMat = new THREE.ShaderMaterial({
      uniforms: this.waterUniforms,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.FrontSide,
      vertexShader: `
        uniform float uTime;
        attribute float waveAmp;
        attribute float waveMotion;
        attribute float innerFade;
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying float vWaveAmp;
        varying float vInnerFade;

        void main() {
          vInnerFade = innerFade;
          vec4 worldP = modelMatrix * vec4(position, 1.0);

          float waveA = sin(worldP.x * 0.055 + uTime * 1.35) * 0.5;
          float waveB = cos(worldP.z * 0.07 - uTime * 1.1) * 0.35;
          float waveC = sin((worldP.x + worldP.z) * 0.03 + uTime * 1.6) * 0.15;
          float wave = (waveA + waveB + waveC) * waveMotion;
          worldP.y += wave;

          float dx = (
            0.055 * 0.5 * cos(worldP.x * 0.055 + uTime * 1.35) +
            0.03 * 0.15 * cos((worldP.x + worldP.z) * 0.03 + uTime * 1.6)
          ) * waveMotion;
          float dz = (
            -0.07 * 0.35 * sin(worldP.z * 0.07 - uTime * 1.1) +
            0.03 * 0.15 * cos((worldP.x + worldP.z) * 0.03 + uTime * 1.6)
          ) * waveMotion;

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
        uniform vec3 uHorizonColor;
        uniform vec3 uDeepHorizonColor;
        uniform float uFadeStart;
        uniform float uFadeRange;
        uniform float uCameraUnderwater;
        uniform float uDayFactor;
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying float vWaveAmp;
        varying float vInnerFade;

        void main() {
          vec3 viewDir = normalize(cameraPosition - vWorldPos);
          float waterDistance = distance(vWorldPos.xz, cameraPosition.xz);
          float fresnel = pow(clamp(1.0 - max(dot(viewDir, vNormal), 0.0), 0.0, 1.0), 3.0);
          float depthTint = clamp((vWaveAmp - 0.03) / 0.29, 0.0, 1.0);
          vec3 waterBase = mix(uColor, uDeepColor, depthTint);
          waterBase *= mix(0.35, 1.0, uDayFactor);

          vec3 reflectedSky = mix(uSkyColor * 0.2, uSkyColor, uDayFactor);
          float reflectionStrength = mix(0.18, 0.72, uDayFactor);
          vec3 finalColor = mix(waterBase, reflectedSky, fresnel * reflectionStrength);
          float distanceFade = smoothstep(uFadeStart, uFadeStart + max(uFadeRange, 1.0), waterDistance);
          distanceFade = clamp(distanceFade * mix(0.94, 1.12, uCameraUnderwater), 0.0, 1.0);
          vec3 horizonWater = mix(uHorizonColor, uDeepHorizonColor, clamp(uCameraUnderwater * 0.82 + depthTint * 0.18, 0.0, 1.0));
          finalColor = mix(finalColor, horizonWater, distanceFade);
          float alpha = mix(mix(0.72, 0.82, uDayFactor), 0.0, distanceFade);
          alpha *= vInnerFade;
          if (alpha < 0.005) discard;

          gl_FragColor = vec4(finalColor, alpha);
        }
      `
    });

    this.waterMaterial = waterMat;
    this.rebuildWaterMeshes(true);
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

  getWaterLodConfigs() {
    const visibleSpan = this.getRenderDistanceWorldSpan();
    const roundUp = (value, step) => Math.ceil(value / step) * step;

    const nearSize = roundUp(Math.max(800, Math.min(visibleSpan * 0.16, 1408)), 32);
    const midSize = roundUp(Math.max(nearSize + 512, Math.min(visibleSpan * 0.42, 4096)), 64);
    const farSize = roundUp(Math.max(midSize + 1024, Math.min(visibleSpan * 0.82, 9216)), 128);
    const horizonSize = roundUp(
      Math.max(farSize + 2048, Math.min(visibleSpan * 1.1, this.camera.far * 1.2)),
      256
    );

    return [
      {
        key: 'near',
        size: nearSize,
        innerSize: 0,
        segments: 80,
        snap: 48,
        waveVisualScale: 1.0,
        waveMotionScale: 1.0,
        renderOrder: 30,
      },
      {
        key: 'mid',
        size: midSize,
        innerSize: nearSize,
        segments: 36,
        snap: 48,
        waveVisualScale: 0.68,
        waveMotionScale: 0.45,
        renderOrder: 29,
      },
      {
        key: 'far',
        size: farSize,
        innerSize: midSize,
        segments: 18,
        snap: 48,
        waveVisualScale: 0.42,
        waveMotionScale: 0.18,
        renderOrder: 28,
      },
      {
        key: 'horizon',
        size: horizonSize,
        innerSize: farSize,
        segments: 6,
        snap: 48,
        waveVisualScale: 0.28,
        waveMotionScale: 0.05,
        renderOrder: 27,
      },
    ];
  }

  createWaterRingGeometry(size, segments, innerSize = 0) {
    const geometry = new THREE.BufferGeometry();
    const vertexCount = (segments + 1) * (segments + 1);
    const positions = new Float32Array(vertexCount * 3);
    const waveAmp = new Float32Array(vertexCount);
    const waveMotion = new Float32Array(vertexCount);
    const innerFadeArr = new Float32Array(vertexCount);
    const indices = [];
    const halfSize = size * 0.5;
    const step = size / segments;
    const innerHalf = innerSize * 0.5;
    const fadeWidth = innerSize > 0 ? Math.max(step * 2.5, innerHalf * 0.18) : 0;

    let vertexIndex = 0;
    for (let iz = 0; iz <= segments; iz++) {
      const z = -halfSize + iz * step;
      for (let ix = 0; ix <= segments; ix++) {
        const x = -halfSize + ix * step;
        const base = vertexIndex * 3;
        positions[base] = x;
        positions[base + 1] = 0;
        positions[base + 2] = z;

        if (innerSize > 0 && fadeWidth > 0) {
          const distFromInner = Math.max(Math.abs(x), Math.abs(z)) - innerHalf;
          innerFadeArr[vertexIndex] = Math.max(0.0, Math.min(1.0, distFromInner / fadeWidth));
        } else {
          innerFadeArr[vertexIndex] = 1.0;
        }

        vertexIndex += 1;
      }
    }

    for (let iz = 0; iz < segments; iz++) {
      for (let ix = 0; ix < segments; ix++) {
        const cellCenterX = -halfSize + (ix + 0.5) * step;
        const cellCenterZ = -halfSize + (iz + 0.5) * step;
        const insideInnerHole = innerSize > 0
          && Math.abs(cellCenterX) < innerHalf
          && Math.abs(cellCenterZ) < innerHalf;

        if (insideInnerHole) continue;

        const a = iz * (segments + 1) + ix;
        const b = a + 1;
        const c = a + segments + 1;
        const d = c + 1;
        indices.push(a, c, b);
        indices.push(b, c, d);
      }
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('waveAmp', new THREE.BufferAttribute(waveAmp, 1));
    geometry.setAttribute('waveMotion', new THREE.BufferAttribute(waveMotion, 1));
    geometry.setAttribute('innerFade', new THREE.BufferAttribute(innerFadeArr, 1));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    return geometry;
  }

  disposeWaterMeshes() {
    if (!this.waterLods || this.waterLods.length === 0) return;

    for (const lod of this.waterLods) {
      if (!lod.mesh) continue;
      this.scene.remove(lod.mesh);
      if (lod.mesh.geometry) {
        lod.mesh.geometry.dispose();
      }
    }

    this.waterLods = [];
    this.waterMesh = null;
  }

  rebuildWaterMeshes(force = false) {
    const lodConfigs = this.getWaterLodConfigs();
    const signature = lodConfigs
      .map((config) => [
        config.key,
        config.size,
        config.innerSize,
        config.segments,
        config.snap,
        config.waveVisualScale,
        config.waveMotionScale,
      ].join(':'))
      .join('|');

    if (!force && signature === this.waterLodSignature) return;

    this.waterLodSignature = signature;
    this.disposeWaterMeshes();

    this.waterLods = lodConfigs.map((config) => {
      const geometry = this.createWaterRingGeometry(config.size, config.segments, config.innerSize);
      const mesh = new THREE.Mesh(geometry, this.waterMaterial);
      mesh.position.y = this.waterLevel;
      mesh.frustumCulled = false;
      mesh.renderOrder = config.renderOrder;
      this.scene.add(mesh);

      return {
        ...config,
        mesh,
        snappedX: null,
        snappedZ: null,
      };
    });

    this.waterMesh = this.waterLods[0] ? this.waterLods[0].mesh : null;
    this.updateWaterPatch(true);
  }

  updateWaterPatch(force = false) {
    if (!this.waterLods || this.waterLods.length === 0) return;

    const centerX = this.position ? this.position.x : 0;
    const centerZ = this.position ? this.position.z : 0;

    for (let lodIndex = 0; lodIndex < this.waterLods.length; lodIndex++) {
      const lod = this.waterLods[lodIndex];
      const snappedX = Math.floor(centerX / lod.snap) * lod.snap;
      const snappedZ = Math.floor(centerZ / lod.snap) * lod.snap;

      if (!force && snappedX === lod.snappedX && snappedZ === lod.snappedZ) {
        continue;
      }

      lod.snappedX = snappedX;
      lod.snappedZ = snappedZ;
      lod.mesh.position.set(snappedX, this.waterLevel, snappedZ);

      const geometry = lod.mesh.geometry;
      const positions = geometry.attributes.position.array;
      const waveAmp = geometry.attributes.waveAmp;
      const waveMotion = geometry.attributes.waveMotion;
      const ampArray = waveAmp.array;
      const motionArray = waveMotion.array;
      const previousLod = lodIndex > 0 ? this.waterLods[lodIndex - 1] : null;
      const previousVisualScale = previousLod ? previousLod.waveVisualScale : lod.waveVisualScale;
      const previousMotionScale = previousLod ? previousLod.waveMotionScale : lod.waveMotionScale;
      const ringThickness = Math.max((lod.size - lod.innerSize) * 0.5, lod.size * 0.05, 1);
      const blendDistance = lod.innerSize > 0
        ? Math.min(ringThickness, Math.max(lod.size / Math.max(lod.segments, 1) * 2.5, ringThickness * 0.2))
        : 0;

      for (let i = 0, j = 0; i < ampArray.length; i++, j += 3) {
        const localX = positions[j];
        const localZ = positions[j + 2];
        const worldX = snappedX + localX;
        const worldZ = snappedZ + localZ;
        const baseAmp = this.getWaterWaveAmplitude(worldX, worldZ);
        let visualScale = lod.waveVisualScale;
        let motionScale = lod.waveMotionScale;

        if (lod.innerSize > 0 && blendDistance > 0) {
          const distFromInnerEdge = Math.max(0, Math.max(Math.abs(localX), Math.abs(localZ)) - lod.innerSize * 0.5);
          const blend = Math.max(0, Math.min(1, distFromInnerEdge / blendDistance));
          visualScale = previousVisualScale + (lod.waveVisualScale - previousVisualScale) * blend;
          motionScale = previousMotionScale + (lod.waveMotionScale - previousMotionScale) * blend;
        }

        ampArray[i] = baseAmp * visualScale;
        motionArray[i] = baseAmp * motionScale;
      }

      waveAmp.needsUpdate = true;
      waveMotion.needsUpdate = true;
    }
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

  async emitStartupProgress(onProgress, message, progress) {
    if (typeof onProgress !== 'function') return;
    const result = onProgress(message, progress);
    if (result && typeof result.then === 'function') {
      await result;
    }
  }

  async start(username, token, userId, onProgress = null) {
    this.username = username;
    this.userId = userId ?? null;
    Game.preloadCharacterAsset().catch(() => {});

    await this.emitStartupProgress(onProgress, 'Attaching controls…', 56);

    // Setup input
    this.setupInput();

    await this.emitStartupProgress(onProgress, 'Connecting to server…', 68);

    // Connect to multiplayer
    const spawnPromise = this.connectMultiplayer(token);

    await this.emitStartupProgress(onProgress, 'Receiving spawn position…', 76);
    const spawnData = await spawnPromise;

    await this.emitStartupProgress(onProgress, 'Positioning player…', 84);
    this.applySpawnPosition(spawnData, { warmTerrain: false });

    await this.emitStartupProgress(onProgress, 'Generating nearby terrain…', 92);

    // Initial terrain around the actual spawn position
    this.terrain.update(this.position.x, this.position.z, this.camera, { forceLoad: true });

    if (!Number.isFinite(spawnData?.y)) {
      const groundY = this.terrain.getHeight(this.position.x, this.position.z);
      this.position.y = groundY + this.playerHeight;
      this.updateCamera();
    }

    // Start game loop
    this.running = true;
    this.clock.start();
    this.clock.getDelta();
    this.animate();

    await this.emitStartupProgress(onProgress, 'Synchronizing world…', 98);
  }

  stop() {
    this.running = false;
    this.isFlying = false;
    this.setDebugMenuOpen(false);
    this.setPhoneOpen(false, { skipPointerLock: true, immediate: true });
    if (this.trees) {
      this.trees.dispose();
    }
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

  setFlying(enabled) {
    const nextState = !!enabled;
    if (this.isFlying === nextState) return;

    this.isFlying = nextState;
    this.isRunning = false;
    this.isCrouching = false;
    this.velocity.y = 0;

    if (nextState) {
      this.isSwimming = false;
      this.jumpAnimationTimer = 0;
    }
  }

  normalizeDayTime(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return 0;
    const wrapped = numericValue % 1;
    return wrapped < 0 ? wrapped + 1 : wrapped;
  }

  normalizeDebugCycleSpeed(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return 1;
    return Math.max(0, Math.min(20, numericValue));
  }

  getCurrentDebugCycleSpeed() {
    return this.debugTimeOverride.active
      ? this.debugTimeOverride.speedMultiplier
      : 1;
  }

  getCurrentDayTime(now = Date.now()) {
    if (this.debugTimeOverride.active) {
      const speedMultiplier = this.normalizeDebugCycleSpeed(this.debugTimeOverride.speedMultiplier);
      if (speedMultiplier <= 0) {
        return this.normalizeDayTime(this.debugTimeOverride.anchorDayTime);
      }

      const elapsedMs = now - this.debugTimeOverride.anchorRealTime;
      const delta = (elapsedMs / this.timeCycleMs) * speedMultiplier;
      return this.normalizeDayTime(this.debugTimeOverride.anchorDayTime + delta);
    }

    if (this.gameWorldStartTime !== null) {
      const elapsedMs = now - this.gameWorldStartTime;
      return this.normalizeDayTime(elapsedMs / this.timeCycleMs);
    }

    return this.normalizeDayTime(this.dayTime);
  }

  formatDayTimeLabel(dayTime) {
    const normalized = this.normalizeDayTime(dayTime);
    const totalMinutes = Math.floor(normalized * 24 * 60) % 1440;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  formatDayCycleSpeedLabel(speedMultiplier) {
    const speed = this.normalizeDebugCycleSpeed(speedMultiplier);
    if (speed <= 0) return 'Paused';

    const cycleMinutes = this.defaultTimeCycleMs / 60000 / speed;
    const speedText = speed < 10 ? speed.toFixed(1) : speed.toFixed(0);
    const cycleText = cycleMinutes >= 10 ? cycleMinutes.toFixed(1) : cycleMinutes.toFixed(2);
    return `${speedText}× · ${cycleText} min/day`;
  }

  syncDebugMenuUI(forceSliderSync = false) {
    const ui = this.debugMenu;
    if (!ui || !ui.root) return;

    const dayTime = this.getCurrentDayTime();
    const speedMultiplier = this.getCurrentDebugCycleSpeed();

    if (ui.sourceLabel) {
      ui.sourceLabel.textContent = this.debugTimeOverride.active
        ? 'Local override active'
        : 'Following server time';
    }

    if (ui.timeValue) {
      ui.timeValue.textContent = this.formatDayTimeLabel(dayTime);
    }

    if (ui.timeSlider && (forceSliderSync || !ui.timeScrubbing)) {
      ui.timeSlider.value = String(Math.floor(dayTime * 1440) % 1440);
    }

    if (ui.speedValue) {
      ui.speedValue.textContent = this.formatDayCycleSpeedLabel(speedMultiplier);
    }

    if (ui.speedSlider && (forceSliderSync || !ui.speedScrubbing)) {
      ui.speedSlider.value = speedMultiplier.toFixed(1);
    }
  }

  refreshDebugLodControls() {
    const ui = this.debugMenu;
    if (!ui || !ui.lodContainer) return;

    const lodSettings = this.terrain.getTerrainLodSettings();
    if (!Array.isArray(ui.lodControls) || ui.lodControls.length !== lodSettings.length) {
      this.buildDebugLodControls();
      return;
    }

    lodSettings.forEach((setting, index) => {
      const control = ui.lodControls[index];
      if (!control) return;

      if (control.distanceInput && Number.isFinite(setting.maxDistance)) {
        control.distanceInput.value = String(setting.maxDistance);
      }

      if (control.trianglesInput) {
        control.trianglesInput.value = String(setting.trianglesTarget);
      }

      if (control.note) {
        const rangeText = Number.isFinite(setting.maxDistance)
          ? `Active until ${setting.maxDistance} m.`
          : 'Fallback level beyond the previous distance.';
        control.note.textContent = `${rangeText} Rendered: ${setting.renderedTriangles.toLocaleString()} tris (${setting.actualTriangles.toLocaleString()} terrain + ${setting.skirtTriangles.toLocaleString()} skirts) · ${setting.gridSize}×${setting.gridSize} vertices.`;
      }
    });
  }

  applyDebugTerrainLodSetting(levelIndex, field, value) {
    const currentSettings = this.terrain.getTerrainLodSettings().map((setting) => ({
      distance: setting.maxDistance,
      triangles: setting.trianglesTarget,
    }));

    if (!currentSettings[levelIndex]) return;

    if (field === 'distance' && levelIndex < currentSettings.length - 1) {
      currentSettings[levelIndex].distance = value;
    }

    if (field === 'triangles') {
      currentSettings[levelIndex].triangles = value;
    }

    const changed = this.terrain.setTerrainLodSettings(currentSettings);
    this.refreshDebugLodControls();

    if (changed && this.running) {
      this.terrain.update(this.position.x, this.position.z, this.camera);
    }
  }

  buildDebugLodControls() {
    const ui = this.debugMenu;
    if (!ui || !ui.lodContainer) return;

    const lodSettings = this.terrain.getTerrainLodSettings();
    ui.lodContainer.innerHTML = '';
    ui.lodControls = [];

    lodSettings.forEach((setting, index) => {
      const card = document.createElement('div');
      card.className = 'debug-lod-card';

      const title = document.createElement('div');
      title.className = 'debug-lod-title';
      title.textContent = `LOD ${index}`;
      card.appendChild(title);

      let distanceInput = null;
      if (index < lodSettings.length - 1) {
        const distanceRow = document.createElement('div');
        distanceRow.className = 'debug-input-row';

        const distanceLabel = document.createElement('label');
        distanceLabel.textContent = 'Max Distance';
        distanceRow.appendChild(distanceLabel);

        distanceInput = document.createElement('input');
        distanceInput.type = 'number';
        distanceInput.className = 'debug-number-input';
        distanceInput.min = String(Math.round(this.terrain.chunkWorldSize * 0.5));
        distanceInput.max = String(this.terrain.maxViewDistance * this.terrain.chunkWorldSize * 4);
        distanceInput.step = '16';
        distanceInput.value = String(setting.maxDistance);
        distanceInput.addEventListener('change', () => {
          this.applyDebugTerrainLodSetting(index, 'distance', distanceInput.value);
        });
        distanceRow.appendChild(distanceInput);
        card.appendChild(distanceRow);
      } else {
        const staticRow = document.createElement('div');
        staticRow.className = 'debug-input-row';

        const staticLabel = document.createElement('div');
        staticLabel.className = 'debug-static-label';
        staticLabel.textContent = 'Distance';
        staticRow.appendChild(staticLabel);

        const staticValue = document.createElement('div');
        staticValue.className = 'debug-static-value';
        staticValue.textContent = 'Beyond previous';
        staticRow.appendChild(staticValue);
        card.appendChild(staticRow);
      }

      const trianglesRow = document.createElement('div');
      trianglesRow.className = 'debug-input-row';

      const trianglesLabel = document.createElement('label');
      trianglesLabel.textContent = 'Triangle Target';
      trianglesRow.appendChild(trianglesLabel);

      const trianglesInput = document.createElement('input');
      trianglesInput.type = 'number';
      trianglesInput.className = 'debug-number-input';
      trianglesInput.min = '32';
      trianglesInput.max = String(this.terrain.maxChunkTriangles);
      trianglesInput.step = '32';
      trianglesInput.value = String(setting.trianglesTarget);
      trianglesInput.addEventListener('change', () => {
        this.applyDebugTerrainLodSetting(index, 'triangles', trianglesInput.value);
      });
      trianglesRow.appendChild(trianglesInput);
      card.appendChild(trianglesRow);

      const note = document.createElement('div');
      note.className = 'debug-lod-note';
      card.appendChild(note);

      ui.lodContainer.appendChild(card);
      ui.lodControls.push({ card, distanceInput, trianglesInput, note });
    });

    this.refreshDebugLodControls();
  }

  applyDebugTimeOfDay(dayTime) {
    const nextDayTime = this.normalizeDayTime(dayTime);
    const speedMultiplier = this.getCurrentDebugCycleSpeed();

    this.debugTimeOverride.active = true;
    this.debugTimeOverride.anchorDayTime = nextDayTime;
    this.debugTimeOverride.anchorRealTime = Date.now();
    this.debugTimeOverride.speedMultiplier = speedMultiplier;
    this.dayTime = nextDayTime;

    this.syncDebugMenuUI(true);
  }

  applyDebugCycleSpeed(speedMultiplier) {
    const nextSpeed = this.normalizeDebugCycleSpeed(speedMultiplier);
    const currentDayTime = this.getCurrentDayTime();

    this.debugTimeOverride.active = true;
    this.debugTimeOverride.anchorDayTime = currentDayTime;
    this.debugTimeOverride.anchorRealTime = Date.now();
    this.debugTimeOverride.speedMultiplier = nextSpeed;
    this.dayTime = currentDayTime;

    this.syncDebugMenuUI(true);
  }

  resetDebugTimeOverride() {
    if (Number.isFinite(this.lastServerTimeSample)) {
      this.gameWorldStartTime = Date.now() - this.lastServerTimeSample * this.timeCycleMs;
    }

    this.debugTimeOverride.active = false;
    this.debugTimeOverride.anchorDayTime = this.getCurrentDayTime();
    this.debugTimeOverride.anchorRealTime = Date.now();
    this.debugTimeOverride.speedMultiplier = 1;
    this.dayTime = this.getCurrentDayTime();

    this.syncDebugMenuUI(true);
  }

  setDebugMenuOpen(open) {
    const ui = this.debugMenu;
    if (!ui || !ui.root) return;

    const nextState = !!open;
    if (this.debugMenuOpen === nextState) return;

    this.debugMenuOpen = nextState;
    ui.root.classList.toggle('open', nextState);
    ui.root.setAttribute('aria-hidden', nextState ? 'false' : 'true');

    const prompt = document.getElementById('lock-prompt');

    if (nextState) {
      if (this.phoneOpen || this.phoneDocked) {
        this.setPhoneOpen(false, { skipPointerLock: true, immediate: true });
      }

      this.keys = {};
      this.lastJumpTapTime = -Infinity;
      this.isRunning = false;
      this.isCrouching = false;
      this.refreshDebugLodControls();
      this.syncDebugMenuUI(true);

      if (prompt) {
        prompt.style.display = 'none';
      }

      if (document.pointerLockElement === this.canvas) {
        document.exitPointerLock();
      }

      return;
    }

    if (prompt && !this.paused) {
      prompt.style.display = 'block';
    }

    if (!this.paused && this.running) {
      this.canvas.requestPointerLock();
    }
  }

  setupDebugMenu() {
    const root = document.getElementById('debug-menu');
    if (!root) return;

    this.debugMenu = {
      root,
      sourceLabel: document.getElementById('debug-time-source'),
      timeSlider: document.getElementById('debug-time-slider'),
      timeValue: document.getElementById('debug-time-value'),
      speedSlider: document.getElementById('debug-speed-slider'),
      speedValue: document.getElementById('debug-speed-value'),
      lodContainer: document.getElementById('debug-lod-controls'),
      lodControls: [],
      closeBtn: document.getElementById('debug-menu-close'),
      resetBtn: document.getElementById('debug-time-reset'),
      timeScrubbing: false,
      speedScrubbing: false,
    };

    const ui = this.debugMenu;

    if (ui.closeBtn) {
      ui.closeBtn.onclick = () => this.setDebugMenuOpen(false);
    }

    if (ui.resetBtn) {
      ui.resetBtn.onclick = () => this.resetDebugTimeOverride();
    }

    if (ui.timeSlider) {
      const stopTimeScrub = () => {
        ui.timeScrubbing = false;
        this.syncDebugMenuUI();
      };

      ui.timeSlider.onpointerdown = () => {
        ui.timeScrubbing = true;
      };
      ui.timeSlider.onpointerup = stopTimeScrub;
      ui.timeSlider.onpointercancel = stopTimeScrub;
      ui.timeSlider.onblur = stopTimeScrub;
      ui.timeSlider.onchange = stopTimeScrub;
      ui.timeSlider.oninput = () => {
        const minutes = Number(ui.timeSlider.value) || 0;
        this.applyDebugTimeOfDay(minutes / 1440);
      };
    }

    if (ui.speedSlider) {
      const stopSpeedScrub = () => {
        ui.speedScrubbing = false;
        this.syncDebugMenuUI();
      };

      ui.speedSlider.onpointerdown = () => {
        ui.speedScrubbing = true;
      };
      ui.speedSlider.onpointerup = stopSpeedScrub;
      ui.speedSlider.onpointercancel = stopSpeedScrub;
      ui.speedSlider.onblur = stopSpeedScrub;
      ui.speedSlider.onchange = stopSpeedScrub;
      ui.speedSlider.oninput = () => {
        this.applyDebugCycleSpeed(ui.speedSlider.value);
      };
    }

    this.buildDebugLodControls();
    this.syncDebugMenuUI(true);
  }

  setupInput() {
    this._onKeyDown = (e) => {
      const kb = this.settings.keybinds;
      const phoneKey = kb.phone;

      if (e.code === 'Enter' && !e.repeat) {
        e.preventDefault();
        if (!this.paused || this.debugMenuOpen) {
          this.setDebugMenuOpen(!this.debugMenuOpen);
        }
        return;
      }

      if (this.debugMenuOpen) {
        if (e.code === 'Escape') {
          e.preventDefault();
          this.setDebugMenuOpen(false);
        }
        return;
      }

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
      if (e.code === kb.jump && !e.repeat) {
        const now = performance.now();
        const tappedTwiceQuickly = now - this.lastJumpTapTime <= this.flightToggleWindowMs;
        this.lastJumpTapTime = now;

        if (!this.isFlying && tappedTwiceQuickly && !this.isSwimming) {
          this.setFlying(true);
          return;
        }

        if (!this.isFlying && this.onGround && !this.isSwimming) {
          this.velocity.y = this.jumpSpeed;
          this.onGround = false;
          this.jumpAnimationTimer = this.jumpAnimationDuration;
        }
      }
    };
    this._onKeyUp = (e) => {
      this.keys[e.code] = false;
      const kb = this.settings.keybinds;
      if (e.code === kb.run)    this.isRunning   = false;
      if (e.code === kb.crouch) this.isCrouching = false;
    };
    this._onMouseMove = (e) => {
      if (!this.mouseLocked || this.paused || this.debugMenuOpen) return;
      this.euler.y -= e.movementX * this.mouseSensitivity;
      this.euler.x -= e.movementY * this.mouseSensitivity;
      this.euler.x = Math.max(-Math.PI / 2.1, Math.min(Math.PI / 2.1, this.euler.x));
    };

    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('mousemove', this._onMouseMove);

    // Click canvas to (re)acquire pointer lock when not paused
    this._onCanvasClick = () => {
      if (!this.paused && !this.phoneOpen && !this.debugMenuOpen) this.canvas.requestPointerLock();
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
        if (this.debugMenuOpen) {
          prompt.style.display = 'none';
          return;
        }
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
    if (this.debugMenuOpen) {
      this.setDebugMenuOpen(false);
    }

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
      this.lastJumpTapTime = -Infinity;
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
    const normalizedSettings = Game.normalizeSettings(settings);
    this.settings = normalizedSettings;
    this.mouseSensitivity = normalizedSettings.sensitivity;
    this.terrain.setViewDistance(normalizedSettings.renderDistance);
    this.terrain.setGrassBladesEnabled(normalizedSettings.renderGrassBlades);
    this.syncDistanceRendering(true);
    this.terrain.update(this.position.x, this.position.z, this.camera);
    Game.saveSettings(normalizedSettings);
    this.updatePhoneKeyHint();
  }

  static get MIN_RENDER_DISTANCE() {
    return 2;
  }

  static get MAX_RENDER_DISTANCE() {
    return 50;
  }

  static defaultSettings() {
    return {
      sensitivity: 0.001,
      renderDistance: 3,
      renderGrassBlades: true,
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

  static normalizeRenderDistance(value) {
    const fallback = Game.defaultSettings().renderDistance;
    const parsedValue = Math.round(Number(value));
    if (!Number.isFinite(parsedValue)) return fallback;

    return Math.max(
      Game.MIN_RENDER_DISTANCE,
      Math.min(Game.MAX_RENDER_DISTANCE, parsedValue)
    );
  }

  static normalizeSettings(settings = {}) {
    const def = Game.defaultSettings();
    const sourceSettings = settings && typeof settings === 'object' ? settings : {};
    const sensitivity = Number(sourceSettings.sensitivity);

    return {
      sensitivity: Number.isFinite(sensitivity) ? sensitivity : def.sensitivity,
      renderDistance: Game.normalizeRenderDistance(sourceSettings.renderDistance),
      renderGrassBlades: typeof sourceSettings.renderGrassBlades === 'boolean'
        ? sourceSettings.renderGrassBlades
        : def.renderGrassBlades,
      keybinds: Object.assign(
        {},
        def.keybinds,
        sourceSettings.keybinds && typeof sourceSettings.keybinds === 'object' ? sourceSettings.keybinds : {}
      ),
    };
  }

  static loadSettings() {
    try {
      const raw = localStorage.getItem('usim_settings');
      if (raw) {
        return Game.normalizeSettings(JSON.parse(raw));
      }
    } catch (e) {}
    return Game.defaultSettings();
  }

  static saveSettings(settings) {
    localStorage.setItem('usim_settings', JSON.stringify(Game.normalizeSettings(settings)));
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
      map.backgroundKey = '';
    }

    return true;
  }

  getPhoneMapBackgroundCanvas(width, height) {
    const map = this.phoneMap;
    if (!map.backgroundCanvas) {
      map.backgroundCanvas = document.createElement('canvas');
      map.backgroundCtx = map.backgroundCanvas.getContext('2d', { alpha: false });
    }

    if (map.backgroundCanvas.width !== width || map.backgroundCanvas.height !== height) {
      map.backgroundCanvas.width = width;
      map.backgroundCanvas.height = height;
    }

    return {
      canvas: map.backgroundCanvas,
      ctx: map.backgroundCtx,
    };
  }

  getPhoneMapBackgroundState(width, height, centerX, centerZ, halfSpan) {
    const raster = this.getPhoneMapTerrainRaster(width, height, halfSpan);
    const span = halfSpan * 2;
    const stepX = span / Math.max(1, raster.width - 1);
    const stepZ = span / Math.max(1, raster.height - 1);
    const snappedGridX = stepX > 0 ? Math.round(centerX / stepX) : 0;
    const snappedGridZ = stepZ > 0 ? Math.round(centerZ / stepZ) : 0;

    return {
      centerX: snappedGridX * stepX,
      centerZ: snappedGridZ * stepZ,
      key: `${width}x${height}:${this.phoneMap.zoomIndex}:${snappedGridX}:${snappedGridZ}`,
    };
  }

  drawPhoneMapBackground(ctx, width, height, centerX, centerZ, halfSpan) {
    ctx.clearRect(0, 0, width, height);

    const bg = ctx.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, '#edf4e8');
    bg.addColorStop(1, '#d8e5d1');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    this.drawPhoneMapTerrainLayer(ctx, width, height, centerX, centerZ, halfSpan);
    this.drawPhoneMapTreeLayer(ctx, width, height, centerX, centerZ, halfSpan);
    this.drawPhoneMapRoads(ctx, width, height, centerX, centerZ, halfSpan);
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
      map.centerX = this.position.x;
      map.centerZ = this.position.z;
    }

    const ctx = map.ctx;
    const width = map.canvas.width;
    const height = map.canvas.height;
    const halfSpan = zoom.halfSpan;
    const backgroundState = this.getPhoneMapBackgroundState(width, height, map.centerX, map.centerZ, halfSpan);
    const needsBackgroundRender = force || map.dirty || map.backgroundKey !== backgroundState.key;
    const worldPerPixel = (halfSpan * 2) / Math.max(1, width);
    const trackerMotionThreshold = Math.max(0.15, worldPerPixel * 0.35);

    if (!force && !needsBackgroundRender && now - map.lastRenderTime < 33 && playerMoved < trackerMotionThreshold && !headingChanged) {
      return;
    }

    const background = this.getPhoneMapBackgroundCanvas(width, height);
    if (needsBackgroundRender && background.ctx) {
      this.drawPhoneMapBackground(background.ctx, width, height, backgroundState.centerX, backgroundState.centerZ, halfSpan);
      map.backgroundKey = backgroundState.key;
      map.backgroundCenterX = backgroundState.centerX;
      map.backgroundCenterZ = backgroundState.centerZ;
      map.dirty = false;
    }

    ctx.clearRect(0, 0, width, height);
    if (background.canvas) {
      ctx.drawImage(background.canvas, 0, 0, width, height);
    }
    this.drawPhoneMapTracker(ctx, width, height, map.backgroundCenterX, map.backgroundCenterZ, halfSpan);

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
  }

  drawPhoneMapTerrainLayer(ctx, width, height, centerX, centerZ, halfSpan) {
    const raster = this.getPhoneMapTerrainRaster(width, height, halfSpan);
    const imageData = raster.imageData;
    const pixels = imageData.data;
    const heights = raster.heights;
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
      const upY = Math.max(0, y - 1);
      const downY = Math.min(raster.height - 1, y + 1);

      for (let x = 0; x < raster.width; x++) {
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
        const normalY = 1 / Math.max(1e-4, Math.hypot(dx, 1.15, dz));
        const light = Math.max(0, (dx * lightX + 1.15 * lightY + dz * lightZ) * normalY);
        const shade = heightValue <= waterLevel ? 0.9 + light * 0.18 : 0.76 + light * 0.38;
        const offset = index * 4;
        this.writePhoneMapNoiseColor(pixels, offset, heightValue, 1 - normalY, shade);
      }
    }

    raster.ctx.putImageData(imageData, 0, 0);

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(raster.canvas, 0, 0, width, height);
    ctx.restore();
  }

  drawPhoneMapTreeLayer(ctx, width, height, centerX, centerZ, halfSpan) {
    if (!this.trees || !this.noise) return;

    const map = this.phoneMap;
    if (!map.treeRasterCanvas) {
      map.treeRasterCanvas = document.createElement('canvas');
      map.treeRasterCtx = map.treeRasterCanvas.getContext('2d');
    }

    // Match terrain raster resolution
    const detailScale = halfSpan <= 1440 ? 0.42 : halfSpan <= 11520 ? 0.32 : halfSpan <= 92160 ? 0.24 : 0.18;
    const minSample = halfSpan <= 1440 ? 96 : halfSpan <= 11520 ? 72 : 56;
    const maxSample = halfSpan <= 1440 ? 160 : halfSpan <= 11520 ? 128 : 96;
    const sw = Math.max(minSample, Math.min(maxSample, Math.round(width * detailScale)));
    const sh = Math.max(minSample, Math.min(maxSample, Math.round(height * detailScale)));

    if (map.treeRasterCanvas.width !== sw || map.treeRasterCanvas.height !== sh) {
      map.treeRasterCanvas.width = sw;
      map.treeRasterCanvas.height = sh;
    }

    const rCtx = map.treeRasterCtx;
    const imageData = rCtx.createImageData(sw, sh);
    const pixels = imageData.data;

    const noise = this.noise;
    const noiseScale = this.trees.treeNoiseScale;
    const noiseOffX = this.trees.treeNoiseOffsetX;
    const noiseOffZ = this.trees.treeNoiseOffsetZ;
    const threshold = this.trees.treeNoiseThreshold;
    const span = halfSpan * 2;
    const minX = centerX - halfSpan;
    const minZ = centerZ - halfSpan;
    const stepX = span / Math.max(1, sw - 1);
    const stepZ = span / Math.max(1, sh - 1);

    for (let y = 0; y < sh; y++) {
      const worldZ = minZ + y * stepZ;
      for (let x = 0; x < sw; x++) {
        const worldX = minX + x * stepX;

        // Skip water
        const h = this.terrain.getBaseHeight(worldX, worldZ);
        if (h <= this.waterLevel) continue;

        // Skip steep slopes (approximate: use neighbour heights)
        const hL = this.terrain.getBaseHeight(worldX - stepX, worldZ);
        const hR = this.terrain.getBaseHeight(worldX + stepX, worldZ);
        const hU = this.terrain.getBaseHeight(worldX, worldZ - stepZ);
        const hD = this.terrain.getBaseHeight(worldX, worldZ + stepZ);
        const dxH = (hR - hL) / (2 * stepX);
        const dzH = (hD - hU) / (2 * stepZ);
        const normalY = 1 / Math.sqrt(dxH * dxH + 1 + dzH * dzH);
        if (normalY < 0.82) continue;

        // Sample tree noise
        const n = noise.perlin2(
          (worldX + noiseOffX) * noiseScale,
          (worldZ + noiseOffZ) * noiseScale
        ) * 0.5 + 0.5;
        if (n < threshold) continue;

        // Map density to alpha (denser = more opaque)
        const density = (n - threshold) / (1 - threshold);
        const alpha = Math.round(density * 150);

        const offset = (y * sw + x) * 4;
        pixels[offset]     = 28;
        pixels[offset + 1] = 95;
        pixels[offset + 2] = 36;
        pixels[offset + 3] = alpha;
      }
    }

    rCtx.putImageData(imageData, 0, 0);

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(map.treeRasterCanvas, 0, 0, width, height);
    ctx.restore();
  }

  getPhoneMapTerrainRaster(width, height, halfSpan) {
    const map = this.phoneMap;
    if (!map.terrainRasterCanvas) {
      map.terrainRasterCanvas = document.createElement('canvas');
      map.terrainRasterCtx = map.terrainRasterCanvas.getContext('2d', { alpha: false });
    }

    const detailScale = halfSpan <= 1440
      ? 0.42
      : halfSpan <= 11520
        ? 0.32
        : halfSpan <= 92160
          ? 0.24
          : 0.18;
    const minSample = halfSpan <= 1440 ? 96 : halfSpan <= 11520 ? 72 : 56;
    const maxSample = halfSpan <= 1440 ? 160 : halfSpan <= 11520 ? 128 : 96;
    const sampleWidth = Math.max(minSample, Math.min(maxSample, Math.round(width * detailScale)));
    const sampleHeight = Math.max(minSample, Math.min(maxSample, Math.round(height * detailScale)));

    if (map.terrainRasterCanvas.width !== sampleWidth || map.terrainRasterCanvas.height !== sampleHeight) {
      map.terrainRasterCanvas.width = sampleWidth;
      map.terrainRasterCanvas.height = sampleHeight;
      map.terrainRasterHeights = new Float32Array(sampleWidth * sampleHeight);
      map.terrainRasterImageData = map.terrainRasterCtx.createImageData(sampleWidth, sampleHeight);
    } else if (!map.terrainRasterHeights || map.terrainRasterHeights.length !== sampleWidth * sampleHeight) {
      map.terrainRasterHeights = new Float32Array(sampleWidth * sampleHeight);
      map.terrainRasterImageData = map.terrainRasterCtx.createImageData(sampleWidth, sampleHeight);
    }

    return {
      canvas: map.terrainRasterCanvas,
      ctx: map.terrainRasterCtx,
      width: sampleWidth,
      height: sampleHeight,
      heights: map.terrainRasterHeights,
      imageData: map.terrainRasterImageData,
    };
  }

  writePhoneMapNoiseColor(pixels, offset, height, steepness, shade) {
    const waterLevel = this.waterLevel;
    let r;
    let g;
    let b;

    if (height <= waterLevel) {
      const depth = Math.max(0, Math.min(1, (waterLevel - height) / 16));
      r = 72 - depth * 14;
      g = 142 + depth * 10;
      b = 214 + depth * 18;
    } else if (height <= waterLevel + 5) {
      const shoreBlend = Math.max(0, Math.min(1, (height - waterLevel) / 5));
      r = 214 - shoreBlend * 14;
      g = 203 - shoreBlend * 10;
      b = 164 - shoreBlend * 18;
      shade = 0.94 + shade * 0.06;
    } else {
      const aboveSeaLevel = height - waterLevel;

      if (aboveSeaLevel < 220) {
        const t = Math.max(0, Math.min(1, (aboveSeaLevel - 5) / 215));
        r = 88 - t * 18;
        g = 142 - t * 20;
        b = 74 - t * 18;
      } else if (aboveSeaLevel < 500) {
        const t = Math.max(0, Math.min(1, (aboveSeaLevel - 220) / 280));
        r = 70 + t * 18;
        g = 122 - t * 18;
        b = 56 + t * 10;
      } else if (aboveSeaLevel < 1100) {
        const t = Math.max(0, Math.min(1, (aboveSeaLevel - 500) / 600));
        r = 104 + t * 54;
        g = 92 + t * 50;
        b = 76 + t * 64;
      } else {
        const snowT = Math.max(0, Math.min(1, (aboveSeaLevel - 1100) / Math.max(1, this.terrain.heightScale - 1100)));
        r = 158 + snowT * 84;
        g = 146 + snowT * 92;
        b = 140 + snowT * 102;
      }

      const rockiness = Math.max(0, Math.min(1, (steepness - 0.12) / 0.34))
        * Math.max(0, Math.min(1, (aboveSeaLevel - 180) / 720));
      if (rockiness > 0.001) {
        const ridgeTint = Math.max(0, Math.min(1, (aboveSeaLevel - 500) / 800));
        const rockR = 92 + ridgeTint * 46;
        const rockG = 88 + ridgeTint * 42;
        const rockB = 84 + ridgeTint * 50;
        r += (rockR - r) * rockiness;
        g += (rockG - g) * rockiness;
        b += (rockB - b) * rockiness;
      }
    }

    pixels[offset] = Math.max(0, Math.min(255, Math.round(r * shade)));
    pixels[offset + 1] = Math.max(0, Math.min(255, Math.round(g * shade)));
    pixels[offset + 2] = Math.max(0, Math.min(255, Math.round(b * shade)));
    pixels[offset + 3] = 255;
  }

  drawPhoneMapRoads(ctx, width, height, centerX, centerZ, halfSpan) {
    if (halfSpan > 92160) return;

    const minX = centerX - halfSpan;
    const minZ = centerZ - halfSpan;
    const maxX = centerX + halfSpan;
    const maxZ = centerZ + halfSpan;
    const curves = this.terrain.getCachedHighwayCurvesInBounds(minX, minZ, maxX, maxZ, halfSpan * 0.15);
    if (!curves.length) return;
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

  applySpawnPosition(data, options = {}) {
    if (!data) return;

    const warmTerrain = options.warmTerrain !== false;

    const nextX = Number.isFinite(data.x) ? data.x : this.position.x;
    const nextZ = Number.isFinite(data.z) ? data.z : this.position.z;
    const nextY = Number.isFinite(data.y)
      ? data.y
      : (warmTerrain ? this.terrain.getHeight(nextX, nextZ) + this.playerHeight : this.position.y);

    this.position.set(
      nextX,
      nextY,
      nextZ
    );

    this.velocity.set(0, 0, 0);
    this.euler.x = Number.isFinite(data.rx) ? data.rx : this.euler.x;
    this.euler.y = Number.isFinite(data.ry) ? data.ry : this.euler.y;
    this.jumpAnimationTimer = 0;
    this.lastSendTime = 0;

    this.updateCamera();

    if (warmTerrain) {
      this.terrain.update(this.position.x, this.position.z, this.camera, { forceLoad: true });
    }

    if (this.phoneMap) {
      this.phoneMap.centerX = this.position.x;
      this.phoneMap.centerZ = this.position.z;
      this.phoneMap.lastRenderPlayerX = this.position.x;
      this.phoneMap.lastRenderPlayerZ = this.position.z;
      this.phoneMap.lastRenderHeading = this.euler.y;
      this.phoneMap.dirty = true;
    }
  }

  isOwnPlayer(socketId, data = null) {
    if (this.socket && socketId === this.socket.id) {
      return true;
    }

    const ownUserId = Number(this.userId);
    const playerUserId = Number(data?.id);

    return Number.isFinite(ownUserId)
      && Number.isFinite(playerUserId)
      && ownUserId === playerUserId;
  }

  connectMultiplayer(token) {
    return new Promise((resolve, reject) => {
      let initialSpawnResolved = false;
      const rejectInitialSpawn = (error) => {
        if (initialSpawnResolved) return;
        initialSpawnResolved = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const resolveInitialSpawn = (data) => {
        if (initialSpawnResolved) return;
        initialSpawnResolved = true;
        resolve(data);
      };

      this.socket = io({
        auth: { token }
      });

      this.socket.on('connect', () => {
        console.log('Connected to server');
      });

      this.socket.on('gameWorldTime', (data) => {
        this.gameWorldStartTime = data.worldStartTime;
        this.lastServerTimeSample = Number.isFinite(data.currentTime) ? data.currentTime : this.lastServerTimeSample;
        console.log('Synchronized with server time');
      });

      this.socket.on('gameTimeUpdate', (data) => {
        // Periodic resync with server (optional, helps prevent drift)
        // The client calculates time locally, but this confirms server thinking
        const serverTime = data.currentTime;
        this.lastServerTimeSample = Number.isFinite(serverTime) ? serverTime : this.lastServerTimeSample;
        if (this.debugTimeOverride.active) {
          return;
        }
        const clientTime = (Date.now() - this.gameWorldStartTime) / this.timeCycleMs % 1.0;
        // Only resync if drift is significant (more than 1 game hour = 1/24th of cycle)
        const drift = Math.abs(serverTime - clientTime);
        if (drift > 1/24 && drift < 0.5) { // Check drift is not wrapping around
          console.warn('Time drift detected, minor adjustment made');
          // Small adjustment to compensate for client/server clock differences
          this.gameWorldStartTime = Date.now() - (serverTime * this.timeCycleMs);
        }
      });

      this.socket.on('spawnPosition', (data) => {
        if (!initialSpawnResolved) {
          resolveInitialSpawn(data);
          return;
        }

        this.applySpawnPosition(data);
      });

      this.socket.on('currentPlayers', (players) => {
        for (const [socketId, data] of Object.entries(players)) {
          if (this.isOwnPlayer(socketId, data)) continue;
          this.addOtherPlayer(socketId, data);
        }
        this.updatePlayerCount();
      });

      this.socket.on('playerJoined', (data) => {
        if (this.isOwnPlayer(data.socketId, data)) return;
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
          player.isFlying = !!data.isFlying;
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
        rejectInitialSpawn(err);
      });
    });
  }

  async addOtherPlayer(socketId, data) {
    if (!socketId || this.isOwnPlayer(socketId, data)) return;

    let player = this.otherPlayers[socketId];
    const footY = data.y - this.playerHeight;

    if (player) {
      player.username = data.username;
      player.targetX = data.x;
      player.targetY = footY;
      player.targetZ = data.z;
      player.targetRY = data.ry || 0;
      player.isSwimming = !!data.isSwimming;
      player.isFlying = !!data.isFlying;
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
      isFlying: !!data.isFlying,
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
      } else if (p.isFlying && p.actions && p.actions.jump) {
        animationState = 'jump';
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
    if (this.debugMenuOpen) {
      this.syncDebugMenuUI();
    }
    this.updateMovement(dt);
    this.syncDistanceFadeEnvironment();
    this.updateCamera();
    this.updateOtherPlayers(dt);

    // Update terrain around player
    this.terrain.update(this.position.x, this.position.z, this.camera);

    // Update trees
    this.trees.update(this.position.x, this.position.z, this.camera);

    // Update HUD
    document.getElementById('coords').textContent =
      `X: ${Math.floor(this.position.x)} Y: ${Math.floor(this.position.y)} Z: ${Math.floor(this.position.z)}`;
    
    // Update FPS counter
    this.frameCount++;
    const currentTime = performance.now();
    if (currentTime - this.fpsUpdateTime >= 1000) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.fpsUpdateTime = currentTime;
      document.getElementById('fps-counter').textContent = `${this.fps} FPS`;
    }
    
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
        isFlying: this.isFlying,
        isJumping: (this.isFlying || this.jumpAnimationTimer > 0) && !this.isSwimming,
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
    const wantsRun = !this.isFlying && this.keys[kb.run] && hasMoveInput && !inWater && !swimmingNow;
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
  const wantsCrouch = !this.isFlying && this.keys[kb.crouch];
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
      if (this.isFlying) speed *= this.flightSpeedMultiplier;
      if (this.isRunning) speed *= this.runSpeedMultiplier;
      if (this.isCrouching) speed *= this.crouchSpeedMultiplier;

      // Slow down in water
      if (!this.isFlying && inWater) speed *= (swimmingNow ? 0.4 : 0.6);

      const newX = this.position.x + moveDir.x * speed * dt;
      const newZ = this.position.z + moveDir.z * speed * dt;

      if (this.isFlying) {
        this.position.x = newX;
        this.position.z = newZ;
      } else {
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
    }

    // --- Gravity & Swimming ---
    if (this.isFlying) {
      const flightVerticalDirection = (this.keys[kb.jump] ? 1 : 0) - (this.keys[kb.crouch] ? 1 : 0);
      if (flightVerticalDirection !== 0) {
        this.position.y += flightVerticalDirection * this.moveSpeed * this.flightSpeedMultiplier * dt;
      }

      this.velocity.y = 0;
    } else if (swimmingNow) {
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
      if (this.isFlying) {
        this.setFlying(false);
      }
    } else {
      this.onGround = false;
    }

    const waterSurfaceY = this.getWaterSurfaceHeight(this.position.x, this.position.z);
    const waterDepth = waterSurfaceY - (this.position.y - this.playerHeight);
    this.isSwimming = !this.isFlying && waterDepth > this.playerHeight * 0.5;
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
