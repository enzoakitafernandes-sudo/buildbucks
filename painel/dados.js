// Leitura dos pedidos na CentralCart + estado de entrega (arquivo em disco).
//
// A CentralCart pagina os pedidos de 15 em 15 e não diz quais produtos foram
// comprados na listagem — só no detalhe. Como a loja tem milhares de pedidos de
// outros produtos, a sincronização é incremental: varre da página mais nova para
// a mais antiga, busca o detalhe só de pedido desconhecido e para quando chega a
// pedidos anteriores ao início da venda de V-Bucks. O que já foi classificado
// nunca é consultado de novo.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const API = 'https://api.centralcart.io/v1';
const TOKEN = process.env.CENTRALCART_TOKEN || '';
const PASTA = process.env.DATA_DIR || path.join(__dirname, '..', 'dados');
const ARQUIVO = path.join(PASTA, 'painel.json');
// Pedidos anteriores a esta data não são varridos (V-Bucks entrou na loja em 22/09/2026).
const DESDE = Date.parse(process.env.VBUCKS_DESDE || '2026-09-20T00:00:00-03:00');
const IDS_VBUCKS = new Set(
  (process.env.VBUCKS_IDS || '911680,911681,911682,911684,911685,911686,911688,911689')
    .split(',').map((s) => Number(s.trim())).filter(Boolean),
);

const ESTADOS = ['nao_entregue', 'realizando', 'entregue'];
const INTERVALO_SYNC_MS = 30_000;

const vazio = () => ({ pedidos: {}, entregas: {}, ignorados: {}, revendedores: {}, pagamentos: {}, sincronizadoEm: 0 });
let estado = vazio();
let sincronizando = null;
let ultimaFalha = null;

function carregar() {
  try {
    fs.mkdirSync(PASTA, { recursive: true });
    if (fs.existsSync(ARQUIVO)) estado = { ...vazio(), ...JSON.parse(fs.readFileSync(ARQUIVO, 'utf8')) };
  } catch (e) {
    console.error('[painel] não consegui ler o arquivo de dados:', e.message);
  }
}
carregar();

// Conta as partidas num arquivo à parte. Se o disco guarda mesmo os dados, a
// contagem sobe a cada reinício; se voltar sempre a 1, o volume não está ligado
// e tudo que os entregadores marcarem some no próximo deploy.
const PARTIDAS = path.join(PASTA, 'partidas.json');
let partidas = 1;
try {
  fs.mkdirSync(PASTA, { recursive: true });
  if (fs.existsSync(PARTIDAS)) partidas = Number(JSON.parse(fs.readFileSync(PARTIDAS, 'utf8')).contagem) + 1 || 1;
  fs.writeFileSync(PARTIDAS, JSON.stringify({ contagem: partidas, ultima: new Date().toISOString() }));
} catch (e) {
  console.error('[painel] não consegui contar as partidas:', e.message);
}
console.log(`[painel] partida nº ${partidas} · ${Object.keys(estado.pedidos).length} pedidos lidos de ${ARQUIVO}`);

let gravacaoPendente = null;
function gravar() {
  // Agrupa gravações próximas e escreve de forma atômica (temporário + rename).
  if (gravacaoPendente) return;
  gravacaoPendente = setTimeout(() => {
    gravacaoPendente = null;
    try {
      fs.mkdirSync(PASTA, { recursive: true });
      const tmp = ARQUIVO + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(estado));
      fs.renameSync(tmp, ARQUIVO);
    } catch (e) {
      console.error('[painel] não consegui gravar o arquivo de dados:', e.message);
    }
  }, 400);
}

const temToken = () => TOKEN.length > 0;

async function api(caminho) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`${API}${caminho}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`CentralCart respondeu ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// Um pedido só interessa se tiver algum pacote de V-Bucks.
function itensVbucks(detalhe) {
  const pacotes = detalhe?.packages || [];
  return pacotes
    .filter((p) => IDS_VBUCKS.has(Number(p.package_id)))
    .map((p) => ({ nome: p.name, quantidade: p.quantity || 1, valor: p.price, pacoteId: Number(p.package_id) }));
}

function resumir(pedido, itens) {
  return {
    id: pedido.internal_id,
    criadoEm: pedido.created_at,
    pagoEm: pedido.paid_at || null,
    status: pedido.status,
    statusTexto: pedido.status_display || pedido.status,
    valor: pedido.price,
    pagamento: pedido.gateway_display || pedido.gateway,
    cliente: pedido.client_name || '',
    email: pedido.client_email || '',
    itens,
  };
}

