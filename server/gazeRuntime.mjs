import { createReadStream, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// MediaPipe resolves its WASM loader and binary by filename. Serve the pair
// from the package that supplies the JavaScript bindings in this build.
export function gazeRuntime() {
  const require = createRequire(import.meta.url);
  const dir = join(dirname(require.resolve('@mediapipe/tasks-vision')), 'wasm');
  const files = readdirSync(dir).filter(name => /^vision_wasm_\w+\.(js|wasm)$/.test(name));
  return {
    name: 'gazeline-gaze-runtime',
    configureServer(server) {
      server.middlewares.use('/gaze-runtime', (req, res, next) => {
        const name = req.url?.split('?')[0].slice(1) ?? '';
        if (!files.includes(name)) return next();
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'application/javascript');
        createReadStream(join(dir, name)).on('error', next).pipe(res);
      });
    },
    generateBundle() {
      for (const name of files) {
        this.emitFile({ type: 'asset', fileName: 'gaze-runtime/' + name, source: readFileSync(join(dir, name)) });
      }
    },
  };
}
