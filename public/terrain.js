/**
 * Infinite chunked terrain system using Perlin noise,
 * with deterministic seeded city anchors connected by dry-land highways.
 */
class TerrainManager {
  constructor(scene, noise) {
    this.scene = scene;
    this.noise = noise;
    this.seed = noise.seedValue || 1;

    // Terrain configuration
    this.chunkSize = 64;        // vertices per chunk side
    this.maxChunkSegments = this.chunkSize - 1;
    this.maxChunkTriangles = this.maxChunkSegments * this.maxChunkSegments * 2;
    this.chunkWorldSize = 128;  // world units per chunk
    this.viewDistance = 3;      // chunks visible in each direction
    this.minViewDistance = 2;
    this.maxViewDistance = 50;
    this.continentHeightScale = 1000; // base continents / oceans range: -1000m to +1000m
    this.continentNoiseScale = 1 / 50000; // ~50 km continents and ocean basins
    this.continentNoiseOctaves = 2;
    this.continentNoiseLacunarity = 2.05;
    this.continentNoiseGain = 0.5;
    this.continentContrast = 2.35;

    this.hillMaskNoiseScale = 1 / 18000; // broad regions where hills/lakes are allowed
    this.hillMaskThresholdMin = 0.44;
    this.hillMaskThresholdMax = 0.74;
    this.hillMaskOffsetX = 7124.17;
    this.hillMaskOffsetZ = -3811.42;
    this.hillNoiseScale = 1 / 5000; // ~1-5 km hills and lakes
    this.hillNoiseOctaves = 3;
    this.hillNoiseLacunarity = 2.0;
    this.hillNoiseGain = 0.52;
    this.hillNoiseOffsetX = -2143.86;
    this.hillNoiseOffsetZ = 1654.39;
    this.hillHeightScale = 220;
    this.hillContrast = 1.7;
    this.hillLakeDepthMultiplier = 1.12;

    this.mountainMaskNoiseScale = 1 / 28000; // rarer mountain provinces
    this.mountainMaskThresholdMin = 0.78;
    this.mountainMaskThresholdMax = 0.92;
    this.mountainMaskOffsetX = 12490.63;
    this.mountainMaskOffsetZ = -9622.48;
    this.mountainHeightScale = 1000;
    this.mountainSharpness = 1.65;
    this.mountainPrimaryScaleX = 1 / 2600;
    this.mountainPrimaryScaleZ = 1 / 11000;
    this.mountainSecondaryScaleX = 1 / 1600;
    this.mountainSecondaryScaleZ = 1 / 6200;
    this.mountainPrimaryOctaves = 3;
    this.mountainSecondaryOctaves = 2;
    this.mountainNoiseLacunarity = 2.05;
    this.mountainNoiseGain = 0.55;
    this.mountainPrimaryOffsetX = 3488.12;
    this.mountainPrimaryOffsetZ = -2196.74;
    this.mountainSecondaryOffsetX = -5871.53;
    this.mountainSecondaryOffsetZ = 4410.27;
    this.mountainPrimaryCos = Math.cos(Math.PI * 0.18);
    this.mountainPrimarySin = Math.sin(Math.PI * 0.18);
    this.mountainSecondaryCos = Math.cos(-Math.PI * 0.31);
    this.mountainSecondarySin = Math.sin(-Math.PI * 0.31);

    this.heightScale = this.continentHeightScale + this.hillHeightScale + this.mountainHeightScale;
    this.waterLevel = 0;

    // Highway / city network configuration
    this.highwayHalfWidth = 9;
    this.highwayShoulder = 10;
    this.highwayCurveSubdivisions = 10;
    this.roadSurfaceHeightOffset = 0.08;
    this.citySpacing = 50000;
    this.citySearchRadius = 17000;
    this.cityMinElevation = 12;
    this.cityMinConnections = 2;
    this.cityConnectionCandidates = 4;
    this.cityConnectionSearchRadiusCells = 4;
    this.highwayPathStep = 2500;
    this.highwayPathMargin = 30000;
    this.highwayClearance = 5;
    this.highwaySegmentCheckStep = 1200;

    this.chunks = new Map();    // key: "cx,cz" -> mesh
    this.cameraFrustum = new THREE.Frustum();
    this.cameraFrustumMatrix = new THREE.Matrix4();
    this.terrainGrassTileSize = 1.5;
    this.terrainTextureMediumDistance = 96;
    this.terrainTextureFarDistance = 224;
    this.terrainTextureBlendDistance = 28;
    this.material = this.createTerrainMaterial();
    this.roadMaterial = new THREE.MeshLambertMaterial({
      color: 0x2f3136,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });

    this.grassRenderDistance = 200;
    this.grassHighDetailDistance = 130;
    this.grassDenseSpacing = 0.006;
    this.grassSparseSpacing = 0.2;
    this.grassUltraNearDistance = 10;
    this.grassUltraRebuildDistance = 0.75;
    this.grassLodFadeDistance = 15;
    this.grassUltraFadeDistance = 4;
    this.grassUltraSpacing = 0.3;
    this.grassHeight = 1.0;
    this.grassBaseWidth = 0.078;
    this.grassMaxSlopeDegrees = 50;
    this.grassMaxSlopeY = Math.cos(this.grassMaxSlopeDegrees * Math.PI / 180);
    this.terrainRockTileSize = 6.5;
    this.terrainRockDetailDistance = 110;
    this.terrainRockBlendDistance = 42;
    this.terrainRockBumpStrength = 2.8;
    this.chunkSkirtDepth = 22;
    this.chunkLodTransitionPadding = this.chunkWorldSize * 0.35;
    this.terrainLodDefaults = [
      { distance: 192, triangles: this.maxChunkTriangles },
      { distance: 448, triangles: 2048 },
      { distance: 896, triangles: 512 },
      { distance: Infinity, triangles: 128 },
    ];
    this.terrainLodLevels = this.normalizeTerrainLodLevels(this.terrainLodDefaults);
    this.lodSettingsVersion = 0;
    this.chunkBuildBudgetMs = 5.5;
    this.chunkBuildsPerFrame = 2;
    this.chunkGenerationQueue = [];
    this.chunkGenerationQueuedKeys = new Set();
    this.chunkGenerationQueuedEntries = new Map();
    this.chunkGenerationQueueNeedsSort = false;
    this.grassBuildBudgetMs = 3.5;
    this.grassBuildsPerFrame = 1;
    this.grassLowBuildPadding = 56;
    this.grassHighBuildPadding = 28;
    this.grassGenerationQueue = [];
    this.grassGenerationQueuedKeys = new Set();
    this.grassGenerationQueueNeedsSort = false;
    this.currentNeededChunkKeys = new Set();
    this.currentGrassBuildKeys = new Set();
    this.cachedRoadBounds = null;
    this.playerSpeed = 0;
    this.grassBladesEnabled = true;
    this.grassSuspendSpeed = 28;
    this.grassResumeSpeed = 18;
    this.grassStreamingSuspended = false;
    this.lastTerrainUpdateX = Number.NaN;
    this.lastTerrainUpdateZ = Number.NaN;
    this.lastTerrainUpdateTime = 0;
    this.grassUltraRebuildMinIntervalMs = 90;
    this.lastUltraGrassRebuildTime = -Infinity;
    this.chunkTopologyCache = new Map();
    this.chunkIndexTemplate = this.createChunkIndexTemplate(this.chunkSize);
    this.chunkTopologyCache.set(this.chunkSize, {
      indices: this.chunkIndexTemplate,
      boundaryRing: this.createChunkBoundaryRing(this.chunkSize),
    });

    this.highways = [];
    this.setupHighways();
    this.setupGrass();
  }

  setWaterLevel(level) {
    this.waterLevel = level;
  }

  setViewDistance(distance) {
    const parsedDistance = Math.round(Number(distance));
    const safeDistance = Number.isFinite(parsedDistance) ? parsedDistance : this.viewDistance;
    const nextDistance = this.clamp(safeDistance, this.minViewDistance, this.maxViewDistance);
    const changed = nextDistance !== this.viewDistance;
    this.viewDistance = nextDistance;
    return changed;
  }

  clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  lerp(a, b, t) {
    return a + (b - a) * t;
  }

