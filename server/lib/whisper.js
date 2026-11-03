import https from 'https';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { getLogger } from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CERT_DIR = resolve(__dirname, '../../cert/system-actor');

let whisperAgent;

function expandHome(p) {
  return p.startsWith('~') ? process.env.HOME + p.slice(1) : p;
}

function getWhisperAgent() {
  if (!whisperAgent) {
    const log = getLogger();
    const certPath = process.env.WHISPER_CLIENT_CERT_PATH || resolve(DEFAULT_CERT_DIR, 'cert.pem');
    const keyPath = process.env.WHISPER_CLIENT_KEY_PATH || resolve(DEFAULT_CERT_DIR, 'private.pem');
    const passPath = process.env.WHISPER_CLIENT_PASS_PATH || '';
    const caPath = process.env.WHISPER_CLIENT_CA_PATH || './node_modules/@apple/node-corp-certs/certs.pem';

    const expandedCertPath = expandHome(certPath);
    const expandedKeyPath = expandHome(keyPath);

    const agentOptions = {
      cert: readFileSync(expandedCertPath),
      key: readFileSync(expandedKeyPath),
      rejectUnauthorized: true,
    };

    if (passPath && passPath.trim() !== '') {
      agentOptions.passphrase = readFileSync(expandHome(passPath), 'utf8').trim();
    }

    if (caPath && caPath.trim() !== '') {
      agentOptions.ca = readFileSync(expandHome(caPath));
    }

    whisperAgent = new https.Agent(agentOptions);
    log.debug('Whisper mTLS agent initialized');
  }
  return whisperAgent;
}

export async function getWhisperSecret(secretName, namespace) {
  const log = getLogger();
  const url = `https://whisper.iss.apple.com/v1/my-secrets/${secretName}?namespace=${namespace}`;
  const agent = getWhisperAgent();

  try {
    const response = await axios.get(url, { httpsAgent: agent });
    const decoded = Buffer.from(response.data.secret, 'base64').toString('utf8');
    log.info({ secretName, namespace }, 'Fetched secret from Whisper');
    return decoded;
  } catch (error) {
    const status = error.response?.status;
    const detail = error.response?.data?.message || error.message;
    log.error({ secretName, namespace, status, detail }, 'Failed to fetch Whisper secret');
    throw new Error(`Whisper ${status || 'request'} error: ${detail}`);
  }
}

export async function updateWhisperSecret(secretName, namespace, data) {
  const log = getLogger();
  const url = `https://whisper.iss.apple.com/v1/secrets/${secretName}?namespace=${namespace}`;
  const agent = getWhisperAgent();
  const payload = {
    updatedContent: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)).toString('base64'),
  };

  try {
    const response = await axios.post(url, payload, { httpsAgent: agent });
    log.info({ secretName, namespace }, 'Updated Whisper secret');
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const detail = error.response?.data?.message || error.message;
    log.error({ secretName, namespace, status, detail }, 'Failed to update Whisper secret');
    throw new Error(`Whisper ${status || 'request'} error: ${detail}`);
  }
}
