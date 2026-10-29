CREATE TABLE IF NOT EXISTS clientes (
  id INTEGER PRIMARY KEY,
  cnpj TEXT NOT NULL UNIQUE,          -- só dígitos
  razao_social TEXT NOT NULL,
  apelido TEXT,                       -- usado no nome da pasta
  uf TEXT NOT NULL,                   -- 'CE'
  cert_arquivo TEXT NOT NULL,         -- nome do .pfx dentro de certs/
  cert_senha_enc TEXT NOT NULL,       -- AES-256-GCM (iv:tag:dados em base64)
  cert_validade TEXT,                 -- lida do certificado no cadastro
  ativo INTEGER NOT NULL DEFAULT 1,
  ult_nsu TEXT NOT NULL DEFAULT '000000000000000',
  max_nsu TEXT,
  proxima_consulta TEXT,              -- ISO; respeita cStat 137
  bloqueado_ate TEXT,                 -- ISO; respeita cStat 656
  ultima_consulta TEXT,
  ultimo_erro TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  papel TEXT NOT NULL DEFAULT 'cliente', -- cliente | escritorio (no máximo um)
  nfse_ult_nsu TEXT NOT NULL DEFAULT '0', -- NSU do ADN (NFS-e), separado do da NF-e
  nfse_proxima_consulta TEXT,
  nfse_ultima_consulta TEXT,
  nfse_ultimo_erro TEXT,
  tambem_cliente INTEGER NOT NULL DEFAULT 0 -- escritório que também puxa as próprias notas, como cliente
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_um_escritorio ON clientes(papel) WHERE papel = 'escritorio';

CREATE TABLE IF NOT EXISTS notas (
  id INTEGER PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  chave TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'entrada', -- entrada | saida
  modelo TEXT NOT NULL DEFAULT 'nfe',   -- nfe | nfse
  nsu TEXT,
  emitente_cnpj TEXT,
  emitente_nome TEXT,
  emitente_ie TEXT,
  destinatario_cnpj TEXT,
  destinatario_nome TEXT,
  numero TEXT,
  serie TEXT,
  data_emissao TEXT,
  valor_total REAL,
  tipo_nf TEXT,                       -- 0 entrada, 1 saída (tpNF)
  situacao_sefaz TEXT,                -- cSitNFe do resumo
  status TEXT NOT NULL,               -- resumo | ciencia_enviada | ciencia_erro | completa
  cancelada INTEGER NOT NULL DEFAULT 0,
  ciencia_protocolo TEXT,
  ciencia_em TEXT,
  ciencia_erro TEXT,
  tentativas_download INTEGER NOT NULL DEFAULT 0,
  caminho_xml TEXT,
  competencia TEXT,                   -- AAAA-MM da data de emissão
  exportada_em TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT,
  UNIQUE(cliente_id, chave)
);
CREATE INDEX IF NOT EXISTS idx_notas_chave ON notas(chave);
CREATE INDEX IF NOT EXISTS idx_notas_cliente_comp ON notas(cliente_id, competencia);
CREATE INDEX IF NOT EXISTS idx_notas_status ON notas(status);

CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY,
  chave TEXT NOT NULL,
  tp_evento TEXT NOT NULL,
  n_seq TEXT,
  descricao TEXT,
  data_evento TEXT,
  protocolo TEXT,
  caminho_xml TEXT,
  UNIQUE(chave, tp_evento, n_seq)
);

CREATE TABLE IF NOT EXISTS execucoes (
  id INTEGER PRIMARY KEY,
  cliente_id INTEGER REFERENCES clientes(id),
  tipo TEXT NOT NULL,                 -- captura | ciencia | download | exportacao
  inicio TEXT NOT NULL,
  fim TEXT,
  c_stat TEXT,
  x_motivo TEXT,
  docs_recebidos INTEGER DEFAULT 0,
  notas_recebidas INTEGER,           -- captura: resNFe + procNFe do lote (NULL nas execuções antigas)
  eventos_recebidos INTEGER,         -- captura: ciência, cancelamento, CC-e etc. de notas já emitidas
  erro TEXT
);

-- Dados do próprio sistema (ex.: ambiente = homologacao | producao | simulada).
CREATE TABLE IF NOT EXISTS sistema (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
