/**
 * Usage
 *   echo 'WALLET_SEED="word1 word2..."' >> .env
 *   node bin/cancel-all-pending-txs.js [concurrency]
 *
 * Recommended concurrency setting: 10
 *
 * You can find the f0 address e.g. at https://filfox.info/en/address/{f4address}
 *
 * You can find addresses of our services here:
 * https://www.notion.so/spacemeridian/Addresses-69580544c50a4c98a34a36d0bed6a4f3)
 */

// dotenv must be imported before importing anything else
import 'dotenv/config'

import assert from 'node:assert'
import { ethers } from 'ethers'
import { CoinType, newDelegatedEthAddress } from '@glif/filecoin-address'
import { assertOkResponse } from '../lib/http-assertions.js'

const {
  GLIF_TOKEN,
  WALLET_SEED
} = process.env

assert(GLIF_TOKEN, 'GLIF_TOKEN required')
assert(WALLET_SEED, 'WALLET_SEED required')

const [, , concurrency = 1] = process.argv
assert(concurrency > 0, 'concurrency must be at least 1')

const { signer } = createSigner()

const f0address = await getWalletId(signer.address)
const pendingTxs = await listPendingTransactions(f0address)
console.log('Found %s pending transactions', pendingTxs.length)
pendingTxs.sort((a, b) => a.nonce - b.nonce)
// for (const tx of pendingTxs) {
//   console.log('%s %s %s', tx.nonce, tx.createdAt, tx.cid)
// }

console.log(
  'Cancelling %s oldest transactions from %s (%s) with concurrency %s',
  pendingTxs.length,
  signer.address,
  f0address,
  concurrency
)

while (pendingTxs.length > 0) {
  const chunk = pendingTxs.splice(0, concurrency)

  const recentSendMessage = await getRecentSendMessage()
  console.log(' - Calculating gas fees from the recent Send message %s (created at %s)',
    recentSendMessage.cid,
    new Date(recentSendMessage.timestamp * 1000).toISOString()
  )

  await Promise.all(chunk.map(async (tx) => cancelTransaction(recentSendMessage, tx)))

  console.log('== %s pending transactions remaining ==', pendingTxs.length)
}

async function getWalletId (f4address) {
  const res = await fetch(`https://filfox.info/api/v1/address/${f4address}`)
  assertOkResponse(res)
  const { id } = await res.json()
  assert.match(id, /^f0/)
  return id
}

async function listPendingTransactions (f0address) {
  const result = []

  let offset = 0
  while (true) {
    console.log('Fetching pending transactions %s-%s', offset + 1, offset + 50)
    const res = await fetch(`https://filfox.info/api/v1/address/${f0address}/pending-messages?limit=50&offset=${offset}`)
    await assertOkResponse(res)
    /**
   * @type {{
   *   totalCount: number;
   *   messages: {
   *     cid: string;
   *     from: string;
   *     to: string;
   *     nonce: number;
   *     value: string;
   *     gasLimit: number;
   *     gasFeeCap: string;
   *     gasPremium: string;
   *     method: string;
   *     methodNumber: number;
   *     evmMethod: string;
   *     createTimestamp: number; // seconds since the Unix epoch
   *   }[];
   * }}
   */
    const body = await res.json()
    const txs = body.messages.map(t => ({ ...t, createdAt: new Date(t.createTimestamp * 1000) }))
    result.push(...txs)
    offset += txs.length

    if (result.length === body.totalCount) break
    assert(result.length < body.totalCount, `API indicated ${body.totalCount} total count but we collected ${result.length} transactions`)
  }

  return result
}

