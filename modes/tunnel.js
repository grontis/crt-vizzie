// modes/tunnel.js — ASCII Tunnel Mode
// Concentric rings scrolling toward viewer. Beat warp. Treble texture rotation.

class TunnelMode {
  constructor(config) {
    this.config = config;
    this._scrollOffset = 0;
    this._warpScale = 1.0;       // multiplier on ring radii (1.0 = normal)
    this._rotation = 0;          // texture rotation angle
    this._beatWarpActive = false;
  }

  reset() {
    this._scrollOffset = 0;
    this._warpScale = 1.0;
    this._rotation = 0;
  }

  update(grid, cols, rows, audio, bg) {
    const bands = audio.getBands();
    const beatActive = audio.beatActive;

    // Scroll speed proportional to bass
    const speed = CONFIG.TUNNEL_BASE_SPEED + bands.bass * 1.5;
    this._scrollOffset += speed;

    // Texture rotation driven by treble
    this._rotation += bands.treble * 0.05;

    // Beat warp: compress radii × 0.7 then ease back
    if (beatActive && this._warpScale > 0.75) {
      this._warpScale = CONFIG.TUNNEL_BEAT_WARP;
      this._beatWarpActive = true;
    }
    if (this._warpScale < 1.0) {
      this._warpScale += CONFIG.TUNNEL_WARP_EASE * (1.0 - this._warpScale);
      if (this._warpScale > 0.99) this._warpScale = 1.0;
    }

    const cx = cols / 2;
    const cy = rows / 2;
    const numRings = CONFIG.TUNNEL_RING_COUNT;

    // Character sets for ring faces
    const ringChars = ['@', '#', '*', '+', ':', '.', '·', ' '];
    const wallChars = '|/\\-+*#@';

    // Draw rings from back to front (largest index = farthest)
    for (let ri = numRings - 1; ri >= 0; ri--) {
      // Depth: rings are evenly spaced in "depth" 0–1
      const depth = (ri + (this._scrollOffset % numRings)) / numRings;
      // Radius shrinks with depth (perspective projection)
      const baseRadius = Math.min(cols, rows * 2) * 0.5;
      const radius = baseRadius * (1 - depth) * this._warpScale;

      if (radius < 1) continue;

      // Number of points along this ring proportional to circumference
      const circumference = 2 * Math.PI * radius;
      const numPoints = Math.max(8, Math.floor(circumference / 1.5));

      // Character for this ring based on depth
      const charDepthIdx = Math.floor(depth * (ringChars.length - 1));
      const ringChar = ringChars[Math.min(ringChars.length - 1, charDepthIdx)];
      const brightness = Math.max(0.05, 1.0 - depth * 0.9);

      for (let pi = 0; pi < numPoints; pi++) {
        const angle = (pi / numPoints) * Math.PI * 2 + this._rotation * (1 + depth);
        // Ellipse: map to cols×rows aspect
        const aspectRatio = cols / (rows * 2.2); // rows are taller than wide in terminals
        const px = Math.round(cx + Math.cos(angle) * radius * aspectRatio);
        const py = Math.round(cy + Math.sin(angle) * radius * 0.5);

        if (px < 0 || px >= cols || py < 0 || py >= rows) continue;

        // Choose char based on angle for texture variety
        const angleChar = wallChars[Math.floor(((angle + this._rotation) / (Math.PI * 2)) * wallChars.length) % wallChars.length];
        const useChar = depth < 0.3 ? angleChar : ringChar;

        setCell(px, py, useChar, brightness);
      }
    }

    // Vanishing point indicator
    const vpX = Math.round(cx);
    const vpY = Math.round(cy);
    if (vpX >= 0 && vpX < cols && vpY >= 0 && vpY < rows) {
      setCell(vpX, vpY, '+', 0.9);
    }

    // Title
    setString(0, 0, 'TUNNEL', 0.25);

    // Bass energy display at bottom
    const bassStr = 'BASS:' + '█'.repeat(Math.floor(bands.bass * 15)) + '░'.repeat(15 - Math.floor(bands.bass * 15));
    if (bassStr.length < cols) {
      setString(0, rows - 1, bassStr, 0.3);
    }
  }
}
