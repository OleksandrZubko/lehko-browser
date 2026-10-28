import { createServer } from 'node:http';
const server = createServer((request, response) => {
  const match = /^\/page\/(\d{1,2})$/.exec(request.url);
  if (!match) { response.writeHead(404); response.end('Use /page/1 … /page/20'); return; }
  const index = Number(match[1]);
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(`<!doctype html><html lang="uk"><head><meta charset="utf-8"><title>Lab ${index}</title><style>body{font:16px system-ui;max-width:650px;margin:60px auto;background:#f4f5ef;color:#263b31}input,button{font:inherit;padding:10px}p{line-height:1.6}</style></head>
  <body><p>BROWSER LAB · FIXTURE V1</p><h1>Вкладка ${index}</h1><p>Синтетична сторінка: 32 MiB виділеної пам’яті. Ці результати не описують усі реальні сайти.</p><p id="state"></p><script>
  window.labMemory = new Uint8Array(32 * 1024 * 1024).fill(${index});
  document.getElementById('state').textContent = document.wasDiscarded ? 'Відновлено після вивантаження' : 'Перше завантаження';
  </script></body></html>`);
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(8917, '127.0.0.1', () => console.log('Synthetic benchmark suite v1: http://127.0.0.1:8917/page/1 … /page/20'));
