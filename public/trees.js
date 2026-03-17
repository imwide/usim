/**
 * Tree system – procedural birch trees with LOD and instanced rendering.
 *
 * LOD levels:
 *   0  (billboard)   – single camera-facing quad, birch_billboard texture
 *   1  (low)         – minimal 3-D trunk + 1-2 branch quads, low-res textures
 *   2  (medium/high) – procedural trunk with branches and leaf clusters, full-res textures
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
    this.treeMinElevation = 18;      // above sea-level minimum
    this.treeMaxElevation = 420;     // above sea-level maximum
    this.treeMaxSlope = 0.82;        // max normal-Y (cos of slope angle)
    this.treeNoiseScale = 0.0045;    // perlin scale for distribution
    this.treeNoiseThreshold = 0.30;  // noise floor – below this, no trees at all
    this.treeNoiseOffsetX = 4871.3;
    this.treeNoiseOffsetZ = -2917.8;
    this.maxTreesPerChunk = 10000;   // effectively unlimited – density is controlled by noise

    // LOD distances (world units from camera)
    this.lodBillboardDistance = 600;  // beyond this → billboard
    this.lodLowDistance = 250;        // beyond this → low-poly
    this.lodHighDistance = 120;       // beyond this → medium, closer → high detail uses same geo

    // View distance for tree chunks (in chunks)
    this.treeViewDistance = 8;

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
    this.trunkMaterialHigh = null;
    this.trunkMaterialLow = null;
    this.leafMaterialHigh = null;
    this.leafMaterialLow = null;

    // ── Geometry caches (keyed by seed hash) ───────────────────
    // We pre-build a small palette of tree geometries to instance from.
    this.treePaletteSize = 12;
    this.highGeometries = [];   // merged BufferGeometry per palette slot
    this.lowGeometries = [];
    this.paletteDirty = true;

    // Reusable helpers
    this._v3 = new THREE.Vector3();
    this._mat4 = new THREE.Matrix4();
    this._quat = new THREE.Quaternion();
    this._frustum = new THREE.Frustum();
    this._frustumMatrix = new THREE.Matrix4();
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
      load('birch_billboard.png'),
      load('birch_billboard_low.png'),
    ]).then(([barkHigh, barkLow, leavesHigh, leavesLow, billboardHigh, billboardLow]) => {
      this.textures.barkHigh = barkHigh;
      this.textures.barkLow = barkLow;
      this.textures.leavesHigh = leavesHigh;
      this.textures.leavesLow = leavesLow;
      this.textures.billboardHigh = billboardHigh;
      this.textures.billboardLow = billboardLow;
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
      ctx.fillStyle = '#e8ddd0';
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

  // ═══════════════════════════════════════════════════════════════
  //  SHARED ASSETS – materials, geometries, palette
  // ═══════════════════════════════════════════════════════════════

  buildSharedAssets() {
    if (this.sharedReady) return;

    // ── Billboard ──
    this.billboardGeo = new THREE.PlaneGeometry(14, 22);
    // shift origin to bottom center so billboard sits on ground
    this.billboardGeo.translate(0, 11, 0);

    this.billboardMat = new THREE.MeshLambertMaterial({
      map: this.textures.billboardHigh,
      color: 0xffffff,
      transparent: true,
      alphaTest: 0.3,
      side: THREE.DoubleSide,
      depthWrite: true,
      fog: true,
    });

    this.billboardMatLow = new THREE.MeshLambertMaterial({
      map: this.textures.billboardLow || this.textures.billboardHigh,
      color: 0xffffff,
      transparent: true,
      alphaTest: 0.3,
      side: THREE.DoubleSide,
      depthWrite: true,
      fog: true,
    });

    // ── Trunk materials ──
    this.trunkMaterialHigh = new THREE.MeshLambertMaterial({
      map: this.textures.barkHigh,
      side: THREE.FrontSide,
      fog: true,
    });

    this.trunkMaterialLow = new THREE.MeshLambertMaterial({
      map: this.textures.barkLow || this.textures.barkHigh,
      side: THREE.FrontSide,
      fog: true,
    });

    // ── Leaf materials ──
    this.leafMaterialHigh = new THREE.MeshLambertMaterial({
      map: this.textures.leavesHigh,
      transparent: true,
      alphaTest: 0.35,
      side: THREE.DoubleSide,
      fog: true,
    });

    this.leafMaterialLow = new THREE.MeshLambertMaterial({
      map: this.textures.leavesLow || this.textures.leavesHigh,
      transparent: true,
      alphaTest: 0.35,
      side: THREE.DoubleSide,
      fog: true,
    });

    // Build geometry palette
    this.buildGeometryPalette();
    this.sharedReady = true;
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

  /**
   * Build a small palette of pre-generated tree geometries for each LOD.
   * Trees in the world simply pick from this palette, avoiding per-tree geometry creation.
   */
  buildGeometryPalette() {
    this.highGeometries = [];
    this.lowGeometries = [];

    for (let i = 0; i < this.treePaletteSize; i++) {
      const seed = i / this.treePaletteSize;
      this.highGeometries.push(this.createTreeGeometry(seed, 'high'));
      this.lowGeometries.push(this.createTreeGeometry(seed, 'low'));
    }
  }

  /**
   * Create a single procedural birch tree geometry (trunk + branches + leaf quads).
   * Returns { trunk: BufferGeometry, leaves: BufferGeometry }
   */
  createTreeGeometry(seed, lod) {
    const rng = this.seededRandom(seed * 99999 + 7);

    // Tree parameters (vary with seed)
    const height = 12 + rng() * 10;            // 12-22
    const trunkRadius = 0.25 + rng() * 0.15;   // 0.25-0.40
    const branchCount = lod === 'high' ? (4 + Math.floor(rng() * 5)) : (2 + Math.floor(rng() * 2));
    const trunkSegments = lod === 'high' ? 6 : 3;
    const trunkRadialSegments = lod === 'high' ? 5 : 3;

    // ── TRUNK ──
    const trunkGeo = this.createTrunkGeometry(
      height, trunkRadius, trunkSegments, trunkRadialSegments, rng
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
      const branchLength = (1.5 + rng() * 3) * (1 - t * 0.4);
      const branchPitch = 0.3 + rng() * 0.5; // upward angle

      // Branch stick (thin so leaves dominate the look)
      if (lod === 'high') {
        const brGeo = this.createBranchGeometry(
          branchY, angle, branchPitch, branchLength, trunkRadius * 0.25, rng
        );
        branchGeos.push(brGeo);
      }

      // Leaf cluster at branch tip
      const tipX = Math.cos(angle) * Math.cos(branchPitch) * branchLength;
      const tipY = branchY + Math.sin(branchPitch) * branchLength;
      const tipZ = Math.sin(angle) * Math.cos(branchPitch) * branchLength;

      // Place leaf quads along the branch, not just at the tip
      const leafCount = lod === 'high' ? (3 + Math.floor(rng() * 3)) : (1 + Math.floor(rng() * 2));
      for (let l = 0; l < leafCount; l++) {
        const along = 0.3 + (l / leafCount) * 0.7; // spread from mid-branch to tip
        const leafSize = lod === 'high' ? (3 + rng() * 2.5) : (5 + rng() * 3);
        const lx = tipX * along + (rng() - 0.5) * 2.5;
        const ly = (branchY + (tipY - branchY) * along) + (rng() - 0.5) * 1.5;
        const lz = tipZ * along + (rng() - 0.5) * 2.5;
        const rotation = rng() * Math.PI;
        leafQuads.push(
          this.createLeafQuad(lx, ly, lz, leafSize, rotation, rng)
        );
      }
    }

    // Add top canopy cluster
    const topLeafSize = lod === 'high' ? (4 + rng() * 3) : (7 + rng() * 4);
    const topLeafCount = lod === 'high' ? 4 : 2;
    for (let t = 0; t < topLeafCount; t++) {
      const ox = (rng() - 0.5) * 3;
      const oy = crownTop + rng() * 1.5;
      const oz = (rng() - 0.5) * 3;
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

  createBranchGeometry(baseY, angle, pitch, length, radius, rng) {
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
      const px = dirX * length * t;
      const py = baseY + dirY * length * t;
      const pz = dirZ * length * t;
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

        // Perlin noise value directly controls spawn probability.
        // noiseVal is 0..1; at 1.0 every cell spawns a tree (dense forest).
        const noiseVal = this.noise.perlin2(
          (wx + this.treeNoiseOffsetX) * this.treeNoiseScale,
          (wz + this.treeNoiseOffsetZ) * this.treeNoiseScale
        ) * 0.5 + 0.5;

        if (noiseVal < this.treeNoiseThreshold) continue;

        // Remap noise from [threshold..1] → [0..1] for spawn probability
        const spawnChance = (noiseVal - this.treeNoiseThreshold) / (1 - this.treeNoiseThreshold);

        // Use hash as a per-cell random roll; tree spawns when roll < spawnChance
        const roll = this.hashTreeSeed(wx * 3.7, wz * 5.3);
        if (roll > spawnChance) continue;

        // Terrain checks
        const height = this.terrain.getHeight(wx, wz);
        const aboveSeaLevel = height - this.terrain.waterLevel;
        if (aboveSeaLevel < this.treeMinElevation || aboveSeaLevel > this.treeMaxElevation) continue;

        // Slope check
        const normalY = this.terrain.getBaseNormalY(wx, wz);
        if (normalY < this.treeMaxSlope) continue;

        // Road avoidance
        const roadInfo = this.terrain.getRoadInfluence(wx, wz, height);
        if (roadInfo && roadInfo.dist < this.terrain.highwayHalfWidth + 8) continue;

        // Select palette index
        const paletteIdx = Math.floor(hash * this.treePaletteSize * 0.999) % this.treePaletteSize;
        // Scale variation
        const scale = 0.7 + hash2 * 0.6;
        // Rotation
        const rotY = hash * Math.PI * 2;

        trees.push({ wx, wz, height, paletteIdx, scale, rotY });

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

    if (lod === 'billboard') {
      return this.createBillboardInstances(trees, chunk.distSq);
    }

    const geoPalette = lod === 'high' ? this.highGeometries : this.lowGeometries;
    const trunkMat = lod === 'high' ? this.trunkMaterialHigh : this.trunkMaterialLow;
    const leafMat = lod === 'high' ? this.leafMaterialHigh : this.leafMaterialLow;

    // Group trees by palette index for instancing
    const byPalette = new Map();
    for (const tree of trees) {
      if (!byPalette.has(tree.paletteIdx)) byPalette.set(tree.paletteIdx, []);
      byPalette.get(tree.paletteIdx).push(tree);
    }

    const group = new THREE.Group();
    group.name = `trees-${lod}-${chunk.key}`;

    for (const [paletteIdx, paletteTrees] of byPalette) {
      const geoSet = geoPalette[paletteIdx];
      if (!geoSet) continue;

      // Trunk instances
      if (geoSet.trunk && geoSet.trunk.getAttribute('position').count > 0) {
        const trunkMesh = new THREE.InstancedMesh(geoSet.trunk, trunkMat, paletteTrees.length);
        trunkMesh.frustumCulled = false; // we cull at chunk level
        trunkMesh.userData.isTreeTrunk = true; // used by sun occlusion raycaster
        const mat4 = this._mat4;
        const quat = this._quat;

        for (let i = 0; i < paletteTrees.length; i++) {
          const t = paletteTrees[i];
          quat.setFromAxisAngle(this._v3.set(0, 1, 0), t.rotY);
          mat4.compose(
            this._v3.set(t.wx, t.height, t.wz),
            quat,
            new THREE.Vector3(t.scale, t.scale, t.scale)
          );
          trunkMesh.setMatrixAt(i, mat4);
        }
        trunkMesh.instanceMatrix.needsUpdate = true;
        group.add(trunkMesh);
      }

      // Leaf instances
      if (geoSet.leaves && geoSet.leaves.getAttribute('position').count > 0) {
        const leafMesh = new THREE.InstancedMesh(geoSet.leaves, leafMat, paletteTrees.length);
        leafMesh.frustumCulled = false;
        const mat4 = this._mat4;
        const quat = this._quat;

        for (let i = 0; i < paletteTrees.length; i++) {
          const t = paletteTrees[i];
          quat.setFromAxisAngle(this._v3.set(0, 1, 0), t.rotY);
          mat4.compose(
            this._v3.set(t.wx, t.height, t.wz),
            quat,
            new THREE.Vector3(t.scale, t.scale, t.scale)
          );
          leafMesh.setMatrixAt(i, mat4);
        }
        leafMesh.instanceMatrix.needsUpdate = true;
        group.add(leafMesh);
      }
    }

    return group;
  }

  createBillboardInstances(trees, distSq) {
    if (trees.length === 0) return null;

    // Use lower-res material for very far billboards
    const mat = distSq > (this.lodBillboardDistance * 1.5) ** 2
      ? this.billboardMatLow
      : this.billboardMat;

    const mesh = new THREE.InstancedMesh(this.billboardGeo, mat, trees.length);
    mesh.frustumCulled = false;
    const mat4 = this._mat4;

    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      // Billboard – always face camera Y rotation: we set the rotation each frame
      mat4.compose(
        this._v3.set(t.wx, t.height, t.wz),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.rotY),
        new THREE.Vector3(t.scale, t.scale, t.scale)
      );
      mesh.setMatrixAt(i, mat4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  /**
   * Update billboard instances to face camera.
   */
  updateBillboards(cameraPosition) {
    for (const [, chunk] of this.treeChunks) {
      if (chunk.currentLod !== 'billboard' || !chunk.meshGroup) continue;

      const mesh = chunk.meshGroup;
      if (!mesh.isInstancedMesh) continue;

      const camAngle = Math.atan2(
        cameraPosition.x - chunk.centerX,
        cameraPosition.z - chunk.centerZ
      );

      const mat4 = this._mat4;
      const quat = this._quat;

      for (let i = 0; i < chunk.trees.length; i++) {
        const t = chunk.trees[i];
        quat.setFromAxisAngle(this._v3.set(0, 1, 0), camAngle);
        mat4.compose(
          this._v3.set(t.wx, t.height, t.wz),
          quat,
          new THREE.Vector3(t.scale, t.scale, t.scale)
        );
        mesh.setMatrixAt(i, mat4);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  CHUNK STREAMING & LOD MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  getLodForDistance(dist) {
    if (dist > this.lodBillboardDistance) return 'billboard';
    if (dist > this.lodLowDistance) return 'low';
    return 'high';
  }

  getChunkCenterDistSq(cx, cz, playerX, playerZ) {
    const centerX = (cx + 0.5) * this.chunkWorldSize;
    const centerZ = (cz + 0.5) * this.chunkWorldSize;
    const dx = centerX - playerX;
    const dz = centerZ - playerZ;
    return dx * dx + dz * dz;
  }

  /**
   * Main update – call each frame from the game loop.
   */
  update(playerX, playerZ, camera) {
    if (!this.sharedReady) return;

    this.camera = camera;
    const pcx = Math.floor(playerX / this.chunkWorldSize);
    const pcz = Math.floor(playerZ / this.chunkWorldSize);
    const needed = new Set();
    const maxViewDist = this.treeViewDistance;

    // Update camera frustum for culling
    this._frustumMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._frustumMatrix);

    // Determine which chunks are needed and at what LOD
    for (let dz = -maxViewDist; dz <= maxViewDist; dz++) {
      for (let dx = -maxViewDist; dx <= maxViewDist; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        const key = `${cx},${cz}`;
        const distSq = this.getChunkCenterDistSq(cx, cz, playerX, playerZ);
        const dist = Math.sqrt(distSq);

        // Beyond view range
        if (dist > (maxViewDist + 0.5) * this.chunkWorldSize) continue;

        needed.add(key);
        const desiredLod = this.getLodForDistance(dist);

        const existing = this.treeChunks.get(key);

        if (existing) {
          existing.distSq = distSq;

          // LOD transition?
          if (existing.currentLod !== desiredLod) {
            this.setChunkLod(existing, desiredLod);
          }

          // Visibility (frustum cull at chunk level)
          if (existing.meshGroup) {
            const chunkSphere = this.getChunkBoundingSphere(cx, cz);
            const visible = this._frustum.intersectsSphere(chunkSphere);
            if (existing.meshGroup.isGroup) {
              existing.meshGroup.visible = visible;
            } else {
              existing.meshGroup.visible = visible;
            }
          }
        } else {
          // Create new tree chunk
          this.createTreeChunk(cx, cz, key, distSq, desiredLod);
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

    // Update billboards to face camera
    this.updateBillboards(camera.position);
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

  createTreeChunk(cx, cz, key, distSq, lod) {
    const trees = this.getTreePositionsForChunk(cx, cz);
    if (trees.length === 0) {
      // Still track the chunk so we don't re-compute
      this.treeChunks.set(key, {
        cx, cz, key, trees: [], meshGroup: null, currentLod: lod,
        centerX: (cx + 0.5) * this.chunkWorldSize,
        centerZ: (cz + 0.5) * this.chunkWorldSize,
        distSq,
        lodMeshCache: {},
      });
      return;
    }

    const chunk = {
      cx, cz, key, trees, meshGroup: null, currentLod: null,
      centerX: (cx + 0.5) * this.chunkWorldSize,
      centerZ: (cz + 0.5) * this.chunkWorldSize,
      distSq,
      lodMeshCache: {},
    };

    this.treeChunks.set(key, chunk);
    this.setChunkLod(chunk, lod);
  }

  setChunkLod(chunk, lod) {
    if (chunk.currentLod === lod) return;

    // Remove old mesh
    if (chunk.meshGroup) {
      chunk.meshGroup.visible = false;
      this.scene.remove(chunk.meshGroup);
    }

    // Check cache
    if (chunk.lodMeshCache[lod]) {
      chunk.meshGroup = chunk.lodMeshCache[lod];
      chunk.meshGroup.visible = true;
      this.scene.add(chunk.meshGroup);
      chunk.currentLod = lod;
      return;
    }

    // Create new mesh for this LOD
    const meshGroup = lod === 'billboard'
      ? this.createBillboardInstances(chunk.trees, chunk.distSq)
      : this.createChunkLodMeshes(chunk, lod);

    if (meshGroup) {
      this.scene.add(meshGroup);
      chunk.lodMeshCache[lod] = meshGroup;
    }

    chunk.meshGroup = meshGroup;
    chunk.currentLod = lod;
  }

  disposeTreeChunk(chunk) {
    // Dispose all cached LOD meshes
    for (const lod in chunk.lodMeshCache) {
      const mesh = chunk.lodMeshCache[lod];
      if (mesh) {
        this.scene.remove(mesh);
        if (mesh.isGroup) {
          mesh.traverse((child) => {
            if (child.isMesh || child.isInstancedMesh) {
              // Don't dispose shared geometry/materials
            }
          });
        }
        // InstancedMesh dispose
        if (mesh.isInstancedMesh) {
          mesh.dispose();
        }
      }
    }
    chunk.lodMeshCache = {};
    chunk.meshGroup = null;
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
    if (this.trunkMaterialHigh) this.trunkMaterialHigh.dispose();
    if (this.trunkMaterialLow) this.trunkMaterialLow.dispose();
    if (this.leafMaterialHigh) this.leafMaterialHigh.dispose();
    if (this.leafMaterialLow) this.leafMaterialLow.dispose();

    // Dispose textures
    for (const key in this.textures) {
      if (this.textures[key]) this.textures[key].dispose();
    }
  }
}

window.TreeManager = TreeManager;
