'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

function requireEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function base64ToHex(base64String) {
  return Buffer.from(base64String, 'base64').toString('hex');
}

function readSigningKey() {
  const keyFilePath = path.resolve(
    requireEnvironment('ANTCHAIN_REST_ACCESS_SECRET_FILE'),
  );
  const fileStatus = fs.statSync(keyFilePath);
  if (!fileStatus.isFile()) {
    throw new Error('Configured AntChain signing-key path is not a file');
  }
  if ((fileStatus.mode & 0o077) !== 0) {
    throw new Error('AntChain signing-key file permissions must be 0600 or stricter');
  }

  const signingKey = fs.readFileSync(keyFilePath, 'utf8').trim();
  if (!signingKey) {
    throw new Error('Configured AntChain signing-key file is empty');
  }
  return signingKey;
}

function normalizeRestUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('ANTCHAIN_REST_URL must use HTTP or HTTPS');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('ANTCHAIN_REST_URL must not contain credentials, query, or fragment');
  }
  return value.replace(/\/+$/, '');
}

async function getRestToken() {
  const now = Date.now();
  const signingKey = readSigningKey();
  const accessId = requireEnvironment('ANTCHAIN_REST_ACCESS_ID');
  const restUrl = normalizeRestUrl(requireEnvironment('ANTCHAIN_REST_URL'));

  const secretBase64 = signData(accessId + now, signingKey);
  const params = {
    accessId,
    time: now.toString(),
    secret: base64ToHex(secretBase64),
  };

  return sendPostRequest(`${restUrl}/api/contract/shakeHand`, params);
}

function signData(data, privateKey) {
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(data, 'utf8');

  const formattedKey = privateKey.includes('-----BEGIN')
    ? privateKey
    : `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`;
  return sign.sign(formattedKey, 'base64');
}

async function sendPostRequest(url, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    throw new Error(`AntChain handshake failed with HTTP ${response.status}`);
  }

  const responseText = await response.text();
  console.log(`[getRestToken] Handshake accepted (HTTP ${response.status})`);
  return responseText;
}

function logFailure(error) {
  const code =
    error && typeof error === 'object' && typeof error.code === 'string'
      ? error.code
      : 'FAILED_CLOSED';
  console.error(`[getRestToken] Request failed (${code})`);
}

if (require.main === module) {
  getRestToken()
    .then(() => {
      console.log('[getRestToken] Response received');
    })
    .catch((error) => {
      logFailure(error);
      process.exitCode = 1;
    });
}

module.exports = {
  base64ToHex,
  getRestToken,
  normalizeRestUrl,
  readSigningKey,
  sendPostRequest,
  signData,
};
