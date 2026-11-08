// Certificado A1 tem poucos KB; acima disso quase sempre é o arquivo errado.
export const TAMANHO_MAXIMO_PFX = 200 * 1024

// Conteúdo de qualquer arquivo em base64, sem o prefixo "data:".
export async function bytesBase64(arquivo) {
  const bytes = new Uint8Array(await arquivo.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

// Certificado em base64, recusando arquivo grande demais para um A1.
export async function arquivoBase64(arquivo) {
  if (arquivo.size > TAMANHO_MAXIMO_PFX) throw new Error('Arquivo grande demais para um certificado A1. Confira se é o .pfx certo.')
  return bytesBase64(arquivo)
}
