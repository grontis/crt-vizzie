// bake-atlas.js — regenerate native/assets/{atlas.png, atlas.json} from the v2 browser app.
//
// WHY: the native Rust frontend does not rasterize fonts. It loads a pre-baked glyph atlas
// produced by the v2 WebGL renderer (Orbitron weight 800, variable-font axis selection that is
// fiddly to reproduce in Rust). Whenever buildCharset() in v2/sketch.js changes (new glyphs),
// the atlas is stale and the new chars render blank — re-bake with this script.
//
// HOW TO RUN:
//   1. cd v2 && python3 -m http.server 8080
//   2. Open Chrome/Chromium at:  http://localhost:8080/#debug-atlas
//      (the #debug-atlas hash is REQUIRED — without it renderer._atlasCanvas is freed to save
//       memory and this script has nothing to export.)
//   3. Pick any audio source so the app finishes init and the atlas is built.
//   4. Open DevTools console, paste this whole file, press Enter.
//   5. Two files download: atlas.png and atlas.json.
//   6. Move both into native/assets/, overwriting the old ones.
//
// JSON shape consumed by native (snake_case): cell_w, cell_h, tile_w, tile_h,
// atlas_cols, atlas_rows, atlas_tex_w, atlas_tex_h, charset[].

(function bakeAtlas() {
  const r = window.renderer;
  if (!r) {
    console.error('[bake-atlas] window.renderer not found — is the app initialized?');
    return;
  }
  if (!r._atlasCanvas) {
    console.error('[bake-atlas] renderer._atlasCanvas is null. Reload the page with the ' +
                  '#debug-atlas URL hash, then re-run. (The canvas is only retained in debug mode.)');
    return;
  }

  const meta = {
    cell_w:      r._cellW,
    cell_h:      r._cellH,
    tile_w:      r._atlasTileW,
    tile_h:      r._atlasTileH,
    atlas_cols:  r._atlasCols,
    atlas_rows:  r._atlasRows,
    atlas_tex_w: r._atlasTexW,
    atlas_tex_h: r._atlasTexH,
    charset:     r._charset,
  };

  // Sanity check: charset length must fit the declared tile grid.
  if (meta.charset.length > meta.atlas_cols * meta.atlas_rows) {
    console.error('[bake-atlas] charset longer than atlas grid — aborting. ' +
                  `chars=${meta.charset.length} grid=${meta.atlas_cols}x${meta.atlas_rows}`);
    return;
  }

  function download(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke after the click has had a chance to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // atlas.json
  download('atlas.json', new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' }));

  // atlas.png (R8 source — white glyphs on black; native reads the red channel)
  r._atlasCanvas.toBlob((pngBlob) => {
    if (!pngBlob) {
      console.error('[bake-atlas] toBlob failed — try toDataURL fallback manually.');
      return;
    }
    download('atlas.png', pngBlob);
    console.log(`[bake-atlas] Done. ${meta.charset.length} chars, ` +
                `${meta.atlas_cols}x${meta.atlas_rows} tiles, ` +
                `texture ${meta.atlas_tex_w}x${meta.atlas_tex_h}. ` +
                `Move atlas.png + atlas.json into native/assets/.`);
  }, 'image/png');
})();
