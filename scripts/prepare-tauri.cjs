'use strict';
// Stage the Orbit UI and non-binary assets for Tauri bundling.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'tauri-web');
fs.rmSync(output, {recursive:true,force:true});
fs.mkdirSync(output, {recursive:true});
fs.cpSync(path.join(root,'src','ui'),output,{recursive:true,force:true});
fs.cpSync(path.join(root,'assets'),path.join(output,'assets'),{
  recursive:true,
  force:true,
  filter:source=>path.basename(source)!=='bin',
});
const entry = path.join(output,'index.html');
let html=fs.readFileSync(entry,'utf8');
// Source HTML loads ../../assets/, while Tauri embeds a flat frontend root.
html=html.replaceAll('../../assets/','./assets/');
// WebView2 rewrites custom scheme requests to http://orbit-art.localhost.
html=html.replace("img-src 'self' orbit-art: data:","img-src 'self' orbit-art: http://orbit-art.localhost https://orbit-art.localhost data:");
html=html.replace("connect-src 'self';", "connect-src 'self' ipc: http://ipc.localhost https://ipc.localhost;");
fs.writeFileSync(entry,html);
for (const filename of ['app.js','controller-mode.js']) {
  const file=path.join(output,filename);
  const source=fs.readFileSync(file,'utf8');
  fs.writeFileSync(file,source.replaceAll('../../assets/','./assets/'));
}
console.log('Staged Orbit UI for Tauri:',output);
