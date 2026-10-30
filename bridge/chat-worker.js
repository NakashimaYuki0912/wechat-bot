#!/usr/bin/env node
// Dedicated chat lane. Same DB/outbox; never claims summary work.
process.env.WORKER_KIND = 'chat';
await import('./agent-worker.js');