async function sincronizar({ forcar = false } = {}) {
  if (!temToken()) return { ok: false, erro: 'sem_token' };
  if (sincronizando) return sincronizando;
  if (!forcar && Date.now() - estado.sincronizadoEm < INTERVALO_SYNC_MS) return { ok: true, cache: true };

  sincronizando = (async () => {
    let novos = 0, detalhes = 0, atualizados = 0;
    try {
      for (let pagina = 1; pagina <= 200; pagina++) {
        const resposta = await api(`/app/order?page=${pagina}`);
        const lista = resposta?.data || [];
        if (!lista.length) break;
        let todosAntigos = true;

        for (const pedido of lista) {
          const criado = Date.parse(pedido.created_at);
          if (Number.isFinite(criado) && criado >= DESDE) todosAntigos = false;
          if (Number.isFinite(criado) && criado < DESDE) continue;

          const id = pedido.internal_id;
          if (estado.ignorados[id]) continue;

          const conhecido = estado.pedidos[id];
          if (conhecido) {
            // Já sei que é de V-Bucks: só atualizo o que muda (status/pagamento).
            if (conhecido.status !== pedido.status || conhecido.pagoEm !== (pedido.paid_at || null)) {
              conhecido.status = pedido.status;
              conhecido.statusTexto = pedido.status_display || pedido.status;
              conhecido.pagoEm = pedido.paid_at || null;
              conhecido.valor = pedido.price;
              atualizados++;
            }
            continue;
          }

          const detalhe = await api(`/app/order/${encodeURIComponent(id)}`);
          detalhes++;
          const itens = itensVbucks(detalhe);
          if (!itens.length) {
            estado.ignorados[id] = 1; // não é V-Bucks: nunca mais consulto
            continue;
          }
          estado.pedidos[id] = resumir({ ...pedido, client_name: detalhe.client_name, client_email: detalhe.client_email }, itens);
          if (!estado.entregas[id]) estado.entregas[id] = { estado: 'nao_entregue', por: null, em: null };
          novos++;
        }

        // Página inteira anterior ao início das vendas de V-Bucks: pode parar.
        if (todosAntigos) break;
        const meta = resposta?.meta;
        if (meta && meta.current_page >= meta.last_page) break;
      }
      estado.sincronizadoEm = Date.now();
      ultimaFalha = null;
      gravar();
      return { ok: true, novos, detalhes, atualizados };
    } catch (e) {
      ultimaFalha = e.message;
      console.error('[painel] falha ao sincronizar:', e.message);
      return { ok: false, erro: e.message };
    } finally {
      sincronizando = null;
    }
  })();
  return sincronizando;
}

function pedidos() {
  return Object.values(estado.pedidos)
    .map((p) => ({ ...p, entrega: estado.entregas[p.id] || { estado: 'nao_entregue', por: null, em: null } }))
    // Mais antigo primeiro: quem comprou antes é atendido antes.
    .sort((a, b) => Date.parse(a.pagoEm || a.criadoEm) - Date.parse(b.pagoEm || b.criadoEm));
}

function marcarEntrega(id, novoEstado, quem) {
  if (!ESTADOS.includes(novoEstado)) throw new Error('estado inválido');
  if (!estado.pedidos[id]) throw new Error('pedido não encontrado');
  const antes = estado.entregas[id] || {};
  // O vínculo com o pagamento fica preso ao pedido: reabrir uma entrega já paga
  // não devolve a comissão ao saldo, senão o mesmo pedido seria pago duas vezes.
  estado.entregas[id] = { estado: novoEstado, por: quem, em: new Date().toISOString(), pagamento: antes.pagamento || null };
  gravar();
  return estado.entregas[id];
}

const soDigitos = (s) => [...s].filter((c) => c >= '0' && c <= '9').join('');

/** Só para mostrar na tela qual é o tipo da chave; não valida a chave. */
function tipoDaChave(bruta) {
  const chave = bruta.trim();
  if (chave.includes('@')) return 'E-mail';
  if (chave.length === 36 && chave.split('-').length === 5) return 'Chave aleatória';
  const digitos = soDigitos(chave);
  if (chave.startsWith('+') && digitos.length >= 12) return 'Telefone';
  if (digitos.length === 11 && digitos === chave) return 'CPF';
  if (digitos.length === 14) return 'CNPJ';
  if (digitos.length === 10 || digitos.length === 11) return 'Telefone';
  return 'Chave';
}

