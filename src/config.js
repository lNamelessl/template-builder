// src/config.js — env parsing with baked defaults (no deploy prompts for derivables).
// The user tokens (LLM provider key / RAILWAY_TOKEN / GITHUB_TOKEN) are NOT env
// variables here — they live in the encrypted vault (src/vault.js) and are
// entered through the setup wizard. Only optional instance-level settings stay
// env-driven.
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  || (fs.existsSync('/data') && process.platform !== 'win32' ? '/data' : path.join(__dirname, '..', '.data'));

const config = {
  dataDir: DATA_DIR,
  port: parseInt(process.env.PORT || '3000', 10),

  // builder-loop caps (env-tunable; the MAX_TURNS=3 caps proof overrides the default 40)
  maxTurns: Math.max(1, parseInt(process.env.MAX_TURNS || '40', 10)),
  spendCapUsd: parseFloat(process.env.SPEND_CAP_USD || '5') || 5,
  buildTimeoutMin: Math.max(1, parseInt(process.env.BUILD_TIMEOUT_MIN || '60', 10)),

  appPassword: (process.env.APP_ACCESS_PASSWORD || '').trim(),
  telegramToken: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
  telegramChat: (process.env.TELEGRAM_CHAT_ID || '').trim(),

  // DeepSeek list prices at peak windows (01:00-04:00 + 06:00-10:00 UTC Mon-Fri).
  // Off-peak is half price; estimates here are the HONEST upper band. Cost is
  // estimated only for deepseek-type providers (their measured price schedule);
  // other providers track token counts with billing on the user's own account.
  priceSearchPer1k: 0.75,
  priceInPerM: 0.30,
  priceOutPerM: 1.20,
};

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'artifacts'), { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'builds'), { recursive: true });

module.exports = config;
