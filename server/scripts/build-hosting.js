// Builds the hosting app (../web) into server/hosting-dist so this server can
// serve it at simonstays.co.za/hosting — one domain, one deploy.
//
// Runs as part of `npm run build` on Render. Never fails the deploy: if the web
// folder isn't there or the build breaks, the server still starts and /hosting
// falls back to the old host address (see index.js).
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const web = path.resolve(__dirname, '../../web');
const out = path.resolve(__dirname, '../hosting-dist');

try {
  if (!fs.existsSync(path.join(web, 'package.json'))) throw new Error(`no web app at ${web}`);
  const env = { ...process.env, VITE_API_BASE: '', NODE_ENV: 'development' }; // devDeps (vite) needed to build
  console.log('[hosting] installing web dependencies…');
  execSync('npm install --include=dev --no-audit --no-fund', { cwd: web, stdio: 'inherit', env });
  console.log('[hosting] building /hosting…');
  execSync(`npx vite build --base /hosting/ --outDir "${out}" --emptyOutDir`, { cwd: web, stdio: 'inherit', env: { ...env, NODE_ENV: 'production' } });
  console.log('[hosting] built into', out);
} catch (e) {
  console.warn('[hosting] build skipped:', e.message, '— /hosting will redirect to the old host address.');
}
