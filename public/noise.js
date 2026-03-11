/**
 * Improved Perlin Noise implementation
 * Based on Stefan Gustavson's implementation
 */
class PerlinNoise {
  constructor(seed) {
    this.grad3 = [
      [1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],
      [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],
      [0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]
    ];
    this.perm = new Uint8Array(512);
    this.gradP = new Array(512);

    this.seed(seed || Math.random());
  }

  seed(val) {
    const p = new Uint8Array(256);
    // Simple seeded shuffle
    let s = Math.floor(val * 65536) || 1;
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      s = (s * 16807) % 2147483647;
      const j = s % (i + 1);
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.gradP[i] = this.grad3[this.perm[i] % 12];
    }
  }

  fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  lerp(a, b, t) { return (1 - t) * a + t * b; }

  dot2(g, x, y) { return g[0] * x + g[1] * y; }

  perlin2(x, y) {
    let X = Math.floor(x), Y = Math.floor(y);
    x -= X; y -= Y;
    X &= 255; Y &= 255;

    const n00 = this.dot2(this.gradP[X + this.perm[Y]], x, y);
    const n01 = this.dot2(this.gradP[X + this.perm[Y + 1]], x, y - 1);
    const n10 = this.dot2(this.gradP[X + 1 + this.perm[Y]], x - 1, y);
    const n11 = this.dot2(this.gradP[X + 1 + this.perm[Y + 1]], x - 1, y - 1);

    const u = this.fade(x);
    return this.lerp(
      this.lerp(n00, n10, u),
      this.lerp(n01, n11, u),
      this.fade(y)
    );
  }

  // Fractal Brownian Motion for more natural terrain
  fbm(x, y, octaves = 6, lacunarity = 2, gain = 0.5) {
    let value = 0;
    let amplitude = 1;
    let frequency = 1;
    let maxValue = 0;

    for (let i = 0; i < octaves; i++) {
      value += amplitude * this.perlin2(x * frequency, y * frequency);
      maxValue += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }

    return value / maxValue;
  }
}

// Export for browser
window.PerlinNoise = PerlinNoise;
