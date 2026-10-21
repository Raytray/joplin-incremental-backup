const fs = require('fs');
const cp = require('child_process');
const path = require('path');

fs.mkdirSync('publish', { recursive: true });
fs.copyFileSync('manifest.json', 'publish/manifest.json');

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const archive = path.join('publish', `${manifest.id}.jpl`);
cp.execSync(`tar -cf ${archive} -C publish manifest.json index.js`, { stdio: 'inherit' });
console.log(`Created ${archive}`);