function createSigner () {
  const fetchRequest = new ethers.FetchRequest('https://api.node.glif.io/rpc/v1')
  fetchRequest.setHeader('Authorization', `Bearer ${GLIF_TOKEN}`)
  const provider = new ethers.JsonRpcProvider(fetchRequest, null, {
    polling: true,
    batchMaxCount: 10
  })

  const signer = ethers.Wallet.fromPhrase(WALLET_SEED, provider)
  const walletDelegatedAddress = newDelegatedEthAddress(/** @type {any} */(signer.address), CoinType.MAIN).toString()
  console.log(
    'Wallet address:',
    signer.address,
    walletDelegatedAddress
  )

  return { provider, signer, walletDelegatedAddress }
}

/**
 * @returns {Promise<{
   "cid": string;
   "nonce": number;
   "height": number;
   "timestamp": number;
   "gasLimit": number;
   "gasFeeCap": string;
   "gasPremium": string;
   "method": string;
   "methodNumber": number;
   "receipt": {
      "exitCode": number;
      "return": string;
      "gasUsed": number;
    },
    "size": number;
    "error": string;
    "baseFee": string;
    "fee": {
      "baseFeeBurn": string;
      "overEstimationBurn": string;
      "minerPenalty": string;
      "minerTip": string;
      "refund": string;
    },
  }>}
 */
async function getRecentSendMessage () {
  let res = await fetch('https://filfox.info/api/v1/message/list?method=Send')
  if (!res.ok) {
    throw new Error(`Filfox request failed with ${res.status}: ${(await res.text()).trimEnd()}`)
  }
  const body = /** @type {any} */(await res.json())
  assert(body.messages.length > 0, '/message/list returned an empty list')
  const sendMsg = body.messages.find(m => m.method === 'Send')
  assert(!!sendMsg, 'No Send message found in the recent committed messages')
  const cid = sendMsg.cid

  res = await fetch(`https://filfox.info/api/v1/message/${cid}`)
  if (!res.ok) {
    throw new Error(`Filfox request failed with ${res.status}: ${(await res.text()).trimEnd()}`)
  }

  return /** @type {any} */(await res.json())
}

/**
 * @param {ReturnType<getRecentSendMessage>} recentSendMessage
 * @param {{
 *  cid: string;
 *  gasPremium: string;
 *  nonce: number;
 *  createdAt: Date;
 * }} tx
 */
async function cancelTransaction (recentSendMessage, tx) {
  // This would skip replacement TXs we created by this script. That's not what we want.
  // if (tx.createdAt.getTime() > Date.now() - 30 * 60_000) {
  //   console.log('TX %s (nonce %s) was created at %s (less than 30 minutes ago), will not cancel it', tx.cid, tx.nonce, tx.createdAt)
  //   return
  // }

  console.log('REPLACING %s (nonce %s, created at %s)', tx.cid, tx.nonce, tx.createdAt)

  const gasUsed = recentSendMessage.receipt.gasUsed
  const gasFeeCap = Number(recentSendMessage.gasFeeCap)
  const oldGasPremium = tx.gasPremium
  const nonce = tx.nonce

  console.log(' - SENDING THE REPLACEMENT TRANSACTION')
  try {
    const replacementTx = await signer.sendTransaction({
      to: signer.address,
      value: 0,
      nonce,
      gasLimit: Math.ceil(gasUsed * 1.1),
      maxFeePerGas: gasFeeCap,
      maxPriorityFeePerGas: Math.ceil(oldGasPremium * 1.252)
    })
    console.log('nonce=%s REPLACED TX %s -> %s', tx.nonce, tx.cid, replacementTx.hash)

    try {
      const receipt = await replacementTx.wait()
      console.log('nonce=%s TX %s status:', tx.nonce, replacementTx.hash, receipt?.status)
    } catch (err) {
      console.log('nonce=%s TX %s was rejected with code %s (%s)', tx.nonce, replacementTx.hash, err.code, err.shortMessage)
    }
  } catch (err) {
    if (err.code === 'NONCE_EXPIRED') {
      console.log('nonce=%s TX %s was already committed', tx.nonce, tx.cid)
    } else {
      throw err
    }
  }
}
