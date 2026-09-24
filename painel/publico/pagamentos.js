// Histórico de pagamentos aos revendedores. Só o dono entra aqui.
import { api, dinheiro, dataHora, el, copiar, exigirSessao, barraTopo } from '/painel/comum.js';

const FUSO = 'America/Sao_Paulo';
const mesDe = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: FUSO }).slice(0, 7) : '');

let pagamentos = [];
let revendedores = [];
let busca = '';

exigirSessao('admin', (sessao) => montar(sessao));

function montar(sessao) {
  document.body.className = '';
  document.body.innerHTML = '';

  const aviso = el('p', { class: 'aviso', hidden: 'hidden' });
  const numeros = el('section', { class: 'numeros' });
  const lista = el('section', { class: 'comissoes' });

  const btAtualizar = el('button', { class: 'btn', text: 'Atualizar', onclick: (e) => carregar(e.target) });
  const irParaAdmin = el('a', { class: 'btn', href: '/admin', text: 'Painel de vendas' });
  document.body.append(barraTopo(sessao, 'Pagamentos', [irParaAdmin, btAtualizar]));

  const campoBusca = el('input', {
    class: 'busca', type: 'search', placeholder: 'Buscar por revendedor',
    oninput: (e) => { busca = e.target.value.trim().toLowerCase(); desenharLista(lista); },
  });

  document.body.append(el('main', { class: 'conteudo' }, [
    aviso, numeros, el('div', { class: 'filtros' }, [campoBusca]), lista,
  ]));

  const carregar = async (botao) => {
    if (botao) botao.disabled = true;
    try {
      const dados = await api('/api/painel/pagamentos');
      pagamentos = dados.pagamentos || [];
      revendedores = dados.revendedores || [];
      // Histórico de dinheiro é o que menos pode sumir: se o disco do servidor
      // estiver zerando a cada publicação, o dono precisa saber antes de confiar.
      const disco = dados.situacao && dados.situacao.partidas === 1
        ? 'ATENÇÃO: o disco do servidor ainda não confirmou que guarda os dados entre reinícios. Se este aviso continuar depois do próximo deploy, este histórico será apagado a cada publicação — ligue o volume do Railway em /data antes de usar isto como controle.'
        : '';
      aviso.textContent = disco;
      aviso.hidden = !disco;
      desenharNumeros(numeros);
      desenharLista(lista);
    } catch (e) {
      aviso.textContent = e.message;
      aviso.hidden = false;
    } finally {
      if (botao) botao.disabled = false;
    }
  };

  carregar();
}

function desenharNumeros(alvo) {
  alvo.innerHTML = '';
  const mes = new Date().toLocaleDateString('en-CA', { timeZone: FUSO }).slice(0, 7);
  const total = pagamentos.reduce((s, p) => s + p.valor, 0);
  const doMes = pagamentos.filter((p) => mesDe(p.criadoEm) === mes);
  const emAberto = revendedores.reduce((s, c) => s + c.aPagar, 0);

  const cartao = (rotulo, valor, nota, destaque) =>
    el('div', { class: 'numero' + (destaque ? ' destaque' : '') }, [
      el('div', { class: 'rotulo', text: rotulo }),
      el('div', { class: 'valor', text: valor }),
      el('div', { class: 'nota', text: nota }),
    ]);

  alvo.append(
    cartao('Pago no total', dinheiro(total), `${pagamentos.length} ${pagamentos.length === 1 ? 'pagamento' : 'pagamentos'}`),
    cartao('Pago este mês', dinheiro(doMes.reduce((s, p) => s + p.valor, 0)), `${doMes.length} ${doMes.length === 1 ? 'pagamento' : 'pagamentos'}`),
    cartao('Em aberto agora', dinheiro(emAberto), emAberto > 0 ? 'a pagar aos revendedores' : 'nada pendente', emAberto > 0),
  );
}

function desenharLista(alvo) {
  alvo.innerHTML = '';
  const filtrados = busca ? pagamentos.filter((p) => p.revendedor.includes(busca)) : pagamentos;

  alvo.append(el('div', { class: 'comissoes-topo' }, [
    el('b', { text: 'Histórico de pagamentos' }),
    el('span', { class: 'sutil', text: 'do mais recente para o mais antigo' }),
  ]));

  if (!filtrados.length) {
    alvo.append(el('p', {
      class: 'vazio',
      text: pagamentos.length ? 'Nenhum pagamento para esse nome.' : 'Nenhum pagamento registrado ainda.',
    }));
    return;
  }

  alvo.append(el('div', {}, filtrados.map((p) => linha(p))));
}

function linha(p) {
  const btChave = p.chavePix ? el('button', { class: 'copiar', text: 'copiar' }) : null;
  if (btChave) btChave.addEventListener('click', () => copiar(p.chavePix, btChave));

  // Os pedidos incluídos ficam guardados atrás de um clique: é a prova do que entrou no valor.
  const pedidos = el('div', { class: 'pagamento-pedidos', hidden: 'hidden' },
    (p.pedidos || []).map((id) => el('code', { text: id })));
  const btPedidos = el('button', {
    class: 'copiar',
    text: `ver ${p.entregas} ${p.entregas === 1 ? 'entrega' : 'entregas'}`,
    onclick: (e) => {
      pedidos.hidden = !pedidos.hidden;
      e.target.textContent = pedidos.hidden
        ? `ver ${p.entregas} ${p.entregas === 1 ? 'entrega' : 'entregas'}`
        : 'esconder';
    },
  });

  return el('article', { class: 'pagamento' }, [
    el('div', { class: 'pagamento-topo' }, [
      el('span', { class: 'nome', text: p.revendedor }),
      el('span', { class: 'valor', text: dinheiro(p.valor) }),
    ]),
    el('div', { class: 'pagamento-notas' }, [
      el('span', { text: dataHora(p.criadoEm) }),
      btPedidos,
      p.por ? el('span', { text: `registrado por ${p.por}` }) : null,
    ]),
    el('div', { class: 'pagamento-notas' }, [
      p.chavePix
        ? el('span', {}, [
            el('b', { text: `${p.tipoPix || 'Chave'}: ` }),
            document.createTextNode(p.chavePix),
            btChave,
          ])
        : el('span', { class: 'sutil', text: 'sem chave PIX cadastrada na hora do pagamento' }),
      p.titular ? el('span', { text: `titular ${p.titular}` }) : null,
    ]),
    p.observacao ? el('div', { class: 'pagamento-notas' }, el('span', { text: p.observacao })) : null,
    pedidos,
  ]);
}
