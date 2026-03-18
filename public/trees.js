/**
 * Tree system – procedural birch trees with LOD and instanced rendering.
 *
 * LOD levels:
 *   0  (billboard)   – far camera-facing quad, lower-res billboard texture
 *   1  (low)         – mid-distance camera-facing quad, full-res billboard texture
 *   2  (high)        – standard 3-D tree for 100m-250m range
 *   3  (near)        – enhanced 3-D tree for the closest 100m range
 *
 * Trees are distributed using Perlin noise so placement is deterministic per seed.
 * The system piggy-backs on TerrainManager's chunk grid for streaming.
 */
class TreeManager {
  constructor(scene, terrain, noise, camera) {
    this.scene = scene;
    this.terrain = terrain;
    this.noise = noise;
    this.camera = camera;

    // ── Configuration ──────────────────────────────────────────
    this.chunkWorldSize = terrain.chunkWorldSize; // match terrain chunks
    this.treeCellSize = 5;           // spacing grid cell in world units
    this.treeMinElevation = 18;      // preferred lower tree line above sea level
    this.treeMaxElevation = 420;     // preferred upper tree line above sea level
    this.treeLowElevationFadeRange = 24;
    this.treeHighElevationFadeRange = 140;
    this.treeMaxSlope = 0.82;        // max normal-Y (cos of slope angle)
    this.treeNoiseScale = 0.0045;    // perlin scale for distribution
    this.treeNoiseThreshold = 0.30;  // noise floor – below this, no trees at all
    this.treeNoiseOffsetX = 4871.3;
    this.treeNoiseOffsetZ = -2917.8;
    this.treeForestMaskScale = 1 / 3400; // broad forest regions around 3-4km across
    this.treeForestMaskThreshold = 0.5;  // darkest 50% blocks trees, brightest 50% allows them
    this.treeForestMaskEdgeFeather = 0.035;
    this.treeForestMaskEdgeJitterScale = 1 / 55;
    this.treeForestMaskEdgeJitterDistance = 50;
    this.treeForestMaskOffsetX = -8241.6;
    this.treeForestMaskOffsetZ = 6117.9;
    this.treeForestMaskJitterOffsetX = 1823.4;
    this.treeForestMaskJitterOffsetZ = -4621.9;
    this.treeForestMaskJitterOffsetX2 = -3157.2;
    this.treeForestMaskJitterOffsetZ2 = 2874.6;
    this.maxTreesPerChunk = 10000;   // effectively unlimited – density is controlled by noise

    // LOD distances (world units from camera)
    this.lodBillboardDistance = 600;  // beyond this → far billboard
    this.lodLowDistance = 230;        // beyond this → mid billboard
    this.lodHighDistance = 90;        // beyond this → standard 3-D, closer → enhanced 3-D
    this.treeLodFadeDistance = 24;
    this.billboardTreeRenderFraction = 2 / 3;

    // View distance for tree chunks (in chunks)
    this.treeViewDistance = 8;
    this.treeViewUnloadBufferChunks = 0.75;
    this.treeFrustumCullPadding = 12;

    // ── State ──────────────────────────────────────────────────
    this.treeChunks = new Map();     // "cx,cz" → { trees[], lodMeshes, … }
    this.texturesLoaded = false;

    // ── Textures ───────────────────────────────────────────────
    this.textures = {};
    this.loadTextures();

    // ── Shared geometries & materials (created after textures) ─
    this.sharedReady = false;
    this.billboardGeo = null;
    this.billboardMat = null;
    this.billboardMatLow = null;
    this.trunkMaterialNear = null;
    this.trunkMaterialHigh = null;
    this.leafMaterialNear = null;
    this.leafMaterialHigh = null;

    // ── Geometry caches (keyed by seed hash) ───────────────────
    // We pre-build a small palette of tree geometries to instance from.
    this.treePaletteSize = 12;
    this.nearGeometries = [];
    this.highGeometries = [];   // merged BufferGeometry per palette slot
    this.lowGeometries = [];
    this.paletteMetrics = [];
    this.paletteDirty = true;

    this.treeLodKeys = ['near', 'high', 'low', 'billboard'];
    this.treeLodBitmask = {
      near: 1,
      high: 2,
      low: 4,
      billboard: 8,
    };

    this.treeStreamingIntervalMs = 50;
    this.treeVisibilityIntervalMs = 33;
    this.treeStreamingMoveThresholdSq = 4;
    this.treeVisibilityMoveThresholdSq = 0.36;
    this.treeVisibilityRotationThreshold = 0.02;
    this.lastTreeStreamingTime = -Infinity;
    this.lastTreeVisibilityTime = -Infinity;
    this.lastTreeStreamingChunkX = Infinity;
    this.lastTreeStreamingChunkZ = Infinity;
    this.lastTreeStreamingViewer = new THREE.Vector3(Infinity, Infinity, Infinity);
    this.lastTreeVisibilityViewer = new THREE.Vector3(Infinity, Infinity, Infinity);
    this.lastTreeVisibilityYaw = NaN;
    this.lastTreeVisibilityPitch = NaN;

    this.treeUniforms = {
      uViewerPos: { value: new THREE.Vector3(0, 0, 0) },
    };

    // Reusable helpers
    this._v3 = new THREE.Vector3();
    this._yAxis = new THREE.Vector3(0, 1, 0);
    this._mat4 = new THREE.Matrix4();
    this._quat = new THREE.Quaternion();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._scale = new THREE.Vector3(1, 1, 1);
    this._frustum = new THREE.Frustum();
    this._frustumMatrix = new THREE.Matrix4();
    this._treeCullBox = new THREE.Box3();
  }

  // ═══════════════════════════════════════════════════════════════
  //  TEXTURES
  // ═══════════════════════════════════════════════════════════════

