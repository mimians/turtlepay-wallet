// Copyright (c) 2018, TurtlePay Developers
//
// Please see the included LICENSE file for more information.

'use strict'

const Config = require('./config.json')
const TurtleCoinUtils = require('turtlecoin-utils')
const request = require('request-promise-native')
const RabbitMQ = require('amqplib')
const cluster = require('cluster')
const util = require('util')
const cryptoUtils = new TurtleCoinUtils()
const cpuCount = require('os').cpus().length

const publicRabbitHost = process.env.RABBIT_PUBLIC_SERVER || 'localhost'
const publicRabbitUsername = process.env.RABBIT_PUBLIC_USERNAME || ''
const publicRabbitPassword = process.env.RABBIT_PUBLIC_PASSWORD || ''

const privateRabbitHost = process.env.RABBIT_PRIVATE_SERVER || 'localhost'
const privateRabbitUsername = process.env.RABBIT_PRIVATE_USERNAME || ''
const privateRabbitPassword = process.env.RABBIT_PRIVATE_PASSWORD || ''

function log (message) {
  console.log(util.format('%s: %s', (new Date()).toUTCString(), message))
}

function spawnNewWorker () {
  cluster.fork()
}

/* Helps us to build the RabbitMQ connection string */
function buildConnectionString (host, username, password) {
  var result = ['amqp://']

  if (username.length !== 0 && password.length !== 0) {
    result.push(username + ':')
    result.push(password + '@')
  }

  result.push(host)

  return result.join('')
}

