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
    this.chunkWorldSize = 128;  // world units per chunk
    this.viewDistance = 3;      // chunks visible in each direction
    this.continentHeightScale = 1000; // broad continents/oceans
    this.detailHeightScale = 200;     // hills, valleys, lakes
    this.heightScale = this.continentHeightScale + this.detailHeightScale;
    this.continentNoiseScale = 0.00005;
    this.detailNoiseScale = 0.00185;
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
    const continentNoise = this.noise.perlin2(
      worldX * this.continentNoiseScale,
      worldZ * this.continentNoiseScale
    );
    const shapedContinent = Math.sign(continentNoise) * Math.pow(Math.abs(continentNoise), 1.18);
    const continentHeight = shapedContinent * this.continentHeightScale;

    const detailNoise = this.noise.perlin2(
      worldX * this.detailNoiseScale,
      worldZ * this.detailNoiseScale
    );
    const detailHeight = detailNoise * this.detailHeightScale;

    return continentHeight + detailHeight;
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

  getTerrainColor(height, worldX, worldZ) {
    const aboveSeaLevel = height - this.waterLevel;

    if (aboveSeaLevel <= 0) {
      const depth = this.clamp(-aboveSeaLevel / this.continentHeightScale, 0, 1);
      return this.mix3([0.1, 0.34, 0.62], [0.02, 0.08, 0.22], depth);
    }

    if (aboveSeaLevel < 30) {
      const shoreline = this.smoothstep(0, 30, aboveSeaLevel);
      const duneNoise = this.noise.perlin2(worldX * 0.012, worldZ * 0.012) * 0.5 + 0.5;
      const brightness = 0.9 + duneNoise * 0.08;
      return this.mix3(
        [0.7 * brightness, 0.66 * brightness, 0.48 * brightness],
        [0.45, 0.56, 0.31],
        shoreline
      );
    }

    if (aboveSeaLevel < 220) {
      const t = this.smoothstep(30, 220, aboveSeaLevel);
      const vegetation = this.noise.perlin2(worldX * 0.01, worldZ * 0.01) * 0.5 + 0.5;
      return this.mix3(
        [0.26, 0.5 + vegetation * 0.08, 0.19],
        [0.22, 0.44, 0.17],
        t
      );
    }

    if (aboveSeaLevel < 520) {
      const t = this.smoothstep(220, 520, aboveSeaLevel);
      return this.mix3([0.24, 0.4, 0.18], [0.42, 0.36, 0.24], t);
    }

    if (aboveSeaLevel < 900) {
      const t = this.smoothstep(520, 900, aboveSeaLevel);
      return this.mix3([0.42, 0.36, 0.24], [0.62, 0.6, 0.58], t);
    }

    const snow = this.smoothstep(900, this.heightScale, aboveSeaLevel);
    return this.mix3([0.62, 0.6, 0.58], [0.95, 0.96, 0.98], snow);
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
    const preloadRadius = (this.viewDistance + 1) * this.chunkWorldSize;

    this.ensureRoadNetworkForBounds(
      playerX - preloadRadius,
      playerZ - preloadRadius,
      playerX + preloadRadius,
      playerZ + preloadRadius
    );

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
