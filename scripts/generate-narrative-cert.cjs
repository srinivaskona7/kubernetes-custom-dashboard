#!/usr/bin/env node

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
require('dotenv').config()

const CERT_DIR = path.resolve(__dirname, '..', 'cert')
const TEMPLATE = path.join(__dirname, 'narrative-config.template.yaml')
const CONFIG = path.join(CERT_DIR, 'narrative-config.yaml')

const { NARRATIVE_PERSON_DSID, NARRATIVE_SYSTEM_DSID } = process.env
if (!NARRATIVE_PERSON_DSID || !NARRATIVE_SYSTEM_DSID) {
  console.error('Set NARRATIVE_PERSON_DSID and NARRATIVE_SYSTEM_DSID in .env or environment')
  process.exit(1)
}

fs.mkdirSync(CERT_DIR, { recursive: true })

const config = fs.readFileSync(TEMPLATE, 'utf8')
  .replace('{{PERSON_DSID}}', NARRATIVE_PERSON_DSID)
  .replace('{{SYSTEM_DSID}}', NARRATIVE_SYSTEM_DSID)
  .replace('{{CERT_DIR}}', CERT_DIR)
fs.writeFileSync(CONFIG, config)

try {
  execSync(`narrative-client ${CONFIG}`, { stdio: 'inherit' })
} finally {
  if (fs.existsSync(CONFIG)) fs.unlinkSync(CONFIG)
}

console.log(`\nDone. Certificates saved to ${CERT_DIR}/`)
