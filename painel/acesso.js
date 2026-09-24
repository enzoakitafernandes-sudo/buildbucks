// Login dos painéis. Sem banco: as senhas ficam em variáveis de ambiente e a
// sessão é um cookie assinado (HMAC), com validade de 12 horas.
//
//   ADMINS=eznoclean:senha1,outro:senha2    (donos, com nome próprio)
//   ADMIN_SENHA=uma-senha-forte             (login simples pelo usuário "admin")
//   ENTREGADORES=joao:senha1,maria:senha2
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const COOKIE = 'bd_painel';
const VALIDADE_MS = 12 * 60 * 60 * 1000;
const PASTA = process.env.DATA_DIR || path.join(__dirname, '..', 'dados');

const ADMIN_SENHA = process.env.ADMIN_SENHA || '';
const lista = (valor) => new Map(
  (valor || '')
    .split(',')
    .map((par) => par.split(':'))
    .filter(([nome, senha]) => nome?.trim() && senha?.trim())
    .map(([nome, senha]) => [nome.trim().toLowerCase(), senha.trim()]),
);
const ADMINS = lista(process.env.ADMINS);
const ENTREGADORES = lista(process.env.ENTREGADORES);

// Segredo das assinaturas: gerado uma vez e guardado junto dos dados, para as
// sessões sobreviverem a um reinício.
function segredo() {
  const arquivo = path.join(PASTA, 'segredo.txt');
  try {
    fs.mkdirSync(PASTA, { recursive: true });
    if (fs.existsSync(arquivo)) return fs.readFileSync(arquivo, 'utf8').trim();
    const novo = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(arquivo, novo);
    return novo;
  } catch {
    return crypto.createHash('sha256').update(`${ADMIN_SENHA}|${process.env.ENTREGADORES || ''}`).digest('hex');
  }
}
const SEGREDO = segredo();

const iguais = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const assinar = (perfil, usuario, emissao, nonce) =>
  crypto.createHmac('sha256', SEGREDO).update(`bd-painel-v1|${perfil}|${usuario}|${emissao}|${nonce}`).digest('hex');

function emitir(perfil, usuario) {
  const emissao = Date.now();
  const nonce = crypto.randomBytes(8).toString('hex');
  return `${perfil}.${usuario}.${emissao}.${nonce}.${assinar(perfil, usuario, emissao, nonce)}`;
}

function sessao(req) {
  const bruto = String(req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([nome]) => nome === COOKIE)?.[1];
  if (!bruto) return null;
  const partes = decodeURIComponent(bruto).split('.');
  if (partes.length !== 5) return null;
  const [perfil, usuario, emissaoTexto, nonce, assinatura] = partes;
  const emissao = Number(emissaoTexto);
  if (!Number.isFinite(emissao)) return null;
  const idade = Date.now() - emissao;
  if (idade > VALIDADE_MS || idade < -60_000) return null;
  if (!iguais(assinatura, assinar(perfil, usuario, emissao, nonce))) return null;
  if (perfil !== 'admin' && perfil !== 'entregador') return null;
  return { perfil, usuario };
}

/** Confere usuário e senha. Devolve a sessão ou null. */
function autenticar(usuario, senha) {
  const nome = String(usuario || '').trim().toLowerCase();
  const chave = String(senha || '');
  const senhaAdmin = ADMINS.get(nome);
  if (senhaAdmin && iguais(chave, senhaAdmin)) return { perfil: 'admin', usuario: nome };
  if (ADMIN_SENHA && (nome === 'admin' || !nome) && iguais(chave, ADMIN_SENHA)) return { perfil: 'admin', usuario: 'admin' };
  const senhaEntregador = ENTREGADORES.get(nome);
  if (senhaEntregador && iguais(chave, senhaEntregador)) return { perfil: 'entregador', usuario: nome };
  return null;
}

const cookieSessao = (valor, seguro) =>
  `${COOKIE}=${encodeURIComponent(valor)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${VALIDADE_MS / 1000}${seguro ? '; Secure' : ''}`;
const cookieSaida = (seguro) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${seguro ? '; Secure' : ''}`;

/* Trava de tentativas: 8 erros por IP a cada 10 minutos. */
const tentativas = new Map();
function podeTentar(ip) {
  const agora = Date.now();
  const reg = tentativas.get(ip);
  if (!reg || agora - reg.desde > 600_000) {
    tentativas.set(ip, { desde: agora, erros: 0 });
    return true;
  }
  return reg.erros < 8;
}
function registrarErro(ip) {
  const reg = tentativas.get(ip) || { desde: Date.now(), erros: 0 };
  reg.erros++;
  tentativas.set(ip, reg);
  if (tentativas.size > 5000) tentativas.clear();
}
const limparTentativas = (ip) => tentativas.delete(ip);

const configurado = () => ADMINS.size > 0 || ADMIN_SENHA.length >= 6 || ENTREGADORES.size > 0;

module.exports = { COOKIE, emitir, sessao, autenticar, cookieSessao, cookieSaida, podeTentar, registrarErro, limparTentativas, configurado };
