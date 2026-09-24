import { api, dinheiro, dataHora, grupoStatus, el, copiar, exigirSessao, barraTopo } from '/painel/comum.js';

const ROTULO_ENTREGA = { nao_entregue: 'Não entregue', realizando: 'Realizando', entregue: 'Entregue' };
let pedidos = [];
let comissoes = [];
let periodos = null;
let config = null;
let filtro = 'todos';
let busca = '';

exigirSessao('admin', (sessao) => montar(sessao));

function montar(sessao) {
  document.body.className = '';
  document.body.innerHTML = '';

  const atualizadoEm = el('span', { class: 'quem' });
  const btAtualizar = el('button', {
    class: 'btn', text: 'Atualizar',
    onclick: (e) => carregar(true, e.target),
  });
  const irParaEntregas = el('a', { class: 'btn', href: '/entregas', text: 'Fila de entregas' });
  document.body.append(barraTopo(sessao, 'Vendas de V-Bucks', [atualizadoEm, irParaEntregas, btAtualizar]));

  const numeros = el('section', { class: 'numeros' });
  const painelComissoes = el('section', { class: 'comissoes' });
  const painelRelatorio = el('section', { class: 'comissoes' });
  const filtros = el('div', { class: 'filtros' });
  const corpoTabela = el('tbody');
  const aviso = el('p', { class: 'aviso', hidden: 'hidden' });

  const campoBusca = el('input', {
    class: 'busca', type: 'search', placeholder: 'Buscar por cliente, e-mail ou ID',
    oninput: (e) => { busca = e.target.value.trim().toLowerCase(); desenharTabela(corpoTabela); },
  });

  for (const [chave, texto] of [['todos', 'Todos'], ['pago', 'Pagos'], ['pendente', 'Pendentes'], ['cancelado', 'Cancelados'], ['nao_entregue', 'Não entregues'], ['realizando', 'Realizando'], ['entregue', 'Entregues']]) {
    filtros.append(el('button', {
      text: texto, 'data-filtro': chave, class: chave === filtro ? 'ativo' : '',
      onclick: () => {
        filtro = chave;
        filtros.querySelectorAll('button').forEach((b) => b.classList.toggle('ativo', b.dataset.filtro === chave));
        desenharTabela(corpoTabela);
      },
    }));
  }
  filtros.append(campoBusca);

  const tabela = el('table', { class: 'tabela' }, [
    el('thead', {}, el('tr', {}, [
      el('th', { text: 'Pedido' }), el('th', { text: 'Data' }), el('th', { text: 'Cliente' }),
      el('th', { text: 'Pacote' }), el('th', { class: 'num', text: 'Venda' }),
      el('th', { class: 'num', text: 'Custo' }), el('th', { class: 'num', text: 'Taxas' }),
      el('th', { class: 'num', text: 'Lucro' }), el('th', { class: 'num', text: 'Comissão' }),
      el('th', { text: 'Pagamento' }), el('th', { text: 'Entrega' }),
    ])),
    corpoTabela,
  ]);

  document.body.append(el('main', { class: 'conteudo' }, [
    numeros, aviso, painelComissoes, filtros, el('div', { class: 'rolagem' }, tabela), painelRelatorio,
  ]));

  const carregar = async (forcar, botao) => {
    if (botao) botao.disabled = true;
    try {
      const dados = await api('/api/painel/pedidos' + (forcar ? '?atualizar=1' : ''));
      pedidos = dados.pedidos;
      comissoes = dados.comissoes || [];
      periodos = dados.periodos || null;
      config = dados.config || null;
      const problema = !dados.situacao.token
        ? 'Falta configurar CENTRALCART_TOKEN no servidor: os pedidos abaixo são os da última sincronização.'
        : dados.situacao.falha
          ? `A loja não respondeu na última tentativa (${dados.situacao.falha}). Mostrando o que já foi lido.`
          : dados.situacao.partidas === 1
            // O servidor já reiniciou várias vezes; se a contagem não sobe, o disco
            // volta vazio e leva junto as entregas marcadas e o ranking.
            ? 'O disco ainda não confirmou que guarda os dados entre reinícios. Se este aviso continuar depois do próximo deploy, o volume do Railway não está ligado em /data e as entregas marcadas se perdem a cada publicação.'
            : '';
      aviso.textContent = problema;
      aviso.hidden = !problema;
      atualizadoEm.textContent = dados.situacao.sincronizadoEm ? 'atualizado ' + dataHora(new Date(dados.situacao.sincronizadoEm).toISOString()) : '';
      desenharNumeros(numeros);
      desenharComissoes(painelComissoes);
      desenharTabela(corpoTabela);
      desenharRelatorio(painelRelatorio);
    } catch (e) {
      aviso.textContent = e.message;
      aviso.hidden = false;
    } finally {
      if (botao) botao.disabled = false;
    }
  };
  carregar(false);
  setInterval(() => carregar(false), 60000);
}

