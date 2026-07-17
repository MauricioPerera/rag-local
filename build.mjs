// build.mjs — ensambla _site/ para Cloudflare Pages.
//
// rag-local corre entero en el navegador: RagEngine + okf + js-vector-store son
// LOS MISMOS archivos que usa el servidor Node (rag-poc/), y el embebedor es
// transformers.js. No se descarga ni se vendoriza nada de terceros: solo se
// copia el código del repo a _site/ y se reescriben las rutas relativas.
//
// _site/
//   index.html          <- rag-web/index.html   ( ../rag-poc/ -> ./rag-poc/ )
//   app.js              <- rag-web/app.js        ( ../rag-poc/ -> ./rag-poc/ )
//   rag-poc/            <- solo los módulos que el navegador necesita en runtime
//
// functions/ NO va dentro de _site: Cloudflare Pages lo toma de la raíz.

import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';

const OUT = '_site';
const POC = `${OUT}/rag-poc`;

// grafo de runtime trazado desde index.html + app.js (imports estáticos, el
// <script> plano y el fetch del corpus de ejemplo). transformers.js se carga
// por CDN en tiempo de ejecución; no se copia.
const POC_FILES = [
  'js-vector-store.js',   // <script> global que usa RagEngine
  'rag-engine.mjs',       // import de app.js  -> ./okf.mjs
  'fsa-persistence.mjs',  // import de app.js
  'embedder-browser.mjs', // import de app.js  -> ./embedder-shared.mjs
  'embedder-shared.mjs',
  'okf.mjs',
  'okf-docs.json',        // fetch() del corpus de ejemplo
];

const rewrite = (s) => s.replaceAll('../rag-poc/', './rag-poc/');

await rm(OUT, { recursive: true, force: true });
await mkdir(POC, { recursive: true });

await writeFile(`${OUT}/index.html`, rewrite(await readFile('rag-web/index.html', 'utf8')));
await writeFile(`${OUT}/app.js`,     rewrite(await readFile('rag-web/app.js', 'utf8')));

for (const f of POC_FILES) {
  await copyFile(`rag-poc/${f}`, `${POC}/${f}`);
}

// La app vivió en /rag-web/ en un deploy anterior y algunos bookmarks quedaron
// ahí; esa ruta llegó a servir el app.js viejo (sin las ops de CRUD por doc).
// Redirigir /rag-web/* a la raíz —donde vive ahora— para que no confunda.
await writeFile(`${OUT}/_redirects`, '/rag-web/* / 302\n');

console.log(`_site listo — index.html + app.js + rag-poc/ (${POC_FILES.length} módulos) + _redirects`);
console.log('functions/ se toma de la raíz del proyecto.');
