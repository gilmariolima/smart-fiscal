'use strict'

const { XMLParser } = require('fast-xml-parser')

// Mesmas opções que o node-mde usa no `json` do docZip: atributos com prefixo "@_",
// texto de nó com atributo em "value" e todos os valores como string.
const parser = new XMLParser({
  attributeNamePrefix: '@_',
  textNodeName: 'value',
  ignoreAttributes: false,
  allowBooleanAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
})

function xmlParaJson(xml) {
  return parser.parse(xml)
}

module.exports = { xmlParaJson }
