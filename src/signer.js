'use strict'

const {
  base64UrlMatcher,
  base64UrlReplacer,
  useNewCrypto,
  hsAlgorithms,
  esAlgorithms,
  rsaAlgorithms,
  edAlgorithms,
  detectPrivateKeyAlgorithm,
  createSignature
} = require('./crypto')
const TokenError = require('./error')
const { getAsyncKey, ensurePromiseCallback } = require('./utils')
const { createPrivateKey, createSecretKey } = require('crypto')

const supportedAlgorithms = Array.from(
  new Set([...hsAlgorithms, ...esAlgorithms, ...rsaAlgorithms, ...edAlgorithms, 'none'])
).join(', ')

function checkIsCompatibleAlgorithm(expected, actual) {
  const expectedType = expected.slice(0, 2)
  const actualType = actual.slice(0, 2)

  let valid = true // We accept everything for HS

  if (expectedType === 'RS' || expectedType === 'PS') {
    // RS and PS use same keys
    valid = actualType === 'RS'
  } else if (expectedType === 'ES' || expectedType === 'Ed') {
    // ES and Ed must match
    valid = expectedType === actualType
  }

  if (!valid) {
    throw new TokenError(TokenError.codes.invalidKey, `Invalid private key provided for algorithm ${expected}.`)
  }
}

function prepareKeyOrSecret(key, algorithm) {
  if (typeof key === 'string') {
    key = Buffer.from(key, 'utf-8')
  }

  // Only on Node 12 - Create a key object
  /* istanbul ignore next */
  if (useNewCrypto) {
    key = algorithm[0] === 'H' ? createSecretKey(key) : createPrivateKey(key)
  }

  return key
}

function sign(
  {
    key,
    algorithm,
    noTimestamp,
    mutatePayload,
    clockTimestamp,
    expiresIn,
    notBefore,
    kid,
    isAsync,
    additionalHeader,
    fixedPayload
  },
  payload,
  cb
) {
  const [callback, promise] = isAsync ? ensurePromiseCallback(cb) : []

  // Validate header and payload
  let payloadType = typeof payload
  if (payload instanceof Buffer) {
    payload = payload.toString('utf-8')
    payloadType = 'string'
  } else if (payloadType !== 'string' && payloadType !== 'object') {
    throw new TokenError(TokenError.codes.invalidType, 'The payload must be a object, a string or a buffer.')
  }

  // Prepare the header
  const header = {
    alg: algorithm,
    typ: payloadType === 'object' ? 'JWT' : undefined,
    kid,
    ...additionalHeader
  }

  // Prepare the payload
  let encodedPayload = ''

  // All the claims are added only if the payload is not a string
  if (payloadType !== 'string') {
    const iat = payload.iat * 1000 || clockTimestamp || Date.now()

    const finalPayload = {
      ...payload,
      ...fixedPayload,
      iat: noTimestamp ? undefined : Math.floor(iat / 1000),
      exp: expiresIn ? Math.floor((iat + expiresIn) / 1000) : undefined,
      nbf: notBefore ? Math.floor((iat + notBefore) / 1000) : undefined
    }

    if (mutatePayload) {
      Object.assign(payload, finalPayload)
    }

    encodedPayload = Buffer.from(JSON.stringify(finalPayload), 'utf-8')
      .toString('base64')
      .replace(base64UrlMatcher, base64UrlReplacer)
  } else {
    encodedPayload = Buffer.from(payload, 'utf-8')
      .toString('base64')
      .replace(base64UrlMatcher, base64UrlReplacer)
  }

  // We have the key
  if (!callback) {
    const encodedHeader = Buffer.from(JSON.stringify(header), 'utf-8')
      .toString('base64')
      .replace(base64UrlMatcher, base64UrlReplacer)

    const input = encodedHeader + '.' + encodedPayload
    const signature = algorithm === 'none' ? '' : createSignature(algorithm, key, input)

    return input + '.' + signature
  }

  // Get the key asynchronously
  getAsyncKey(key, header, (err, currentKey) => {
    if (err) {
      const error = TokenError.wrap(err, TokenError.codes.keyFetchingError, 'Cannot fetch key.')
      return callback(error)
    }

    if (typeof currentKey === 'string') {
      currentKey = Buffer.from(currentKey, 'utf-8')
    } else if (!(currentKey instanceof Buffer)) {
      return callback(
        new TokenError(
          TokenError.codes.keyFetchingError,
          'The key returned from the callback must be a string or a buffer containing a secret or a private key.'
        )
      )
    }

    let token
    try {
      // Detect the private key - If the algorithm was known, just verify they match, otherwise assign it
      const availableAlgorithm = detectPrivateKeyAlgorithm(currentKey)

      if (algorithm) {
        checkIsCompatibleAlgorithm(algorithm, availableAlgorithm)
      } else {
        header.alg = algorithm = availableAlgorithm
      }

      currentKey = prepareKeyOrSecret(currentKey, algorithm)

      const encodedHeader = Buffer.from(JSON.stringify(header), 'utf-8')
        .toString('base64')
        .replace(base64UrlMatcher, base64UrlReplacer)

      const input = encodedHeader + '.' + encodedPayload
      token = input + '.' + createSignature(algorithm, currentKey, input)
    } catch (e) {
      return callback(e)
    }

    callback(null, token)
  })

  return promise
}