  smoothstep(edge0, edge1, x) {
    if (edge0 === edge1) return x < edge0 ? 0 : 1;
    const t = this.clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  mix3(a, b, t) {
    return [
      this.lerp(a[0], b[0], t),
      this.lerp(a[1], b[1], t),
      this.lerp(a[2], b[2], t),
    ];
  }

  remapNoise01(value) {
    return this.clamp(value * 0.5 + 0.5, 0, 1);
  }

  sampleNoise01(worldX, worldZ, scale, offsetX = 0, offsetZ = 0) {
    return this.remapNoise01(
      this.noise.perlin2((worldX + offsetX) * scale, (worldZ + offsetZ) * scale)
    );
  }

  sampleAnisotropicFbm(worldX, worldZ, scaleX, scaleZ, octaves = 4, lacunarity = 2, gain = 0.5, cosAngle = 1, sinAngle = 0) {
    const rotatedX = worldX * cosAngle - worldZ * sinAngle;
    const rotatedZ = worldX * sinAngle + worldZ * cosAngle;
    let value = 0;
    let amplitude = 1;
    let maxValue = 0;
    let freqX = scaleX;
    let freqZ = scaleZ;

    for (let octave = 0; octave < octaves; octave++) {
      value += amplitude * this.noise.perlin2(rotatedX * freqX, rotatedZ * freqZ);
      maxValue += amplitude;
      amplitude *= gain;
      freqX *= lacunarity;
      freqZ *= lacunarity;
    }

    return maxValue > 0 ? value / maxValue : 0;
  }

  sampleRidgedRangeNoise(worldX, worldZ, scaleX, scaleZ, octaves = 4, lacunarity = 2, gain = 0.5, cosAngle = 1, sinAngle = 0) {
    const folded = this.sampleAnisotropicFbm(
      worldX,
      worldZ,
      scaleX,
      scaleZ,
      octaves,
      lacunarity,
      gain,
      cosAngle,
      sinAngle
    );
    const ridge = 1 - Math.abs(folded);
    return ridge * ridge;
  }

  hash2(x, z, salt = 0) {
    const n = Math.sin(x * 127.1 + z * 311.7 + this.seed * 74.7 + salt * 19.19) * 43758.5453123;
    return n - Math.floor(n);
  }

  // Get chunk coordinates for a world position
  worldToChunk(x, z) {
    return {
      cx: Math.floor(x / this.chunkWorldSize),
      cz: Math.floor(z / this.chunkWorldSize),
    };
  }

  createTerrainTexture(path) {
    const texture = new THREE.TextureLoader().load(path);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.encoding = THREE.sRGBEncoding;
    texture.needsUpdate = true;
    return texture;
  }

  createTerrainMaterial() {
    this.terrainUniforms = {
      uPlayerXZ: { value: new THREE.Vector2(0, 0) },
      uGrassTileSize: { value: this.terrainGrassTileSize },
      uTextureMediumDistance: { value: this.terrainTextureMediumDistance },
      uTextureFarDistance: { value: this.terrainTextureFarDistance },
      uTextureBlendDistance: { value: this.terrainTextureBlendDistance },
      uGrassSlopeLimit: { value: this.grassMaxSlopeY },
      uRockTileSize: { value: this.terrainRockTileSize },
      uRockDetailDistance: { value: this.terrainRockDetailDistance },
      uRockBlendDistance: { value: this.terrainRockBlendDistance },
      uRockBumpStrength: { value: this.terrainRockBumpStrength },
    };

    this.terrainGrassTextureHigh = this.createTerrainTexture('/assets/textures/terrain/grass-high.jpg');
    this.terrainGrassTextureMedium = this.createTerrainTexture('/assets/textures/terrain/grass-medium.jpg');
    this.terrainGrassTextureLow = this.createTerrainTexture('/assets/textures/terrain/grass-low.jpg');

    const material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.FrontSide,
      transparent: false,
      depthWrite: true,
      depthTest: true,
    });

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTerrainPlayerXZ = this.terrainUniforms.uPlayerXZ;
      shader.uniforms.uTerrainGrassTileSize = this.terrainUniforms.uGrassTileSize;
      shader.uniforms.uTerrainTextureMediumDistance = this.terrainUniforms.uTextureMediumDistance;
      shader.uniforms.uTerrainTextureFarDistance = this.terrainUniforms.uTextureFarDistance;
      shader.uniforms.uTerrainTextureBlendDistance = this.terrainUniforms.uTextureBlendDistance;
      shader.uniforms.uTerrainGrassSlopeLimit = this.terrainUniforms.uGrassSlopeLimit;
      shader.uniforms.uTerrainRockTileSize = this.terrainUniforms.uRockTileSize;
      shader.uniforms.uTerrainRockDetailDistance = this.terrainUniforms.uRockDetailDistance;
      shader.uniforms.uTerrainRockBlendDistance = this.terrainUniforms.uRockBlendDistance;
      shader.uniforms.uTerrainRockBumpStrength = this.terrainUniforms.uRockBumpStrength;
      shader.uniforms.uTerrainGrassHigh = { value: this.terrainGrassTextureHigh };
      shader.uniforms.uTerrainGrassMedium = { value: this.terrainGrassTextureMedium };
      shader.uniforms.uTerrainGrassLow = { value: this.terrainGrassTextureLow };

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
        attribute float terrainGrassMask;
        varying float vTerrainGrassMask;
        varying vec2 vTerrainWorldXZ;
        varying vec3 vTerrainWorldPos;
        varying float vTerrainNormalY;`
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <defaultnormal_vertex>',
        `#include <defaultnormal_vertex>
        vec3 terrainWorldNormal = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);
        vTerrainNormalY = terrainWorldNormal.y;`
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vTerrainGrassMask = terrainGrassMask;
        vec4 terrainWorldPosition = modelMatrix * vec4(transformed, 1.0);
        vTerrainWorldXZ = terrainWorldPosition.xz;
        vTerrainWorldPos = terrainWorldPosition.xyz;`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D uTerrainGrassHigh;
        uniform sampler2D uTerrainGrassMedium;
        uniform sampler2D uTerrainGrassLow;
        uniform vec2 uTerrainPlayerXZ;
        uniform float uTerrainGrassTileSize;
        uniform float uTerrainTextureMediumDistance;
        uniform float uTerrainTextureFarDistance;
        uniform float uTerrainTextureBlendDistance;
        uniform float uTerrainGrassSlopeLimit;
        uniform float uTerrainRockTileSize;
        uniform float uTerrainRockDetailDistance;
        uniform float uTerrainRockBlendDistance;
        uniform float uTerrainRockBumpStrength;
        varying float vTerrainGrassMask;
        varying vec2 vTerrainWorldXZ;
        varying vec3 vTerrainWorldPos;
        varying float vTerrainNormalY;

        float terrainHash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        float terrainNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);

          return mix(
            mix(terrainHash12(i + vec2(0.0, 0.0)), terrainHash12(i + vec2(1.0, 0.0)), u.x),
            mix(terrainHash12(i + vec2(0.0, 1.0)), terrainHash12(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }

        float terrainFbm(vec2 p) {
          float value = 0.0;
          float amplitude = 0.5;
          for (int i = 0; i < 4; i++) {
            value += terrainNoise(p) * amplitude;
            p = p * 2.03 + vec2(17.13, -9.41);
            amplitude *= 0.5;
          }
          return value;
        }

        float terrainRockHeight(vec2 uv, float worldHeight) {
          float macro = terrainFbm(uv * 0.85 + vec2(worldHeight * 0.014, -worldHeight * 0.011));
          float grains = terrainFbm(uv * 3.9 + vec2(7.4, -3.1) - worldHeight * 0.034);
          float veins = terrainNoise(uv * vec2(1.5, 5.4) + vec2(worldHeight * 0.021, 9.7));
          float crackNoise = abs(terrainNoise(uv * 7.2 + vec2(13.1, -8.4) + worldHeight * 0.01) * 2.0 - 1.0);
          float cracks = 1.0 - smoothstep(0.18, 0.72, crackNoise);
          return clamp(macro * 0.58 + grains * 0.26 + veins * 0.16 - cracks * 0.18, 0.0, 1.0);
        }

        vec3 terrainSrgbToLinear(vec3 color) {
          return pow(color, vec3(2.2));
        }`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float terrainDistance = distance(vTerrainWorldXZ, uTerrainPlayerXZ);
        float slopeGrassFade = smoothstep(uTerrainGrassSlopeLimit - 0.015, uTerrainGrassSlopeLimit + 0.055, vTerrainNormalY);
        float rockMask = 1.0 - smoothstep(uTerrainGrassSlopeLimit - 0.08, uTerrainGrassSlopeLimit + 0.08, vTerrainNormalY);
        rockMask = clamp(rockMask, 0.0, 1.0);

        if (rockMask > 0.001) {
          vec2 rockUv = vTerrainWorldXZ / max(uTerrainRockTileSize, 0.0001);
          float dust = terrainFbm(rockUv * 0.55 + vec2(vTerrainWorldPos.y * 0.012, -vTerrainWorldPos.y * 0.009));
          float grains = terrainFbm(rockUv * 3.8 - vec2(vTerrainWorldPos.y * 0.035, vTerrainWorldPos.y * 0.028));
          float rockHeight = terrainRockHeight(rockUv, vTerrainWorldPos.y);
          float bumpOffset = 0.18;
          float rockDx = terrainRockHeight(rockUv + vec2(bumpOffset, 0.0), vTerrainWorldPos.y)
            - terrainRockHeight(rockUv - vec2(bumpOffset, 0.0), vTerrainWorldPos.y);
          float rockDz = terrainRockHeight(rockUv + vec2(0.0, bumpOffset), vTerrainWorldPos.y)
            - terrainRockHeight(rockUv - vec2(0.0, bumpOffset), vTerrainWorldPos.y);
          vec3 detailNormal = normalize(vec3(
            -rockDx * uTerrainRockBumpStrength,
            1.0,
            -rockDz * uTerrainRockBumpStrength
          ));
          float detailLight = clamp(dot(detailNormal, normalize(vec3(-0.45, 0.86, 0.22))), 0.0, 1.0);
          vec3 farRock = mix(vec3(0.31, 0.31, 0.33), vec3(0.48, 0.49, 0.52), rockHeight);
          vec3 dirtTint = mix(vec3(0.34, 0.29, 0.22), vec3(0.44, 0.38, 0.30), dust);
          vec3 rockTint = mix(farRock, dirtTint, smoothstep(0.2, 0.78, dust) * 0.38);
          vec3 detailRock = rockTint * mix(0.78, 1.16, detailLight);
          detailRock *= mix(0.9, 1.08, grains);
          float rockDetailFade = 1.0 - smoothstep(
            uTerrainRockDetailDistance - uTerrainRockBlendDistance,
            uTerrainRockDetailDistance + uTerrainRockBlendDistance,
            terrainDistance
          );
          vec3 rockySurface = mix(farRock, detailRock, rockDetailFade);
          diffuseColor.rgb = mix(diffuseColor.rgb, rockySurface, rockMask);
        }

        float effectiveGrassMask = clamp(vTerrainGrassMask * slopeGrassFade, 0.0, 1.0);
        if (effectiveGrassMask > 0.001) {
          vec2 grassUv = vTerrainWorldXZ / max(uTerrainGrassTileSize, 0.0001);
          float highToMedium = smoothstep(
            uTerrainTextureMediumDistance - uTerrainTextureBlendDistance,
            uTerrainTextureMediumDistance + uTerrainTextureBlendDistance,
            terrainDistance
          );
          float mediumToLow = smoothstep(
            uTerrainTextureFarDistance - uTerrainTextureBlendDistance,
            uTerrainTextureFarDistance + uTerrainTextureBlendDistance,
            terrainDistance
          );
          vec3 grassHigh = terrainSrgbToLinear(texture2D(uTerrainGrassHigh, grassUv).rgb);
          vec3 grassMedium = terrainSrgbToLinear(texture2D(uTerrainGrassMedium, grassUv).rgb);
          vec3 grassLow = terrainSrgbToLinear(texture2D(uTerrainGrassLow, grassUv).rgb);
          vec3 grassTex = mix(grassHigh, grassMedium, highToMedium);
          grassTex = mix(grassTex, grassLow, mediumToLow);
          float terrainLuma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          vec3 grassTint = mix(vec3(0.9, 1.02, 0.84), vec3(1.02, 1.1, 0.94), clamp(terrainLuma, 0.0, 1.0));
          vec3 texturedGrass = grassTex * grassTint * mix(0.88, 1.05, terrainLuma);
          diffuseColor.rgb = mix(diffuseColor.rgb, texturedGrass, effectiveGrassMask);
        }`
      );
    };

    material.customProgramCacheKey = () => 'terrain-grass-texture-v3';
    return material;
  }

  // Base terrain height before any roads flatten or cut the terrain
  getBaseHeight(worldX, worldZ) {
    const continentNoise = this.noise.fbm(
      worldX * this.continentNoiseScale,
      worldZ * this.continentNoiseScale,
      this.continentNoiseOctaves,
      this.continentNoiseLacunarity,
      this.continentNoiseGain
    );
    const continentHeight = Math.tanh(continentNoise * this.continentContrast) * this.continentHeightScale;

    const landMask = this.smoothstep(-120, 180, continentHeight);

    const hillRegionMask = this.smoothstep(
      this.hillMaskThresholdMin,
      this.hillMaskThresholdMax,
      this.sampleNoise01(worldX, worldZ, this.hillMaskNoiseScale, this.hillMaskOffsetX, this.hillMaskOffsetZ)
    ) * landMask;

    let hillHeight = Math.tanh(
      this.noise.fbm(
        (worldX + this.hillNoiseOffsetX) * this.hillNoiseScale,
        (worldZ + this.hillNoiseOffsetZ) * this.hillNoiseScale,
        this.hillNoiseOctaves,
        this.hillNoiseLacunarity,
        this.hillNoiseGain
      ) * this.hillContrast
    ) * this.hillHeightScale;

    if (hillHeight < 0) {
      hillHeight *= this.hillLakeDepthMultiplier;
    }

    hillHeight *= hillRegionMask;

    const mountainRegionNoise = this.sampleNoise01(
      worldX,
      worldZ,
      this.mountainMaskNoiseScale,
      this.mountainMaskOffsetX,
      this.mountainMaskOffsetZ
    );
    const inlandMountainMask = this.smoothstep(80, 320, continentHeight + Math.max(0, hillHeight));
    const mountainRegionMask = this.smoothstep(
      this.mountainMaskThresholdMin,
      this.mountainMaskThresholdMax,
      mountainRegionNoise
    ) * inlandMountainMask;

    const mountainPrimary = this.sampleRidgedRangeNoise(
      worldX + this.mountainPrimaryOffsetX,
      worldZ + this.mountainPrimaryOffsetZ,
      this.mountainPrimaryScaleX,
      this.mountainPrimaryScaleZ,
      this.mountainPrimaryOctaves,
      this.mountainNoiseLacunarity,
      this.mountainNoiseGain,
      this.mountainPrimaryCos,
      this.mountainPrimarySin
    );
    const mountainSecondary = this.sampleRidgedRangeNoise(
      worldX + this.mountainSecondaryOffsetX,
      worldZ + this.mountainSecondaryOffsetZ,
      this.mountainSecondaryScaleX,
      this.mountainSecondaryScaleZ,
      this.mountainSecondaryOctaves,
      this.mountainNoiseLacunarity,
      this.mountainNoiseGain,
      this.mountainSecondaryCos,
      this.mountainSecondarySin
    );
    const mountainBlend = this.lerp(
      mountainPrimary,
      mountainSecondary,
      this.smoothstep(0.35, 0.8, mountainRegionNoise)
    );
    const mountainHeight = Math.pow(this.clamp(mountainBlend, 0, 1), this.mountainSharpness)
      * this.mountainHeightScale
      * mountainRegionMask;

    return continentHeight + hillHeight + mountainHeight;
  }

  // Get terrain height at world position after roads are applied
  getHeight(worldX, worldZ) {
    const baseHeight = this.getBaseHeight(worldX, worldZ);
    const roadInfo = this.getRoadInfluence(worldX, worldZ, baseHeight);
    return roadInfo ? roadInfo.height : baseHeight;
  }

  getSurfaceNormal(worldX, worldZ) {
    // Sample height at nearby points to compute surface normal
    const sampleDist = 2; // sample distance
    const h0 = this.getHeight(worldX, worldZ);
    const hX = this.getHeight(worldX + sampleDist, worldZ);
    const hZ = this.getHeight(worldX, worldZ + sampleDist);

    // Compute normal from height differences
    // Edge 1: (sampleDist, 0, hX - h0)
    // Edge 2: (0, sampleDist, hZ - h0)
    const normal = new THREE.Vector3(
      -(hX - h0) / sampleDist,
      1,
      -(hZ - h0) / sampleDist
    );
    normal.normalize();
    return normal;
  }

  setupHighways() {
    this.highways = [];
    this.cityCache = new Map();
    this.highwayCache = new Map();
  }

  setupGrass() {
    this.grassUniforms = {
      uTime: { value: 0 },
      uPlayerXZ: { value: new THREE.Vector2(0, 0) },
    };
    this.grassUltraCullSphere = new THREE.Sphere();
    this.grassUltraGeometry = this.createDetailedGrassBladeGeometry(this.grassHeight, this.grassBaseWidth, 4);
    this.grassDetailedGeometry = this.createDetailedGrassBladeGeometry(this.grassHeight, this.grassBaseWidth, 3);
    this.grassSimpleGeometry = this.createSimpleGrassBladeGeometry();
    this.grassUltraMaterial = this.createGrassMaterial(0, this.grassUltraNearDistance, this.grassUltraFadeDistance);
    this.grassDetailedMaterial = this.createGrassMaterial(0, this.grassHighDetailDistance, this.grassLodFadeDistance);
    this.grassSimpleMaterial = this.createGrassMaterial(this.grassHighDetailDistance, this.grassRenderDistance, this.grassLodFadeDistance);
    this.grassUltraMesh = null;
    this.grassUltraLastX = Number.NaN;
    this.grassUltraLastZ = Number.NaN;
  }

  createChunkBoundaryRing(size = this.chunkSize) {
    const ring = [];

    for (let ix = 0; ix < size; ix++) {
      ring.push(ix);
    }

    for (let iz = 1; iz < size; iz++) {
      ring.push(iz * size + (size - 1));
    }

    for (let ix = size - 2; ix >= 0; ix--) {
      ring.push((size - 1) * size + ix);
    }

    for (let iz = size - 2; iz >= 1; iz--) {
      ring.push(iz * size);
    }

    return ring;
  }

  getChunkTopology(size = this.chunkSize) {
    if (this.chunkTopologyCache.has(size)) {
      return this.chunkTopologyCache.get(size);
    }

    const topology = {
      indices: this.createChunkIndexTemplate(size),
      boundaryRing: this.createChunkBoundaryRing(size),
    };

    this.chunkTopologyCache.set(size, topology);
    return topology;
  }

  createChunkIndexTemplate(size = this.chunkSize) {
    const quadCount = (size - 1) * (size - 1);
    const boundaryRing = this.createChunkBoundaryRing(size);
    const boundaryCount = boundaryRing.length;
    const indices = new Uint16Array(quadCount * 6 + boundaryCount * 6);
    const mainVertexCount = size * size;
    let offset = 0;

    for (let iz = 0; iz < size - 1; iz++) {
      for (let ix = 0; ix < size - 1; ix++) {
        const a = iz * size + ix;
        const b = a + 1;
        const c = a + size;
        const d = c + 1;
        indices[offset++] = a;
        indices[offset++] = c;
        indices[offset++] = b;
        indices[offset++] = b;
        indices[offset++] = c;
        indices[offset++] = d;
      }
    }

    for (let ringIndex = 0; ringIndex < boundaryCount; ringIndex++) {
      const nextRingIndex = (ringIndex + 1) % boundaryCount;
      const a = boundaryRing[ringIndex];
      const b = boundaryRing[nextRingIndex];
      const skirtA = mainVertexCount + ringIndex;
      const skirtB = mainVertexCount + nextRingIndex;

      indices[offset++] = a;
      indices[offset++] = b;
      indices[offset++] = skirtA;
      indices[offset++] = skirtA;
      indices[offset++] = b;
      indices[offset++] = skirtB;
    }

    return indices;
  }

  buildHeightfieldNormals(heights, size, step) {
    const normals = new Float32Array(size * size * 3);
    const upScale = Math.max(step * 2, 1e-4);

    for (let iz = 0; iz < size; iz++) {
      const upZ = Math.max(0, iz - 1);
      const downZ = Math.min(size - 1, iz + 1);

      for (let ix = 0; ix < size; ix++) {
        const leftX = Math.max(0, ix - 1);
        const rightX = Math.min(size - 1, ix + 1);
        const leftHeight = heights[iz * size + leftX];
        const rightHeight = heights[iz * size + rightX];
        const upHeight = heights[upZ * size + ix];
        const downHeight = heights[downZ * size + ix];
        const nx = leftHeight - rightHeight;
        const ny = upScale;
        const nz = upHeight - downHeight;
        const invLength = 1 / Math.max(1e-6, Math.hypot(nx, ny, nz));
        const index = (iz * size + ix) * 3;

        normals[index] = nx * invLength;
        normals[index + 1] = ny * invLength;
        normals[index + 2] = nz * invLength;
      }
    }

    return normals;
  }

  clearChunkGenerationState() {
    this.chunkGenerationQueue.length = 0;
    this.chunkGenerationQueuedKeys.clear();
    this.chunkGenerationQueuedEntries.clear();
    this.chunkGenerationQueueNeedsSort = false;
  }

  normalizeTerrainLodDistance(value, fallback = this.chunkWorldSize) {
    const parsedValue = Math.round(Number(value));
    const safeValue = Number.isFinite(parsedValue) ? parsedValue : fallback;
    const maxDistance = Math.max(this.chunkWorldSize, this.maxViewDistance * this.chunkWorldSize * 4);
    return this.clamp(safeValue, Math.round(this.chunkWorldSize * 0.5), maxDistance);
  }

  normalizeTerrainLodTriangles(value, fallback = this.maxChunkTriangles) {
    const parsedValue = Math.round(Number(value));
    const safeValue = Number.isFinite(parsedValue) ? parsedValue : fallback;
    return this.clamp(safeValue, 32, this.maxChunkTriangles);
  }

  normalizeTerrainLodLevels(levels = this.terrainLodDefaults) {
    const defaults = Array.isArray(this.terrainLodDefaults) && this.terrainLodDefaults.length
      ? this.terrainLodDefaults
      : levels;
    const sourceLevels = Array.isArray(levels) && levels.length ? levels : defaults;
    const normalized = [];
    const lastLevelIndex = defaults.length - 1;
    let previousDistance = Math.round(this.chunkWorldSize * 0.5) - 16;

    for (let index = 0; index < defaults.length; index++) {
      const fallback = defaults[index] || defaults[lastLevelIndex];
      const source = sourceLevels[index] || fallback;
      const triangles = this.normalizeTerrainLodTriangles(source.triangles, fallback.triangles);

      if (index === lastLevelIndex) {
        normalized.push({ distance: Infinity, triangles });
        continue;
      }

      const requestedDistance = source.maxDistance ?? source.distance;
      const distance = Math.max(
        previousDistance + 16,
        this.normalizeTerrainLodDistance(requestedDistance, fallback.distance)
      );

      normalized.push({ distance, triangles });
      previousDistance = distance;
    }

    return normalized;
  }

  getTerrainLodInfo(levelIndex = 0) {
    const lastLevelIndex = this.terrainLodLevels.length - 1;
    const safeLevelIndex = this.clamp(Math.round(Number(levelIndex)) || 0, 0, lastLevelIndex);
    const level = this.terrainLodLevels[safeLevelIndex] || this.terrainLodLevels[lastLevelIndex];
    const segments = this.clamp(
      Math.floor(Math.sqrt(this.normalizeTerrainLodTriangles(level.triangles) / 2)),
      4,
      this.maxChunkSegments
    );
    const actualTriangles = segments * segments * 2;
    const skirtTriangles = segments * 8;

    return {
      level: safeLevelIndex,
      maxDistance: level.distance,
      targetTriangles: level.triangles,
      actualTriangles,
      skirtTriangles,
      renderedTriangles: actualTriangles + skirtTriangles,
      segments,
      gridSize: segments + 1,
    };
  }

  getTerrainLodSettings() {
    return this.terrainLodLevels.map((level, index) => {
      const info = this.getTerrainLodInfo(index);
      return {
        level: index,
        maxDistance: level.distance,
        trianglesTarget: info.targetTriangles,
        actualTriangles: info.actualTriangles,
        skirtTriangles: info.skirtTriangles,
        renderedTriangles: info.renderedTriangles,
        segments: info.segments,
        gridSize: info.gridSize,
      };
    });
  }

  setTerrainLodSettings(levels) {
    const normalizedLevels = this.normalizeTerrainLodLevels(levels);
    const unchanged = normalizedLevels.length === this.terrainLodLevels.length
      && normalizedLevels.every((level, index) => {
        const current = this.terrainLodLevels[index];
        return current && current.distance === level.distance && current.triangles === level.triangles;
      });

    if (unchanged) return false;

    this.terrainLodLevels = normalizedLevels;
    this.lodSettingsVersion += 1;
    this.clearChunkGenerationState();
    return true;
  }

  getBaseLodLevelForDistance(distance) {
    const safeDistance = Math.max(0, Number(distance) || 0);

    for (let index = 0; index < this.terrainLodLevels.length - 1; index++) {
      if (safeDistance <= this.terrainLodLevels[index].distance) {
        return index;
      }
    }

    return this.terrainLodLevels.length - 1;
  }

  getDesiredLodLevel(distance, currentLevel = null) {
    const safeDistance = Math.max(0, Number(distance) || 0);
    const safeCurrentLevel = Number.isInteger(currentLevel)
      ? this.clamp(currentLevel, 0, this.terrainLodLevels.length - 1)
      : null;

    if (safeCurrentLevel === null) {
      return this.getBaseLodLevelForDistance(safeDistance);
    }

    const minDistance = safeCurrentLevel === 0
      ? -Infinity
      : this.terrainLodLevels[safeCurrentLevel - 1].distance - this.chunkLodTransitionPadding;
    const maxDistance = safeCurrentLevel >= this.terrainLodLevels.length - 1
      ? Infinity
      : this.terrainLodLevels[safeCurrentLevel].distance + this.chunkLodTransitionPadding;

    if (safeDistance >= minDistance && safeDistance <= maxDistance) {
      return safeCurrentLevel;
    }

    return this.getBaseLodLevelForDistance(safeDistance);
  }

  clearGrassGenerationState() {
    this.grassGenerationQueue.length = 0;
    this.grassGenerationQueuedKeys.clear();
    this.grassGenerationQueueNeedsSort = false;
    this.currentGrassBuildKeys = new Set();
  }

  setGrassBladesEnabled(enabled) {
    const nextState = enabled !== false;
    if (this.grassBladesEnabled === nextState) return;

    this.grassBladesEnabled = nextState;
    this.clearGrassGenerationState();
    this.removeUltraNearGrass();
    this.grassUltraLastX = Number.NaN;
    this.grassUltraLastZ = Number.NaN;

    if (!nextState) {
      for (const chunk of this.chunks.values()) {
        this.removeGrassFromChunk(chunk);
      }
    }
  }

  setGrassStreamingSuspended(suspended) {
    const nextState = !!suspended;
    if (this.grassStreamingSuspended === nextState) return;

    this.grassStreamingSuspended = nextState;

    if (nextState) {
      this.clearGrassGenerationState();
      this.removeUltraNearGrass();

      for (const chunk of this.chunks.values()) {
        if (chunk.grassHighMesh) chunk.grassHighMesh.visible = false;
        if (chunk.grassLowMesh) chunk.grassLowMesh.visible = false;
      }
    }
  }

  updatePlayerMotionEstimate(playerX, playerZ) {
    const now = performance.now();

    if (!Number.isFinite(this.lastTerrainUpdateX) || !Number.isFinite(this.lastTerrainUpdateZ) || this.lastTerrainUpdateTime <= 0) {
      this.lastTerrainUpdateX = playerX;
      this.lastTerrainUpdateZ = playerZ;
      this.lastTerrainUpdateTime = now;
      this.playerSpeed = 0;
      return;
    }

    const dt = Math.max((now - this.lastTerrainUpdateTime) * 0.001, 1 / 240);
    const distance = Math.hypot(playerX - this.lastTerrainUpdateX, playerZ - this.lastTerrainUpdateZ);
    const instantaneousSpeed = distance / dt;

    this.playerSpeed = this.lerp(this.playerSpeed, instantaneousSpeed, 0.35);
    this.lastTerrainUpdateX = playerX;
    this.lastTerrainUpdateZ = playerZ;
    this.lastTerrainUpdateTime = now;
  }

  shouldRefreshRoadNetwork(minX, minZ, maxX, maxZ) {
    if (!this.cachedRoadBounds) return true;

    return (
      minX < this.cachedRoadBounds.minX ||
      minZ < this.cachedRoadBounds.minZ ||
      maxX > this.cachedRoadBounds.maxX ||
      maxZ > this.cachedRoadBounds.maxZ
    );
  }

  queueChunkGeneration(cx, cz, priority = 0, lodLevel = 0, rebuild = false) {
    const key = `${cx},${cz}`;

    if (!rebuild && this.chunks.has(key)) return;

    const queuedEntry = this.chunkGenerationQueuedEntries.get(key);
    if (queuedEntry) {
      queuedEntry.priority = Math.min(queuedEntry.priority, priority);
      queuedEntry.lodLevel = lodLevel;
      queuedEntry.rebuild = queuedEntry.rebuild || rebuild;
      queuedEntry.settingsVersion = this.lodSettingsVersion;
      this.chunkGenerationQueueNeedsSort = true;
      return;
    }

    const entry = { key, cx, cz, priority, lodLevel, rebuild, settingsVersion: this.lodSettingsVersion };
    this.chunkGenerationQueue.push(entry);
    this.chunkGenerationQueuedKeys.add(key);
    this.chunkGenerationQueuedEntries.set(key, entry);
    this.chunkGenerationQueueNeedsSort = true;
  }

  processChunkGenerationQueue() {
    if (!this.chunkGenerationQueue.length) return;

    const maxBuilds = this.playerSpeed > 22 ? 1 : this.chunkBuildsPerFrame;
    const budgetMs = this.playerSpeed > 22 ? this.chunkBuildBudgetMs : this.chunkBuildBudgetMs * 1.5;
    const startTime = performance.now();
    let builtCount = 0;

    if (this.chunkGenerationQueueNeedsSort) {
      if (this.chunkGenerationQueue.length > 1) {
        this.chunkGenerationQueue.sort((a, b) => b.priority - a.priority);
      }
      this.chunkGenerationQueueNeedsSort = false;
    }

    while (
      this.chunkGenerationQueue.length > 0 &&
      builtCount < maxBuilds &&
      (performance.now() - startTime) < budgetMs
    ) {
      const entry = this.chunkGenerationQueue.pop();
      if (!entry) break;

      this.chunkGenerationQueuedKeys.delete(entry.key);
      this.chunkGenerationQueuedEntries.delete(entry.key);

      if (this.currentNeededChunkKeys && !this.currentNeededChunkKeys.has(entry.key)) {
        continue;
      }

      const existingChunk = this.chunks.get(entry.key);
      if (
        existingChunk
        && existingChunk.lodLevel === entry.lodLevel
        && existingChunk.lodSettingsVersion === this.lodSettingsVersion
        && !entry.rebuild
      ) {
        continue;
      }

      this.generateChunk(entry.cx, entry.cz, entry.lodLevel, { replace: !!existingChunk });
      builtCount += 1;
    }
  }

  getGrassQueueKey(chunkKey, lodKey) {
    return `${chunkKey}:${lodKey}`;
  }

  queueGrassChunkBuild(chunk, lodKey, priority = 0) {
    if (!chunk || !this.grassBladesEnabled) return;

    const chunkKey = chunk.key || `${chunk.cx},${chunk.cz}`;
    const ready = lodKey === 'high' ? chunk.grassHighReady : chunk.grassLowReady;
    if (ready) return;

    const queueKey = this.getGrassQueueKey(chunkKey, lodKey);
    if (this.grassGenerationQueuedKeys.has(queueKey)) return;

    this.grassGenerationQueue.push({ queueKey, chunkKey, lodKey, priority });
    this.grassGenerationQueuedKeys.add(queueKey);
    this.grassGenerationQueueNeedsSort = true;
  }

  processGrassGenerationQueue() {
    if (!this.grassBladesEnabled) {
      this.clearGrassGenerationState();
      return [];
    }

    if (!this.grassGenerationQueue.length) return [];

    const maxBuilds = this.playerSpeed > 22 ? 1 : this.grassBuildsPerFrame;
    const budgetMs = this.playerSpeed > 22 ? this.grassBuildBudgetMs : this.grassBuildBudgetMs * 1.4;
    const startTime = performance.now();
    let builtCount = 0;
    const refreshedChunks = [];

    if (this.grassGenerationQueueNeedsSort) {
      if (this.grassGenerationQueue.length > 1) {
        this.grassGenerationQueue.sort((a, b) => (
          b.priority - a.priority || (a.lodKey === b.lodKey ? 0 : a.lodKey === 'high' ? 1 : -1)
        ));
      }
      this.grassGenerationQueueNeedsSort = false;
    }

    while (
      this.grassGenerationQueue.length > 0 &&
      builtCount < maxBuilds &&
      (performance.now() - startTime) < budgetMs
    ) {
      const entry = this.grassGenerationQueue.pop();
      if (!entry) break;

      this.grassGenerationQueuedKeys.delete(entry.queueKey);

      if (this.currentGrassBuildKeys && !this.currentGrassBuildKeys.has(entry.queueKey)) {
        continue;
      }

      const chunk = this.chunks.get(entry.chunkKey);
      if (!chunk) continue;

      if (this.buildGrassChunkLod(chunk, entry.lodKey)) {
        refreshedChunks.push(chunk);
      }

      builtCount += 1;
    }

    return refreshedChunks;
  }

  createDetailedGrassBladeGeometry(height = this.grassHeight, baseWidth = this.grassBaseWidth, segments = 5) {
    const positions = [];
    const uvs = [];
    const bladeFactors = [];
    const indices = [];
    const halfBaseWidth = baseWidth * 0.5;

    for (let segment = 0; segment < segments; segment++) {
      const t = segment / segments;
      const y = t * height;
      const halfWidth = halfBaseWidth * Math.max(0.08, 1 - Math.pow(t, 1.15));

      positions.push(-halfWidth, y, 0, halfWidth, y, 0);
      uvs.push(0, t, 1, t);
      bladeFactors.push(t, t);
    }

    const tipIndex = positions.length / 3;
    positions.push(0, height, 0);
    uvs.push(0.5, 1);
    bladeFactors.push(1);

    for (let segment = 0; segment < segments - 1; segment++) {
      const a = segment * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;

      indices.push(a, c, b);
      indices.push(b, c, d);
    }

    const lastRow = (segments - 1) * 2;
    indices.push(lastRow, tipIndex, lastRow + 1);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('bladeFactor', new THREE.Float32BufferAttribute(bladeFactors, 1));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  createSimpleGrassBladeGeometry(height = this.grassHeight * 0.95, baseWidth = this.grassBaseWidth * 0.82) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -baseWidth * 0.5, 0, 0,
      baseWidth * 0.5, 0, 0,
      0, height, 0,
    ], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
      0, 0,
      1, 0,
      0.5, 1,
    ], 2));
    geometry.setAttribute('bladeFactor', new THREE.Float32BufferAttribute([
      0,
      0,
      1,
    ], 1));
    geometry.setIndex([0, 2, 1]);
    geometry.computeVertexNormals();
    return geometry;
  }

  createGrassMaterial(visibleMinDistance = 0, visibleMaxDistance = Infinity, fadeDistance = this.grassLodFadeDistance) {
    const material = new THREE.MeshLambertMaterial({
      color: 0xa9dd68,
      emissive: 0x000000,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true,
      fog: true,
      flatShading: true,
      transparent: true,
    });

    material.userData.grassLodUniforms = {
      uGrassVisibleMin: { value: visibleMinDistance },
      uGrassVisibleMax: { value: visibleMaxDistance },
      uGrassFadeDistance: { value: fadeDistance },
    };

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uGrassTime = this.grassUniforms.uTime;
      shader.uniforms.uGrassPlayerXZ = this.grassUniforms.uPlayerXZ;
      shader.uniforms.uGrassVisibleMin = material.userData.grassLodUniforms.uGrassVisibleMin;
      shader.uniforms.uGrassVisibleMax = material.userData.grassLodUniforms.uGrassVisibleMax;
      shader.uniforms.uGrassFadeDistance = material.userData.grassLodUniforms.uGrassFadeDistance;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
        uniform float uGrassTime;
        uniform vec2 uGrassPlayerXZ;
        uniform float uGrassVisibleMin;
        uniform float uGrassVisibleMax;
        uniform float uGrassFadeDistance;
        attribute float bladeFactor;
        varying float vBladeFactor;
        varying float vGrassVisibility;
        varying vec3 vGrassTint;

        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }`
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        float grassNormalBend = bladeFactor * 0.55;
        objectNormal = normalize(objectNormal + vec3(grassNormalBend * 0.45, 0.0, grassNormalBend * 0.08));`
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vBladeFactor = bladeFactor;

        vec3 grassWorldRoot = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        #ifdef USE_INSTANCING
          grassWorldRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        #endif

        float grassPlayerDist = distance(grassWorldRoot.xz, uGrassPlayerXZ);
        float fadeIn = uGrassVisibleMin <= 0.0
          ? 1.0
          : smoothstep(uGrassVisibleMin - uGrassFadeDistance, uGrassVisibleMin, grassPlayerDist);
        float fadeOut = uGrassVisibleMax > 1000000.0
          ? 1.0
          : 1.0 - smoothstep(uGrassVisibleMax - uGrassFadeDistance, uGrassVisibleMax, grassPlayerDist);
        vGrassVisibility = clamp(fadeIn * fadeOut, 0.0, 1.0);

        float primaryWave = sin(uGrassTime * 1.55 + grassWorldRoot.x * 0.033 + grassWorldRoot.z * 0.029);
        float secondaryWave = sin(uGrassTime * 2.85 + grassWorldRoot.x * 0.121 - grassWorldRoot.z * 0.097);
        float gust = sin(uGrassTime * 0.47 + grassWorldRoot.x * 0.013 - grassWorldRoot.z * 0.011) * 0.5 + 0.5;
        float bendFactor = bladeFactor * bladeFactor;
        float bendStrength = (0.06 + gust * 0.16) * bendFactor;
        float sway = (primaryWave * 0.72 + secondaryWave * 0.28) * bendStrength;

        transformed.x += sway;
        transformed.z += secondaryWave * bendStrength * 0.18;
        transformed.y += abs(primaryWave) * bendFactor * 0.035;

        float tintNoise = hash12(grassWorldRoot.xz * 0.071);
        vGrassTint = mix(vec3(0.82, 0.90, 0.78), vec3(1.04, 1.08, 0.92), tintNoise);`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        varying float vBladeFactor;
        varying float vGrassVisibility;
        varying vec3 vGrassTint;`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 bladeGradient = mix(vec3(0.16, 0.30, 0.08), vec3(0.41, 0.64, 0.18), smoothstep(0.0, 1.0, vBladeFactor));
        diffuseColor.rgb *= bladeGradient * vGrassTint * mix(0.35, 1.0, vGrassVisibility);
        diffuseColor.a *= vGrassVisibility;
        if (diffuseColor.a < 0.01) discard;`
      );
    };

    material.customProgramCacheKey = () => `terrain-grass-wind-v6-${visibleMinDistance}-${visibleMaxDistance}-${fadeDistance}`;
    return material;
  }

  getBaseNormalY(worldX, worldZ) {
    const sampleDist = 1.5;
    const h0 = this.getBaseHeight(worldX, worldZ);
    const hX = this.getBaseHeight(worldX + sampleDist, worldZ);
    const hZ = this.getBaseHeight(worldX, worldZ + sampleDist);
    const nx = -(hX - h0) / sampleDist;
    const nz = -(hZ - h0) / sampleDist;
    return 1 / Math.hypot(nx, 1, nz);
  }

  getGrassColorStrength(color) {
    const dominantGreen = color[1] - Math.max(color[0], color[2]);
    const saturation = this.clamp((dominantGreen - 0.01) / 0.22, 0, 1);
    const brightness = this.clamp((color[1] - 0.23) / 0.38, 0, 1);
    return saturation * brightness;
  }

  isGrassColor(color) {
    return this.getGrassColorStrength(color) > 0.14;
  }

  getElevatedGrassCoverage(aboveSeaLevel, worldX, worldZ) {
    if (aboveSeaLevel <= 220) return 1;
    if (aboveSeaLevel >= 500) return 0;

    const altitudeFade = 1 - this.smoothstep(240, 500, aboveSeaLevel);
    const patchBlend = this.smoothstep(260, 500, aboveSeaLevel);
    const macroNoise = this.noise.perlin2(worldX * 0.0038 + 512.4, worldZ * 0.0038 - 217.8) * 0.5 + 0.5;
    const detailNoise = this.noise.perlin2(worldX * 0.0105 - 143.7, worldZ * 0.0105 + 64.2) * 0.5 + 0.5;
    const sparseNoise = macroNoise * 0.72 + detailNoise * 0.28;
    const sparseRegions = this.smoothstep(
      0.34 + patchBlend * 0.22,
      0.76 + patchBlend * 0.08,
      sparseNoise
    );

    return this.clamp(altitudeFade * this.lerp(1, sparseRegions, patchBlend), 0, 1);
  }

  getGrassSpawnData(worldX, worldZ, surfaceHeight, terrainColor, clusterThreshold) {
    const height = Number.isFinite(surfaceHeight) ? surfaceHeight : this.getHeight(worldX, worldZ);
    const aboveSeaLevel = height - this.waterLevel;
    if (aboveSeaLevel < 14 || aboveSeaLevel > 500) return null;

    const elevatedCoverage = this.getElevatedGrassCoverage(aboveSeaLevel, worldX, worldZ);
    if (elevatedCoverage <= 0.025) return null;

    const roadInfo = this.getRoadInfluence(worldX, worldZ, height);
    if (roadInfo && roadInfo.dist < this.highwayHalfWidth + 3.5) return null;

    const slopeY = this.getBaseNormalY(worldX, worldZ);
    const slopeGrassCoverage = this.smoothstep(this.grassMaxSlopeY - 0.015, this.grassMaxSlopeY + 0.055, slopeY);
    if (slopeGrassCoverage <= 0.001) return null;

    const surfaceData = this.getTerrainSurfaceData(height, worldX, worldZ, roadInfo);
    const effectiveGrassCoverage = this.clamp(surfaceData.grassMask * slopeGrassCoverage, 0, 1);
    if (effectiveGrassCoverage <= 0.02) return null;

    const color = terrainColor || surfaceData.color;
    const colorStrength = Math.max(this.getGrassColorStrength(color), effectiveGrassCoverage * 0.42);
    if (colorStrength <= 0.08) return null;

    const patchNoise = this.noise.perlin2(worldX * 0.018 + 73.1, worldZ * 0.018 - 41.7) * 0.5 + 0.5;
    const lushness = (colorStrength * 0.82 + patchNoise * 0.18) * effectiveGrassCoverage;
    if (lushness < Math.max(0.04, clusterThreshold * 0.3)) return null;

    return {
      height: roadInfo ? roadInfo.height : height,
      coverage: effectiveGrassCoverage,
      lushness,
      colorStrength,
    };
  }

  createGrassSamplesForChunk(chunk, spacing, clusterThreshold, lod = 'high') {
    if (!chunk || !chunk.terrainMesh) return [];

    const size = chunk.gridSize || this.chunkSize;
    const step = chunk.step || (this.chunkWorldSize / (size - 1));
    const quadStride = Math.max(1, Math.floor(spacing / Math.max(step, 0.01)));
    const samplesPerQuadAxis = lod === 'high'
      ? Math.min(3, Math.max(1, Math.ceil(step / Math.max(spacing, step / 3))))
      : Math.min(2, Math.max(1, Math.ceil(step / Math.max(spacing, step / 2))));
    const subCellSize = step / samplesPerQuadAxis;
    const jitterAmount = subCellSize * (lod === 'high' ? 0.82 : 0.65);
    const originX = chunk.cx * this.chunkWorldSize;
    const originZ = chunk.cz * this.chunkWorldSize;
    const samples = [];

    for (let iz = 0; iz < size - 1; iz += quadStride) {
      for (let ix = 0; ix < size - 1; ix += quadStride) {
        const quadX = originX + ix * step;
        const quadZ = originZ + iz * step;

        for (let subZ = 0; subZ < samplesPerQuadAxis; subZ++) {
          for (let subX = 0; subX < samplesPerQuadAxis; subX++) {
            const seedX = ix * 17 + subX * 31 + (lod === 'high' ? 11 : 101);
            const seedZ = iz * 19 + subZ * 37 + (lod === 'high' ? 13 : 103);
            const offsetX = (this.hash2(chunk.cx * 4096 + seedX, chunk.cz * 4096 + seedZ, 901) - 0.5) * jitterAmount;
            const offsetZ = (this.hash2(chunk.cx * 4096 + seedX, chunk.cz * 4096 + seedZ, 902) - 0.5) * jitterAmount;
            const wx = this.clamp(
              quadX + (subX + 0.5) * subCellSize + offsetX,
              originX + 0.02,
              originX + this.chunkWorldSize - 0.02
            );
            const wz = this.clamp(
              quadZ + (subZ + 0.5) * subCellSize + offsetZ,
              originZ + 0.02,
              originZ + this.chunkWorldSize - 0.02
            );
            const height = this.getHeight(wx, wz);
            const terrainColor = this.getTerrainColor(height, wx, wz);
            const spawnData = this.getGrassSpawnData(wx, wz, height, terrainColor, clusterThreshold);

            if (!spawnData) continue;

            const heightScale = (lod === 'high' ? 0.82 : 0.72)
              + this.hash2(wx, wz, 903) * (lod === 'high' ? 0.42 : 0.22)
              + spawnData.lushness * (lod === 'high' ? 0.32 : 0.12);
            const widthScale = (lod === 'high' ? 0.72 : 0.66)
              + this.hash2(wx, wz, 904) * (lod === 'high' ? 0.34 : 0.18);

            samples.push({
              x: wx,
              y: spawnData.height + 0.035,
              z: wz,
              scaleY: heightScale,
              scaleXZ: widthScale,
              rotationY: this.hash2(wx, wz, 905) * Math.PI * 2,
              leanX: (this.hash2(wx, wz, 906) - 0.5) * 0.14,
              leanZ: (this.hash2(wx, wz, 907) - 0.5) * 0.14,
            });
          }
        }
      }
    }

    return samples;
  }

  createUltraNearGrassSamples(playerX, playerZ) {
    const terrainStep = this.chunkWorldSize / (this.chunkSize - 1);
    const samplesPerQuadAxis = Math.ceil(terrainStep / this.grassUltraSpacing);
    const subCellSize = terrainStep / samplesPerQuadAxis;
    const jitterAmount = subCellSize * 0.58;
    const radius = this.grassUltraNearDistance;
    const radiusSq = radius * radius;
    const startX = Math.floor((playerX - radius) / subCellSize);
    const endX = Math.ceil((playerX + radius) / subCellSize);
    const startZ = Math.floor((playerZ - radius) / subCellSize);
    const endZ = Math.ceil((playerZ + radius) / subCellSize);
    const samples = [];

    for (let gridZ = startZ; gridZ <= endZ; gridZ++) {
      for (let gridX = startX; gridX <= endX; gridX++) {
        const baseX = (gridX + 0.5) * subCellSize;
        const baseZ = (gridZ + 0.5) * subCellSize;
        const offsetX = (this.hash2(gridX, gridZ, 921) - 0.5) * jitterAmount;
        const offsetZ = (this.hash2(gridX, gridZ, 922) - 0.5) * jitterAmount;
        const worldX = baseX + offsetX;
        const worldZ = baseZ + offsetZ;
        const dx = worldX - playerX;
        const dz = worldZ - playerZ;
        const distSq = dx * dx + dz * dz;

        if (distSq > radiusSq) continue;

        const height = this.getHeight(worldX, worldZ);
        const terrainColor = this.getTerrainColor(height, worldX, worldZ);
        const spawnData = this.getGrassSpawnData(worldX, worldZ, height, terrainColor, 0.16);

        if (!spawnData) continue;

        const ultraCoverageChance = this.smoothstep(0.12, 0.68, spawnData.coverage || 0);
        const ultraCoverageRoll = this.hash2(worldX * 0.37, worldZ * 0.37, 929);
        if (ultraCoverageRoll > ultraCoverageChance) continue;

        const heightScale = 0.74
          + this.hash2(worldX, worldZ, 924) * 0.28
          + spawnData.lushness * 0.2
          + (spawnData.coverage || 0) * 0.08;
        const widthScale = 0.68
          + this.hash2(worldX, worldZ, 925) * 0.24;

        samples.push({
          x: worldX,
          y: spawnData.height + 0.035,
          z: worldZ,
          scaleY: heightScale,
          scaleXZ: widthScale,
          rotationY: this.hash2(worldX, worldZ, 926) * Math.PI * 2,
          leanX: (this.hash2(worldX, worldZ, 927) - 0.5) * 0.12,
          leanZ: (this.hash2(worldX, worldZ, 928) - 0.5) * 0.12,
        });
      }
    }

    return samples;
  }

  removeUltraNearGrass() {
    if (!this.grassUltraMesh) return;

    this.scene.remove(this.grassUltraMesh);
    this.grassUltraMesh = null;
  }

  updateUltraNearGrass(playerX, playerZ, force = false) {
    const now = performance.now();
    const movedX = playerX - this.grassUltraLastX;
    const movedZ = playerZ - this.grassUltraLastZ;
    const adaptiveRebuildDistance = this.grassUltraRebuildDistance + Math.min(4.5, this.playerSpeed * 0.12);
    const rebuildDistanceSq = adaptiveRebuildDistance * adaptiveRebuildDistance;
    const movedSq = movedX * movedX + movedZ * movedZ;
    const withinCooldown = (now - this.lastUltraGrassRebuildTime) < this.grassUltraRebuildMinIntervalMs;

    if (!force && this.grassUltraMesh) {
      if (movedSq < rebuildDistanceSq) {
        return;
      }

      if (withinCooldown && movedSq < rebuildDistanceSq * 2.25) {
        return;
      }
    }

    this.grassUltraLastX = playerX;
    this.grassUltraLastZ = playerZ;
    this.lastUltraGrassRebuildTime = now;

    this.removeUltraNearGrass();

    const ultraSamples = this.createUltraNearGrassSamples(playerX, playerZ);
    this.grassUltraMesh = this.createGrassInstancedMesh(
      ultraSamples,
      this.grassUltraGeometry,
      this.grassUltraMaterial
    );

    if (this.grassUltraMesh) {
      this.grassUltraMesh.renderOrder = 32;
      this.scene.add(this.grassUltraMesh);
    }
  }

  createGrassInstancedMesh(samples, geometry, material) {
    if (!samples.length) return null;

    const mesh = new THREE.InstancedMesh(geometry, material, samples.length);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const dummy = new THREE.Object3D();

    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index];
      dummy.position.set(sample.x, sample.y, sample.z);
      dummy.rotation.set(sample.leanX, sample.rotationY, sample.leanZ);
      dummy.scale.set(sample.scaleXZ, sample.scaleY, sample.scaleXZ);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    }

    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = 31;
    return mesh;
  }

  updateCameraFrustum(camera) {
    if (!camera) return null;

    camera.updateMatrixWorld();
    this.cameraFrustumMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.cameraFrustum.setFromProjectionMatrix(this.cameraFrustumMatrix);
    return this.cameraFrustum;
  }

  isChunkInFrustum(chunk, frustum) {
    if (!frustum || !chunk || !chunk.cullBounds) return true;
    return frustum.intersectsBox(chunk.cullBounds);
  }

  updateChunkFrustumVisibility(chunk, frustum) {
    if (!chunk) return false;

    const inFrustum = this.isChunkInFrustum(chunk, frustum);

    if (chunk.terrainMesh) {
      chunk.terrainMesh.visible = inFrustum;
    }

    if (chunk.roadMesh) {
      chunk.roadMesh.visible = inFrustum;
    }

    chunk.inFrustum = inFrustum;
    return inFrustum;
  }

  buildGrassChunkLod(chunk, lodKey) {
    if (!chunk || !this.grassBladesEnabled) return false;

    if (lodKey === 'high') {
      if (chunk.grassHighReady) return false;

      const detailedSamples = this.createGrassSamplesForChunk(chunk, this.grassDenseSpacing, 0.22, 'high');
      chunk.grassHighMesh = this.createGrassInstancedMesh(
        detailedSamples,
        this.grassDetailedGeometry,
        this.grassDetailedMaterial
      );

      if (chunk.grassHighMesh) {
        chunk.grassHighMesh.visible = false;
        this.scene.add(chunk.grassHighMesh);
      }

      chunk.grassHighReady = true;
      return true;
    }

    if (lodKey === 'low') {
      if (chunk.grassLowReady) return false;

      const simpleSamples = this.createGrassSamplesForChunk(chunk, this.grassSparseSpacing, 0.14, 'low');
      chunk.grassLowMesh = this.createGrassInstancedMesh(
        simpleSamples,
        this.grassSimpleGeometry,
        this.grassSimpleMaterial
      );

      if (chunk.grassLowMesh) {
        chunk.grassLowMesh.visible = false;
        this.scene.add(chunk.grassLowMesh);
      }

      chunk.grassLowReady = true;
      return true;
    }

    return false;
  }

  removeGrassFromChunk(chunk) {
    if (!chunk || (!chunk.grassHighReady && !chunk.grassLowReady && !chunk.grassHighMesh && !chunk.grassLowMesh)) return;

    if (chunk.grassHighMesh) {
      this.scene.remove(chunk.grassHighMesh);
      chunk.grassHighMesh = null;
    }

    if (chunk.grassLowMesh) {
      this.scene.remove(chunk.grassLowMesh);
      chunk.grassLowMesh = null;
    }

    chunk.grassHighReady = false;
    chunk.grassLowReady = false;
  }

  disposeChunk(chunk) {
    if (!chunk) return;

    this.removeGrassFromChunk(chunk);

    if (chunk.terrainMesh) {
      this.scene.remove(chunk.terrainMesh);
      chunk.terrainMesh.geometry.dispose();
      chunk.terrainMesh = null;
    }

    if (chunk.roadMesh) {
      this.scene.remove(chunk.roadMesh);
      chunk.roadMesh.geometry.dispose();
      chunk.roadMesh = null;
    }
  }

  getChunkMinDistanceSq(chunkX, chunkZ, worldX, worldZ) {
    const minX = chunkX * this.chunkWorldSize;
    const minZ = chunkZ * this.chunkWorldSize;
    const maxX = minX + this.chunkWorldSize;
    const maxZ = minZ + this.chunkWorldSize;
    const nearestX = this.clamp(worldX, minX, maxX);
    const nearestZ = this.clamp(worldZ, minZ, maxZ);
    const dx = nearestX - worldX;
    const dz = nearestZ - worldZ;
    return dx * dx + dz * dz;
  }

  updateGrassChunkLod(chunk, playerX, playerZ, inFrustum = true) {
    if (!chunk || (!chunk.grassHighMesh && !chunk.grassLowMesh)) return;

    if (!this.grassBladesEnabled) {
      if (chunk.grassHighMesh) chunk.grassHighMesh.visible = false;
      if (chunk.grassLowMesh) chunk.grassLowMesh.visible = false;
      return;
    }

    const distSq = this.getChunkMinDistanceSq(chunk.cx, chunk.cz, playerX, playerZ);
    const maxDistanceWithFade = this.grassRenderDistance + this.grassLodFadeDistance;
    const highDistanceWithFade = this.grassHighDetailDistance + this.grassLodFadeDistance;
    const maxDistSq = maxDistanceWithFade * maxDistanceWithFade;
    const highDistSq = highDistanceWithFade * highDistanceWithFade;
    const withinGrassRange = distSq <= maxDistSq;
    const withinHighRange = distSq <= highDistSq;

    if (chunk.grassHighMesh) {
      chunk.grassHighMesh.visible = inFrustum && withinHighRange;
    }

    if (chunk.grassLowMesh) {
      chunk.grassLowMesh.visible = inFrustum && withinGrassRange;
    }
  }

  updateUltraNearGrassVisibility(playerX, playerZ, frustum) {
    if (!this.grassUltraMesh) return;

    if (!frustum) {
      this.grassUltraMesh.visible = true;
      return;
    }

    this.grassUltraCullSphere.center.set(
      playerX,
      this.getHeight(playerX, playerZ) + this.grassHeight * 0.5,
      playerZ
    );
    this.grassUltraCullSphere.radius = this.grassUltraNearDistance + this.grassHeight + 1;
    this.grassUltraMesh.visible = frustum.intersectsSphere(this.grassUltraCullSphere);
  }

  getCityKey(cellX, cellZ) {
    return `${cellX},${cellZ}`;
  }

  getHighwayConnectionKey(cityA, cityB) {
    return cityA.id < cityB.id
      ? `${cityA.id}|${cityB.id}`
      : `${cityB.id}|${cityA.id}`;
  }

  getCityReference(cellX, cellZ) {
    const key = this.getCityKey(cellX, cellZ);
    if (this.cityCache.has(key)) {
      return this.cityCache.get(key);
    }

    const anchorX = cellX * this.citySpacing;
    const anchorZ = cellZ * this.citySpacing;
    let bestCandidate = null;

    for (let attempt = 0; attempt < 14; attempt++) {
      const angle = this.hash2(cellX * 17 + attempt * 13, cellZ * 29 - attempt * 7, 301) * Math.PI * 2;
      const radiusFactor = attempt === 0
        ? this.hash2(cellX, cellZ, 302) * 0.18
        : 0.2 + this.hash2(cellX * -23 + attempt * 11, cellZ * 19 + attempt * 5, 303) * 0.8;
      const radius = radiusFactor * this.citySearchRadius;
      const x = anchorX + Math.cos(angle) * radius;
      const z = anchorZ + Math.sin(angle) * radius;
      const height = this.getBaseHeight(x, z);
      const submergePenalty = height < this.waterLevel + this.cityMinElevation
        ? (this.waterLevel + this.cityMinElevation - height) * 12000
        : 0;
      const shorelinePenalty = height < this.waterLevel + 40
        ? (this.waterLevel + 40 - height) * 100
        : 0;
      const offsetPenalty = radius * 0.035;
      const altitudePenalty = Math.abs(height - (this.waterLevel + 120)) * 0.05;
      const score = submergePenalty + shorelinePenalty + offsetPenalty + altitudePenalty + attempt * 0.01;

      if (!bestCandidate || score < bestCandidate.score) {
        bestCandidate = { x, z, height, score };
      }
    }

    const city = bestCandidate && bestCandidate.height >= this.waterLevel + this.cityMinElevation
      ? {
          id: `CITY-${cellX}-${cellZ}`,
          cellX,
          cellZ,
          x: bestCandidate.x,
          z: bestCandidate.z,
          height: bestCandidate.height,
        }
      : null;

    this.cityCache.set(key, city);
    return city;
  }

  getCitiesInCellRange(minCellX, minCellZ, maxCellX, maxCellZ) {
    const cities = [];

    for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        const city = this.getCityReference(cellX, cellZ);
        if (city) cities.push(city);
      }
    }

    return cities;
  }

  getNearestCities(city, limit = this.cityConnectionCandidates) {
    const candidates = [];

    for (let radius = 1; radius <= this.cityConnectionSearchRadiusCells; radius++) {
      for (let cellZ = city.cellZ - radius; cellZ <= city.cellZ + radius; cellZ++) {
        for (let cellX = city.cellX - radius; cellX <= city.cellX + radius; cellX++) {
          if (Math.max(Math.abs(cellX - city.cellX), Math.abs(cellZ - city.cellZ)) !== radius) continue;

          const other = this.getCityReference(cellX, cellZ);
          if (!other || other.id === city.id) continue;

          const dx = other.x - city.x;
          const dz = other.z - city.z;
          candidates.push({ city: other, distSq: dx * dx + dz * dz });
        }
      }

      if (candidates.length >= limit) break;
    }

    candidates.sort((a, b) => a.distSq - b.distSq);
    return candidates.slice(0, limit).map((entry) => entry.city);
  }

  getCityConnectionCandidates(city) {
    return this.getNearestCities(city, this.cityConnectionCandidates)
      .map((other, index) => ({
        city: other,
        priority: this.hash2(
          city.cellX * 37 + other.cellX * 11 + index,
          city.cellZ * 41 + other.cellZ * 13 - index,
          320
        ),
      }))
      .sort((a, b) => a.priority - b.priority)
      .map((entry) => entry.city);
  }

  ensureCityConnections(city) {
    const candidates = this.getCityConnectionCandidates(city);
    let successfulConnections = 0;

    for (const otherCity of candidates) {
      const highway = this.ensureHighwayConnection(city, otherCity);
      if (highway) {
        successfulConnections += 1;
      }
      if (successfulConnections >= this.cityMinConnections) {
        break;
      }
    }
  }

  ensureRoadNetworkForBounds(minX, minZ, maxX, maxZ, padding = this.citySpacing * 0.75) {
    const minCellX = Math.floor((minX - padding) / this.citySpacing) - 1;
    const maxCellX = Math.ceil((maxX + padding) / this.citySpacing) + 1;
    const minCellZ = Math.floor((minZ - padding) / this.citySpacing) - 1;
    const maxCellZ = Math.ceil((maxZ + padding) / this.citySpacing) + 1;
    const cities = this.getCitiesInCellRange(minCellX, minCellZ, maxCellX, maxCellZ);

    for (const city of cities) {
      this.ensureCityConnections(city);
    }
  }

  ensureHighwayConnection(cityA, cityB) {
    if (!cityA || !cityB || cityA.id === cityB.id) return null;

    const connectionKey = this.getHighwayConnectionKey(cityA, cityB);
    if (this.highwayCache.has(connectionKey)) {
      return this.highwayCache.get(connectionKey);
    }

    const pathPoints = this.buildHighwayPath(cityA, cityB);
    if (!pathPoints || pathPoints.length < 2) {
      this.highwayCache.set(connectionKey, null);
      return null;
    }

    const bounds = this.computeHighwayBounds(pathPoints);
    const highway = {
      id: `HW-${connectionKey}`,
      fromCityId: cityA.id,
      toCityId: cityB.id,
      halfWidth: this.highwayHalfWidth,
      shoulder: this.highwayShoulder,
      cutRadius: this.highwayHalfWidth + 2.5,
      influenceRadius: this.highwayHalfWidth + this.highwayShoulder,
      points: pathPoints,
      minX: bounds.minX,
      minZ: bounds.minZ,
      maxX: bounds.maxX,
      maxZ: bounds.maxZ,
    };

    this.highwayCache.set(connectionKey, highway);
    this.highways.push(highway);
    return highway;
  }

  projectPointToSegment(px, pz, ax, az, bx, bz) {
    const abx = bx - ax;
    const abz = bz - az;
    const abLenSq = abx * abx + abz * abz;
    if (abLenSq <= 1e-6) {
      const dx = px - ax;
      const dz = pz - az;
      return { t: 0, x: ax, z: az, distSq: dx * dx + dz * dz };
    }

    const apx = px - ax;
    const apz = pz - az;
    const t = this.clamp((apx * abx + apz * abz) / abLenSq, 0, 1);
    const x = ax + abx * t;
    const z = az + abz * t;
    const dx = px - x;
    const dz = pz - z;
    return { t, x, z, distSq: dx * dx + dz * dz };
  }

  isRoadPointDry(worldX, worldZ, baseHeight = null) {
    const requiredHeight = this.waterLevel + this.highwayClearance;
    const probeRadius = this.highwayHalfWidth + 3;
    const sampleOffsets = [
      [0, 0],
      [probeRadius, 0],
      [-probeRadius, 0],
      [0, probeRadius],
      [0, -probeRadius],
      [probeRadius * 0.7, probeRadius * 0.7],
      [-probeRadius * 0.7, probeRadius * 0.7],
      [probeRadius * 0.7, -probeRadius * 0.7],
      [-probeRadius * 0.7, -probeRadius * 0.7],
    ];

    for (let i = 0; i < sampleOffsets.length; i++) {
      const [offsetX, offsetZ] = sampleOffsets[i];
      const height = i === 0 && baseHeight !== null
        ? baseHeight
        : this.getBaseHeight(worldX + offsetX, worldZ + offsetZ);
      if (height < requiredHeight) {
        return false;
      }
    }

    return true;
  }

  isRoadSegmentDry(startPoint, endPoint, sampleStep = this.highwaySegmentCheckStep) {
    const distance = Math.hypot(endPoint.x - startPoint.x, endPoint.z - startPoint.z);
    const steps = Math.max(1, Math.ceil(distance / sampleStep));

    for (let stepIndex = 0; stepIndex <= steps; stepIndex++) {
      const t = stepIndex / steps;
      const x = this.lerp(startPoint.x, endPoint.x, t);
      const z = this.lerp(startPoint.z, endPoint.z, t);
      if (!this.isRoadPointDry(x, z)) {
        return false;
      }
    }

    return true;
  }

  buildHighwayPath(cityA, cityB) {
    if (this.isRoadSegmentDry(cityA, cityB)) {
      return this.resampleHighwayPath([cityA, cityB]);
    }

    const marginAttempts = [
      this.highwayPathMargin,
      this.highwayPathMargin + this.citySpacing * 0.5,
      this.highwayPathMargin + this.citySpacing,
    ];

    for (const margin of marginAttempts) {
      const path = this.findDryHighwayPath(cityA, cityB, margin);
      if (path && path.length >= 2) {
        return this.resampleHighwayPath(this.simplifyHighwayPath(path));
      }
    }

    return null;
  }

  findDryHighwayPath(cityA, cityB, margin) {
    const step = this.highwayPathStep;
    const startGX = Math.round(cityA.x / step);
    const startGZ = Math.round(cityA.z / step);
    const endGX = Math.round(cityB.x / step);
    const endGZ = Math.round(cityB.z / step);
    const startKey = `${startGX},${startGZ}`;
    const endKey = `${endGX},${endGZ}`;

    if (startKey === endKey) {
      return [cityA, cityB];
    }

    const minGX = Math.floor((Math.min(cityA.x, cityB.x) - margin) / step);
    const maxGX = Math.ceil((Math.max(cityA.x, cityB.x) + margin) / step);
    const minGZ = Math.floor((Math.min(cityA.z, cityB.z) - margin) / step);
    const maxGZ = Math.ceil((Math.max(cityA.z, cityB.z) + margin) / step);
    const openNodes = new Map();
    const closedKeys = new Set();
    const nodeRecords = new Map();
    const terrainNodeCache = new Map();
    const directions = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ];
    const heuristic = (gx, gz) => Math.hypot((endGX - gx) * step, (endGZ - gz) * step);
    const getNodeSample = (gx, gz, key) => {
      if (key === startKey) {
        return { x: cityA.x, z: cityA.z, height: cityA.height, dry: true };
      }
      if (key === endKey) {
        return { x: cityB.x, z: cityB.z, height: cityB.height, dry: true };
      }
      if (terrainNodeCache.has(key)) {
        return terrainNodeCache.get(key);
      }

      const x = gx * step;
      const z = gz * step;
      const height = this.getBaseHeight(x, z);
      const sample = {
        x,
        z,
        height,
        dry: this.isRoadPointDry(x, z, height),
      };
      terrainNodeCache.set(key, sample);
      return sample;
    };

    const startRecord = {
      key: startKey,
      gx: startGX,
      gz: startGZ,
      x: cityA.x,
      z: cityA.z,
      height: cityA.height,
      g: 0,
      h: heuristic(startGX, startGZ),
      f: heuristic(startGX, startGZ),
      parentKey: null,
    };
    openNodes.set(startKey, startRecord);
    nodeRecords.set(startKey, startRecord);

    let iterations = 0;
    while (openNodes.size && iterations < 40000) {
      iterations += 1;
      let current = null;
      for (const node of openNodes.values()) {
        if (!current || node.f < current.f || (node.f === current.f && node.h < current.h)) {
          current = node;
        }
      }

      if (!current) break;
      openNodes.delete(current.key);

      if (current.key === endKey) {
        const path = [];
        let walkKey = current.key;
        while (walkKey) {
          const node = nodeRecords.get(walkKey);
          path.push({ x: node.x, z: node.z, height: node.height });
          walkKey = node.parentKey;
        }
        path.reverse();
        return path;
      }

      closedKeys.add(current.key);

      for (const [dx, dz] of directions) {
        const nextGX = current.gx + dx;
        const nextGZ = current.gz + dz;
        if (nextGX < minGX || nextGX > maxGX || nextGZ < minGZ || nextGZ > maxGZ) continue;

        const nextKey = `${nextGX},${nextGZ}`;
        if (closedKeys.has(nextKey)) continue;

        const nextSample = getNodeSample(nextGX, nextGZ, nextKey);
        if (!nextSample.dry && nextKey !== endKey) continue;
        if (!this.isRoadSegmentDry(current, nextSample)) continue;

        const moveDistance = Math.hypot(nextSample.x - current.x, nextSample.z - current.z);
        const elevationDelta = Math.abs(nextSample.height - current.height);
        const shorelinePenalty = Math.max(0, this.waterLevel + 35 - nextSample.height) * 2.5;
        const slopePenalty = elevationDelta * 0.08;
        const turnPenalty = dx !== 0 && dz !== 0 ? step * 0.03 : 0;
        const tentativeG = current.g + moveDistance + slopePenalty + shorelinePenalty + turnPenalty;
        const existing = nodeRecords.get(nextKey);

        if (existing && tentativeG >= existing.g) continue;

        const h = heuristic(nextGX, nextGZ);
        const nextRecord = {
          key: nextKey,
          gx: nextGX,
          gz: nextGZ,
          x: nextSample.x,
          z: nextSample.z,
          height: nextSample.height,
          g: tentativeG,
          h,
          f: tentativeG + h,
          parentKey: current.key,
        };

        nodeRecords.set(nextKey, nextRecord);
        openNodes.set(nextKey, nextRecord);
      }
    }

    return null;
  }

  simplifyHighwayPath(points) {
    if (!points || points.length <= 2) return points;

    const simplified = [points[0]];
    let anchorIndex = 0;

    while (anchorIndex < points.length - 1) {
      let nextIndex = points.length - 1;
      while (nextIndex > anchorIndex + 1) {
        if (this.isRoadSegmentDry(points[anchorIndex], points[nextIndex])) {
          break;
        }
        nextIndex -= 1;
      }

      simplified.push(points[nextIndex]);
      anchorIndex = nextIndex;
    }

    return simplified;
  }

  resampleHighwayPath(points) {
    if (!points || points.length < 2) return points;

    const resampled = [{ x: points[0].x, z: points[0].z, height: points[0].height }];

    for (let index = 1; index < points.length; index++) {
      const start = points[index - 1];
      const end = points[index];
      const distance = Math.hypot(end.x - start.x, end.z - start.z);
      const steps = Math.max(1, Math.ceil(distance / Math.max(1, this.highwayPathStep * 0.6)));

      for (let stepIndex = 1; stepIndex <= steps; stepIndex++) {
        const t = stepIndex / steps;
        const x = this.lerp(start.x, end.x, t);
        const z = this.lerp(start.z, end.z, t);
        resampled.push({
          x,
          z,
          height: this.getBaseHeight(x, z),
        });
      }
    }

    return resampled;
  }

  computeHighwayBounds(points) {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;

    for (const point of points) {
      if (point.x < minX) minX = point.x;
      if (point.z < minZ) minZ = point.z;
      if (point.x > maxX) maxX = point.x;
      if (point.z > maxZ) maxZ = point.z;
    }

    return { minX, minZ, maxX, maxZ };
  }

  getHighwayInfluence(highway, worldX, worldZ) {
    if (
      worldX < highway.minX - highway.influenceRadius ||
      worldX > highway.maxX + highway.influenceRadius ||
      worldZ < highway.minZ - highway.influenceRadius ||
      worldZ > highway.maxZ + highway.influenceRadius
    ) {
      return null;
    }

    let best = null;

    for (let index = 0; index < highway.points.length - 1; index++) {
      const start = highway.points[index];
      const end = highway.points[index + 1];
      const projection = this.projectPointToSegment(worldX, worldZ, start.x, start.z, end.x, end.z);
      if (projection.distSq > highway.influenceRadius * highway.influenceRadius) continue;

      const dist = Math.sqrt(projection.distSq);
      const roadHeight = this.lerp(start.height, end.height, projection.t);
      if (roadHeight < this.waterLevel + this.highwayClearance) continue;

      const flattenWeight = dist <= highway.cutRadius
        ? 1
        : 1 - this.smoothstep(highway.cutRadius, highway.influenceRadius, dist);
      const coreWeight = dist <= highway.halfWidth ? 1 : 0;
      const shoulderWeight = 0;

      if (!best || dist < best.dist) {
        best = {
          dist,
          roadHeight,
          flattenWeight,
          coreWeight,
          shoulderWeight,
        };
      }
    }

    return best;
  }

  getRoadInfluence(worldX, worldZ, baseHeight = this.getBaseHeight(worldX, worldZ)) {
    let weightedHeight = 0;
    let totalWeight = 0;
    let roadStrength = 0;
    let shoulderStrength = 0;
    let minDist = Infinity;

    for (const highway of this.highways) {
      const influence = this.getHighwayInfluence(highway, worldX, worldZ);
      if (!influence) continue;

      weightedHeight += influence.roadHeight * influence.flattenWeight;
      totalWeight += influence.flattenWeight;
      roadStrength = Math.max(roadStrength, influence.coreWeight);
      shoulderStrength = Math.max(shoulderStrength, influence.shoulderWeight);
      minDist = Math.min(minDist, influence.dist);
    }

    if (totalWeight <= 1e-4) return null;

    const flattenBlend = this.clamp(totalWeight, 0, 1);
    const roadHeight = weightedHeight / totalWeight;

    return {
      height: this.lerp(baseHeight, roadHeight - 0.18, flattenBlend),
      roadHeight,
      flattenBlend,
      roadStrength,
      shoulderStrength,
      dist: minDist,
    };
  }

  getRoadInfluenceForHighways(worldX, worldZ, baseHeight, highways) {
    let weightedHeight = 0;
    let totalWeight = 0;
    let roadStrength = 0;
    let shoulderStrength = 0;
    let minDist = Infinity;

    for (const highway of highways) {
      const influence = this.getHighwayInfluence(highway, worldX, worldZ);
      if (!influence) continue;

      weightedHeight += influence.roadHeight * influence.flattenWeight;
      totalWeight += influence.flattenWeight;
      roadStrength = Math.max(roadStrength, influence.coreWeight);
      shoulderStrength = Math.max(shoulderStrength, influence.shoulderWeight);
      minDist = Math.min(minDist, influence.dist);
    }

    if (totalWeight <= 1e-4) return null;

    const flattenBlend = this.clamp(totalWeight, 0, 1);
    const roadHeight = weightedHeight / totalWeight;

    return {
      height: this.lerp(baseHeight, roadHeight - 0.18, flattenBlend),
      roadHeight,
      flattenBlend,
      roadStrength,
      shoulderStrength,
      dist: minDist,
    };
  }

  getHighwaysAffectingBounds(minX, minZ, maxX, maxZ, padding = 0) {
    const highways = [];

    for (const highway of this.highways) {
      if (
        highway.maxX < minX - padding ||
        highway.minX > maxX + padding ||
        highway.maxZ < minZ - padding ||
        highway.minZ > maxZ + padding
      ) {
        continue;
      }

      highways.push(highway);
    }

    return highways;
  }

  getHighwayCurvesInBounds(minX, minZ, maxX, maxZ, padding = 0) {
    this.ensureRoadNetworkForBounds(minX, minZ, maxX, maxZ, Math.max(padding, this.citySpacing * 0.75));

    const curves = [];

    for (const highway of this.highways) {
      if (
        highway.maxX < minX - padding ||
        highway.minX > maxX + padding ||
        highway.maxZ < minZ - padding ||
        highway.minZ > maxZ + padding
      ) {
        continue;
      }

      curves.push({
        highwayId: highway.id,
        orientation: 'path',
        halfWidth: highway.halfWidth,
        points: highway.points.map((point) => ({
          x: point.x,
          z: point.z,
        })),
      });
    }

    return curves;
  }

  getCachedHighwayCurvesInBounds(minX, minZ, maxX, maxZ, padding = 0) {
    const curves = [];

    for (const highway of this.highways) {
      if (
        highway.maxX < minX - padding ||
        highway.minX > maxX + padding ||
        highway.maxZ < minZ - padding ||
        highway.minZ > maxZ + padding
      ) {
        continue;
      }

      curves.push({
        highwayId: highway.id,
        orientation: 'path',
        halfWidth: highway.halfWidth,
        points: highway.points.map((point) => ({
          x: point.x,
          z: point.z,
        })),
      });
    }

    return curves;
  }

  getCityReferencePointsInBounds(minX, minZ, maxX, maxZ, padding = 0) {
    const minCellX = Math.floor((minX - padding) / this.citySpacing) - 1;
    const maxCellX = Math.ceil((maxX + padding) / this.citySpacing) + 1;
    const minCellZ = Math.floor((minZ - padding) / this.citySpacing) - 1;
    const maxCellZ = Math.ceil((maxZ + padding) / this.citySpacing) + 1;

    return this.getCitiesInCellRange(minCellX, minCellZ, maxCellX, maxCellZ).filter((city) => (
      city.x >= minX - padding &&
      city.x <= maxX + padding &&
      city.z >= minZ - padding &&
      city.z <= maxZ + padding
    ));
  }

  getTerrainSurfaceData(height, worldX, worldZ, roadInfo = null) {
    const aboveSeaLevel = height - this.waterLevel;

    const applyRoadFade = (surfaceData) => {
      if (!roadInfo) return surfaceData;

      const roadFade = this.smoothstep(this.highwayHalfWidth + 1, this.highwayShoulder + 2, roadInfo.dist);
      return {
        color: surfaceData.color,
        grassMask: this.clamp(surfaceData.grassMask * roadFade, 0, 1),
      };
    };

    if (aboveSeaLevel <= 0) {
      const depth = this.clamp(-aboveSeaLevel / this.continentHeightScale, 0, 1);
      return applyRoadFade({
        color: this.mix3([0.1, 0.34, 0.62], [0.02, 0.08, 0.22], depth),
        grassMask: 0,
      });
    }

    if (aboveSeaLevel < 30) {
      const shoreline = this.smoothstep(0, 30, aboveSeaLevel);
      const duneNoise = this.noise.perlin2(worldX * 0.012, worldZ * 0.012) * 0.5 + 0.5;
      const brightness = 0.9 + duneNoise * 0.08;
      return applyRoadFade({
        color: this.mix3(
          [0.7 * brightness, 0.66 * brightness, 0.48 * brightness],
          [0.45, 0.56, 0.31],
          shoreline
        ),
        grassMask: 0,
      });
    }

    if (aboveSeaLevel < 220) {
      const t = this.smoothstep(30, 220, aboveSeaLevel);
      const vegetation = this.noise.perlin2(worldX * 0.01, worldZ * 0.01) * 0.5 + 0.5;
      return applyRoadFade({
        color: this.mix3(
          [0.26, 0.5 + vegetation * 0.08, 0.19],
          [0.22, 0.44, 0.17],
          t
        ),
        grassMask: 0.82 + vegetation * 0.18,
      });
    }

    if (aboveSeaLevel < 500) {
      const elevatedCoverage = this.getElevatedGrassCoverage(aboveSeaLevel, worldX, worldZ);
      const hillVegetation = this.noise.perlin2(worldX * 0.006 + 148.23, worldZ * 0.006 - 91.71) * 0.5 + 0.5;
      const mountainBlend = this.smoothstep(220, 500, aboveSeaLevel);
      const rockBlend = this.smoothstep(340, 500, aboveSeaLevel);
      const grassyTone = this.mix3(
        [0.22, 0.42 + hillVegetation * 0.08, 0.17],
        [0.2, 0.35 + hillVegetation * 0.05, 0.15],
        mountainBlend
      );
      const rockyTone = this.mix3([0.32, 0.31, 0.21], [0.42, 0.36, 0.24], rockBlend);
      return applyRoadFade({
        color: this.mix3(rockyTone, grassyTone, this.clamp(elevatedCoverage * 0.92 + 0.08, 0, 1)),
        grassMask: elevatedCoverage,
      });
    }

    if (aboveSeaLevel < 1100) {
      const t = this.smoothstep(500, 1100, aboveSeaLevel);
      return applyRoadFade({
        color: this.mix3([0.42, 0.36, 0.24], [0.62, 0.6, 0.58], t),
        grassMask: 0,
      });
    }

    const snow = this.smoothstep(1100, this.heightScale, aboveSeaLevel);
    return applyRoadFade({
      color: this.mix3([0.62, 0.6, 0.58], [0.95, 0.96, 0.98], snow),
      grassMask: 0,
    });
  }

  getTerrainColor(height, worldX, worldZ) {
    return this.getTerrainSurfaceData(height, worldX, worldZ).color;
  }

  getSurfaceColor(height, worldX, worldZ, roadInfo) {
    return this.getTerrainSurfaceData(height, worldX, worldZ, roadInfo).color;
  }

  buildRoadMesh(size, step, originX, originZ, vertices, roadHighways = this.highways) {
    if (!roadHighways || roadHighways.length === 0) return null;

    const positions = [];
    const indices = [];
    let vertexOffset = 0;

    const addVertex = (srcIndex) => {
      positions.push(
        vertices[srcIndex],
        vertices[srcIndex + 1] + this.roadSurfaceHeightOffset,
        vertices[srcIndex + 2]
      );
      return vertexOffset++;
    };

    for (let iz = 0; iz < size - 1; iz++) {
      for (let ix = 0; ix < size - 1; ix++) {
        const centerX = originX + (ix + 0.5) * step;
        const centerZ = originZ + (iz + 0.5) * step;
        const centerBaseHeight = this.getBaseHeight(centerX, centerZ);
        const centerRoadInfo = this.getRoadInfluenceForHighways(centerX, centerZ, centerBaseHeight, roadHighways);

        if (!centerRoadInfo || centerRoadInfo.dist > this.highwayHalfWidth + step * 0.35) {
          continue;
        }

        const a = (iz * size + ix) * 3;
        const b = a + 3;
        const c = ((iz + 1) * size + ix) * 3;
        const d = c + 3;

        const ia = addVertex(a);
        const ib = addVertex(b);
        const ic = addVertex(c);
        const id = addVertex(d);

        indices.push(ia, ic, ib);
        indices.push(ib, ic, id);
      }
    }

    if (!indices.length) return null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, this.roadMaterial);
    mesh.frustumCulled = false;
    return mesh;
  }

  // Generate a single chunk mesh
  generateChunk(cx, cz, lodLevel = 0, options = {}) {
    const key = `${cx},${cz}`;
    const replace = !!options.replace;
    const existingChunk = this.chunks.get(key);
    if (
      existingChunk
      && !replace
      && existingChunk.lodLevel === lodLevel
      && existingChunk.lodSettingsVersion === this.lodSettingsVersion
    ) {
      return existingChunk;
    }

    const lodInfo = this.getTerrainLodInfo(lodLevel);
    const size = lodInfo.gridSize;
    const worldSize = this.chunkWorldSize;
    const step = worldSize / lodInfo.segments;
    const originX = cx * worldSize;
    const originZ = cz * worldSize;
    const topology = this.getChunkTopology(size);

    const mainVertexCount = size * size;
    const vertices = new Float32Array(mainVertexCount * 3);
    const heights = new Float32Array(mainVertexCount);
    const colors = new Float32Array(mainVertexCount * 3);
    const terrainGrassMasks = new Float32Array(mainVertexCount);
    let minY = Infinity;
    let maxY = -Infinity;

    const roadHighways = this.getHighwaysAffectingBounds(
      originX,
      originZ,
      originX + worldSize,
      originZ + worldSize,
      this.highwayHalfWidth + this.highwayShoulder + step * 1.5
    );
    const hasRoadCandidates = roadHighways.length > 0;

    for (let iz = 0; iz < size; iz++) {
      for (let ix = 0; ix < size; ix++) {
        const idx = (iz * size + ix) * 3;
        const gridIndex = iz * size + ix;
        const wx = originX + ix * step;
        const wz = originZ + iz * step;

        const baseHeight = this.getBaseHeight(wx, wz);
        const roadInfo = hasRoadCandidates
          ? this.getRoadInfluenceForHighways(wx, wz, baseHeight, roadHighways)
          : null;
        const height = roadInfo ? roadInfo.height : baseHeight;
        const surfaceData = this.getTerrainSurfaceData(height, wx, wz, roadInfo);
        const color = surfaceData.color;

        vertices[idx] = wx;
        vertices[idx + 1] = height;
        vertices[idx + 2] = wz;
        heights[gridIndex] = height;
        terrainGrassMasks[gridIndex] = surfaceData.grassMask;

        if (height < minY) minY = height;
        if (height > maxY) maxY = height;

        colors[idx] = color[0];
        colors[idx + 1] = color[1];
        colors[idx + 2] = color[2];
      }
    }

    const normals = this.buildHeightfieldNormals(heights, size, step);
    const skirtDepth = Math.max(this.chunkSkirtDepth, step * 2.5);
    const boundaryRing = topology.boundaryRing;
    const totalVertexCount = mainVertexCount + boundaryRing.length;
    const finalVertices = new Float32Array(totalVertexCount * 3);
    const finalNormals = new Float32Array(totalVertexCount * 3);
    const finalColors = new Float32Array(totalVertexCount * 3);
    const finalGrassMasks = new Float32Array(totalVertexCount);

    finalVertices.set(vertices);
    finalNormals.set(normals);
    finalColors.set(colors);
    finalGrassMasks.set(terrainGrassMasks);

    for (let ringIndex = 0; ringIndex < boundaryRing.length; ringIndex++) {
      const sourceVertexIndex = boundaryRing[ringIndex];
      const sourceOffset = sourceVertexIndex * 3;
      const skirtVertexIndex = mainVertexCount + ringIndex;
      const skirtOffset = skirtVertexIndex * 3;

      finalVertices[skirtOffset] = vertices[sourceOffset];
      finalVertices[skirtOffset + 1] = vertices[sourceOffset + 1] - skirtDepth;
      finalVertices[skirtOffset + 2] = vertices[sourceOffset + 2];

      finalNormals[skirtOffset] = normals[sourceOffset];
      finalNormals[skirtOffset + 1] = normals[sourceOffset + 1];
      finalNormals[skirtOffset + 2] = normals[sourceOffset + 2];

      finalColors[skirtOffset] = colors[sourceOffset];
      finalColors[skirtOffset + 1] = colors[sourceOffset + 1];
      finalColors[skirtOffset + 2] = colors[sourceOffset + 2];
      finalGrassMasks[skirtVertexIndex] = 0;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(finalVertices, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(finalNormals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(finalColors, 3));
    geometry.setAttribute('terrainGrassMask', new THREE.BufferAttribute(finalGrassMasks, 1));
    geometry.setIndex(new THREE.BufferAttribute(topology.indices, 1));

    const terrainMesh = new THREE.Mesh(geometry, this.material);
    terrainMesh.receiveShadow = true;
    terrainMesh.frustumCulled = false;

    const roadMesh = hasRoadCandidates
      ? this.buildRoadMesh(size, step, originX, originZ, vertices, roadHighways)
      : null;
    if (roadMesh) {
      roadMesh.receiveShadow = true;
    }

    if (existingChunk) {
      this.disposeChunk(existingChunk);
    }

    this.scene.add(terrainMesh);
    if (roadMesh) {
      this.scene.add(roadMesh);
    }

    const cullPaddingY = Math.max(6, this.grassHeight + 2, skirtDepth);
    const chunkRecord = {
      key,
      cx,
      cz,
      step,
      gridSize: size,
      lodLevel: lodInfo.level,
      lodSegments: lodInfo.segments,
      lodTriangles: lodInfo.actualTriangles,
      lodTargetTriangles: lodInfo.targetTriangles,
      lodSettingsVersion: this.lodSettingsVersion,
      centerX: originX + worldSize * 0.5,
      centerZ: originZ + worldSize * 0.5,
      cullBounds: new THREE.Box3(
        new THREE.Vector3(originX, minY - cullPaddingY, originZ),
        new THREE.Vector3(originX + worldSize, maxY + cullPaddingY, originZ + worldSize)
      ),
      inFrustum: true,
      terrainMesh,
      roadMesh,
      grassHighMesh: null,
      grassLowMesh: null,
      grassHighReady: false,
      grassLowReady: false,
    };

    this.chunks.set(key, chunkRecord);
    return chunkRecord;
  }

  // Update chunks based on player position
  update(playerX, playerZ, camera = null, options = null) {
    const forceLoad = !!(options && options.forceLoad);
    const { cx: pcx, cz: pcz } = this.worldToChunk(playerX, playerZ);
    const needed = new Set();
    const grassBuildKeys = new Set();
    const preloadRadius = (this.viewDistance + 1) * this.chunkWorldSize;
    const lowGrassBuildDistance = this.grassRenderDistance + this.grassLowBuildPadding;
    const highGrassBuildDistance = this.grassHighDetailDistance + this.grassHighBuildPadding;
    const lowGrassBuildDistanceSq = lowGrassBuildDistance * lowGrassBuildDistance;
    const highGrassBuildDistanceSq = highGrassBuildDistance * highGrassBuildDistance;
    const frustum = this.updateCameraFrustum(camera);

    this.updatePlayerMotionEstimate(playerX, playerZ);
    const suspendGrassStreaming = this.grassStreamingSuspended
      ? this.playerSpeed > this.grassResumeSpeed
      : this.playerSpeed > this.grassSuspendSpeed;
    this.setGrassStreamingSuspended(suspendGrassStreaming);
    const grassBladesActive = this.grassBladesEnabled && !this.grassStreamingSuspended;
    this.grassUniforms.uTime.value = performance.now() * 0.001;
    this.grassUniforms.uPlayerXZ.value.set(playerX, playerZ);
    this.terrainUniforms.uPlayerXZ.value.set(playerX, playerZ);

    const roadMinX = playerX - preloadRadius;
    const roadMinZ = playerZ - preloadRadius;
    const roadMaxX = playerX + preloadRadius;
    const roadMaxZ = playerZ + preloadRadius;

    if (forceLoad || this.shouldRefreshRoadNetwork(roadMinX, roadMinZ, roadMaxX, roadMaxZ)) {
      this.ensureRoadNetworkForBounds(roadMinX, roadMinZ, roadMaxX, roadMaxZ);
      this.cachedRoadBounds = {
        minX: roadMinX,
        minZ: roadMinZ,
        maxX: roadMaxX,
        maxZ: roadMaxZ,
      };
    }

    for (let dz = -this.viewDistance; dz <= this.viewDistance; dz++) {
      for (let dx = -this.viewDistance; dx <= this.viewDistance; dx++) {
        const chunkX = pcx + dx;
        const chunkZ = pcz + dz;
        const key = `${chunkX},${chunkZ}`;
        const chunkDistSq = this.getChunkMinDistanceSq(chunkX, chunkZ, playerX, playerZ);
        const chunkDistance = Math.sqrt(chunkDistSq);
        const existingChunk = this.chunks.get(key);
        const desiredLodLevel = this.getDesiredLodLevel(chunkDistance, existingChunk ? existingChunk.lodLevel : null);
        const chunkLodReady = !!existingChunk
          && existingChunk.lodLevel === desiredLodLevel
          && existingChunk.lodSettingsVersion === this.lodSettingsVersion;
        needed.add(key);

        if (forceLoad) {
          if (
            !existingChunk
            || existingChunk.lodLevel !== desiredLodLevel
            || existingChunk.lodSettingsVersion !== this.lodSettingsVersion
          ) {
            this.generateChunk(chunkX, chunkZ, desiredLodLevel, { replace: !!existingChunk });
          }
        } else {
          if (
            !existingChunk
            || existingChunk.lodLevel !== desiredLodLevel
            || existingChunk.lodSettingsVersion !== this.lodSettingsVersion
          ) {
            this.queueChunkGeneration(chunkX, chunkZ, chunkDistSq, desiredLodLevel, !!existingChunk);
          }
        }

        if (grassBladesActive && chunkLodReady && chunkDistSq <= lowGrassBuildDistanceSq) {
          grassBuildKeys.add(this.getGrassQueueKey(key, 'low'));
        }

        if (grassBladesActive && chunkLodReady && chunkDistSq <= highGrassBuildDistanceSq) {
          grassBuildKeys.add(this.getGrassQueueKey(key, 'high'));
        }
      }
    }

    this.currentNeededChunkKeys = needed;
    this.currentGrassBuildKeys = grassBladesActive ? grassBuildKeys : new Set();

    if (!forceLoad) {
      this.processChunkGenerationQueue();
    }

    const refreshedGrassChunks = [];

    for (const [key, chunk] of this.chunks) {
      if (!needed.has(key)) {
        this.disposeChunk(chunk);
        this.chunks.delete(key);
        continue;
      }

      const inFrustum = this.updateChunkFrustumVisibility(chunk, frustum);
      const chunkDistSq = this.getChunkMinDistanceSq(chunk.cx, chunk.cz, playerX, playerZ);
      const desiredChunkLod = this.getDesiredLodLevel(Math.sqrt(chunkDistSq), chunk.lodLevel);
      const chunkNeedsLodRefresh = chunk.lodLevel !== desiredChunkLod || chunk.lodSettingsVersion !== this.lodSettingsVersion;

      if (!grassBladesActive) {
        if (chunk.grassHighMesh) chunk.grassHighMesh.visible = false;
        if (chunk.grassLowMesh) chunk.grassLowMesh.visible = false;
        continue;
      }

      if (chunkNeedsLodRefresh) {
        if (chunk.grassHighMesh) chunk.grassHighMesh.visible = false;
        if (chunk.grassLowMesh) chunk.grassLowMesh.visible = false;
        continue;
      }

      if (chunkDistSq <= lowGrassBuildDistanceSq && !chunk.grassLowReady) {
        if (forceLoad) {
          if (this.buildGrassChunkLod(chunk, 'low')) {
            refreshedGrassChunks.push(chunk);
          }
        } else {
          this.queueGrassChunkBuild(chunk, 'low', chunkDistSq + 0.25);
        }
      }

      if (chunkDistSq <= highGrassBuildDistanceSq && !chunk.grassHighReady) {
        if (forceLoad) {
          if (this.buildGrassChunkLod(chunk, 'high')) {
            refreshedGrassChunks.push(chunk);
          }
        } else {
          this.queueGrassChunkBuild(chunk, 'high', Math.max(0, chunkDistSq - 0.25));
        }
      }

      this.updateGrassChunkLod(chunk, playerX, playerZ, inFrustum);
    }

    if (!forceLoad && grassBladesActive) {
      refreshedGrassChunks.push(...this.processGrassGenerationQueue());
    }

    for (const chunk of refreshedGrassChunks) {
      this.updateGrassChunkLod(chunk, playerX, playerZ, chunk.inFrustum !== false);
    }

    if (grassBladesActive) {
      this.updateUltraNearGrass(playerX, playerZ, forceLoad);
      this.updateUltraNearGrassVisibility(playerX, playerZ, frustum);
    }
  }
}

window.TerrainManager = TerrainManager;
