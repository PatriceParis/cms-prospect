// Produit .vercel/output (Build Output API v3) : public/ en statique et toute l'API
// dans une seule fonction Node bundlée par esbuild. Vercel déploie ce dossier tel quel.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const OUT = '.vercel/output';
const FN = `${OUT}/functions/api.func`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(FN, { recursive: true });
cpSync('public', `${OUT}/static`, { recursive: true });

await build({
  entryPoints: ['src/web/vercel.ts'],
  outfile: `${FN}/index.mjs`,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  legalComments: 'none',
  // exceljs et ses dépendances sont en CommonJS : on leur fournit require() dans le bundle ESM.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
});

writeFileSync(`${FN}/.vc-config.json`, JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', maxDuration: 60 }, null, 2));

const securityHeaders = {
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

writeFileSync(`${OUT}/config.json`, JSON.stringify({
  version: 3,
  routes: [
    { src: '/(.*)', headers: securityHeaders, continue: true },
    { src: '^/api(?:/.*)?$', dest: '/api' },
    { handle: 'filesystem' },
  ],
}, null, 2));

console.log(`Build Vercel prêt dans ${OUT}`);