/** Guarda (ou apaga, se vier em branco) a chave PIX de um revendedor. */
function salvarRevendedor(nome, { chavePix, titular }, por) {
  const chave = String(nome || '').trim().toLowerCase();
  if (!chave) throw new Error('revendedor não informado');
  const pix = String(chavePix || '').trim();
  if (pix.length > 140) throw new Error('chave PIX longa demais');
  if ([...pix].some((c) => c.charCodeAt(0) < 32)) throw new Error('chave PIX inválida');

  if (!pix) delete estado.revendedores[chave];
  else {
    estado.revendedores[chave] = {
      chavePix: pix,
      tipo: tipoDaChave(pix),
      titular: String(titular || '').trim().slice(0, 120),
      atualizadoEm: new Date().toISOString(),
      atualizadoPor: por || null,
    };
  }
  gravar();
  return estado.revendedores[chave] || null;
}

/**
 * Fecha o saldo de um revendedor: guarda quanto foi pago, com qual chave e
 * quais entregas entraram, e marca essas entregas como pagas. O dinheiro sai
 * por fora, na mão; aqui fica só o registro.
 */
function registrarPagamento({ revendedor, pedidos: ids, valor, observacao }, por) {
  const nome = String(revendedor || '').trim().toLowerCase();
  if (!nome) throw new Error('revendedor não informado');
  if (!Array.isArray(ids) || !ids.length) throw new Error('esse revendedor não tem saldo em aberto');

  for (const id of ids) {
    const entrega = estado.entregas[id];
    if (!entrega) throw new Error(`entrega ${id} não encontrada`);
    if (entrega.pagamento) throw new Error(`a entrega ${id} já foi paga`);
    if (entrega.por !== nome) throw new Error(`a entrega ${id} não é de ${nome}`);
  }

  const cadastro = estado.revendedores[nome] || {};
  const pagamento = {
    id: crypto.randomUUID(),
    revendedor: nome,
    valor: Math.round(Number(valor) * 100) / 100,
    entregas: ids.length,
    pedidos: ids,
    chavePix: cadastro.chavePix || null,
    tipoPix: cadastro.tipo || null,
    titular: cadastro.titular || null,
    observacao: String(observacao || '').trim().slice(0, 200),
    criadoEm: new Date().toISOString(),
    por: por || null,
  };
  if (!Number.isFinite(pagamento.valor) || pagamento.valor <= 0) throw new Error('valor inválido');

  estado.pagamentos[pagamento.id] = pagamento;
  for (const id of ids) estado.entregas[id].pagamento = pagamento.id;
  gravar();
  return pagamento;
}

const revendedores = () => ({ ...estado.revendedores });
/** Histórico do mais novo para o mais antigo. */
const pagamentos = () => Object.values(estado.pagamentos).sort((a, b) => Date.parse(b.criadoEm) - Date.parse(a.criadoEm));

/**
 * Espera a sincronização no máximo alguns segundos e devolve o que já está
 * guardado se ela demorar. A varredura continua por trás e a tela, que recarrega
 * sozinha a cada 30s, mostra os pedidos novos assim que chegam. Sem isso o
 * painel fica em branco até a loja responder — quase um minuto quando a memória
 * está vazia depois de um reinício.
 */
function sincronizarComLimite(opcoes, limiteMs = 3000) {
  let relogio;
  const espera = new Promise((pronto) => { relogio = setTimeout(() => pronto({ ok: true, andamento: true }), limiteMs); });
  return Promise.race([sincronizar(opcoes).finally(() => clearTimeout(relogio)), espera]);
}

const situacao = () => ({
  token: temToken(),
  sincronizando: Boolean(sincronizando),
  pasta: PASTA,
  partidas, // continua 1 depois de vários deploys = o disco está sendo zerado
  sincronizadoEm: estado.sincronizadoEm,
  falha: ultimaFalha,
  total: Object.keys(estado.pedidos).length,
});

// Já começa a buscar na partida, para o painel encontrar os pedidos prontos.
if (temToken()) sincronizar();

module.exports = {
  sincronizar, sincronizarComLimite, pedidos, marcarEntrega, situacao, ESTADOS, temToken,
  salvarRevendedor, registrarPagamento, revendedores, pagamentos,
};
