// Servidor do site (Railway roda "npm start"). Sem dependências: sobe rápido e
// dá controle sobre cache e cabeçalhos.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const RAIZ = __dirname;
const PORTA = Number(process.env.PORT) || 3000;

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp4': 'video/mp4',
};
// Imagens, vídeos e fontes nunca mudam sem trocar de nome: cache longo.
// HTML, CSS e JS revalidam sempre, para uma publicação nova aparecer na hora.
const CACHE_LONGO = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico', '.woff2', '.woff', '.mp4']);
// Texto comprime muito bem (o CSS do tema cai de 193 KB para ~25 KB); imagens e fontes já vêm comprimidas.
const COMPRIMIVEIS = new Set(['.html', '.css', '.js', '.json', '.txt', '.svg', '.xml']);
const PRIVADOS = new Set(['/server.js', '/package.json', '/package-lock.json']);

const SEGURANCA = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  // Só o próprio site pode carregar scripts; a única conexão externa é o checkout da CentralCart;
  // "data:" em img-src é o QR code do Pix, que chega em base64.
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' https://api.centralcart.io",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '),
};

const codificacao = (req, ext) => {
  if (!COMPRIMIVEIS.has(ext)) return null;
  const aceita = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(aceita)) return 'br';
  if (/\bgzip\b/.test(aceita)) return 'gzip';
  return null;
};

const responder = (res, status, corpo, cabecalhos = {}) => {
  res.writeHead(status, { ...SEGURANCA, ...cabecalhos });
  res.end(corpo);
};

const paginaErro = (titulo, texto) =>
  `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${titulo} | Build V-Bucks</title>` +
  `<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#050b11;color:#fff;font-family:system-ui,sans-serif;text-align:center">` +
  `<div><h1 style="margin:0;font-size:3rem">${titulo}</h1><p style="color:#8aa;margin:.5rem 0 1.5rem">${texto}</p>` +
  `<a href="/" style="color:#5ce8ff">Voltar para a loja</a></div>`;

const servidor = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return responder(res, 405, 'Método não permitido', { Allow: 'GET, HEAD' });
  }

  const host = String(req.headers.host || '');
  // www.buildbucks.com.br -> buildbucks.com.br (um endereço só, melhor para SEO)
  if (host.startsWith('www.')) {
    return responder(res, 301, '', { Location: `https://${host.slice(4)}${req.url}` });
  }

  let caminho;
  try {
    caminho = decodeURIComponent(new URL(req.url, `http://${host || 'localhost'}`).pathname);
  } catch {
    return responder(res, 400, paginaErro('400', 'Endereço inválido.'), { 'Content-Type': TIPOS['.html'] });
  }
  if (caminho.endsWith('/')) caminho += 'index.html';
  if (PRIVADOS.has(caminho) || caminho.split('/').some((parte) => parte.startsWith('.'))) {
    return responder(res, 404, paginaErro('404', 'Página não encontrada.'), { 'Content-Type': TIPOS['.html'] });
  }

  const arquivo = path.join(RAIZ, caminho);
  if (arquivo !== RAIZ && !arquivo.startsWith(RAIZ + path.sep)) {
    return responder(res, 403, paginaErro('403', 'Acesso negado.'), { 'Content-Type': TIPOS['.html'] });
  }

  fs.stat(arquivo, (erro, info) => {
    if (erro || !info.isFile()) {
      return responder(res, 404, paginaErro('404', 'Página não encontrada.'), { 'Content-Type': TIPOS['.html'] });
    }

    const ext = path.extname(arquivo).toLowerCase();
    const enc = codificacao(req, ext);
    const etag = `"${info.size.toString(16)}-${info.mtimeMs.toString(16)}${enc ? '-' + enc : ''}"`;
    const cabecalhos = {
      'Content-Type': TIPOS[ext] || 'application/octet-stream',
      'Cache-Control': CACHE_LONGO.has(ext) ? 'public, max-age=31536000, immutable' : 'no-cache',
      ETag: etag,
      'Last-Modified': info.mtime.toUTCString(),
      ...(COMPRIMIVEIS.has(ext) ? { Vary: 'Accept-Encoding' } : {}),
    };

    if (req.headers['if-none-match'] === etag) return responder(res, 304, '', cabecalhos);
    if (req.method === 'HEAD') return responder(res, 200, '', enc ? { ...cabecalhos, 'Content-Encoding': enc } : { ...cabecalhos, 'Content-Length': info.size });

    if (!enc) {
      res.writeHead(200, { ...SEGURANCA, ...cabecalhos, 'Content-Length': info.size });
      return fs.createReadStream(arquivo).pipe(res);
    }
    res.writeHead(200, { ...SEGURANCA, ...cabecalhos, 'Content-Encoding': enc });
    const compressor = enc === 'br'
      ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: info.size } })
      : zlib.createGzip({ level: 6 });
    fs.createReadStream(arquivo).pipe(compressor).pipe(res);
  });
});

servidor.listen(PORTA, '0.0.0.0', () => {
  console.log(`Build V-Bucks no ar em http://localhost:${PORTA}`);
});
