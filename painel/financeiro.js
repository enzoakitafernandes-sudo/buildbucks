// Cálculo do lucro de cada venda e da comissão de quem entregou.
//
// Os V-Bucks são comprados na loja do Egito, em EGP. O câmbio usado é o que a
// Build realmente paga: R$ 379,23 a cada 3.000 EGP (mude em CAMBIO_BRL/CAMBIO_EGP
// quando o valor pago mudar).
//
//   lucro   = venda − custo dos V-Bucks − 3% da CentralCart − R$ 0,50 por venda
//   comissão = 50% do lucro, para o entregador que concluiu

const CAMBIO_BRL = Number(process.env.CAMBIO_BRL || 379.23);
const CAMBIO_EGP = Number(process.env.CAMBIO_EGP || 3000);
const REAL_POR_EGP = CAMBIO_BRL / CAMBIO_EGP;

const TAXA_PERCENTUAL = Number(process.env.TAXA_CENTRALCART || 0.03);
const TAXA_FIXA = Number(process.env.TAXA_FIXA || 0.5);
const FATIA_ENTREGADOR = Number(process.env.COMISSAO_ENTREGADOR || 0.5);

// Preço na loja do Egito, em EGP. A Epic só vende 800, 2.400, 4.500 e 12.500 —
// os demais são combinações desses.
const EGP_POR_PACOTE = {
  911680: 144.99,        // 800
  911681: 359.0,         // 2.400
  911682: 579.0,         // 4.500
  911684: 579.0 * 2,     // 9.000  = 2 × 4.500
  911685: 1439.99,       // 12.500
  911686: 1439.99 * 2,   // 25.000 = 2 × 12.500
  911688: 1439.99 * 3,   // 37.500 = 3 × 12.500
  911689: 1439.99 * 4,   // 50.000 = 4 × 12.500
};

const cent = (v) => Math.round(v * 100) / 100;

/** Custo em reais dos V-Bucks de um pedido (soma dos itens). */
function custoDe(itens = []) {
  let egp = 0;
  let conhecido = true;
  for (const item of itens) {
    const preco = EGP_POR_PACOTE[item.pacoteId];
    if (preco === undefined) { conhecido = false; continue; }
    egp += preco * (item.quantidade || 1);
  }
  return { egp: cent(egp), reais: cent(egp * REAL_POR_EGP), conhecido };
}

/** Contas de uma venda. `entregue` decide se a comissão já é devida. */
function calcular(pedido) {
  const venda = Number(pedido.valor) || 0;
  const custo = custoDe(pedido.itens);
  const taxa = cent(venda * TAXA_PERCENTUAL + TAXA_FIXA);
  const lucro = cent(venda - custo.reais - taxa);
  const comissao = cent(Math.max(0, lucro) * FATIA_ENTREGADOR);
  return {
    venda,
    custoEgp: custo.egp,
    custo: custo.reais,
    custoEstimado: !custo.conhecido,
    taxa,
    lucro,
    comissao,
    lucroLiquido: cent(lucro - comissao),
  };
}

const configuracao = () => ({
  cambio: { brl: CAMBIO_BRL, egp: CAMBIO_EGP, realPorEgp: REAL_POR_EGP },
  taxaPercentual: TAXA_PERCENTUAL,
  taxaFixa: TAXA_FIXA,
  fatiaEntregador: FATIA_ENTREGADOR,
});

module.exports = { calcular, custoDe, configuracao };
