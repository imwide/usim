/**
 * Generate birch tree textures at multiple resolutions.
 * Run with: node scripts/generate-tree-textures.js
 */
const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '..', 'public', 'assets', 'textures', 'trees');
fs.mkdirSync(outDir, { recursive: true });

function seededRandom(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Birch Bark ───────────────────────────────────────────────────

function generateBark(width, height, filename) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const rng = seededRandom(12345);

  // Base color – slightly muted birch to avoid glowing trunks in-engine
  ctx.fillStyle = '#d4cbc0';
  ctx.fillRect(0, 0, width, height);

  // Add subtle vertical grain
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y += 2) {
      const noise = (rng() - 0.5) * 15;
      const r = 212 + noise;
      const g = 203 + noise;
      const b = 192 + noise;
      ctx.fillStyle = `rgb(${r|0},${g|0},${b|0})`;
      ctx.fillRect(x, y, 1, 2);
    }
  }

  // Dark horizontal streaks (characteristic birch bark lenticels)
  const streakCount = Math.floor(height / 4);
  for (let i = 0; i < streakCount; i++) {
    const y = rng() * height;
    const streakWidth = width * (0.15 + rng() * 0.85);
    const streakHeight = 1 + rng() * (height > 128 ? 4 : 2);
    const startX = (width - streakWidth) * rng();
    const alpha = 0.08 + rng() * 0.45;
    const darkness = 25 + rng() * 30;

    ctx.fillStyle = `rgba(${darkness|0},${(darkness-5)|0},${(darkness-10)|0},${alpha})`;
    ctx.fillRect(startX, y, streakWidth, streakHeight);

    // Sometimes add a second thin line nearby
    if (rng() > 0.6) {
      ctx.fillStyle = `rgba(${darkness|0},${(darkness-5)|0},${(darkness-10)|0},${alpha * 0.5})`;
      ctx.fillRect(startX + rng() * 10, y + streakHeight + rng() * 3, streakWidth * 0.7, 1);
    }
  }

  // Occasional darker patches / knots
  const knotCount = Math.floor(height / 60);
  for (let i = 0; i < knotCount; i++) {
    const kx = rng() * width;
    const ky = rng() * height;
    const kr = 3 + rng() * 8;
    ctx.fillStyle = `rgba(60,50,40,${0.1 + rng() * 0.2})`;
    ctx.beginPath();
    ctx.ellipse(kx, ky, kr * 1.5, kr, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(outDir, filename), buf);
  console.log(`  ✓ ${filename} (${width}×${height})`);
}

// ─── Birch Leaves ─────────────────────────────────────────────────

function generateLeaves(size, filename) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const rng = seededRandom(54321);

  ctx.clearRect(0, 0, size, size);

  // Draw a branch stem
  ctx.strokeStyle = '#5a4a3a';
  ctx.lineWidth = size > 64 ? 2 : 1;
  ctx.beginPath();
  ctx.moveTo(size * 0.5, size * 0.95);
  ctx.quadraticCurveTo(size * 0.48, size * 0.5, size * 0.52, size * 0.1);
  ctx.stroke();

  // Small sub-branches
  const subBranches = size > 64 ? 6 : 3;
  for (let i = 0; i < subBranches; i++) {
    const t = 0.2 + (i / subBranches) * 0.65;
    const bx = size * (0.49 + rng() * 0.04);
    const by = size * (0.95 - t * 0.85);
    const angle = (rng() > 0.5 ? 1 : -1) * (0.4 + rng() * 0.8);
    const len = size * (0.1 + rng() * 0.15);
    ctx.strokeStyle = '#5a4a3a';
    ctx.lineWidth = size > 64 ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + Math.cos(angle - Math.PI / 2) * len, by - Math.sin(angle) * len * 0.5);
    ctx.stroke();
  }

  // Leaves clustered around the branch
  const leafCount = size > 64 ? 22 : 12;
  for (let i = 0; i < leafCount; i++) {
    // Position along the branch with some spread
    const t = 0.05 + rng() * 0.85;
    const branchX = size * (0.49 + (rng() - 0.5) * 0.04);
    const branchY = size * (0.95 - t * 0.85);
    const spreadX = (rng() - 0.5) * size * 0.55;
    const spreadY = (rng() - 0.5) * size * 0.3;
    const lx = branchX + spreadX;
    const ly = branchY + spreadY;
    const lr = size * (0.04 + rng() * 0.06);

    // Leaf color – significantly desaturated birch green
    const g = 105 + Math.floor(rng() * 60);
    const r = 88 + Math.floor(rng() * 45);
    const b = 75 + Math.floor(rng() * 28);

    // Leaf shape – pointed oval
    ctx.fillStyle = `rgba(${r},${g},${b},0.92)`;
    ctx.beginPath();
    const leafAngle = rng() * Math.PI;
    ctx.ellipse(lx, ly, lr * 0.7, lr * 1.3, leafAngle, 0, Math.PI * 2);
    ctx.fill();

    // Vein line
    if (size > 64) {
      ctx.strokeStyle = `rgba(${r - 15},${g - 20},${b - 5},0.4)`;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(lx - Math.cos(leafAngle) * lr * 0.5, ly - Math.sin(leafAngle) * lr * 0.5);
      ctx.lineTo(lx + Math.cos(leafAngle) * lr * 0.5, ly + Math.sin(leafAngle) * lr * 0.5);
      ctx.stroke();
    }
  }

  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(outDir, filename), buf);
  console.log(`  ✓ ${filename} (${size}×${size})`);
}

