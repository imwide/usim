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

    // Day / night cycle
    this.dayTime = 0.27;   // 0 = midnight, 0.5 = noon
    this.daySpeed = 1 / 180; // full cycle in 3 real minutes

    // Sky, sun, moon, stars, lights
    this.setupSky();

    // Terrain
    this.noise = new PerlinNoise(42);
    this.terrain = new TerrainManager(this.scene, this.noise);

    // Water
    this.waterLevel = -15.5;
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
    this.moveSpeed = 15;
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
    this.runSpeedMultiplier = 1.5;
    this.crouchCameraOffset = 0;       // current camera height offset (lerped)
    this.crouchSpeedMultiplier = 0.65;

    // Settings (loaded from localStorage)
    this.settings = Game.loadSettings();

    // Input
    this.keys = {};
    this.mouseLocked = false;
    this.paused = false;
    this.mouseSensitivity = this.settings.sensitivity;

    // Multiplayer
    this.socket = null;
    this.otherPlayers = {};
    this.username = '';
    this.sendRate = 50; // ms between position updates
    this.lastSendTime = 0;

    // Resize
    window.addEventListener('resize', () => this.onResize());
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
    this.dayTime = (this.dayTime + dt * this.daySpeed) % 1.0;
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
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    document.exitPointerLock();
  }

  setupInput() {
    this._onKeyDown = (e) => {
      // Escape toggles pause (only works when NOT pointer-locked; browser
      // intercepts Escape to kill pointer lock before keydown fires, so the
      // real pause trigger is pointerlockchange below).
      if (e.code === 'Escape') {
        e.preventDefault();
        if (this.paused) this.togglePause(); // resume if already paused
        return;
      }
      if (this.paused) return;
      this.keys[e.code] = true;
      const kb = this.settings.keybinds;
      if (e.code === kb.jump && this.onGround && !this.isSwimming) {
        this.velocity.y = this.jumpSpeed;
        this.onGround = false;
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
    this.canvas.addEventListener('click', () => {
      if (!this.paused) this.canvas.requestPointerLock();
    });

    // Primary pause trigger: browser kills pointer lock with Escape BEFORE
    // keydown fires, so we detect the lock loss here instead.
    this._onPointerLockChange = () => {
      this.mouseLocked = document.pointerLockElement === this.canvas;
      const prompt = document.getElementById('lock-prompt');
      if (this.mouseLocked) {
        // Lock acquired — hide the "click to play" prompt
        prompt.style.display = 'none';
      } else if (!this.paused && this.running) {
        // Lock lost (user pressed Escape) — pause the game
        this.togglePause();
      }
    };
    document.addEventListener('pointerlockchange', this._onPointerLockChange);

    // Show prompt initially
    document.getElementById('lock-prompt').style.display = 'block';
  }

  togglePause() {
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

    // --- Swimming State ---
    const initialWaterSurfaceY = this.getWaterSurfaceHeight(this.position.x, this.position.z);
    const initialBottomY = this.position.y - this.playerHeight;
    const initialWaterDepth = initialWaterSurfaceY - initialBottomY;
    const inWater = initialWaterDepth > 0.05;
    const swimmingNow = initialWaterDepth > this.playerHeight * 0.5;

    // --- Stamina / Running ---
    const wantsRun = this.keys[kb.run] && !inWater && !swimmingNow;
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
      if (this.isRunning && moveDir.dot(forward) > 0.5) speed *= this.runSpeedMultiplier;
      if (this.isCrouching) speed *= this.crouchSpeedMultiplier;

      // Slow down in water
      if (inWater) speed *= (swimmingNow ? 0.4 : 0.6);

      this.position.x += moveDir.x * speed * dt;
      this.position.z += moveDir.z * speed * dt;
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