  loadTextures() {
    const loader = new THREE.TextureLoader();
    const basePath = '/assets/textures/trees/';

    const load = (name, wrapRepeat = false) => {
      return new Promise((resolve) => {
        loader.load(basePath + name, (tex) => {
          tex.encoding = THREE.sRGBEncoding;
          if (wrapRepeat) {
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
          }
          tex.needsUpdate = true;
          resolve(tex);
        }, undefined, () => {
          // Texture missing – generate a fallback
          resolve(this.generateFallbackTexture(name));
        });
      });
    };

    // Load all textures, proceed when ready
    Promise.all([
      load('birch_bark.png', true),
      load('birch_bark_low.png', true),
      load('birch_leaves.png'),
      load('birch_leaves_low.png'),
      load('birch_leaves_dense.png'),
      load('birch_leaves_dense_low.png'),
      load('birch_billboard.png'),
      load('birch_billboard_low.png'),
    ]).then(([barkHigh, barkLow, leavesHigh, leavesLow, leavesDense, leavesDenseLow, billboardHigh, billboardLow]) => {
      this.textures.barkHigh = barkHigh;
      this.textures.barkLow = barkLow;
      this.textures.leavesHigh = this.prepareTreeAlphaTexture(leavesHigh);
      this.textures.leavesLow = this.prepareTreeAlphaTexture(leavesLow);
      this.textures.leavesHighStable = this.createTreeTextureVariant(this.textures.leavesHigh, {
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      this.textures.leavesLowStable = this.createTreeTextureVariant(this.textures.leavesLow, {
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      // Dense composite leaf textures (6 clusters per quad)
      this.textures.leavesDense = this.prepareTreeAlphaTexture(leavesDense);
      this.textures.leavesDenseLow = this.prepareTreeAlphaTexture(leavesDenseLow);
      this.textures.leavesDenseStable = this.createTreeTextureVariant(this.textures.leavesDense, {
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      this.textures.leavesDenseLowStable = this.createTreeTextureVariant(this.textures.leavesDenseLow, {
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      this.textures.billboardHigh = this.prepareTreeAlphaTexture(billboardHigh);
      this.textures.billboardLow = this.prepareTreeAlphaTexture(billboardLow);
      this.texturesLoaded = true;
      this.buildSharedAssets();
    });
  }

  /**
   * Generate a minimal runtime fallback texture when the image file is missing.
   */
  generateFallbackTexture(name) {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (name.includes('bark')) {
      ctx.fillStyle = '#cfc6bb';
      ctx.fillRect(0, 0, 64, 64);
    } else {
      ctx.fillStyle = '#4a8a30';
      ctx.fillRect(0, 0, 64, 64);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.encoding = THREE.sRGBEncoding;
    if (name.includes('bark')) {
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
    }
    tex.needsUpdate = true;
    return tex;
  }

  prepareTreeAlphaTexture(texture) {
    if (!texture) return texture;

    const image = texture.image;
    if (!image || !image.width || !image.height) {
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.premultiplyAlpha = false;
      texture.needsUpdate = true;
      return texture;
    }

    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');

    if (!ctx) return texture;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    this.bleedTransparentCanvasColors(ctx, canvas.width, canvas.height, 12);

    texture.image = canvas;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.premultiplyAlpha = false;
    texture.needsUpdate = true;
    return texture;
  }

  createTreeTextureVariant(texture, options = {}) {
    if (!texture) return texture;

    const variant = texture.clone();
    variant.image = texture.image;
    variant.encoding = texture.encoding;
    variant.wrapS = options.wrapS ?? texture.wrapS;
    variant.wrapT = options.wrapT ?? texture.wrapT;
    variant.minFilter = options.minFilter ?? texture.minFilter;
    variant.magFilter = options.magFilter ?? texture.magFilter;
    variant.generateMipmaps = options.generateMipmaps ?? texture.generateMipmaps;
    variant.premultiplyAlpha = options.premultiplyAlpha ?? texture.premultiplyAlpha;
    variant.needsUpdate = true;
    return variant;
  }

  bleedTransparentCanvasColors(ctx, width, height, iterations = 12) {
    if (!ctx || width <= 0 || height <= 0) return;

    let imageData = ctx.getImageData(0, 0, width, height);
    let source = imageData.data;
    const hasValidColor = new Uint8Array(width * height);

    for (let i = 0; i < width * height; i++) {
      hasValidColor[i] = source[i * 4 + 3] >= 250 ? 1 : 0;
    }

    for (let iteration = 0; iteration < iterations; iteration++) {
      let changed = false;
      const nextSource = new Uint8ClampedArray(source);
      const nextValid = new Uint8Array(hasValidColor);

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = y * width + x;
          if (hasValidColor[idx]) continue;

          let found = false;
          for (let oy = -1; oy <= 1 && !found; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              if (ox === 0 && oy === 0) continue;
              const nx = x + ox;
              const ny = y + oy;
              if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

              const nidx = ny * width + nx;
              if (!hasValidColor[nidx]) continue;

              nextSource[idx * 4 + 0] = source[nidx * 4 + 0];
              nextSource[idx * 4 + 1] = source[nidx * 4 + 1];
              nextSource[idx * 4 + 2] = source[nidx * 4 + 2];
              nextValid[idx] = 1;
              found = true;
              changed = true;
              break;
            }
          }
        }
      }

      source = nextSource;
      hasValidColor.set(nextValid);
      if (!changed) break;
    }

    imageData.data.set(source);
    ctx.putImageData(imageData, 0, 0);
  }

  // ═══════════════════════════════════════════════════════════════
  //  SHARED ASSETS – materials, geometries, palette
  // ═══════════════════════════════════════════════════════════════

  buildSharedAssets() {
    if (this.sharedReady) return;

    // ── Billboard ──
    this.billboardGeo = new THREE.PlaneGeometry(14, 22);
    // shift origin to bottom center so billboard sits on ground
    this.billboardGeo.translate(0, 11, 0);

    const billboardBase = {
      color: 0xffffff,
      transparent: false,
      alphaTest: 0.45,
      alphaToCoverage: false,
      side: THREE.FrontSide,
      depthWrite: true,
      fog: true,
      billboardMode: 'cylindrical-y',
    };
    this.billboardMat = this.createTreeLodMaterial({
      map: this.textures.billboardHigh,
      ...billboardBase,
    }, this.lodLowDistance, this.lodBillboardDistance);

    this.billboardMatLow = this.createTreeLodMaterial({
      map: this.textures.billboardLow || this.textures.billboardHigh,
      ...billboardBase,
    }, this.lodBillboardDistance, Infinity);

    // ── Trunk materials ──
    const trunkBase = {
      side: THREE.FrontSide,
      fog: true,
      depthWrite: true,
      depthTest: true,
    };
    this.trunkMaterialNear = this.createTreeLodMaterial({
      map: this.textures.barkHigh,
      color: 0xbfb7ac,
      ...trunkBase,
    }, 0, this.lodHighDistance);

    this.trunkMaterialHigh = this.createTreeLodMaterial({
      map: this.textures.barkHigh,
      color: 0xbfb7ac,
      ...trunkBase,
    }, this.lodHighDistance, this.lodLowDistance);

    // ── Leaf materials ──
    const leafBaseNear = {
      transparent: false,
      alphaTest: 0.4,
      alphaToCoverage: true,
      side: THREE.DoubleSide,
      fog: true,
      depthWrite: true,
      depthTest: true,
    };
    this.leafMaterialNear = this.createTreeLodMaterial({
      map: this.textures.leavesDenseStable || this.textures.leavesDense || this.textures.leavesHigh,
      ...leafBaseNear,
    }, 0, this.lodHighDistance);

    const leafBaseHigh = {
      transparent: false,
      color: 0xaaaaaa,
      alphaTest: 0.3,
      alphaToCoverage: false,
      side: THREE.DoubleSide,
      fog: true,
      depthWrite: true,
      depthTest: true,
      useDitherFade: false,
    };
    this.leafMaterialHigh = this.createTreeLodMaterial({
      map: this.textures.leavesDenseLowStable || this.textures.leavesDenseLow || this.textures.leavesDenseStable || this.textures.leavesDense || this.textures.leavesLow,
      ...leafBaseHigh,
    }, this.lodHighDistance, this.lodLowDistance);

    // Build geometry palette
    this.buildGeometryPalette();
    this.sharedReady = true;
  }

  createTreeLodMaterial(materialOptions, visibleMinDistance = 0, visibleMaxDistance = Infinity, fadeDistance = this.treeLodFadeDistance, fadeInDistance = fadeDistance) {
    const {
      useDitherFade = true,
      billboardMode = null,
      ...meshMaterialOptions
    } = materialOptions || {};
    const maxDistance = Number.isFinite(visibleMaxDistance) ? visibleMaxDistance : 1e9;
    const material = new THREE.MeshLambertMaterial({
      ...meshMaterialOptions,
      transparent: meshMaterialOptions.transparent === true,
      alphaToCoverage: meshMaterialOptions.alphaToCoverage === true,
      depthWrite: meshMaterialOptions.depthWrite ?? true,
      depthTest: meshMaterialOptions.depthTest ?? true,
      fog: meshMaterialOptions.fog !== false,
    });

    material.userData.treeLodUniforms = {
      uTreeVisibleMin: { value: visibleMinDistance },
      uTreeVisibleMax: { value: maxDistance },
      uTreeFadeDistance: { value: fadeDistance },
      uTreeFadeInDistance: { value: fadeInDistance },
    };
    material.userData.treeLodUseDitherFade = useDitherFade;
    material.userData.treeLodBillboardMode = billboardMode;

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTreeViewerPos = this.treeUniforms.uViewerPos;
      shader.uniforms.uTreeVisibleMin = material.userData.treeLodUniforms.uTreeVisibleMin;
      shader.uniforms.uTreeVisibleMax = material.userData.treeLodUniforms.uTreeVisibleMax;
      shader.uniforms.uTreeFadeDistance = material.userData.treeLodUniforms.uTreeFadeDistance;
      shader.uniforms.uTreeFadeInDistance = material.userData.treeLodUniforms.uTreeFadeInDistance;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uTreeViewerPos;
        uniform float uTreeVisibleMin;
        uniform float uTreeVisibleMax;
        uniform float uTreeFadeDistance;
        uniform float uTreeFadeInDistance;
        varying float vTreeVisibility;`
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec3 treeWorldRoot = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        #ifdef USE_INSTANCING
          treeWorldRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        #endif

        ${material.userData.treeLodBillboardMode === 'cylindrical-y' ? `vec3 treeToViewer = uTreeViewerPos - treeWorldRoot;
        float treeBillboardAngle = atan(treeToViewer.x, treeToViewer.z);
        float treeBillboardSin = sin(treeBillboardAngle);
        float treeBillboardCos = cos(treeBillboardAngle);
        transformed.xz = vec2(
          transformed.x * treeBillboardCos + transformed.z * treeBillboardSin,
          -transformed.x * treeBillboardSin + transformed.z * treeBillboardCos
        );` : ''}

        float treeViewerDist = distance(treeWorldRoot, uTreeViewerPos);
        float fadeIn = uTreeVisibleMin <= 0.0
          ? 1.0
          : smoothstep(uTreeVisibleMin - uTreeFadeInDistance, uTreeVisibleMin, treeViewerDist);
        float fadeOut = uTreeVisibleMax > 1000000.0
          ? 1.0
          : 1.0 - smoothstep(uTreeVisibleMax - uTreeFadeDistance, uTreeVisibleMax, treeViewerDist);
        vTreeVisibility = clamp(fadeIn * fadeOut, 0.0, 1.0);`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        varying float vTreeVisibility;

        float treeHash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        ${material.userData.treeLodUseDitherFade ? `if (vTreeVisibility < 0.999) {
          float fadeDither = treeHash12(gl_FragCoord.xy);
          if (fadeDither > vTreeVisibility) discard;
        }` : ''}
        diffuseColor.a *= vTreeVisibility;
        if (diffuseColor.a < 0.01) discard;`
      );
    };

    const mapKey = meshMaterialOptions && meshMaterialOptions.map ? meshMaterialOptions.map.uuid : 'no-map';
    material.customProgramCacheKey = () => (
      `tree-lod-v6-${mapKey}-${visibleMinDistance}-${Number.isFinite(visibleMaxDistance) ? visibleMaxDistance : 'inf'}-${fadeDistance}-${fadeInDistance}-${material.alphaToCoverage ? 'atc' : 'noatc'}-${material.userData.treeLodUseDitherFade ? 'dither' : 'nodither'}-${material.userData.treeLodBillboardMode || 'mesh'}`
    );

    return material;
  }

  // ═══════════════════════════════════════════════════════════════
  //  PROCEDURAL BIRCH TREE GEOMETRY
  // ═══════════════════════════════════════════════════════════════

  /**
   * Deterministic hash for a tree position → palette index.
   */
  hashTreeSeed(wx, wz) {
    let n = Math.sin(wx * 127.1 + wz * 311.7 + (this.noise.seedValue || 42) * 53.3) * 43758.5453;
    n = n - Math.floor(n);
    return n;
  }

  clamp01(value) {
    return Math.max(0, Math.min(1, value));
  }

  smoothstep(edge0, edge1, x) {
    if (edge0 === edge1) {
      return x < edge0 ? 0 : 1;
    }

    const t = this.clamp01((x - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
  }

  getTreeElevationDensity(aboveSeaLevel) {
    const lowDensity = this.smoothstep(
      this.treeMinElevation - this.treeLowElevationFadeRange,
      this.treeMinElevation + this.treeLowElevationFadeRange,
      aboveSeaLevel
    );
    const highDensity = 1 - this.smoothstep(
      this.treeMaxElevation - this.treeHighElevationFadeRange,
      this.treeMaxElevation + this.treeHighElevationFadeRange,
      aboveSeaLevel
    );

    return this.clamp01(lowDensity * highDensity);
  }

  sampleTreeNoise(worldX, worldZ, scale, offsetX, offsetZ) {
    return this.noise.perlin2(
      (worldX + offsetX) * scale,
      (worldZ + offsetZ) * scale
    ) * 0.5 + 0.5;
  }

  getTreeBaseDensity(worldX, worldZ) {
    const noiseVal = this.sampleTreeNoise(
      worldX,
      worldZ,
      this.treeNoiseScale,
      this.treeNoiseOffsetX,
      this.treeNoiseOffsetZ
    );

    if (noiseVal < this.treeNoiseThreshold) {
      return 0;
    }

    return (noiseVal - this.treeNoiseThreshold) / (1 - this.treeNoiseThreshold);
  }

  getTreeForestAreaMask(worldX, worldZ) {
    const jitterX = (this.sampleTreeNoise(
      worldX,
      worldZ,
      this.treeForestMaskEdgeJitterScale,
      this.treeForestMaskJitterOffsetX,
      this.treeForestMaskJitterOffsetZ
    ) - 0.5) * 2 * this.treeForestMaskEdgeJitterDistance;
    const jitterZ = (this.sampleTreeNoise(
      worldX,
      worldZ,
      this.treeForestMaskEdgeJitterScale,
      this.treeForestMaskJitterOffsetX2,
      this.treeForestMaskJitterOffsetZ2
    ) - 0.5) * 2 * this.treeForestMaskEdgeJitterDistance;

    const forestNoise = this.sampleTreeNoise(
      worldX + jitterX,
      worldZ + jitterZ,
      this.treeForestMaskScale,
      this.treeForestMaskOffsetX,
      this.treeForestMaskOffsetZ
    );

    return this.smoothstep(
      this.treeForestMaskThreshold - this.treeForestMaskEdgeFeather,
      this.treeForestMaskThreshold + this.treeForestMaskEdgeFeather,
      forestNoise
    );
  }

  isTreeForestRegionEnabled(worldX, worldZ) {
    const forestMask = this.getTreeForestAreaMask(worldX, worldZ);
    if (forestMask <= 0) return false;
    if (forestMask >= 1) return true;

    const edgeRoll = this.hashTreeSeed(worldX * 4.91 + 137.2, worldZ * -6.37 - 281.4);
    return edgeRoll < forestMask;
  }

  getTreeSpawnDensity(worldX, worldZ, aboveSeaLevel = null) {
    const baseDensity = this.getTreeBaseDensity(worldX, worldZ);
    if (baseDensity <= 0) {
      return 0;
    }

    if (!this.isTreeForestRegionEnabled(worldX, worldZ)) {
      return 0;
    }

    const elevationDensity = this.getTreeElevationDensity(
      aboveSeaLevel ?? (this.terrain.getHeight(worldX, worldZ) - this.terrain.waterLevel)
    );
    if (elevationDensity <= 0) {
      return 0;
    }

    return baseDensity * elevationDensity;
  }

  /**
   * Build a small palette of pre-generated tree geometries for each LOD.
   * Trees in the world simply pick from this palette, avoiding per-tree geometry creation.
   */
  buildGeometryPalette() {
    this.nearGeometries = [];
    this.highGeometries = [];
    this.lowGeometries = [];
    this.paletteMetrics = [];

    for (let i = 0; i < this.treePaletteSize; i++) {
      const seed = i / this.treePaletteSize;
      const nearGeometry = this.createTreeGeometry(seed, 'near');
      const highGeometry = this.createTreeGeometry(seed, 'high');
      const lowGeometry = this.createTreeGeometry(seed, 'low');
      this.nearGeometries.push(nearGeometry);
      this.highGeometries.push(highGeometry);
      this.lowGeometries.push(lowGeometry);
      this.paletteMetrics.push(this.buildPaletteMetrics(nearGeometry, highGeometry, lowGeometry));
    }
  }

  /**
  * Create a single procedural birch tree geometry (trunk + branches + leaf quads).
  * Returns { trunk: BufferGeometry, leaves: BufferGeometry }
   */
  createTreeGeometry(seed, lod) {
    const rng = this.seededRandom(seed * 99999 + 7);
    const isNear = lod === 'near';
    const isHighDetail = lod === 'high' || isNear;
    const sharedCloseLeafScale = 0.56;
    const denseLeafBillboardScale = 1.55;

    // Tree parameters (vary with seed)
    const height = 12 + rng() * 10;            // 12-22
    const trunkRadius = 0.25 + rng() * 0.15;   // 0.25-0.40
    const branchCount = isNear
      ? (6 + Math.floor(rng() * 6))
      : lod === 'high'
        ? (4 + Math.floor(rng() * 5))
        : (2 + Math.floor(rng() * 2));
    const trunkSegments = isNear ? 8 : lod === 'high' ? 6 : 3;
    const trunkRadialSegments = isNear ? 6 : lod === 'high' ? 5 : 3;

    // ── TRUNK ──
    const trunkGeo = this.createTrunkGeometry(
      height,
      trunkRadius,
      trunkSegments,
      trunkRadialSegments,
      rng
    );

    // ── BRANCHES + LEAVES ──
    const leafQuads = [];
    const branchGeos = [];

    const crownBase = height * (0.35 + rng() * 0.15);
    const crownTop = height * (0.9 + rng() * 0.1);

    for (let b = 0; b < branchCount; b++) {
      const t = (b + 0.5) / branchCount;
      const branchY = crownBase + (crownTop - crownBase) * t;
      const angle = (b / branchCount) * Math.PI * 2 + rng() * 1.2;
      const branchLength = (isNear ? (2.4 + rng() * 3.8) : (1.5 + rng() * 3)) * (1 - t * 0.4);
      const branchPitch = (isNear ? 0.22 : 0.3) + rng() * (isNear ? 0.45 : 0.5); // upward angle

      this.addBranchSystem(branchGeos, leafQuads, {
        baseX: 0,
        baseY: branchY,
        baseZ: 0,
        angle,
        pitch: branchPitch,
        length: branchLength,
        radius: trunkRadius * (isNear ? 0.22 : 0.25),
        lod,
        rng,
      });
    }

    // Add top canopy cluster
    // Dense texture: fewer top-cap quads, each larger
    const topLeafSize = (isHighDetail ? (4 + rng() * 3) : (7 + rng() * 4)) * (isHighDetail ? sharedCloseLeafScale * denseLeafBillboardScale : denseLeafBillboardScale);
    const topLeafCount = isHighDetail ? 2 : 1;
    for (let t = 0; t < topLeafCount; t++) {
      const spread = 3;
      const ox = (rng() - 0.5) * spread;
      const oy = crownTop + rng() * 1.5;
      const oz = (rng() - 0.5) * spread;
      leafQuads.push(this.createLeafQuad(ox, oy, oz, topLeafSize, rng() * Math.PI, rng));
    }

    // Merge trunk + branches
    const trunkParts = [trunkGeo, ...branchGeos];
    const mergedTrunk = this.mergeBufferGeometries(trunkParts);

    // Merge leaf quads
    const mergedLeaves = this.mergeBufferGeometries(leafQuads);

    // Cleanup
    trunkGeo.dispose();
    branchGeos.forEach(g => g.dispose());
    leafQuads.forEach(g => g.dispose());

    return { trunk: mergedTrunk, leaves: mergedLeaves, height };
  }

  addBranchSystem(branchGeos, leafQuads, options) {
    const {
      baseX,
      baseY,
      baseZ,
      angle,
      pitch,
      length,
      radius,
      lod,
      rng,
    } = options;

    const isNear = lod === 'near';
    const isHighDetail = lod === 'high' || isNear;
    const sharedCloseLeafScale = 0.56;
    const denseLeafBillboardScale = 1.55;

    if (isNear) {
      const branchGeo = this.createBranchGeometry(baseX, baseY, baseZ, angle, pitch, length, radius, rng);
      branchGeos.push(branchGeo);
    }

    const tip = this.getBranchEndpoint(baseX, baseY, baseZ, angle, pitch, length);
    // Dense texture covers multiple clusters per quad → keep quad count flat, upscale cards.
    const baseLeafCount = isHighDetail
      ? (2 + Math.floor(rng() * 2))
      : (1 + Math.floor(rng() * 2));
    const leafCount = baseLeafCount;
    const leafJitter = 2.8;
    const leafHeightJitter = 1.8;

    for (let l = 0; l < leafCount; l++) {
      const along = 0.25 + (l / Math.max(leafCount - 1, 1)) * 0.75;
      const baseLeafSize = isHighDetail ? (3 + rng() * 2.5) : (5 + rng() * 3);
      const leafSize = baseLeafSize * (isHighDetail ? sharedCloseLeafScale * denseLeafBillboardScale : denseLeafBillboardScale);
      const lx = baseX + (tip.x - baseX) * along + (rng() - 0.5) * leafJitter;
      const ly = baseY + (tip.y - baseY) * along + (rng() - 0.5) * leafHeightJitter;
      const lz = baseZ + (tip.z - baseZ) * along + (rng() - 0.5) * leafJitter;
      leafQuads.push(
        this.createLeafQuad(lx, ly, lz, leafSize, rng() * Math.PI, rng)
      );
    }
  }

  expandPaletteMetricBounds(metric, geometry) {
    if (!geometry) return;

    const position = geometry.getAttribute('position');
    if (!position || position.count === 0) return;

    if (!geometry.boundingBox) {
      geometry.computeBoundingBox();
    }

    const box = geometry.boundingBox;
    if (!box) return;

    metric.minX = Math.min(metric.minX, box.min.x);
    metric.minY = Math.min(metric.minY, box.min.y);
    metric.minZ = Math.min(metric.minZ, box.min.z);
    metric.maxX = Math.max(metric.maxX, box.max.x);
    metric.maxY = Math.max(metric.maxY, box.max.y);
    metric.maxZ = Math.max(metric.maxZ, box.max.z);
  }

  buildPaletteMetrics(...geoSets) {
    const metric = {
      minX: Infinity,
      minY: Infinity,
      minZ: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
      maxZ: -Infinity,
    };

    for (const geoSet of geoSets) {
      if (!geoSet) continue;
      this.expandPaletteMetricBounds(metric, geoSet.trunk);
      this.expandPaletteMetricBounds(metric, geoSet.leaves);
    }

    if (!Number.isFinite(metric.minX)) {
      return {
        radius: 10,
        minY: 0,
        maxY: 24,
      };
    }

    const radius = Math.max(
      Math.hypot(metric.minX, metric.minZ),
      Math.hypot(metric.minX, metric.maxZ),
      Math.hypot(metric.maxX, metric.minZ),
      Math.hypot(metric.maxX, metric.maxZ)
    );

    return {
      radius,
      minY: metric.minY,
      maxY: metric.maxY,
    };
  }

  getBranchEndpoint(baseX, baseY, baseZ, angle, pitch, length) {
    const dirX = Math.cos(angle) * Math.cos(pitch);
    const dirY = Math.sin(pitch);
    const dirZ = Math.sin(angle) * Math.cos(pitch);

    return {
      x: baseX + dirX * length,
      y: baseY + dirY * length,
      z: baseZ + dirZ * length,
    };
  }

  createTrunkGeometry(height, radius, heightSegments, radialSegments, rng) {
    const verts = [];
    const indices = [];
    const uvs = [];

    for (let iy = 0; iy <= heightSegments; iy++) {
      const t = iy / heightSegments;
      const y = t * height;
      // Taper + slight wobble
      const r = radius * (1 - t * 0.6) + (rng() - 0.5) * 0.03;

      for (let ir = 0; ir < radialSegments; ir++) {
        const angle = (ir / radialSegments) * Math.PI * 2;
        const wobble = (rng() - 0.5) * 0.04;
        verts.push(
          Math.cos(angle) * (r + wobble),
          y,
          Math.sin(angle) * (r + wobble)
        );
        uvs.push(ir / radialSegments, t * 3); // repeat bark texture
      }
    }

    for (let iy = 0; iy < heightSegments; iy++) {
      for (let ir = 0; ir < radialSegments; ir++) {
        const a = iy * radialSegments + ir;
        const b = iy * radialSegments + ((ir + 1) % radialSegments);
        const c = (iy + 1) * radialSegments + ((ir + 1) % radialSegments);
        const d = (iy + 1) * radialSegments + ir;
        indices.push(a, c, b, a, d, c);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  createBranchGeometry(baseX, baseY, baseZ, angle, pitch, length, radius, rng) {
    // Simple 3-segment tube
    const segments = 2;
    const radial = 3;
    const verts = [];
    const indices = [];
    const uvs = [];

    const dirX = Math.cos(angle) * Math.cos(pitch);
    const dirY = Math.sin(pitch);
    const dirZ = Math.sin(angle) * Math.cos(pitch);

    // perpendicular vectors
    const upX = 0, upY = 1, upZ = 0;
    let rightX = dirY * upZ - dirZ * upY;
    let rightY = dirZ * upX - dirX * upZ;
    let rightZ = dirX * upY - dirY * upX;
    const rl = Math.hypot(rightX, rightY, rightZ) || 1;
    rightX /= rl; rightY /= rl; rightZ /= rl;
    let fwdX = rightY * dirZ - rightZ * dirY;
    let fwdY = rightZ * dirX - rightX * dirZ;
    let fwdZ = rightX * dirY - rightY * dirX;
    const fl = Math.hypot(fwdX, fwdY, fwdZ) || 1;
    fwdX /= fl; fwdY /= fl; fwdZ /= fl;

    for (let is = 0; is <= segments; is++) {
      const t = is / segments;
      const px = baseX + dirX * length * t;
      const py = baseY + dirY * length * t;
      const pz = baseZ + dirZ * length * t;
      const r = radius * (1 - t * 0.7);

      for (let ir = 0; ir < radial; ir++) {
        const a = (ir / radial) * Math.PI * 2;
        const cx = Math.cos(a);
        const cz = Math.sin(a);
        verts.push(
          px + (rightX * cx + fwdX * cz) * r,
          py + (rightY * cx + fwdY * cz) * r,
          pz + (rightZ * cx + fwdZ * cz) * r
        );
        uvs.push(ir / radial, t);
      }
    }

    for (let is = 0; is < segments; is++) {
      for (let ir = 0; ir < radial; ir++) {
        const a = is * radial + ir;
        const b = is * radial + ((ir + 1) % radial);
        const c = (is + 1) * radial + ((ir + 1) % radial);
        const d = (is + 1) * radial + ir;
        indices.push(a, c, b, a, d, c);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  createLeafQuad(x, y, z, size, rotation, rng) {
    const halfSize = size * 0.5;
    // Slightly varied aspect and tilt for natural look
    const aspect = 0.8 + rng() * 0.4;
    const tiltAngle = (rng() - 0.5) * 0.6;

    const geo = new THREE.PlaneGeometry(size * aspect, size);
    // Rotate for variation
    const matrix = new THREE.Matrix4();
    matrix.makeRotationY(rotation);
    const tiltMatrix = new THREE.Matrix4().makeRotationX(tiltAngle);
    matrix.multiply(tiltMatrix);
    // Translate to position
    const translateMatrix = new THREE.Matrix4().makeTranslation(x, y, z);
    translateMatrix.multiply(matrix);
    geo.applyMatrix4(translateMatrix);
    return geo;
  }

  /**
   * Simple seeded PRNG (mulberry32).
   */
  seededRandom(seed) {
    let s = Math.floor(seed) | 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Merge an array of BufferGeometries into one.
   */
  mergeBufferGeometries(geos) {
    if (geos.length === 0) {
      const empty = new THREE.BufferGeometry();
      empty.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
      return empty;
    }

    let totalVerts = 0;
    let totalIndices = 0;
    const hasUV = !!geos[0].getAttribute('uv');

    for (const g of geos) {
      totalVerts += g.getAttribute('position').count;
      totalIndices += g.index ? g.index.count : 0;
    }

    const positions = new Float32Array(totalVerts * 3);
    const uvArray = hasUV ? new Float32Array(totalVerts * 2) : null;
    const indexArray = new Uint32Array(totalIndices);

    let vertOffset = 0;
    let idxOffset = 0;
    let vertCounter = 0;

    for (const g of geos) {
      const posAttr = g.getAttribute('position');
      const count = posAttr.count;

      positions.set(posAttr.array.subarray(0, count * 3), vertOffset * 3);

      if (hasUV) {
        const uvAttr = g.getAttribute('uv');
        if (uvAttr) {
          uvArray.set(uvAttr.array.subarray(0, count * 2), vertOffset * 2);
        }
      }

      if (g.index) {
        const idx = g.index.array;
        for (let i = 0; i < idx.length; i++) {
          indexArray[idxOffset + i] = idx[i] + vertCounter;
        }
        idxOffset += idx.length;
      }

      vertCounter += count;
      vertOffset += count;
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (uvArray) {
      merged.setAttribute('uv', new THREE.Float32BufferAttribute(uvArray, 2));
    }
    if (totalIndices > 0) {
      merged.setIndex(new THREE.BufferAttribute(indexArray.subarray(0, idxOffset), 1));
    }
    merged.computeVertexNormals();
    return merged;
  }

  // ═══════════════════════════════════════════════════════════════
  //  TREE PLACEMENT (per-chunk)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Determine tree positions within a chunk using Perlin noise for distribution.
   */
  getTreePositionsForChunk(cx, cz) {
    const trees = [];
    const worldMinX = cx * this.chunkWorldSize;
    const worldMinZ = cz * this.chunkWorldSize;
    const cellSize = this.treeCellSize;
    const cellsPerSide = Math.floor(this.chunkWorldSize / cellSize);

    for (let gz = 0; gz < cellsPerSide; gz++) {
      for (let gx = 0; gx < cellsPerSide; gx++) {
        // Jittered position within cell
        const hash = this.hashTreeSeed(
          worldMinX + gx * cellSize + cellSize * 0.5,
          worldMinZ + gz * cellSize + cellSize * 0.5
        );
        const hash2 = this.hashTreeSeed(
          worldMinX + gx * cellSize + 7.3,
          worldMinZ + gz * cellSize - 13.1
        );

        const wx = worldMinX + (gx + 0.15 + hash * 0.7) * cellSize;
        const wz = worldMinZ + (gz + 0.15 + hash2 * 0.7) * cellSize;

        const baseDensity = this.getTreeBaseDensity(wx, wz);
        if (baseDensity <= 0) continue;

        if (!this.isTreeForestRegionEnabled(wx, wz)) continue;

        // Terrain checks
        const height = this.terrain.getHeight(wx, wz);
        const aboveSeaLevel = height - this.terrain.waterLevel;
        const elevationDensity = this.getTreeElevationDensity(aboveSeaLevel);
        if (elevationDensity <= 0.001) continue;

        // Slope check
        const normalY = this.terrain.getBaseNormalY(wx, wz);
        if (normalY < this.treeMaxSlope) continue;

        // Broad forest mask acts as a separate binary gate; allowed regions keep normal density.
        const spawnChance = baseDensity * elevationDensity;

        // Use hash as a per-cell random roll; tree spawns when roll < spawnChance
        const roll = this.hashTreeSeed(wx * 3.7, wz * 5.3);
        if (roll > spawnChance) continue;

        // Road avoidance
        const roadInfo = this.terrain.getRoadInfluence(wx, wz, height);
        if (roadInfo && roadInfo.dist < this.terrain.highwayHalfWidth + 8) continue;

        // Select palette index
        const paletteIdx = Math.floor(hash * this.treePaletteSize * 0.999) % this.treePaletteSize;
        // Scale variation
        const scale = 0.7 + hash2 * 0.6;
        // Rotation
        const rotY = hash * Math.PI * 2;

        const leanX = (this.hashTreeSeed(wx * 11.9, wz * -17.3) - 0.5) * 0.16;
        const leanZ = (this.hashTreeSeed(wx * -14.7, wz * 9.1) - 0.5) * 0.16;

        trees.push({ wx, wz, height, paletteIdx, scale, rotY, leanX, leanZ });

        if (trees.length >= this.maxTreesPerChunk) break;
      }
      if (trees.length >= this.maxTreesPerChunk) break;
    }

    return trees;
  }

  // ═══════════════════════════════════════════════════════════════
  //  LOD MESH CREATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Create an instanced mesh group for trees at a specific LOD within a chunk.
   */
  createChunkLodMeshes(chunk, lod) {
    if (!this.sharedReady || chunk.trees.length === 0) return null;

    const trees = chunk.trees;

    if (lod === 'billboard' || lod === 'low') {
      return this.createBillboardInstances(trees, lod);
    }

    const geoPalette = lod === 'near' ? this.nearGeometries : this.highGeometries;
    const trunkMat = lod === 'near' ? this.trunkMaterialNear : this.trunkMaterialHigh;
    const leafMat = lod === 'near' ? this.leafMaterialNear : this.leafMaterialHigh;
    const paletteGroups = chunk.paletteGroups || this.buildPaletteGroups(trees);

    const group = new THREE.Group();
    group.name = `trees-${lod}-${chunk.key}`;
    group.matrixAutoUpdate = false;

    for (let paletteIdx = 0; paletteIdx < paletteGroups.length; paletteIdx++) {
      const paletteTrees = paletteGroups[paletteIdx];
      if (!paletteTrees || paletteTrees.length === 0) continue;

      const geoSet = geoPalette[paletteIdx];
      if (!geoSet) continue;

      // Trunk instances
      if (geoSet.trunk && geoSet.trunk.getAttribute('position').count > 0) {
        const trunkMesh = new THREE.InstancedMesh(geoSet.trunk, trunkMat, paletteTrees.length);
        trunkMesh.frustumCulled = false; // we cull at chunk level
        trunkMesh.matrixAutoUpdate = false;
        trunkMesh.userData.isTreeTrunk = true; // used by sun occlusion raycaster
        trunkMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        const mat4 = this._mat4;
        const quat = this._quat;

        for (let i = 0; i < paletteTrees.length; i++) {
          const t = paletteTrees[i];
          this.composeTreeMatrix(mat4, quat, t, lod, t.rotY);
          trunkMesh.setMatrixAt(i, mat4);
        }
        trunkMesh.instanceMatrix.needsUpdate = true;
        trunkMesh.updateMatrix();
        group.add(trunkMesh);
      }

      // Leaf instances
      if (geoSet.leaves && geoSet.leaves.getAttribute('position').count > 0) {
        const leafMesh = new THREE.InstancedMesh(geoSet.leaves, leafMat, paletteTrees.length);
        leafMesh.frustumCulled = false;
        leafMesh.matrixAutoUpdate = false;
        leafMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        const mat4 = this._mat4;
        const quat = this._quat;

        for (let i = 0; i < paletteTrees.length; i++) {
          const t = paletteTrees[i];
          this.composeTreeMatrix(mat4, quat, t, lod, t.rotY);
          leafMesh.setMatrixAt(i, mat4);
        }
        leafMesh.instanceMatrix.needsUpdate = true;
        leafMesh.updateMatrix();
        group.add(leafMesh);
      }
    }

    group.userData.treeLod = lod;
    group.updateMatrix();
    return group;
  }

  composeTreeMatrix(mat4, quat, tree, lod, rotY) {
    if (lod === 'near') {
      this._euler.set(tree.leanX || 0, rotY, tree.leanZ || 0, 'YXZ');
      quat.setFromEuler(this._euler);
    } else {
      quat.setFromAxisAngle(this._yAxis, rotY);
    }

    mat4.compose(
      this._v3.set(tree.wx, tree.height, tree.wz),
      quat,
      this._scale.set(tree.scale, tree.scale, tree.scale)
    );
  }

  createBillboardInstances(trees, lod = 'low') {
    if (trees.length === 0) return null;

    const billboardTrees = this.getBillboardTreeSubset(trees);
    if (billboardTrees.length === 0) return null;

    const mat = lod === 'billboard'
      ? this.billboardMatLow
      : this.billboardMat;

    const mesh = new THREE.InstancedMesh(this.billboardGeo, mat, billboardTrees.length);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.userData.isTreeBillboard = true;
    mesh.userData.treeLod = lod;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const mat4 = this._mat4;
    const quat = this._quat;

    for (let i = 0; i < billboardTrees.length; i++) {
      const t = billboardTrees[i];
      this.composeTreeMatrix(mat4, quat, t, 'billboard', 0);
      mesh.setMatrixAt(i, mat4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.updateMatrix();
    return mesh;
  }

  getBillboardTreeSubset(trees) {
    if (!Array.isArray(trees) || trees.length === 0) {
      return [];
    }

    const subset = [];
    const renderFraction = this.billboardTreeRenderFraction;

    for (let i = 0; i < trees.length; i++) {
      const tree = trees[i];
      const selectionHash = this.hashTreeSeed(
        tree.wx * 0.173 + tree.paletteIdx * 11.7 + tree.scale * 3.1,
        tree.wz * 0.197 + tree.rotY * 0.37 + tree.height * 0.11
      );

      if (selectionHash < renderFraction) {
        subset.push(tree);
      }
    }

    if (subset.length === 0) {
      subset.push(trees[0]);
    }

    return subset;
  }

  /**
   * Update billboard instances to face camera.
   */
  updateBillboards(cameraPosition) {
    return;
  }

  getAngleDelta(a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
    let delta = a - b;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    return Math.abs(delta);
  }

  getTreeCameraAngles(camera) {
    return {
      yaw: camera && camera.rotation && Number.isFinite(camera.rotation.y) ? camera.rotation.y : 0,
      pitch: camera && camera.rotation && Number.isFinite(camera.rotation.x) ? camera.rotation.x : 0,
    };
  }

  shouldRunTreeStreamingUpdate(viewer, pcx, pcz, now) {
    if (!Number.isFinite(this.lastTreeStreamingTime)) return true;
    if (pcx !== this.lastTreeStreamingChunkX || pcz !== this.lastTreeStreamingChunkZ) return true;

    const dx = viewer.x - this.lastTreeStreamingViewer.x;
    const dy = viewer.y - this.lastTreeStreamingViewer.y;
    const dz = viewer.z - this.lastTreeStreamingViewer.z;
    if (dx * dx + dy * dy + dz * dz >= this.treeStreamingMoveThresholdSq) return true;

    return (now - this.lastTreeStreamingTime) >= this.treeStreamingIntervalMs;
  }

  shouldRunTreeVisibilityUpdate(viewer, cameraAngles, now) {
    if (!Number.isFinite(this.lastTreeVisibilityTime)) return true;

    const dx = viewer.x - this.lastTreeVisibilityViewer.x;
    const dy = viewer.y - this.lastTreeVisibilityViewer.y;
    const dz = viewer.z - this.lastTreeVisibilityViewer.z;
    if (dx * dx + dy * dy + dz * dz >= this.treeVisibilityMoveThresholdSq) return true;

    if (this.getAngleDelta(cameraAngles.yaw, this.lastTreeVisibilityYaw) >= this.treeVisibilityRotationThreshold) {
      return true;
    }

    if (this.getAngleDelta(cameraAngles.pitch, this.lastTreeVisibilityPitch) >= this.treeVisibilityRotationThreshold) {
      return true;
    }

    return (now - this.lastTreeVisibilityTime) >= this.treeVisibilityIntervalMs;
  }

  recordTreeStreamingState(viewer, pcx, pcz, now) {
    this.lastTreeStreamingTime = now;
    this.lastTreeStreamingChunkX = pcx;
    this.lastTreeStreamingChunkZ = pcz;
    this.lastTreeStreamingViewer.copy(this.treeUniforms.uViewerPos.value);
  }

  recordTreeVisibilityState(viewer, cameraAngles, now) {
    this.lastTreeVisibilityTime = now;
    this.lastTreeVisibilityViewer.set(viewer.x, viewer.y, viewer.z);
    this.lastTreeVisibilityYaw = cameraAngles.yaw;
    this.lastTreeVisibilityPitch = cameraAngles.pitch;
  }

  // ═══════════════════════════════════════════════════════════════
  //  CHUNK STREAMING & LOD MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  getLodForDistance(dist) {
    if (dist > this.lodBillboardDistance) return 'billboard';
    if (dist > this.lodLowDistance) return 'low';
    if (dist > this.lodHighDistance) return 'high';
    return 'near';
  }

  getTreeViewerPosition(playerX, playerZ, camera = null) {
    const viewerX = camera && camera.position && Number.isFinite(camera.position.x)
      ? camera.position.x
      : playerX;
    const viewerZ = camera && camera.position && Number.isFinite(camera.position.z)
      ? camera.position.z
      : playerZ;
    const viewerY = camera && camera.position && Number.isFinite(camera.position.y)
      ? camera.position.y
      : this.terrain.getHeight(viewerX, viewerZ) + 2;

    return { x: viewerX, y: viewerY, z: viewerZ };
  }

  getChunkMinDistanceSq(cx, cz, worldX, worldZ) {
    if (this.terrain && typeof this.terrain.getChunkMinDistanceSq === 'function') {
      return this.terrain.getChunkMinDistanceSq(cx, cz, worldX, worldZ);
    }

    const minX = cx * this.chunkWorldSize;
    const minZ = cz * this.chunkWorldSize;
    const maxX = minX + this.chunkWorldSize;
    const maxZ = minZ + this.chunkWorldSize;
    const nearestX = Math.max(minX, Math.min(maxX, worldX));
    const nearestZ = Math.max(minZ, Math.min(maxZ, worldZ));
    const dx = nearestX - worldX;
    const dz = nearestZ - worldZ;
    return dx * dx + dz * dz;
  }

  buildTreeChunkBounds(cx, cz, trees) {
    const minX = cx * this.chunkWorldSize;
    const minZ = cz * this.chunkWorldSize;
    const maxX = minX + this.chunkWorldSize;
    const maxZ = minZ + this.chunkWorldSize;

    if (!trees || trees.length === 0) {
      const centerX = minX + this.chunkWorldSize * 0.5;
      const centerZ = minZ + this.chunkWorldSize * 0.5;
      const baseY = this.terrain.getHeight(centerX, centerZ);
      return {
        renderBounds: new THREE.Box3(
          new THREE.Vector3(minX, baseY - 2, minZ),
          new THREE.Vector3(maxX, baseY + 30, maxZ)
        ),
        lodBounds: new THREE.Box3(
          new THREE.Vector3(minX, baseY - 1, minZ),
          new THREE.Vector3(maxX, baseY + 1, maxZ)
        ),
      };
    }

    let renderMinX = Infinity;
    let renderMinY = Infinity;
    let renderMinZ = Infinity;
    let renderMaxX = -Infinity;
    let renderMaxY = -Infinity;
    let renderMaxZ = -Infinity;
    let lodMinX = Infinity;
    let lodMinY = Infinity;
    let lodMinZ = Infinity;
    let lodMaxX = -Infinity;
    let lodMaxY = -Infinity;
    let lodMaxZ = -Infinity;

    for (const tree of trees) {
      const paletteMetric = this.paletteMetrics[tree.paletteIdx] || { radius: 10, minY: 0, maxY: 24 };
      const canopyRadius = paletteMetric.radius * tree.scale;
      const treeMinY = tree.height + paletteMetric.minY * tree.scale;
      const treeMaxY = tree.height + paletteMetric.maxY * tree.scale;

      renderMinX = Math.min(renderMinX, tree.wx - canopyRadius);
      renderMinY = Math.min(renderMinY, treeMinY);
      renderMinZ = Math.min(renderMinZ, tree.wz - canopyRadius);
      renderMaxX = Math.max(renderMaxX, tree.wx + canopyRadius);
      renderMaxY = Math.max(renderMaxY, treeMaxY);
      renderMaxZ = Math.max(renderMaxZ, tree.wz + canopyRadius);

      lodMinX = Math.min(lodMinX, tree.wx);
      lodMinY = Math.min(lodMinY, tree.height);
      lodMinZ = Math.min(lodMinZ, tree.wz);
      lodMaxX = Math.max(lodMaxX, tree.wx);
      lodMaxY = Math.max(lodMaxY, tree.height);
      lodMaxZ = Math.max(lodMaxZ, tree.wz);
    }

    return {
      renderBounds: new THREE.Box3(
        new THREE.Vector3(renderMinX - 1, renderMinY - 2, renderMinZ - 1),
        new THREE.Vector3(renderMaxX + 1, renderMaxY + 2, renderMaxZ + 1)
      ),
      lodBounds: new THREE.Box3(
        new THREE.Vector3(lodMinX - 0.5, lodMinY - 0.5, lodMinZ - 0.5),
        new THREE.Vector3(lodMaxX + 0.5, lodMaxY + 0.5, lodMaxZ + 0.5)
      ),
    };
  }

  getTreeChunkMinDistanceSq(chunk, worldX, worldY, worldZ) {
    if (!chunk) return Infinity;
    if (chunk.lodBounds && this.terrain && typeof this.terrain.getBoundsMinDistanceSq === 'function') {
      return this.terrain.getBoundsMinDistanceSq(chunk.lodBounds, worldX, worldY, worldZ);
    }
    return this.getChunkMinDistanceSq(chunk.cx, chunk.cz, worldX, worldZ);
  }

  isTreeChunkVisible(chunk) {
    if (!chunk || !chunk.bounds) return true;
    this._treeCullBox.copy(chunk.bounds);
    this._treeCullBox.expandByScalar(this.treeFrustumCullPadding);
    return this._frustum.intersectsBox(this._treeCullBox);
  }

  getTreeChunkDistanceRange(chunk, worldX, worldY, worldZ) {
    const minSq = this.getTreeChunkMinDistanceSq(chunk, worldX, worldY, worldZ);
    const lodBounds = chunk && chunk.lodBounds ? chunk.lodBounds : chunk && chunk.bounds ? chunk.bounds : null;
    if (!lodBounds) {
      return { minSq, maxSq: minSq };
    }

    const farX = Math.max(Math.abs(worldX - lodBounds.min.x), Math.abs(worldX - lodBounds.max.x));
    const farY = Math.max(Math.abs(worldY - lodBounds.min.y), Math.abs(worldY - lodBounds.max.y));
    const farZ = Math.max(Math.abs(worldZ - lodBounds.min.z), Math.abs(worldZ - lodBounds.max.z));

    return {
      minSq,
      maxSq: farX * farX + farY * farY + farZ * farZ,
    };
  }

  getTreeLodDistanceWindow(lod) {
    const fade = this.treeLodFadeDistance;

    switch (lod) {
      case 'near':
        return { min: 0, max: this.lodHighDistance, effectiveMin: 0, effectiveMax: this.lodHighDistance };
      case 'high':
        return {
          min: this.lodHighDistance,
          max: this.lodLowDistance,
          effectiveMin: Math.max(0, this.lodHighDistance - fade),
          effectiveMax: this.lodLowDistance,
        };
      case 'low':
        return {
          min: this.lodLowDistance,
          max: this.lodBillboardDistance,
          effectiveMin: Math.max(0, this.lodLowDistance - fade),
          effectiveMax: this.lodBillboardDistance,
        };
      case 'billboard':
      default:
        return {
          min: this.lodBillboardDistance,
          max: Infinity,
          effectiveMin: Math.max(0, this.lodBillboardDistance - fade),
          effectiveMax: Infinity,
        };
    }
  }

  getActiveLodsForDistanceRange(minDist, maxDist) {
    const activeLods = [];

    for (const lodKey of this.treeLodKeys) {
      const window = this.getTreeLodDistanceWindow(lodKey);
      if (maxDist < window.effectiveMin || minDist > window.effectiveMax) continue;
      activeLods.push(lodKey);
    }

    if (!activeLods.length) {
      activeLods.push(this.getLodForDistance(minDist));
    }

    return activeLods;
  }

  getActiveLodMaskForDistanceRange(minDist, maxDist) {
    let activeMask = 0;

    for (const lodKey of this.treeLodKeys) {
      const window = this.getTreeLodDistanceWindow(lodKey);
      if (maxDist < window.effectiveMin || minDist > window.effectiveMax) continue;
      activeMask |= this.treeLodBitmask[lodKey];
    }

    if (activeMask === 0) {
      activeMask = this.treeLodBitmask[this.getLodForDistance(minDist)];
    }

    return activeMask;
  }

  getLodListFromMask(mask) {
    const lods = [];
    for (const lodKey of this.treeLodKeys) {
      if (mask & this.treeLodBitmask[lodKey]) {
        lods.push(lodKey);
      }
    }
    return lods;
  }

  updateChunkLodMeshes(chunk, viewer, distanceRange = null) {
    if (!chunk || !chunk.trees || chunk.trees.length === 0) {
      if (chunk) {
        chunk.activeLods = [];
        chunk.currentLod = null;
      }
      return;
    }

    const range = distanceRange || this.getTreeChunkDistanceRange(chunk, viewer.x, viewer.y, viewer.z);
    const minDist = Math.sqrt(range.minSq);
    const maxDist = Math.sqrt(range.maxSq);
    const activeLodMask = this.getActiveLodMaskForDistanceRange(minDist, maxDist);

    chunk.distSq = range.minSq;
    chunk.maxDistSq = range.maxSq;

    if (!chunk.meshGroup) {
      chunk.meshGroup = new THREE.Group();
      chunk.meshGroup.name = `trees-${chunk.key}`;
      chunk.meshGroup.matrixAutoUpdate = false;
      chunk.meshGroup.updateMatrix();
      this.scene.add(chunk.meshGroup);
    }

    if (chunk.activeLodMask !== activeLodMask) {
      for (const lodKey of this.treeLodKeys) {
        const lodBit = this.treeLodBitmask[lodKey];
        const shouldBeActive = (activeLodMask & lodBit) !== 0;
        let lodMesh = chunk.lodMeshCache[lodKey];

        if (shouldBeActive) {
          if (!lodMesh) {
            lodMesh = this.createChunkLodMeshes(chunk, lodKey);
            if (!lodMesh) continue;
            chunk.lodMeshCache[lodKey] = lodMesh;
          }

          lodMesh.visible = true;
          if (lodMesh.parent !== chunk.meshGroup) {
            chunk.meshGroup.add(lodMesh);
          }
        } else if (lodMesh) {
          lodMesh.visible = false;
          if (lodMesh.parent === chunk.meshGroup) {
            chunk.meshGroup.remove(lodMesh);
          }
        }
      }

      chunk.activeLodMask = activeLodMask;
      chunk.activeLods = this.getLodListFromMask(activeLodMask);
      chunk.currentLod = chunk.activeLods.length === 1 ? chunk.activeLods[0] : 'mixed';
    }
  }

  /**
   * Main update – call each frame from the game loop.
   */
  update(playerX, playerZ, camera) {
    if (!this.sharedReady) return;

    this.camera = camera;
    const viewer = this.getTreeViewerPosition(playerX, playerZ, camera);
    this.treeUniforms.uViewerPos.value.set(viewer.x, viewer.y, viewer.z);
    const pcx = Math.floor(viewer.x / this.chunkWorldSize);
    const pcz = Math.floor(viewer.z / this.chunkWorldSize);
    const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
    const cameraAngles = this.getTreeCameraAngles(camera);
    const shouldRunStreamingUpdate = this.shouldRunTreeStreamingUpdate(viewer, pcx, pcz, now);
    const shouldRunVisibilityUpdate = shouldRunStreamingUpdate || this.shouldRunTreeVisibilityUpdate(viewer, cameraAngles, now);

    if (!shouldRunStreamingUpdate && !shouldRunVisibilityUpdate) {
      return;
    }

    // Update camera frustum for culling
    this._frustumMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._frustumMatrix);

    if (!shouldRunStreamingUpdate) {
      for (const [, chunk] of this.treeChunks) {
        if (chunk.meshGroup) {
          chunk.meshGroup.visible = this.isTreeChunkVisible(chunk);
        }
      }
      this.recordTreeVisibilityState(viewer, cameraAngles, now);
      return;
    }

    const needed = new Set();
    const maxViewDist = this.treeViewDistance;
    const maxLoadDistanceSq = ((maxViewDist + 0.5) * this.chunkWorldSize) ** 2;
    const maxKeepDistanceSq = ((maxViewDist + 0.5 + this.treeViewUnloadBufferChunks) * this.chunkWorldSize) ** 2;
    const loopViewDist = maxViewDist + Math.max(1, Math.ceil(this.treeViewUnloadBufferChunks));

    // Determine which chunks are needed and at what LOD
    for (let dz = -loopViewDist; dz <= loopViewDist; dz++) {
      for (let dx = -loopViewDist; dx <= loopViewDist; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        const key = `${cx},${cz}`;
        const existing = this.treeChunks.get(key);
        const horizontalDistSq = this.getChunkMinDistanceSq(cx, cz, viewer.x, viewer.z);
        const distanceLimitSq = existing ? maxKeepDistanceSq : maxLoadDistanceSq;

        if (horizontalDistSq > distanceLimitSq) continue;

        const distanceRange = existing
          ? this.getTreeChunkDistanceRange(existing, viewer.x, viewer.y, viewer.z)
          : { minSq: horizontalDistSq, maxSq: Infinity };
        const distSq = distanceRange.minSq;

        // Beyond view range
        if (!existing && distSq > maxLoadDistanceSq) continue;

        needed.add(key);

        if (existing) {
          existing.distSq = distanceRange.minSq;
          existing.maxDistSq = distanceRange.maxSq;
          this.updateChunkLodMeshes(existing, viewer, distanceRange);

          // Visibility (frustum cull at chunk level)
          if (existing.meshGroup) {
            existing.meshGroup.visible = this.isTreeChunkVisible(existing);
          }
        } else {
          // Create new tree chunk
          this.createTreeChunk(cx, cz, key, viewer);
          const createdChunk = this.treeChunks.get(key);
          if (createdChunk && createdChunk.meshGroup) {
            createdChunk.meshGroup.visible = this.isTreeChunkVisible(createdChunk);
          }
        }
      }
    }

    // Remove chunks no longer needed
    for (const [key, chunk] of this.treeChunks) {
      if (!needed.has(key)) {
        this.disposeTreeChunk(chunk);
        this.treeChunks.delete(key);
      }
    }

    this.recordTreeStreamingState(viewer, pcx, pcz, now);
    this.recordTreeVisibilityState(viewer, cameraAngles, now);
  }

  getChunkBoundingSphere(cx, cz) {
    const centerX = (cx + 0.5) * this.chunkWorldSize;
    const centerZ = (cz + 0.5) * this.chunkWorldSize;
    // Rough estimate: chunks are flat squares, radius is diagonal/2 + tree height
    const radius = this.chunkWorldSize * 0.72 + 25;
    return new THREE.Sphere(
      new THREE.Vector3(centerX, this.terrain.getHeight(centerX, centerZ), centerZ),
      radius
    );
  }

  createTreeChunk(cx, cz, key, viewer = null) {
    const trees = this.getTreePositionsForChunk(cx, cz);
    const boundsInfo = this.buildTreeChunkBounds(cx, cz, trees);

    const chunk = {
      cx,
      cz,
      key,
      trees,
      paletteGroups: this.buildPaletteGroups(trees),
      meshGroup: null,
      currentLod: null,
      activeLods: [],
      activeLodMask: 0,
      centerX: (cx + 0.5) * this.chunkWorldSize,
      centerZ: (cz + 0.5) * this.chunkWorldSize,
      distSq: Infinity,
      maxDistSq: Infinity,
      bounds: boundsInfo.renderBounds,
      lodBounds: boundsInfo.lodBounds,
      lodMeshCache: {},
    };

    if (viewer) {
      const distanceRange = this.getTreeChunkDistanceRange(chunk, viewer.x, viewer.y, viewer.z);
      chunk.distSq = distanceRange.minSq;
      chunk.maxDistSq = distanceRange.maxSq;
    }

    this.treeChunks.set(key, chunk);

    if (!trees.length || !viewer) {
      return;
    }

    this.updateChunkLodMeshes(chunk, viewer, {
      minSq: chunk.distSq,
      maxSq: chunk.maxDistSq,
    });
  }

  buildPaletteGroups(trees) {
    const groups = Array.from({ length: this.treePaletteSize }, () => []);
    for (const tree of trees) {
      groups[tree.paletteIdx].push(tree);
    }
    return groups;
  }

  disposeTreeChunk(chunk) {
    if (chunk.meshGroup) {
      this.scene.remove(chunk.meshGroup);
    }

    // Dispose all cached LOD meshes
    for (const lod in chunk.lodMeshCache) {
      const mesh = chunk.lodMeshCache[lod];
      if (!mesh) continue;
      if (mesh.parent) {
        mesh.parent.remove(mesh);
      }

      if (mesh.isGroup) {
        mesh.traverse((child) => {
          if (child.isInstancedMesh && typeof child.dispose === 'function') {
            child.dispose();
          }
        });
      } else if (mesh.isInstancedMesh && typeof mesh.dispose === 'function') {
        mesh.dispose();
      }
    }
    chunk.lodMeshCache = {};
    chunk.meshGroup = null;
    chunk.activeLods = [];
  }

  // ═══════════════════════════════════════════════════════════════
  //  CLEANUP
  // ═══════════════════════════════════════════════════════════════

  dispose() {
    for (const [, chunk] of this.treeChunks) {
      this.disposeTreeChunk(chunk);
    }
    this.treeChunks.clear();

    // Dispose palette geometries
    for (const g of this.nearGeometries) {
      if (g.trunk) g.trunk.dispose();
      if (g.leaves) g.leaves.dispose();
    }
    for (const g of this.highGeometries) {
      if (g.trunk) g.trunk.dispose();
      if (g.leaves) g.leaves.dispose();
    }
    for (const g of this.lowGeometries) {
      if (g.trunk) g.trunk.dispose();
      if (g.leaves) g.leaves.dispose();
    }

    // Dispose shared
    if (this.billboardGeo) this.billboardGeo.dispose();
    if (this.billboardMat) this.billboardMat.dispose();
    if (this.billboardMatLow) this.billboardMatLow.dispose();
    if (this.trunkMaterialNear) this.trunkMaterialNear.dispose();
    if (this.trunkMaterialHigh) this.trunkMaterialHigh.dispose();
    if (this.leafMaterialNear) this.leafMaterialNear.dispose();
    if (this.leafMaterialHigh) this.leafMaterialHigh.dispose();

    // Dispose textures
    for (const key in this.textures) {
      if (this.textures[key]) this.textures[key].dispose();
    }
  }
}

window.TreeManager = TreeManager;