function desenharNumeros(alvo) {
  if (!periodos) return;
  const pendentes = pedidos.filter((p) => p.status === 'PENDING');
  const aEntregar = pedidos.filter((p) => p.status === 'APPROVED' && p.entrega.estado !== 'entregue');
  const somaPendentes = pendentes.reduce((n, p) => n + (p.valor || 0), 0);
  const comissaoDevida = comissoes.reduce((n, c) => n + c.comissao, 0);

  const cartao = (rotulo, valor, nota, destaque) =>
    el('div', { class: 'numero' + (destaque ? ' destaque' : '') }, [
      el('p', { class: 'rotulo', text: rotulo }),
      el('p', { class: 'valor', text: valor }),
      el('p', { class: 'nota', text: nota }),
    ]);

  alvo.innerHTML = '';
  alvo.append(
    cartao('Faturado hoje', dinheiro(periodos.hoje.faturamento), `${periodos.hoje.vendas} venda(s) · lucro ${dinheiro(periodos.hoje.lucro)}`, true),
    cartao('Esta semana', dinheiro(periodos.semana.faturamento), `${periodos.semana.vendas} venda(s) · lucro ${dinheiro(periodos.semana.lucro)}`),
    cartao('Este mês', dinheiro(periodos.mes.faturamento), `${periodos.mes.vendas} venda(s) · lucro ${dinheiro(periodos.mes.lucro)}`),
    cartao('Total pago', dinheiro(periodos.total.faturamento), `${periodos.total.vendas} venda(s) · lucro ${dinheiro(periodos.total.lucro)}`),
    cartao('Custo dos V-Bucks', dinheiro(periodos.total.custo), `taxas ${dinheiro(periodos.total.taxas)}`),
    cartao('Comissões a pagar', dinheiro(comissaoDevida), 'entregas concluídas'),
    cartao('Aguardando pagamento', String(pendentes.length), dinheiro(somaPendentes)),
    cartao('Falta entregar', String(aEntregar.length), aEntregar.length ? 'pedidos pagos na fila' : 'tudo entregue'),
  );
}

function desenharRelatorio(alvo) {
  alvo.innerHTML = '';
  if (!periodos) return;
  const faixas = [
    ['Hoje', periodos.hoje], ['Esta semana', periodos.semana],
    ['Este mês', periodos.mes], ['Desde o começo', periodos.total],
  ];
  const linha = (rotulo, faixa) => el('tr', {}, [
    el('td', { text: rotulo }),
    el('td', { class: 'num', text: String(faixa.vendas) }),
    el('td', { class: 'num', text: dinheiro(faixa.faturamento) }),
    el('td', { class: 'num', text: dinheiro(faixa.custo) }),
    el('td', { class: 'num', text: dinheiro(faixa.taxas) }),
    el('td', { class: 'num' }, el('b', { class: 'lucro', text: dinheiro(faixa.lucro) })),
    el('td', { class: 'num', text: dinheiro(faixa.comissao) }),
    el('td', { class: 'num' }, el('b', { text: dinheiro(faixa.lucroLiquido) })),
  ]);
  alvo.append(
    el('div', { class: 'comissoes-topo' }, [
      el('b', { text: 'Relatório por período' }),
      el('span', { class: 'sutil', text: 'semana começa na segunda · mês é o corrente' }),
    ]),
    el('div', { class: 'rolagem' }, el('table', { class: 'tabela' }, [
      el('thead', {}, el('tr', {}, [
        el('th', { text: 'Período' }), el('th', { class: 'num', text: 'Vendas' }),
        el('th', { class: 'num', text: 'Faturamento' }), el('th', { class: 'num', text: 'Custo' }),
        el('th', { class: 'num', text: 'Taxas' }), el('th', { class: 'num', text: 'Lucro' }),
        el('th', { class: 'num', text: 'Comissões' }), el('th', { class: 'num', text: 'Sobra' }),
      ])),
      el('tbody', {}, faixas.map(([rotulo, faixa]) => linha(rotulo, faixa))),
    ])),
  );
}

