const SEM_CONEXAO = 'Sem conexão com o Smart Fiscal. Ele está aberto?'

async function requisitar(caminho, opcoes) {
  let resposta
  try {
    resposta = await fetch(caminho, opcoes)
  } catch {
    throw new Error(SEM_CONEXAO)
  }
  if (!resposta.ok) {
    let corpo = null
    try {
      corpo = await resposta.json()
    } catch {
      corpo = null
    }
    throw new Error(corpo?.erro || `Falha na comunicação com o servidor (${resposta.status}).`)
  }
  return resposta
}

function lerJson(resposta) {
  return resposta.json().catch(() => {
    throw new Error(SEM_CONEXAO)
  })
}

const comoPost = (corpo) => ({
  method: 'POST',
  headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Painel': '1' },
  body: JSON.stringify(corpo ?? {}),
})

// filename*=UTF-8''... tem prioridade sobre filename="..."
function nomeDoArquivo(disposicao) {
  if (!disposicao) return null
  const estendido = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposicao)
  if (estendido) {
    try {
      return decodeURIComponent(estendido[1].trim())
    } catch {
      // cai no filename simples
    }
  }
  const simples = /filename\s*=\s*"?([^";]+)"?/i.exec(disposicao)
  return simples ? simples[1].trim() : null
}

export const api = {
  async get(caminho) {
    return lerJson(await requisitar(caminho, { headers: { Accept: 'application/json' } }))
  },

  async post(caminho, corpo) {
    return lerJson(await requisitar(caminho, comoPost(corpo)))
  },

  async baixar(caminho, corpo) {
    const resposta = await requisitar(caminho, comoPost(corpo))
    let blob
    try {
      blob = await resposta.blob()
    } catch {
      throw new Error(SEM_CONEXAO)
    }
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = nomeDoArquivo(resposta.headers.get('Content-Disposition')) || 'arquivo'
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  },
}
