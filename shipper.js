const Zlib = require('zlib')
const Logsene = require('logsene-js')
const logger = new Logsene(process.env.LOGS_TOKEN)
const axios = require('axios')
const spmToken = process.env.SPM_TOKEN
const spmReceiverUrl = process.env.SPM_RECEIVER_URL
const errorPatterns = [
  'error'
]
const configurationErrorPatterns = [
  'module initialization error',
  'unable to import module'
]
const timeoutErrorPatterns = [
  'task timed out',
  'process exited before completing'
]
/**
 * Sample of a structured log
 * ***************************************************************************
 * Timestamp                RequestId                            Message
 * 2019-03-08T15:58:45.736Z 53499d7f-60f1-476a-adc8-1e6c6125a67c Hello World!
 * ***************************************************************************
 */
const structuredLogPattern = '[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[1-2][0-9]|3[0-1])T(2[0-3]|[01][0-9]):[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z([ \t])[a-zA-Z0-9]{8}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{12}([ \t])(.*)'
const regexError = new RegExp(errorPatterns.join('|'), 'gi')
const regexConfigurationError = new RegExp(configurationErrorPatterns.join('|'), 'gi')
const regexTimeoutError = new RegExp(timeoutErrorPatterns.join('|'), 'gi')
const regexStructuredLog = new RegExp(structuredLogPattern)
const lambdaVersion = (logStream) => logStream.substring(logStream.indexOf('[') + 1, logStream.indexOf(']'))
const lambdaName = (logGroup) => logGroup.split('/').reverse()[0]

const parseStringWith = (regex, input) => {
  const res = regex.exec(input)
  return String(res[1])
}
const parseFloatWith = (regex, input) => {
  const res = regex.exec(input)
  return parseFloat(res[1])
}
const parseFloatWithAndConvertToBytes = (regex, input) => {
  const res = regex.exec(input)
  return parseFloat(res[1]) * 1000000
}
// BUG: timestamp is not from invocation out of Kinesis, but instead of the metricShipper :(
const getNanoSecondTimestamp = () => {
  return (new Date()).getTime() * 1000000 // to get ns timestamp
}

/**
 * Create payload for SPM API
 */
const parseMetric = (functionName, functionVersion, message, awsRegion) => {
  if (message.startsWith('REPORT RequestId:')) {
    const parts = message.split('\t', 5)

    const requestId = parseStringWith(/REPORT RequestId: (.*)/i, parts[0])
    const duration = parseFloatWith(/Duration: (.*) ms/i, parts[1]) // in ms
    const billedDuration = parseFloatWith(/Billed Duration: (.*) ms/i, parts[2]) // in ms
    const memorySize = parseFloatWithAndConvertToBytes(/Memory Size: (.*) MB/i, parts[3]) // in bytes
    const memoryUsed = parseFloatWithAndConvertToBytes(/Max Memory Used: (.*) MB/i, parts[4]) // in bytes
    const timestamp = getNanoSecondTimestamp()

    return `function,token=${spmToken},function.name=${functionName},function.version=${functionVersion},function.request.id=${requestId},aws.region=${awsRegion} duration=${duration},duration.billed=${billedDuration}i,memory.size=${memorySize}i,memory.used=${memoryUsed}i ${timestamp}`
  }
}

const checkLogError = (log) => {
  if (log.message.match(regexError)) {
    log.severity = 'error'
    log.error = {
      type: 'runtime'
    }
  } else if (log.message.match(regexConfigurationError)) {
    log.severity = 'error'
    log.error = {
      type: 'configuration'
    }
  } else if (log.message.match(regexTimeoutError)) {
    log.severity = 'error'
    log.error = {
      type: 'timeout'
    }
  }
  return log
}
const splitStructuredLog = (message) => {
  const parts = message.split('\t', 3)
  return {
    execTimestamp: parts[0],
    requestId: parts[1],
    msg: parts[2]
  }
}

/**
 * Create payload for Logsene API
 */
const parseLog = (functionName, functionVersion, message, awsRegion) => {
  if (
    message.startsWith('START RequestId') ||
    message.startsWith('END RequestId') ||
    message.startsWith('REPORT RequestId')
  ) {
    return
  }

  // if log is structured
  if (message.match(regexStructuredLog)) {
    const { execTimestamp, requestId, msg } = splitStructuredLog(message)
    return checkLogError({
      message: msg,
      function: functionName,
      version: functionVersion,
      region: awsRegion,
      type: 'lambda',
      severity: 'debug',
      execTimestamp: execTimestamp,
      requestId: requestId
    })
  } else { // if log is NOT structured
    return checkLogError({
      message: message,
      function: functionName,
      version: functionVersion,
      region: awsRegion,
      type: 'lambda',
      severity: 'debug'
    })
  }
}

const parseRecords = (event) => {
  const logs = []
  const metrics = []

  event.Records.forEach(record => {
    const payload = Buffer.from(record.kinesis.data, 'base64')
    const json = (Zlib.gunzipSync(payload)).toString('utf8')
    const data = JSON.parse(json)
    if (data.messageType === 'CONTROL_MESSAGE') { return }

    const functionName = lambdaName(data.logGroup)
    const functionVersion = lambdaVersion(data.logStream)
    const awsRegion = record.awsRegion

    data.logEvents.forEach(logEvent => {
      const log = parseLog(functionName, functionVersion, logEvent.message, awsRegion)
      if (log) {
        logs.push(log)
      }

      const metric = parseMetric(functionName, functionVersion, logEvent.message, awsRegion)
      if (metric) {
        metrics.push(metric)
      }
    })
  })

  return {
    logs,
    metrics
  }
}

const shipMetrics = async (metrics) => {
  if (!metrics.length) {
    return 'No metrics to ship.'
  }

  const config = {
    headers: {
      'Content-Length': 0,
      'Content-Type': 'text/plain'
    },
    responseType: 'text'
  }
  const res = await Promise.all(metrics.map(m => axios.post(spmReceiverUrl, m, config)))
  console.log('Metrics res: ', res)
  return 'Metrics shipped successfully!'
}

const shipLogs = async (logs) => {
  return new Promise((resolve) => {
    if (!logs.length) {
      return resolve('No logs to ship.')
    }
    logs.forEach(log => {
      logger.log(log.severity, 'LogseneJS', log)
    })
    logger.send(() => resolve('Logs shipped successfully!'))
  })
}

exports.handler = async (event) => {
  try {
    const { logs, metrics } = parseRecords(event)
    const l = await shipLogs(logs)
    const m = await shipMetrics(metrics)
    console.log(l, m)
  } catch (err) {
    console.log(err)
    return err
    // TODO: handle err by pushing to SNS, and consume by another Lambda to retry with DLQ
  }
  return 'log shipper done'
}