function desenharComissoes(alvo) {
  alvo.innerHTML = '';
  if (!comissoes.length) return;
  const taxa = config ? `${Math.round(config.fatiaEntregador * 100)}% do lucro · taxa ${Math.round(config.taxaPercentual * 100)}% + ${dinheiro(config.taxaFixa)} por venda · câmbio ${dinheiro(config.cambio.brl)} / ${config.cambio.egp} EGP` : '';
  const linhas = comissoes.map((c) =>
    el('div', { class: 'comissao-linha' }, [
      el('span', { class: 'nome', text: c.entregador }),
      el('span', { class: 'sutil', text: `${c.entregas} ${c.entregas === 1 ? 'entrega' : 'entregas'}` }),
      el('span', { class: 'hoje', text: dinheiro(c.comissaoSemana) }),
      el('span', { class: 'hoje', text: dinheiro(c.comissaoMes) }),
      el('span', { class: 'valor', text: dinheiro(c.comissao) }),
    ]));
  alvo.append(
    el('div', { class: 'comissoes-topo' }, [
      el('b', { text: 'Comissão dos entregadores' }),
      el('span', { class: 'sutil', text: taxa }),
    ]),
    el('div', { class: 'comissoes-cabecalho' }, [
      el('span', { text: 'Entregador' }), el('span', { text: 'Entregas' }),
      el('span', { class: 'hoje', text: 'Semana' }), el('span', { class: 'hoje', text: 'Mês' }),
      el('span', { class: 'valor', text: 'Total' }),
    ]),
    ...linhas,
  );
}

function desenharTabela(corpo) {
  corpo.innerHTML = '';
  const lista = pedidos.filter((p) => {
    const grupo = grupoStatus(p.status);
    if (['pago', 'pendente', 'cancelado'].includes(filtro) && grupo !== filtro) return false;
    if (['nao_entregue', 'realizando', 'entregue'].includes(filtro) && p.entrega.estado !== filtro) return false;
    if (busca && !`${p.cliente} ${p.email} ${p.id}`.toLowerCase().includes(busca)) return false;
    return true;
  }).reverse(); // no admin, mais recente primeiro

  if (!lista.length) {
    corpo.append(el('tr', {}, el('td', { colspan: '11', class: 'vazio', text: 'Nenhum pedido neste filtro.' })));
    return;
  }

  for (const p of lista) {
    const grupo = grupoStatus(p.status);
    const btCopiar = el('button', { class: 'copiar', text: 'copiar' });
    btCopiar.addEventListener('click', () => copiar(p.id, btCopiar));
    corpo.append(el('tr', {}, [
      el('td', {}, [el('code', { text: p.id }), btCopiar]),
      el('td', {}, [el('span', { text: dataHora(p.pagoEm || p.criadoEm) }), el('div', { class: 'sutil', text: p.pagamento || '' })]),
      el('td', {}, [el('div', { text: p.cliente || '—' }), el('div', { class: 'sutil', text: p.email || '' })]),
      el('td', {}, p.itens.map((i) => el('div', { text: `${i.quantidade}× ${i.nome}` }))),
      el('td', { class: 'num', text: dinheiro(p.valor) }),
      el('td', { class: 'num' }, [
        el('span', { text: dinheiro(p.financeiro.custo) }),
        el('div', { class: 'sutil', text: `${p.financeiro.custoEgp.toLocaleString('pt-BR')} EGP` }),
      ]),
      el('td', { class: 'num', text: dinheiro(p.financeiro.taxa) }),
      el('td', { class: 'num' }, el('b', { class: p.financeiro.lucro >= 0 ? 'lucro' : 'prejuizo', text: dinheiro(p.financeiro.lucro) })),
      el('td', { class: 'num' }, [
        el('span', { class: p.entrega.estado === 'entregue' && p.status === 'APPROVED' ? 'comissao-paga' : 'sutil', text: dinheiro(p.financeiro.comissao) }),
        p.entrega.estado === 'entregue' && p.entrega.por ? el('div', { class: 'sutil', text: p.entrega.por }) : null,
      ]),
      el('td', {}, el('span', { class: `pilula ${grupo}`, text: p.statusTexto || p.status })),
      el('td', {}, [
        el('span', { class: `pilula ${p.entrega.estado}`, text: ROTULO_ENTREGA[p.entrega.estado] }),
        p.entrega.por ? el('div', { class: 'sutil', text: `${p.entrega.por} · ${dataHora(p.entrega.em)}` }) : null,
      ]),
    ]));
  }
}
