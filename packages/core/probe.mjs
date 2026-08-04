import { buildProjectGraph, serializeGraph } from './dist/index.js';
for (const f of ['minimal','defi','inheritance','pathological']) {
  const runs = [];
  for (const workers of [1, 4, 8, 4]) {
    const { file } = await buildProjectGraph(`fixtures/${f}`, { cacheDir: null, workers });
    runs.push(serializeGraph(file));
  }
  const same = runs.every(r => r === runs[0]);
  console.log(`${f.padEnd(14)} deterministic across worker counts: ${same}`);
  if (!same) {
    const a = runs[0].split('\n'), b = runs.find(r=>r!==runs[0]).split('\n');
    for (let i=0;i<Math.max(a.length,b.length);i++) if (a[i]!==b[i]) { 
      console.log('  first divergence line', i+1, '\n   1w:', a[i], '\n   Nw:', b[i]); break; }
  }
}
