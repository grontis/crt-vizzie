#version 300 es
// v2/shaders/vert.glsl — Passthrough vertex shader for full-screen quad
// SOURCE REFERENCE ONLY — the runtime version is inlined in renderer.js (VERT_SRC).
// Reason: avoids fetch() CORS issues when serving from file:// or bare http.server.

precision mediump float;

// Full-screen quad: clip-space positions passed in as attribute
in vec2 a_pos;
out vec2 v_uv;

void main() {
  // a_pos is in [-1..1] clip space; convert to [0..1] UV
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