module.exports = function createSigner(options) {
  let {
    key,
    algorithm,
    noTimestamp,
    mutatePayload,
    clockTimestamp,
    expiresIn,
    notBefore,
    jti,
    aud,
    iss,
    sub,
    nonce,
    kid,
    header: additionalHeader
  } = { clockTimestamp: 0, ...options }

  // Validate options
  if (
    algorithm &&
    algorithm !== 'none' &&
    !hsAlgorithms.includes(algorithm) &&
    !esAlgorithms.includes(algorithm) &&
    !rsaAlgorithms.includes(algorithm) &&
    !edAlgorithms.includes(algorithm)
  ) {
    throw new TokenError(
      TokenError.codes.invalidOption,
      `The algorithm option must be one of the following values: ${supportedAlgorithms}.`
    )
  }

  const keyType = typeof key

  if (algorithm === 'none') {
    if (key) {
      throw new TokenError(
        TokenError.codes.invalidOption,
        'The key option must not be provided when the algorithm option is "none".'
      )
    }
  } else if (!key || (keyType !== 'string' && !(key instanceof Buffer) && keyType !== 'function')) {
    throw new TokenError(
      TokenError.codes.invalidOption,
      'The key option must be a string, a buffer or a function returning the algorithm secret or private key.'
    )
  }

  // Convert the key to a string when not a function, in order to be able to detect
  if (key && keyType !== 'function') {
    // Detect the private key - If the algorithm was known, just verify they match, otherwise assign it
    const availableAlgorithm = detectPrivateKeyAlgorithm(key)

    if (algorithm) {
      checkIsCompatibleAlgorithm(algorithm, availableAlgorithm)
    } else {
      algorithm = availableAlgorithm
    }

    key = prepareKeyOrSecret(key, algorithm)
  }

  if (expiresIn && (typeof expiresIn !== 'number' || expiresIn < 0)) {
    throw new TokenError(TokenError.codes.invalidOption, 'The expiresIn option must be a positive number.')
  }

  if (notBefore && (typeof notBefore !== 'number' || notBefore < 0)) {
    throw new TokenError(TokenError.codes.invalidOption, 'The notBefore option must be a positive number.')
  }

  if (clockTimestamp && (typeof clockTimestamp !== 'number' || clockTimestamp < 0)) {
    throw new TokenError(TokenError.codes.invalidOption, 'The clockTimestamp option must be a positive number.')
  }

  if (jti && typeof jti !== 'string') {
    throw new TokenError(TokenError.codes.invalidOption, 'The jti option must be a string.')
  }

  if (aud && typeof aud !== 'string' && !Array.isArray(aud)) {
    throw new TokenError(TokenError.codes.invalidOption, 'The aud option must be a string or an array of strings.')
  }

  if (iss && typeof iss !== 'string') {
    throw new TokenError(TokenError.codes.invalidOption, 'The iss option must be a string.')
  }

  if (sub && typeof sub !== 'string') {
    throw new TokenError(TokenError.codes.invalidOption, 'The sub option must be a string.')
  }

  if (nonce && typeof nonce !== 'string') {
    throw new TokenError(TokenError.codes.invalidOption, 'The nonce option must be a string.')
  }

  if (kid && typeof kid !== 'string') {
    throw new TokenError(TokenError.codes.invalidOption, 'The kid option must be a string.')
  }

  if (additionalHeader && typeof additionalHeader !== 'object') {
    throw new TokenError(TokenError.codes.invalidOption, 'The header option must be a object.')
  }

  // Return the signer
  const context = {
    key,
    algorithm,
    noTimestamp,
    mutatePayload,
    clockTimestamp,
    expiresIn,
    notBefore,
    kid,
    isAsync: keyType === 'function',
    additionalHeader,
    fixedPayload: {
      jti,
      aud,
      iss,
      sub,
      nonce
    }
  }

  return sign.bind(null, context)
}
