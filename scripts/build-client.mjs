import { mkdir, writeFile } from 'node:fs/promises';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

const bundle = await rollup({
  input: 'src/client/client.js',
  plugins: [
    nodeResolve({ browser: true, preferBuiltins: false }),
    commonjs({ transformMixedEsModules: true }),
  ],
  onwarn(warning, warn) {
    if (warning.code === 'CIRCULAR_DEPENDENCY') return;
    warn(warning);
  },
});
try {
  const { output } = await bundle.generate({
    format: 'iife',
    generatedCode: 'es2015',
    sourcemap: false,
  });
  await mkdir('lib', { recursive: true });
  await writeFile('lib/client.js', `${output[0].code}\n`, 'utf8');
  console.log(`built lib/client.js (${output[0].code.length} bytes)`);
} finally {
  await bundle.close();
}
