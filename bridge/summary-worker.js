#!/usr/bin/env node
// Dedicated summary lane/coordinator. It owns summary batch fan-out and the
// single publish path for summary parts; it never claims chat or memory work.
process.env.WORKER_KIND = 'summary';
await import('./agent-worker.js');
