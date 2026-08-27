/* One engine, two products.
 *
 * glyph.js is the single source of truth. The desktop avatar loads it directly;
 * this wraps the same file into the standalone full-screen page (cosmic cloud,
 * no chrome) that gets published as an Artifact, so the two can never drift.
 *
 *   node tools/build-artifact.js [outfile]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const engine = fs.readFileSync(path.join(root, 'glyph.js'), 'utf8');
const out = process.argv[2] || path.join(root, 'metatron-resonance.html');

const page = `<title>Metatron Resonance Glyph</title>
<style>
  html, body { margin:0; padding:0; height:100%; background:#01030b; overflow:hidden; }
  #stage { position:fixed; inset:0; background:#01030b; }
  #glyph { display:block; width:100%; height:100%; }
</style>
<div id="stage"><canvas id="glyph"></canvas></div>
<script>
${engine}</script>
`;

fs.writeFileSync(out, page);
console.log('wrote ' + out + ' (' + page.length + ' bytes, engine ' + engine.split('\n').length + ' lines)');
