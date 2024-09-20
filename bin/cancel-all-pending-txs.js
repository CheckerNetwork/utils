/**
 * Usage
 *   node bin/scrape-pending-txt.js <f0address>
 *
 * You can find the f0 address e.g. at https://filfox.info/en/address/{f4address}
 *
 * You can find addresses of our services here:
 * https://www.notion.so/spacemeridian/Addresses-69580544c50a4c98a34a36d0bed6a4f3)
 */

import {assertOkResponse} from '../lib/http-assertions.js'

const [,,address] = process.argv

if (!address || !address.match(/^f0/)) {
  console.error('Missing required argument: f0 address')
  process.exit(1)
}

const pendingTxCids = await listPendingTransactions(address)
console.log(pendingTxCids.map(t => ({...t, createdAt: new Date(t.createTimestamp * 1000)}) ))

// TODO: add typings
/*
  {
    cid: 'bafy2bzaceddzmistgjcjegdjcf2myzrvkcwivt7522qlb54holxdd5sd2aj4u',
    from: 'f410fj3g4re56wcisdzhvzo5enhjt6x7wdbccfitupvq',
    to: 'f410fqrqhm3w4mk2sl7a7utlcr7dzeko4ombrjptgwui',
    nonce: 99253,
    value: '0',
    gasLimit: 5020269148,
    gasFeeCap: '64289397',
    gasPremium: '137561',
    method: 'InvokeContract',
    methodNumber: 3844450837,
    evmMethod: '',
    createTimestamp: 1726794710,
*/
async function listPendingTransactions(address) {
  const res = await fetch(`https://filfox.info/api/v1/address/${address}/pending-messages?limit=1000`)
  assertOkResponse(res)
  const body = await res.json()
  if (body.totalCount >= 1000) {
    console.error('There are more than 1000 pending messages. This script cannot handle that yet.')
    console.error('Please improve the script to support pagination.')
    process.exit(2)
  }
  return body.messages
}
