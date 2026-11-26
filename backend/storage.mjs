import fs from 'node:fs';
import path from 'node:path';

export function createAppStorage(storagePath) {
  function ensureParentDir() {
    const dir = path.dirname(storagePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  function read() {
    try {
      if (fs.existsSync(storagePath)) {
        const raw = fs.readFileSync(storagePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed;
        }
      }
    } catch {
      // ignore corrupted or absent storage file
    }
    return {};
  }

  function update(changes) {
    try {
      ensureParentDir();
      const current = read();
      for (const [k, v] of Object.entries(changes || {})) {
        if (v === null || v === undefined) {
          delete current[k];
        } else {
          current[k] = String(v);
        }
      }
      const tmpPath = `${storagePath}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmpPath, JSON.stringify(current, null, 2) + '\n', {
        encoding: 'utf-8',
        mode: 0o600,
      });
      fs.renameSync(tmpPath, storagePath);
      return true;
    } catch (err) {
      console.error('[agy-web-gateway] Failed to update app_storage.json:', err.message);
      return false;
    }
  }

  return {
    path: storagePath,
    read,
    update,
  };
}
