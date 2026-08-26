/**
 * Build script for the EvapoFlex Print Prep tool.
 *
 * Bundles src/ into three self-contained ES modules (the app and its two
 * workers), gzips them together, encrypts the result with AES-256-GCM under a
 * key derived from the gate password, and writes the whole thing into
 * ../../printprep.html.
 *
 * The point of the encryption is not secrecy - the repository is public and the
 * sources are committed right next to this file. The point is that the gate
 * cannot be bypassed from the browser. There is no flag to flip in devtools,
 * because without the password the application bytes are not on the page in any
 * usable form.
 *
 *   node build.mjs            # reads ../../.printprep-password
 *   PRINTPREP_PASSWORD=x node build.mjs
 */
import { build } from 'esbuild';
import { createHash, pbkdf2Sync, randomBytes, createCipheriv } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

// PBKDF2 rounds. High enough that guessing a 12-character password offline is
// not worth anybody's electricity; low enough that a legitimate unlock is
// roughly a third of a second in the browser.
const PBKDF2_ROUNDS = 310000;

function password() {
  if (process.env.PRINTPREP_PASSWORD) return process.env.PRINTPREP_PASSWORD.trim();
  const f = resolve(REPO, '.printprep-password');
  if (!existsSync(f)) {
    console.error('No password. Put one in .printprep-password or set PRINTPREP_PASSWORD.');
    process.exit(1);
  }
  return readFileSync(f, 'utf8').trim();
}

async function bundle(entry, opts = {}) {
  const r = await build({
    entryPoints: [resolve(HERE, 'src', entry)],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    write: false,
    legalComments: 'none',
    minify: false,          // readability in devtools once unlocked; gzip does the shrinking
    ...opts,
  });
  if (r.errors.length) { console.error(r.errors); process.exit(1); }
  return r.outputFiles[0].text;
}

const t0 = Date.now();

// `three` stays external on the main thread: it is resolved by the import map in
// printprep.html against the vendored copy in assets/. Keeping ~750 KB of
// three.js out of the encrypted payload keeps the unlock fast and lets the
// browser cache it normally.
const app = await bundle('app.js', { external: ['three', 'three/addons/controls/OrbitControls.js'] });

// Workers get everything inlined. Import maps do not apply inside workers, so a
// worker module must not contain a bare specifier. manifold is pulled in at
// runtime by dynamic import against an absolute URL handed to the worker in its
// init message.
const geomWorker = await bundle('workers/geom.worker.js');
const csgWorker  = await bundle('workers/csg.worker.js');

const payload = Buffer.from(JSON.stringify({ app, geomWorker, csgWorker }), 'utf8');
const packed = gzipSync(payload, { level: 9 });

const salt = randomBytes(16);
const iv = randomBytes(12);
const key = pbkdf2Sync(password(), salt, PBKDF2_ROUNDS, 32, 'sha256');
const cipher = createCipheriv('aes-256-gcm', key, iv);
const ct = Buffer.concat([cipher.update(packed), cipher.final(), cipher.getAuthTag()]);

const shell = readFileSync(resolve(HERE, 'shell.html'), 'utf8');
const html = shell
  .replace('__PP_SALT__', salt.toString('base64'))
  .replace('__PP_IV__', iv.toString('base64'))
  .replace('__PP_ROUNDS__', String(PBKDF2_ROUNDS))
  .replace('__PP_PAYLOAD__', ct.toString('base64'))
  .replace('__PP_BUILD__', new Date().toISOString().slice(0, 16).replace('T', ' '))
  .replace('__PP_HASH__', createHash('sha256').update(payload).digest('hex').slice(0, 12));

const out = resolve(REPO, 'printprep.html');
writeFileSync(out, html);

const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log(`printprep.html  ${kb(html.length)}`);
console.log(`  app         ${kb(app.length)}`);
console.log(`  geom.worker ${kb(geomWorker.length)}`);
console.log(`  csg.worker  ${kb(csgWorker.length)}`);
console.log(`  payload     ${kb(payload.length)} -> ${kb(packed.length)} gzipped -> ${kb(ct.length)} encrypted`);
console.log(`  ${Date.now() - t0} ms`);
