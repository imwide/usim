/**
 * Infinite chunked terrain system using Perlin noise,
 * with deterministic seeded highways carved into the landscape.
 */
class TerrainManager {
  constructor(scene, noise) {
    this.scene = scene;
    this.noise = noise;
    this.seed = noise.seedValue || 1;

    // Terrain configuration
    this.chunkSize = 64;        // vertices per chunk side
    this.chunkWorldSize = 128;  // world units per chunk
    this.viewDistance = 3;      // chunks visible in each direction
    this.heightScale = 40;      // max terrain height
    this.noiseScale = 0.008;    // noise frequency
    this.waterLevel = -15.5;

    // Highway configuration
    this.highwayStep = 48;
    this.highwayHalfWidth = 9;
    this.highwayShoulder = 10;
    this.highwayCurveSubdivisions = 10;
    this.roadSurfaceHeightOffset = 0.08;

    this.chunks = new Map();    // key: "cx,cz" -> mesh
    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.FrontSide,
    });
    this.roadMaterial = new THREE.MeshLambertMaterial({
      color: 0x2f3136,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });

    this.highways = [];
    this.setupHighways();
  }

  setWaterLevel(level) {
    this.waterLevel = level;
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

  // Base terrain height before any roads flatten or cut the terrain
  getBaseHeight(worldX, worldZ) {
    const nx = worldX * this.noiseScale;
    const nz = worldZ * this.noiseScale;
    let h = this.noise.fbm(nx, nz, 6, 2, 0.5);
    h += 0.5 * this.noise.fbm(nx * 0.3, nz * 0.3, 3, 2, 0.5);
    return h * this.heightScale;
  }

  // Get terrain height at world position after roads are applied
  getHeight(worldX, worldZ) {
    const baseHeight = this.getBaseHeight(worldX, worldZ);
    const roadInfo = this.getRoadInfluence(worldX, worldZ, baseHeight);
    return roadInfo ? roadInfo.height : baseHeight;
  }

  setupHighways() {
    const nearEastWest = (this.hash2(3, 5, 1) - 0.5) * 120;
    const nearNorthSouth = (this.hash2(-4, 7, 2) - 0.5) * 120;

    this.highways = [
      this.createHighway('HW-EW-1', 'ew', nearEastWest, 1),
      this.createHighway('HW-NS-1', 'ns', nearNorthSouth, 2),
    ];
  }

  createHighway(id, orientation, baseOffset, salt) {
    return {
      id,
      orientation,
      salt,
      baseOffset,
      step: this.highwayStep,
      halfWidth: this.highwayHalfWidth,
      shoulder: this.highwayShoulder,
      cutRadius: this.highwayHalfWidth + 2.5,
      influenceRadius: this.highwayHalfWidth + this.highwayShoulder,
      driftScale: 0.00045 + this.hash2(salt, salt * 2, 10) * 0.00018,
      driftAmplitude: 70 + this.hash2(salt, -salt, 11) * 45,
      secondaryScale: 0.0010 + this.hash2(-salt, salt, 12) * 0.00035,
      secondaryAmplitude: 18 + this.hash2(salt, salt, 13) * 16,
      samples: new Map(),
      curves: new Map(),
      minIndex: 0,
      maxIndex: 0,
    };
  }

  catmullRom(a, b, c, d, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (
      (2 * b) +
      (-a + c) * t +
      (2 * a - 5 * b + 4 * c - d) * t2 +
      (-a + 3 * b - 3 * c + d) * t3
    );
  }

  getHighwayGuideMinor(highway, major) {
    const primary = this.noise.perlin2(
      major * highway.driftScale + highway.salt * 17.13,
      highway.salt * 12.73
    ) * highway.driftAmplitude;

    const secondary = this.noise.perlin2(
      major * highway.secondaryScale - highway.salt * 9.17,
      highway.salt * 31.21
    ) * highway.secondaryAmplitude;

    return highway.baseOffset + primary + secondary;
  }

  getHighwayWorldPoint(highway, major, minor) {
    return highway.orientation === 'ew'
      ? { x: major, z: minor }
      : { x: minor, z: major };
  }

  getHighwayWaterPenalty(highway, major, minor) {
    const drySpan = highway.halfWidth + highway.shoulder + 4;
    const offsets = [-drySpan, -drySpan * 0.5, 0, drySpan * 0.5, drySpan];
    let penalty = 0;

    for (const offset of offsets) {
      const point = highway.orientation === 'ew'
        ? { x: major, z: minor + offset }
        : { x: minor + offset, z: major };

      const h = this.getBaseHeight(point.x, point.z);
      const submergeAmount = this.waterLevel + 1.75 - h;
      const shorelineAmount = this.waterLevel + 5.0 - h;

      if (submergeAmount > 0) {
        penalty += 18000 + submergeAmount * 5000;
      } else if (shorelineAmount > 0) {
        penalty += shorelineAmount * 50;
      }
    }

    return penalty;
  }

  createHighwaySample(highway, prevSample, index) {
    const major = index * highway.step;
    const guideMinor = this.getHighwayGuideMinor(highway, major);
    const anchorMinor = prevSample
      ? this.lerp(prevSample.minor, guideMinor, 0.22)
      : guideMinor;

    const candidateOffsets = [0, -12, 12, -24, 24, -40, 40, -60, 60, -84, 84, -112, 112, -148, 148];
    let best = null;

    for (const offset of candidateOffsets) {
      const minor = anchorMinor + offset;
      const point = this.getHighwayWorldPoint(highway, major, minor);
      const baseHeight = this.getBaseHeight(point.x, point.z);

      let cost = Math.abs(offset) * 0.4;
      cost += (minor - guideMinor) * (minor - guideMinor) * 0.016;
      cost += this.getHighwayWaterPenalty(highway, major, minor);

      const lowGround = this.waterLevel + 4.0 - baseHeight;
      if (lowGround > 0) {
        cost += lowGround * 900;
      }

      if (prevSample) {
        const lateralDelta = minor - prevSample.minor;
        cost += lateralDelta * lateralDelta * 0.028;
        cost += Math.abs(baseHeight - prevSample.height) * 0.95;

        const midX = (point.x + prevSample.x) * 0.5;
        const midZ = (point.z + prevSample.z) * 0.5;
        const midHeight = this.getBaseHeight(midX, midZ);
        const midLowGround = this.waterLevel + 3.0 - midHeight;
        if (midLowGround > 0) {
          cost += 14000 + midLowGround * 3500;
        }
      }

      cost += this.hash2(index, highway.salt, 97) * 0.01;

      if (!best || cost < best.cost) {
        best = { cost, major, minor, point, baseHeight };
      }
    }

    return {
      index,
      major,
      minor: best.minor,
      x: best.point.x,
      z: best.point.z,
      height: best.baseHeight,
    };
  }

  ensureHighwaySample(highway, index) {
    if (!highway.samples.size) {
      const sample0 = this.createHighwaySample(highway, null, 0);
      highway.samples.set(0, sample0);
      highway.minIndex = 0;
      highway.maxIndex = 0;
    }

    if (index > highway.maxIndex) {
      let prev = highway.samples.get(highway.maxIndex);
      for (let i = highway.maxIndex + 1; i <= index; i++) {
        const sample = this.createHighwaySample(highway, prev, i);
        highway.samples.set(i, sample);
        prev = sample;
      }
      highway.maxIndex = index;
    }

    if (index < highway.minIndex) {
      let prev = highway.samples.get(highway.minIndex);
      for (let i = highway.minIndex - 1; i >= index; i--) {
        const sample = this.createHighwaySample(highway, prev, i);
        highway.samples.set(i, sample);
        prev = sample;
      }
      highway.minIndex = index;
    }

    return highway.samples.get(index);
  }

  getHighwayCurvePoint(highway, index, t) {
    const p0 = this.ensureHighwaySample(highway, index - 1);
    const p1 = this.ensureHighwaySample(highway, index);
    const p2 = this.ensureHighwaySample(highway, index + 1);
    const p3 = this.ensureHighwaySample(highway, index + 2);

    return {
      x: this.catmullRom(p0.x, p1.x, p2.x, p3.x, t),
      z: this.catmullRom(p0.z, p1.z, p2.z, p3.z, t),
      height: this.catmullRom(p0.height, p1.height, p2.height, p3.height, t),
    };
  }

  ensureHighwayCurve(highway, index) {
    if (highway.curves.has(index)) {
      return highway.curves.get(index);
    }

    const points = [];
    for (let i = 0; i <= this.highwayCurveSubdivisions; i++) {
      const t = i / this.highwayCurveSubdivisions;
      points.push(this.getHighwayCurvePoint(highway, index, t));
    }

    highway.curves.set(index, points);
    return points;
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

  segmentIntersection2D(ax, az, bx, bz, cx, cz, dx, dz) {
    const rX = bx - ax;
    const rZ = bz - az;
    const sX = dx - cx;
    const sZ = dz - cz;
    const denom = rX * sZ - rZ * sX;
    if (Math.abs(denom) < 1e-5) return null;

    const qpx = cx - ax;
    const qpz = cz - az;
    const t = (qpx * sZ - qpz * sX) / denom;
    const u = (qpx * rZ - qpz * rX) / denom;

    if (t < 0 || t > 1 || u < 0 || u > 1) return null;

    return {
      x: ax + rX * t,
      z: az + rZ * t,
      t,
      u,
    };
  }

  appendIntersectionPatch(positions, indices, centerX, centerY, centerZ, radius, rotation = 0, sides = 8) {
    const centerIndex = positions.length / 3;
    positions.push(centerX, centerY, centerZ);

    for (let i = 0; i < sides; i++) {
      const angle = rotation + (i / sides) * Math.PI * 2;
      positions.push(
        centerX + Math.cos(angle) * radius,
        centerY,
        centerZ + Math.sin(angle) * radius
      );
    }

    for (let i = 0; i < sides; i++) {
      const a = centerIndex;
      const b = centerIndex + 1 + i;
      const c = centerIndex + 1 + ((i + 1) % sides);
      indices.push(a, b, c);
    }
  }

  getHighwayInfluence(highway, worldX, worldZ) {
    const majorCoord = highway.orientation === 'ew' ? worldX : worldZ;
    const centerIndex = Math.floor(majorCoord / highway.step);
    const lookAround = 2;

    this.ensureHighwaySample(highway, centerIndex - lookAround - 1);
    this.ensureHighwaySample(highway, centerIndex + lookAround + 2);

    let best = null;

    for (let i = centerIndex - lookAround; i <= centerIndex + lookAround; i++) {
      const curve = this.ensureHighwayCurve(highway, i);
      for (let j = 0; j < curve.length - 1; j++) {
        const a = curve[j];
        const b = curve[j + 1];
        const projection = this.projectPointToSegment(worldX, worldZ, a.x, a.z, b.x, b.z);
        if (projection.distSq > highway.influenceRadius * highway.influenceRadius) continue;

        const dist = Math.sqrt(projection.distSq);
        const roadHeight = this.lerp(a.height, b.height, projection.t);
        if (roadHeight < this.waterLevel + 0.9) continue;

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

  getTerrainColor(height, worldX, worldZ) {
    const t = (height / this.heightScale + 1) * 0.5;

    if (t < 0.3) {
      return [0.1, 0.3, 0.6];
    }

    if (t < 0.4) {
      const shoreline = (t - 0.3) / 0.1;
      const wetness = 1 - shoreline;
      const duneNoise = this.noise.perlin2(worldX * 0.025, worldZ * 0.025) * 0.5 + 0.5;
      const brightness = 0.88 + duneNoise * 0.10 - wetness * 0.08;
      return [0.68 * brightness, 0.62 * brightness, 0.42 * brightness];
    }

    if (t < 0.7) {
      const g = 0.3 + (t - 0.4) * 0.5;
      return [0.2, g, 0.15];
    }

    if (t < 0.85) {
      const g = 0.4 + (t - 0.7) * 1.5;
      return [g, g, g];
    }

    return [0.95, 0.95, 0.98];
  }

  getSurfaceColor(height, worldX, worldZ, roadInfo) {
    return this.getTerrainColor(height, worldX, worldZ);
  }

  buildRoadMesh(size, step, originX, originZ, vertices) {
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
        const centerRoadInfo = this.getRoadInfluence(centerX, centerZ, centerBaseHeight);

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

    return new THREE.Mesh(geometry, this.roadMaterial);
  }

  // Generate a single chunk mesh
  generateChunk(cx, cz) {
    const key = `${cx},${cz}`;
    if (this.chunks.has(key)) return;

    const size = this.chunkSize;
    const worldSize = this.chunkWorldSize;
    const step = worldSize / (size - 1);
    const originX = cx * worldSize;
    const originZ = cz * worldSize;

    const geometry = new THREE.BufferGeometry();
    const vertices = new Float32Array(size * size * 3);
    const colors = new Float32Array(size * size * 3);
    const indices = [];

    for (let iz = 0; iz < size; iz++) {
      for (let ix = 0; ix < size; ix++) {
        const idx = (iz * size + ix) * 3;
        const wx = originX + ix * step;
        const wz = originZ + iz * step;

        const baseHeight = this.getBaseHeight(wx, wz);
        const roadInfo = this.getRoadInfluence(wx, wz, baseHeight);
        const height = roadInfo ? roadInfo.height : baseHeight;
        const color = this.getSurfaceColor(height, wx, wz, roadInfo);

        vertices[idx] = wx;
        vertices[idx + 1] = height;
        vertices[idx + 2] = wz;

        colors[idx] = color[0];
        colors[idx + 1] = color[1];
        colors[idx + 2] = color[2];
      }
    }

    // Build triangle indices
    for (let iz = 0; iz < size - 1; iz++) {
      for (let ix = 0; ix < size - 1; ix++) {
        const a = iz * size + ix;
        const b = a + 1;
        const c = a + size;
        const d = c + 1;
        indices.push(a, c, b);
        indices.push(b, c, d);
      }
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const terrainMesh = new THREE.Mesh(geometry, this.material);
    terrainMesh.receiveShadow = true;
    this.scene.add(terrainMesh);

    const roadMesh = this.buildRoadMesh(size, step, originX, originZ, vertices);
    if (roadMesh) {
      roadMesh.receiveShadow = true;
      this.scene.add(roadMesh);
    }

    this.chunks.set(key, { terrainMesh, roadMesh });
  }

  // Update chunks based on player position
  update(playerX, playerZ) {
    const { cx: pcx, cz: pcz } = this.worldToChunk(playerX, playerZ);
    const needed = new Set();

    for (let dz = -this.viewDistance; dz <= this.viewDistance; dz++) {
      for (let dx = -this.viewDistance; dx <= this.viewDistance; dx++) {
        const key = `${pcx + dx},${pcz + dz}`;
        needed.add(key);
        this.generateChunk(pcx + dx, pcz + dz);
      }
    }

    for (const [key, chunk] of this.chunks) {
      if (!needed.has(key)) {
        if (chunk.terrainMesh) {
          this.scene.remove(chunk.terrainMesh);
          chunk.terrainMesh.geometry.dispose();
        }
        if (chunk.roadMesh) {
          this.scene.remove(chunk.roadMesh);
          chunk.roadMesh.geometry.dispose();
        }
        this.chunks.delete(key);
      }
    }
  }
}

window.TerrainManager = TerrainManager;