if (cluster.isMaster) {
  for (var cpuThread = 0; cpuThread < cpuCount; cpuThread++) {
    spawnNewWorker()
  }

  cluster.on('exit', (worker, code, signal) => {
    log(util.format('worker %s died', worker.process.pid))
    spawnNewWorker()
  })
} else if (cluster.isWorker) {
  (async function () {
    try {
      /* Set up our access to the necessary RabbitMQ systems */
      var publicRabbit = await RabbitMQ.connect(buildConnectionString(publicRabbitHost, publicRabbitUsername, publicRabbitPassword))
      var publicChannel = await publicRabbit.createChannel()

      var privateRabbit = await RabbitMQ.connect(buildConnectionString(privateRabbitHost, privateRabbitUsername, privateRabbitPassword))
      var privateChannel = await privateRabbit.createChannel()

      await publicChannel.assertQueue(Config.queues.complete, {
        durable: true
      })
      await privateChannel.assertQueue(Config.queues.send, {
        durable: true
      })

      privateChannel.consume(Config.queues.scan, async function (message) {
        if (message !== null) {
          var payload = JSON.parse(message.content.toString())

          /* Let's get some basic block information regarding our wallet */
          var topBlock
          var startBlock
          try {
            topBlock = await request({ url: Config.blockHeaderUrl + 'top', json: true })
            startBlock = await request({ url: Config.blockHeaderUrl + payload.scanHeight, json: true })
          } catch (e) {
            /* If we can't grab this information, then something went wrong and we need
               to leave this for someone else to handle */
            log(util.format('[ERROR] Worker #%s encountered an error retrieving block data', cluster.worker.id))
            return privateChannel.nack(message)
          }

          /* If we're at the same block height as when the request was
             created, then there's 0% chance that our transaction has
             occurred */
          if (topBlock.height === payload.scanHeight) {
            return privateChannel.nack(message)
          }

          /* Let's go get blockchain transactional data so we can scan through it */
          var syncData
          try {
            syncData = await request({ url: Config.syncUrl, json: true, method: 'POST', body: { lastKnownBlockHashes: [startBlock.hash], blockCount: (Config.maximumScanBlocks + 1) } })
          } catch (e) {
            /* That didn't work out well, let's just leave this for someone else */
            log(util.format('[ERROR] Worker #%s could not retrieve sync data for wallet [%s]', cluster.worker.id, payload.wallet.address))
            return privateChannel.nack(message)
          }

          /* We'll store our outputs in here */
          var walletOutputs = []
          var totalAmount = 0
          var fundsFoundInBlock = 0

          /* Loop through the returned blocks */
          for (var i = 0; i < syncData.length; i++) {
            var block = syncData[i]

            /* Loop through transactions in the block */
            for (var j = 0; j < block.transactions.length; j++) {
              var transaction = block.transactions[j]

              /* Reform transaction outputs */
              var txnOutputs = []
              for (var k = 0; k < transaction.outputs.length; k++) {
                var out = transaction.outputs[k]
                txnOutputs.push({
                  index: out.outputIndex,
                  globalIndex: out.globalIndex,
                  amount: out.amount,
                  key: out.key
                })
              }

              /* Check to see if any of the outputs in the transaction belong to us */
              var outputs = cryptoUtils.scanTransactionOutputs(transaction.publicKey, txnOutputs, payload.wallet.view.privateKey, payload.wallet.spend.publicKey, payload.wallet.spend.privateKey)

              /* If we found outputs, we need to store the top block height we found
                 the funds in so we know where to start our confirmation check from */
              if (outputs.length !== 0 && block.height > fundsFoundInBlock) {
                fundsFoundInBlock = block.height
              }

              /* Loop through any found outputs and start tallying them up */
              for (var l = 0; l < outputs.length; l++) {
                totalAmount += outputs[l].amount
                walletOutputs.push(outputs[l])
              }
            }
          }

          /* Did we find some outputs for us? */
          if (walletOutputs.length > 0) {
            /* Did we find all the funds we requested and do we have the required confirmations? */
            if (totalAmount >= payload.request.amount && (topBlock.height - fundsFoundInBlock) >= Config.confirmationsRequired) {
              /* Congrats, we found all the funds that we requested and we're ready
                 to send them on */

              /* Generate the response for sending it back to the requestor,
                 to let them know that funds were received (still incomplete) */
              var goodResponse = {
                address: payload.wallet.address,
                status: 100,
                request: payload.request
              }

              publicChannel.sendToQueue(Config.queues.complete, Buffer.from(JSON.stringify(goodResponse)), {
                persistent: true
              })

              /* Stick our funds in our payload */
              payload.funds = walletOutputs

              /* Signal to the workers who send the funds to their real destination that things are ready */
              privateChannel.sendToQueue(Config.queues.send, Buffer.from(JSON.stringify(payload)), {
                persistent: true
              })

              /* This request is now complete from the scanning standpoint */
              log(util.format('[INFO] Worker #%s found %s for [%s] and is forwarding request to send workers', cluster.worker.id, totalAmount, payload.wallet.address))
              return privateChannel.ack(message)
            } else if (totalAmount >= payload.request.amount) {
              /* We found all the funds we need, but we don't have enough confirmations yet */
              log(util.format('[INFO] Worker #%s found %s for [%s] but is awaiting confirmations. %s blocks to go', cluster.worker.id, totalAmount, payload.wallet.address, (Config.confirmationsRequired - (topBlock.height - fundsFoundInBlock))))

              /* Let Rabbit know that this request needs to be handled again */
              return privateChannel.nack(message)
            } else if (topBlock.height > payload.maxHeight && (topBlock.height - fundsFoundInBlock) >= Config.confirmationsRequired) {
              /* We found founds but it's not at least the amount that we requested
                 unfortunately, we've also ran out of time to look for more */

              /* Build a response that we can send back to the requestor to let them know
                 that we've received some funds, but not all of them, but that their
                 request has been timed out */
              var partialResponse = {
                address: payload.wallet.address,
                status: 206,
                request: payload.request
              }

              publicChannel.sendToQueue(Config.queues.complete, Buffer.from(JSON.stringify(partialResponse)), {
                persistent: true
              })

              /* Stick our funds in our payload */
              payload.funds = walletOutputs

              /* Signal to the workers who send the funds to their real destination that things are ready */
              privateChannel.sendToQueue(Config.queues.send, Buffer.from(JSON.stringify(payload)), {
                persistent: true
              })

              /* This request is now complete from the scanning standpoint */
              log(util.format('[INFO] Worker #%s found %s for [%s] and is forwarding request to send workers', cluster.worker.id, totalAmount, payload.wallet.address))
              return privateChannel.ack(message)
            } else {
              /* We found some funds, it's not what we're looking for but we still have time
                 to keep looking for more */
              log(util.format('[INFO] Worker #%s found %s for [%s] but we need to look for more', cluster.worker.id, totalAmount, payload.wallet.address))
              return privateChannel.nack(message)
            }
          }

          /* We need to observe the maximum amount of time
             that we are going to look for transactions if we
             don't find anything that we're looking for */
          if (topBlock.height > payload.maxHeight && walletOutputs.length === 0) {
            var response = {
              address: payload.wallet.address,
              status: 408, // request timed out
              request: payload.request
            }

            /* Send the 'cancelled' wallet back to the public
               workers that will signal to the caller that the
               request has been abandoned */
            publicChannel.sendToQueue(Config.queues.complete, Buffer.from(JSON.stringify(response)), {
              persistent: true
            })

            /* That's it, we're done with this request */
            log(util.format('[INFO] Worker #%s timed out wallet [%s]', cluster.worker.id, payload.wallet.address))
            return privateChannel.ack(message)
          }

          /* If our request has not been timed out (cancelled) and
             we didn't find our funds yet, then let's throw it
             back in the queue for checking again later */
          return privateChannel.nack(message)
        }
      })
    } catch (e) {
      log(util.format('Error in worker #%s: %s', cluster.worker.id, e.toString()))
      cluster.worker.kill()
    }

    log(util.format('Worker #%s awaiting requests', cluster.worker.id))
  }())
}