// ─── Dense Leaves (multiple clusters stitched onto one canvas) ───────

function generateDenseLeaves(size, filename) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const rng = seededRandom(73819);

  ctx.clearRect(0, 0, size, size);

  // Pack many smaller branch-with-leaves clusters onto the same canvas so each
  // quad reads as a fuller canopy card without oversized individual leaves.
  const clusterCount = 10;
  const clusterRadius = size * 0.34;

  for (let c = 0; c < clusterCount; c++) {
    // Random center for this cluster, keep it away from edges
    const margin = size * 0.06;
    const cx = margin + rng() * (size - margin * 2);
    const cy = margin + rng() * (size - margin * 2);
    const scale = 0.58 + rng() * 0.42;
    const clusterAngle = (rng() - 0.5) * Math.PI * 0.6; // random tilt

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(clusterAngle);

    const cs = clusterRadius * scale;

    // Branch stem
    ctx.strokeStyle = '#5a4a3a';
    ctx.lineWidth = Math.max(1, cs * 0.018);
    ctx.beginPath();
    ctx.moveTo(0, cs * 0.45);
    ctx.quadraticCurveTo(cs * (rng() - 0.5) * 0.06, 0, cs * (rng() - 0.5) * 0.05, -cs * 0.45);
    ctx.stroke();

    // Sub-branches
    const subCount = 4 + Math.floor(rng() * 4);
    for (let i = 0; i < subCount; i++) {
      const t = 0.2 + (i / subCount) * 0.65;
      const bx = (rng() - 0.5) * cs * 0.04;
      const by = cs * (0.45 - t * 0.9);
      const sAngle = (rng() > 0.5 ? 1 : -1) * (0.4 + rng() * 0.8);
      const len = cs * (0.12 + rng() * 0.18);
      ctx.strokeStyle = '#5a4a3a';
      ctx.lineWidth = Math.max(0.5, cs * 0.012);
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + Math.cos(sAngle - Math.PI / 2) * len, by - Math.sin(sAngle) * len * 0.5);
      ctx.stroke();
    }

    // Low-alpha foliage undercoat to fill interior gaps between visible leaves.
    const undercoatCount = 7 + Math.floor(rng() * 5);
    for (let i = 0; i < undercoatCount; i++) {
      const ux = (rng() - 0.5) * cs * 0.42;
      const uy = (rng() - 0.15) * cs * 0.52;
      const ur = cs * (0.1 + rng() * 0.08);
      const ug = 96 + Math.floor(rng() * 36);
      const urc = 86 + Math.floor(rng() * 28);
      const ub = 76 + Math.floor(rng() * 22);
      ctx.fillStyle = `rgba(${urc},${ug},${ub},${0.14 + rng() * 0.12})`;
      ctx.beginPath();
      ctx.ellipse(ux, uy, ur * (0.95 + rng() * 0.25), ur, rng() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }

    // Leaf ellipses
    const leafCount = 40 + Math.floor(rng() * 22);
    for (let i = 0; i < leafCount; i++) {
      const t = 0.05 + rng() * 0.85;
      const lx = (rng() - 0.5) * cs * 0.58;
      const ly = cs * (0.45 - t * 0.9) + (rng() - 0.5) * cs * 0.32;
      const lr = cs * (0.032 + rng() * 0.04);

      const g = 100 + Math.floor(rng() * 65);
      const r = 85 + Math.floor(rng() * 45);
      const b = 72 + Math.floor(rng() * 28);

      ctx.fillStyle = `rgba(${r},${g},${b},0.95)`;
      ctx.beginPath();
      const leafAngle = rng() * Math.PI;
      ctx.ellipse(lx, ly, lr * 0.7, lr * 1.3, leafAngle, 0, Math.PI * 2);
      ctx.fill();

      // Vein for high-res
      if (size >= 128) {
        ctx.strokeStyle = `rgba(${r - 15},${g - 20},${b - 5},0.35)`;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(lx - Math.cos(leafAngle) * lr * 0.5, ly - Math.sin(leafAngle) * lr * 0.5);
        ctx.lineTo(lx + Math.cos(leafAngle) * lr * 0.5, ly + Math.sin(leafAngle) * lr * 0.5);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(outDir, filename), buf);
  console.log(`  ✓ ${filename} (${size}×${size})`);
}

// ─── Birch Billboard ──────────────────────────────────────────────

function generateBillboard(width, height, filename) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const rng = seededRandom(98765);

  ctx.clearRect(0, 0, width, height);

  // ── Trunk ──
  const trunkW = width * 0.07;
  const trunkTop = height * 0.32;
  const trunkBot = height * 0.98;

  // Trunk gradient
  const trunkGrad = ctx.createLinearGradient(0, trunkTop, 0, trunkBot);
  trunkGrad.addColorStop(0, '#ddd5c8');
  trunkGrad.addColorStop(0.5, '#e8e0d4');
  trunkGrad.addColorStop(1, '#c8bfb0');
  ctx.fillStyle = trunkGrad;
  ctx.fillRect(width / 2 - trunkW / 2, trunkTop, trunkW, trunkBot - trunkTop);

  // Bark streaks on trunk
  for (let i = 0; i < 15; i++) {
    const sy = trunkTop + rng() * (trunkBot - trunkTop);
    const sw = trunkW * (0.3 + rng() * 0.7);
    const sh = 1 + rng() * (height > 256 ? 3 : 1.5);
    ctx.fillStyle = `rgba(35,30,25,${0.15 + rng() * 0.35})`;
    ctx.fillRect(width / 2 - sw / 2, sy, sw, sh);
  }

  // ── Canopy ──
  const canopyCX = width / 2;
  const canopyCY = height * 0.24;
  const canopyRX = width * 0.4;
  const canopyRY = height * 0.26;

  // Build up foliage with many smaller overlapping leaf blobs
  const blobCount = width > 128 ? 180 : 84;
  for (let i = 0; i < blobCount; i++) {
    const angle = rng() * Math.PI * 2;
    const dist = rng();
    const bx = canopyCX + Math.cos(angle) * canopyRX * dist;
    const by = canopyCY + Math.sin(angle) * canopyRY * dist * 0.9;
    const br = (width > 128 ? 3.25 : 1.35) + rng() * (width > 128 ? 6.75 : 3.25);

    // Color variation – very desaturated birch canopy to match 3D LODs
    const g = 82 + Math.floor(rng() * 60);
    const r = 74 + Math.floor(rng() * 30);
    const b = 64 + Math.floor(rng() * 20);
    const alpha = 0.66 + rng() * 0.22;

    ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.beginPath();
    ctx.ellipse(bx, by, br, br * (0.8 + rng() * 0.6), rng() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  // Add some depth/shadow blobs underneath (also desaturated)
  for (let i = 0; i < Math.floor(blobCount * 0.5); i++) {
    const angle = rng() * Math.PI * 2;
    const dist = 0.3 + rng() * 0.7;
    const bx = canopyCX + Math.cos(angle) * canopyRX * dist * 0.8;
    const by = canopyCY + Math.abs(Math.sin(angle)) * canopyRY * dist + canopyRY * 0.3;
    const br = (width > 128 ? 2.4 : 1.2) + rng() * (width > 128 ? 4.8 : 2.2);

    ctx.fillStyle = `rgba(55,65,50,${0.3 + rng() * 0.2})`;
    ctx.beginPath();
    ctx.ellipse(bx, by, br, br * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Bright highlights on top (desaturated)
  for (let i = 0; i < Math.floor(blobCount * 0.24); i++) {
    const angle = -Math.PI * 0.3 + rng() * Math.PI * 0.6;
    const dist = rng() * 0.6;
    const bx = canopyCX + Math.cos(angle) * canopyRX * dist;
    const by = canopyCY + Math.sin(angle) * canopyRY * dist - canopyRY * 0.2;
    const br = (width > 128 ? 1.9 : 1) + rng() * (width > 128 ? 3.8 : 1.8);

    const hg = 135 + Math.floor(rng() * 30);
    const hr = 120 + Math.floor(rng() * 25);
    const hb = 110 + Math.floor(rng() * 20);
    ctx.fillStyle = `rgba(${hr},${hg},${hb},${0.4 + rng() * 0.3})`;
    ctx.beginPath();
    ctx.ellipse(bx, by, br, br * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(outDir, filename), buf);
  console.log(`  ✓ ${filename} (${width}×${height})`);
}

// ─── Generate All ─────────────────────────────────────────────────

console.log('Generating birch tree textures…');

generateBark(128, 256, 'birch_bark.png');
generateBark(64, 128, 'birch_bark_low.png');

generateLeaves(128, 'birch_leaves.png');
generateLeaves(64, 'birch_leaves_low.png');

generateDenseLeaves(256, 'birch_leaves_dense.png');
generateDenseLeaves(128, 'birch_leaves_dense_low.png');

generateBillboard(256, 512, 'birch_billboard.png');
generateBillboard(64, 128, 'birch_billboard_low.png');

console.log('Done! Textures saved to public/assets/textures/trees/');
