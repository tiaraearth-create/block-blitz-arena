// 開発用。public/js/icons.js に入っているアイコンを全部並べて目で確かめる。
// ビルドは無いので、このファイルをそのままブラウザが読む。
//
// ⚠️ このフォルダ（tools/）はサーバーが配信しない。以前は public/ の中に
//    置いてあり、本番URLでも誰でも開けてしまっていた（＝作りかけのアイコンも
//    含めて全部見えていた）。開き方は tools/icons-preview.html の頭を参照。
import { icon, iconNames } from '../public/js/icons.js';

const names = iconNames();
const cell = (n, size, cls) => `<div class="c ${cls}">${icon(n, { size })}<div>${n}</div></div>`;

document.getElementById('n').textContent = `${names.length}個`;
document.getElementById('g').innerHTML = names.map(n => cell(n, 38, '')).join('');
document.getElementById('m').innerHTML = names.map(n => cell(n, 34, 'mono')).join('');
// 2色とも白に潰す段。ここまでやって残るのが本当のシルエット。
document.getElementById('s').innerHTML = names.map(n => cell(n, 34, 'solid')).join('');
