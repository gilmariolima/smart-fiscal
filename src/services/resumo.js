'use strict'

// Números gerais do sistema (comando `status` e visão geral do painel).

const { DIAS_ALERTA_CERT } = require('./clientes')

function criarServicoResumo({ db, config = {}, agora = () => new Date() }) {
  const maxTentativas = config.maxTentativasDownload || 5
  const sql = {
    porStatus: db.prepare(`SELECT status, COUNT(*) total, SUM(cancelada) canceladas FROM notas GROUP BY status ORDER BY status`),
    clientes: db.prepare("SELECT COUNT(*) total, COALESCE(SUM(ativo), 0) ativos FROM clientes WHERE papel = 'cliente'"),
    notasMes: db.prepare('SELECT COUNT(*) n FROM notas WHERE competencia = ?'),
    certificados: db.prepare(`SELECT COUNT(*) total,
        COALESCE(SUM(cert_validade < @agora), 0) vencidos,
        COALESCE(SUM(cert_validade >= @agora AND cert_validade < @limite), 0) a_vencer
      FROM clientes WHERE ativo = 1 AND cert_validade IS NOT NULL`),
    semXml: db.prepare(`SELECT COUNT(*) n FROM notas WHERE status <> 'completa' AND cancelada = 0`),
    semXmlPorSituacao: db.prepare(`SELECT
        COALESCE(SUM(status = 'resumo'), 0) aguardandoCiencia,
        COALESCE(SUM(status = 'ciencia_enviada' AND tentativas_download < @max), 0) aguardandoXml,
        COALESCE(SUM(status = 'ciencia_enviada' AND tentativas_download >= @max), 0) esgotada,
        COALESCE(SUM(status = 'ciencia_erro'), 0) cienciaErro
      FROM notas WHERE cancelada = 0`),
    comErro: db.prepare(`SELECT cnpj, COALESCE(apelido, razao_social) nome, ultimo_erro, ultima_consulta FROM clientes
      WHERE ativo = 1 AND ultimo_erro IS NOT NULL ORDER BY razao_social`),
    agenda: db.prepare(`SELECT cnpj, COALESCE(apelido, razao_social) nome, proxima_consulta, bloqueado_ate FROM clientes
      WHERE ativo = 1 AND papel = 'cliente' ORDER BY COALESCE(bloqueado_ate, proxima_consulta, '')`),
    certVencendo: db.prepare(`SELECT cnpj, COALESCE(apelido, razao_social) nome, cert_validade FROM clientes
      WHERE ativo = 1 AND cert_validade IS NOT NULL AND cert_validade < ? ORDER BY cert_validade`),
  }

  function resumo() {
    const t = agora()
    // Mês corrente no horário de Brasília (-03:00), como as datas de emissão.
    const competencia = new Date(t.getTime() - 3 * 3600e3).toISOString().slice(0, 7)
    const limiteCert = new Date(t.getTime() + DIAS_ALERTA_CERT * 86400e3).toISOString()
    const clientes = sql.clientes.get()
    const cert = sql.certificados.get({ agora: t.toISOString(), limite: limiteCert })
    const futuro = (iso) => iso && new Date(iso).getTime() > t.getTime()
    return {
      geradoEm: t.toISOString(),
      competenciaAtual: competencia,
      clientesAtivos: clientes.ativos,
      clientesTotal: clientes.total,
      notasNoMes: sql.notasMes.get(competencia).n,
      notasSemXml: sql.semXml.get().n,
      semXmlPorSituacao: sql.semXmlPorSituacao.get({ max: maxTentativas }),
      certificados: { total: cert.total, noPrazo: cert.total - cert.vencidos - cert.a_vencer, aVencer: cert.a_vencer, vencidos: cert.vencidos },
      notasPorStatus: sql.porStatus.all(),
      clientesComErro: sql.comErro.all(),
      certificadosVencendo: sql.certVencendo.all(limiteCert).map((c) => ({
        ...c,
        dias: Math.floor((new Date(c.cert_validade).getTime() - t.getTime()) / 86400e3),
      })),
      agenda: sql.agenda.all().map((c) => ({
        cnpj: c.cnpj,
        nome: c.nome,
        bloqueadoAte: futuro(c.bloqueado_ate) ? c.bloqueado_ate : null,
        proximaConsulta: futuro(c.proxima_consulta) ? c.proxima_consulta : null,
      })),
    }
  }

  return { resumo }
}

module.exports = { criarServicoResumo }
