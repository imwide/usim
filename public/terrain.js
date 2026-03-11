/**
 * Infinite chunked terrain system using Perlin noise
 */
class TerrainManager {
  constructor(scene, noise) {
    this.scene = scene;
    this.noise = noise;

    // Terrain configuration
    this.chunkSize = 64;        // vertices per chunk side
    this.chunkWorldSize = 128;  // world units per chunk
    this.viewDistance = 3;      // chunks visible in each direction
    this.heightScale = 40;      // max terrain height
    this.noiseScale = 0.008;    // noise frequency

    this.chunks = new Map();    // key: "cx,cz" -> mesh
    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.FrontSide,
    });
  }

  // Get chunk coordinates for a world position
  worldToChunk(x, z) {
    return {
      cx: Math.floor(x / this.chunkWorldSize),
      cz: Math.floor(z / this.chunkWorldSize),
    };
  }

  // Get terrain height at world position
  getHeight(worldX, worldZ) {
    const nx = worldX * this.noiseScale;
    const nz = worldZ * this.noiseScale;
    let h = this.noise.fbm(nx, nz, 6, 2, 0.5);
    // Add large-scale hills
    h += 0.5 * this.noise.fbm(nx * 0.3, nz * 0.3, 3, 2, 0.5);
    return h * this.heightScale;
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
        const h = this.getHeight(wx, wz);

        vertices[idx] = wx;
        vertices[idx + 1] = h;
        vertices[idx + 2] = wz;

        // Color based on height
        const t = (h / this.heightScale + 1) * 0.5; // normalize to 0-1
        if (t < 0.3) {
          // Deep water blue
          colors[idx] = 0.1; colors[idx+1] = 0.3; colors[idx+2] = 0.6;
        } else if (t < 0.4) {
          // Sand - slightly darker with subtle dune variation so it keeps contrast at noon
          const shoreline = (t - 0.3) / 0.1;
          const wetness = 1 - shoreline;
          const duneNoise = this.noise.perlin2(wx * 0.025, wz * 0.025) * 0.5 + 0.5;
          const brightness = 0.88 + duneNoise * 0.10 - wetness * 0.08;
          colors[idx] = 0.68 * brightness;
          colors[idx+1] = 0.62 * brightness;
          colors[idx+2] = 0.42 * brightness;
        } else if (t < 0.7) {
          // Grass green
          const g = 0.3 + (t - 0.4) * 0.5;
          colors[idx] = 0.2; colors[idx+1] = g; colors[idx+2] = 0.15;
        } else if (t < 0.85) {
          // Rocky grey
          const g = 0.4 + (t - 0.7) * 1.5;
          colors[idx] = g; colors[idx+1] = g; colors[idx+2] = g;
        } else {
          // Snow
          colors[idx] = 0.95; colors[idx+1] = 0.95; colors[idx+2] = 0.98;
        }
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

    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.chunks.set(key, mesh);
  }

  // Update chunks based on player position
  update(playerX, playerZ) {
    const { cx: pcx, cz: pcz } = this.worldToChunk(playerX, playerZ);
    const needed = new Set();

    // Generate needed chunks
    for (let dz = -this.viewDistance; dz <= this.viewDistance; dz++) {
      for (let dx = -this.viewDistance; dx <= this.viewDistance; dx++) {
        const key = `${pcx + dx},${pcz + dz}`;
        needed.add(key);
        this.generateChunk(pcx + dx, pcz + dz);
      }
    }

    // Remove distant chunks
    for (const [key, mesh] of this.chunks) {
      if (!needed.has(key)) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        this.chunks.delete(key);
      }
    }
  }
}

window.TerrainManager = TerrainManager;
