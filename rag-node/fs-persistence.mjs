// fs-persistence.mjs — adapter de persistencia sobre filesystem para RagEngine.
// Sin dependencias: solo node:fs y node:path. Guarda cada colección como
// <dir>/<name>.jvsb (bundle JVSB crudo, ArrayBuffer).

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EXT = '.jvsb';

// Defensa en profundidad contra path traversal: el nombre solo puede ser
// [a-z0-9-] acotado, sin puntos ni barras. El engine también valida, pero
// este adapter se defiende por sí mismo.
function assertName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`Nombre de colección inválido: "${name}" (debe matchear ${NAME_RE})`);
  }
}

export function fsPersistence(dir) {
  return {
    async save(name, arrayBuffer) {
      assertName(name);
      await fsp.mkdir(dir, { recursive: true });
      const buf = Buffer.from(arrayBuffer);
      await fsp.writeFile(join(dir, name + EXT), buf);
    },

    async load(name) {
      assertName(name);
      try {
        const buf = await fsp.readFile(join(dir, name + EXT));
        // Devolver un ArrayBuffer puro (no un Buffer/view compartido): el
        // consumidor (js-vector-store.unpackBundle) crea un DataView sobre él.
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      } catch (e) {
        if (e && e.code === 'ENOENT') return null;
        throw e;
      }
    },

    async list() {
      let entries;
      try {
        entries = await fsp.readdir(dir);
      } catch (e) {
        if (e && e.code === 'ENOENT') return [];
        throw e;
      }
      return entries
        .filter((f) => f.endsWith(EXT))
        .map((f) => f.slice(0, -EXT.length))
        .sort();
    },

    async delete(name) {
      assertName(name);
      // Idempotente a nivel adapter: si no existe, no-op. La validación de
      // existencia la hace el engine (deleteCollection throw si no está).
      try {
        await fsp.unlink(join(dir, name + EXT));
      } catch (e) {
        if (e && e.code === 'ENOENT') return;
        throw e;
      }
    },
  };
}