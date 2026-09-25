// verify-pack.js — 機体と設定のZIP（js/02b-pack.js）を確かめる
//
//   node tools/verify-pack.js
//
// ブラウザは要らない（Node 18 以降の CompressionStream / DecompressionStream を使う）。
// 作ったZIPを読み戻して1バイトも変わらないこと、よそで作り直したZIP
// （1段深いフォルダ・__MACOSX・無圧縮）も読めること、壊れたZIPを見抜けることを確かめる。

const P = require('../js/02b-pack.js');

let failed = 0;
function check(label, ok, detail) {
  console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
}
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));

(async () => {
  if (typeof CompressionStream === 'undefined') {
    console.log('この Node には CompressionStream が無いので飛ばします（Node 18 以降で走ります）');
    return;
  }

  check('CRC-32 の既知の値（"123456789" → cbf43926）',
    P.packCrc32(new TextEncoder().encode('123456789')).toString(16) === 'cbf43926');

  // 縮む中身（GLBのような規則のあるバイト列）と、縮まない中身（乱数）
  const glb = new Uint8Array(300000);
  for (let i = 0; i < glb.length; i++) glb[i] = ((i * 7) % 251) ^ (i >> 9);
  let seed = 1;
  const noise = new Uint8Array(5000).map(() => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 24));
  const rec = (name, buf, extra) => Object.assign({
    name, savedAt: 1700000000000, modelName: 'plane.glb', modelFileType: 'glb',
    modelBuffer: buf.buffer.slice(0), parts: [{ id: 1, type: 'wing', props: {} }], cg: { x: 0, y: 1, z: 0 },
  }, extra || {});
  const env = { kind: 'flight-sim-env', version: 1, time: { hours: 9 }, airports: {} };

  const zip = await P.buildPackZip([rec('日本語の機体', glb), rec('a/b:c', noise, { modelName: 'x.gltf', modelFileType: 'gltf' })], env);
  const back = await P.readPackZip(zip);
  check('2機と設定を入れて読み戻す', back.aircraft.length === 2 && !!back.env && back.env.time.hours === 9,
    `機体 ${back.aircraft.length}・設定 ${back.env ? 'あり' : 'なし'}・ZIP ${zip.length} バイト（中身 ${glb.length + noise.length}）`);
  const a0 = back.aircraft.find((a) => a.name === '日本語の機体');
  const a1 = back.aircraft.find((a) => a.name === 'a/b:c');
  check('3Dモデルが1バイトも変わらない（縮むもの・縮まないもの）',
    !!a0 && !!a1 && same(a0.modelBuffer, glb) && same(a1.modelBuffer, noise));
  check('設定（部品・重心・形式）が戻る', a0 && a0.parts.length === 1 && a0.cg.y === 1 && a1.modelFileType === 'gltf'
    && !('kind' in a0) && !('modelFile' in a0));

  // 目次の中の名前（Windows で展開できない文字は置き換える）
  const names = [];
  {
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    for (let i = 0; i + 4 <= zip.length; i++) {
      if (dv.getUint32(i, true) !== 0x02014b50) continue;
      const n = dv.getUint16(i + 28, true);
      names.push(new TextDecoder().decode(zip.subarray(i + 46, i + 46 + n)));
    }
  }
  check('ファイル名に / や : を入れない', names.every((n) => !/[:*?"<>|\\]/.test(n)) && names.includes('aircraft/a_b_c/config.json'),
    names.join(', '));

  // よそで作り直したZIP：1段深いフォルダ、__MACOSX、config.json にモデル名が書いてない、無圧縮
  const cfg = JSON.stringify({ name: '作り直し', parts: [{ type: 'wing' }] });
  const other = await P.zipBuild([
    { name: 'まとめ/aircraft/作り直し/config.json', data: cfg },
    { name: 'まとめ/aircraft/作り直し/model.glb', data: noise },
    { name: '__MACOSX/まとめ/._env.json', data: 'x' },
    { name: 'まとめ/env.json', data: JSON.stringify(env) },
  ]);
  const ob = await P.readPackZip(other);
  check('1段深いフォルダ・__MACOSX・モデル名なしでも読める', ob.aircraft.length === 1 && ob.aircraft[0].name === '作り直し'
    && same(ob.aircraft[0].modelBuffer, noise) && !!ob.env);

  // モデルの入っていない設定は取り込まずに知らせる
  const noModel = await P.readPackZip(await P.zipBuild([{ name: 'x/config.json', data: cfg }]));
  check('モデルの無い設定は取り込まずに知らせる', noModel.aircraft.length === 0 && noModel.skipped.length === 1, noModel.skipped[0]);

  // 壊れたZIP
  const bad = zip.slice();
  bad[200] ^= 0xff;
  let err1 = null;
  try { await P.readPackZip(bad); } catch (e) { err1 = e.message; }
  check('中身が壊れていたら見抜く', !!err1, err1);
  let err2 = null;
  try { await P.readPackZip(new TextEncoder().encode('not a zip at all')); } catch (e) { err2 = e.message; }
  check('ZIPでないものを見抜く', err2 === 'ZIPファイルではありません', err2);

  console.log(failed ? `\n❌ ${failed} 件失敗` : '\n✅ すべて通過');
  if (failed) process.exitCode = 1;
})();
