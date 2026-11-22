// src/bus.js — per-build SSE event bus (harness per-idea pattern, one channel per build).
'use strict';
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(50);

function emit(buildId, type, data = {}, ts) {
  bus.emit(`build:${buildId}`, JSON.stringify({ type, ...data, ts: ts || new Date().toISOString() }));
}

module.exports = { bus, emit };
