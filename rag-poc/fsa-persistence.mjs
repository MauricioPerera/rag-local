// fsa-persistence.mjs — adapter de persistencia sobre File System Access API
// para RagEngine, en el navegador.
//
// Espejo de rag-node/fs-persistence.mjs: mismo contrato (save/load/list/delete),
// mismo nombre de archivo `<name>.jvsb`, mismos bytes. Eso es deliberado: la
// carpeta que el usuario elige acá es intercambiable con la que usa
// rag-server.mjs, así que se puede indexar en Node y consultar en el navegador
// (o al revés) sobre las MISMAS colecciones. Ver fsa-persistence.test.mjs, que
// corre el mismo contrato contra los dos adapters.
//
// Se eligió File System Access sobre IndexedDB a propósito: IndexedDB es
// desalojable por el navegador bajo presión de disco, y una base de conocimiento
// que se borra sola no sirve. Acá son archivos de verdad en una carpeta del
// usuario.
//
//   const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
//   const engine = new RagEngine({ embedFn, persistence: fsaPersistence(dirHandle) });

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EXT = '.jvsb';

// Defensa en profundidad contra path traversal: aunque acá el handle acota el
// alcance a la carpeta elegida, el adapter valida igual que el de Node.
function assertName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`Nombre de colección inválido: "${name}" (debe matchear ${NAME_RE})`);
  }
}

// El navegador tira NotFoundError; el mock del test también. Node usa ENOENT.
function isNotFound(e) {
  return !!e && (e.name === 'NotFoundError' || e.code === 'ENOENT');
}

// dirHandle: un FileSystemDirectoryHandle, típicamente de showDirectoryPicker().
export function fsaPersistence(dirHandle) {
  if (!dirHandle || typeof dirHandle.getFileHandle !== 'function') {
    throw new Error('fsaPersistence requiere un FileSystemDirectoryHandle');
  }

  return {
    async save(name, arrayBuffer) {
      assertName(name);
      const fh = await dirHandle.getFileHandle(name + EXT, { create: true });
      // createWritable() trunca por defecto: guardar es sobrescribir, igual que
      // writeFile en el adapter de Node.
      const writable = await fh.createWritable();
      try {
        await writable.write(arrayBuffer);
      } catch (e) {
        // No dejar el writable colgado si falla la escritura.
        try { await writable.abort(); } catch {}
        throw e;
      }
      await writable.close();
    },

    async load(name) {
      assertName(name);
      try {
        const fh = await dirHandle.getFileHandle(name + EXT);
        const file = await fh.getFile();
        // ArrayBuffer puro, igual que el de Node: unpackBundle le monta un
        // DataView encima.
        return await file.arrayBuffer();
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },

    async list() {
      const out = [];
      for await (const handle of dirHandle.values()) {
        if (handle.kind === 'file' && handle.name.endsWith(EXT)) {
          out.push(handle.name.slice(0, -EXT.length));
        }
      }
      return out.sort();
    },

    async delete(name) {
      assertName(name);
      // Idempotente a nivel adapter, igual que el de Node: la validación de
      // existencia la hace el engine.
      try {
        await dirHandle.removeEntry(name + EXT);
      } catch (e) {
        if (isNotFound(e)) return;
        throw e;
      }
    },
  };
}
