/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import http from 'node:http';

const PORT = 11434;
const delayedMarker = 'LIBRE_KILL_WORKER_ONCE';
const authorizationMarker = 'LIBRE_AUTH_OUTAGE_JOB';
const workMarker = 'LIBRE_WORK_TOOL_KILL';
const videoJobId = 'libre-video-fixture';
const liveStreamMarker = 'LIBRE_LIVE_STREAM';
const counts = new Map();
const videoIdempotencyKeys = new Map();

const json = (response, status, value) => {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
};

const readJson = async request => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('request too large');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
};

const ndjson = (response, value) => {
  response.write(`${JSON.stringify(value)}\n`);
};

const embedding = value => {
  const result = Array.from({ length: 8 }, () => 0);
  for (const [index, byte] of Buffer.from(String(value)).entries()) {
    result[index % result.length] += (byte + 1) / 256;
  }
  const norm = Math.sqrt(result.reduce((sum, item) => sum + item * item, 0));
  return result.map(item => item / (norm || 1));
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://fixture.invalid');
    if (request.method === 'GET' && url.pathname === '/') {
      json(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/version') {
      json(response, 200, { version: '0.0.0-libre-team-fixture' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/tags') {
      json(response, 200, {
        models: [
          {
            name: 'libre-test',
            model: 'libre-test',
            modified_at: '2026-01-01T00:00:00Z',
            size: 1,
            digest: 'sha256:libre-team-fixture',
            details: { family: 'fixture', parameter_size: '1B' },
          },
          {
            name: 'nomic-embed-text',
            model: 'nomic-embed-text',
            modified_at: '2026-01-01T00:00:00Z',
            size: 1,
            digest: 'sha256:libre-embedding-fixture',
            details: { family: 'fixture', parameter_size: '8' },
          },
        ],
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/__stats') {
      json(response, 200, Object.fromEntries(counts));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/show') {
      json(response, 200, {
        modelfile: 'FROM libre-team-fixture',
        parameters: '',
        template: '',
        details: { family: 'fixture', parameter_size: '1B' },
        model_info: {},
        capabilities: ['completion', 'tools'],
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/embed') {
      const body = await readJson(request);
      const values = Array.isArray(body.input) ? body.input : [body.input];
      json(response, 200, {
        model: body.model || 'nomic-embed-text',
        embeddings: values.map(embedding),
        total_duration: 1,
        load_duration: 1,
        prompt_eval_count: values.length,
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/chat') {
      const body = await readJson(request);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const content = messages
        .map(message =>
          typeof message?.content === 'string' ? message.content : ''
        )
        .join('\n');
      if (content.includes(workMarker)) {
        const count = (counts.get(workMarker) || 0) + 1;
        counts.set(workMarker, count);
        const hasToolResult = messages.some(
          message => message?.role === 'tool'
        );
        const message = hasToolResult
          ? { role: 'assistant', content: 'Work tool recovery completed.' }
          : {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'libre-work-tool-call',
                  function: {
                    name: 'run_command',
                    arguments: {
                      command:
                        'printf ready > /workspace/.libre-work-tool-ready.tmp && mv /workspace/.libre-work-tool-ready.tmp /workspace/.libre-work-tool-ready && sleep 60; printf LIBRE_WORK_TOOL_FINISHED',
                      timeout_ms: 90000,
                    },
                  },
                },
              ],
            };
        const payload = {
          model: body.model || 'libre-test',
          created_at: new Date().toISOString(),
          message,
          done: true,
          done_reason: 'stop',
          total_duration: 1,
          load_duration: 1,
          prompt_eval_count: 1,
          eval_count: 1,
        };
        if (body.stream === true) {
          response.writeHead(200, { 'content-type': 'application/x-ndjson' });
          response.end(`${JSON.stringify(payload)}\n`);
        } else {
          json(response, 200, payload);
        }
        return;
      }
      const key = content.includes(delayedMarker)
        ? delayedMarker
        : content.includes(authorizationMarker)
          ? authorizationMarker
          : content.includes(liveStreamMarker)
            ? liveStreamMarker
            : 'ordinary';
      const count = (counts.get(key) || 0) + 1;
      counts.set(key, count);
      if (
        (key === delayedMarker || key === authorizationMarker) &&
        count === 1
      ) {
        await new Promise(resolve => setTimeout(resolve, 60_000));
      }
      const payload = {
        model: body.model || 'libre-test',
        created_at: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: `fixture-response:${key}:${count}`,
        },
        done: true,
        done_reason: 'stop',
        total_duration: 1,
        load_duration: 1,
        prompt_eval_count: 1,
        eval_count: 1,
      };
      if (body.stream === true) {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        if (key === liveStreamMarker) {
          ndjson(response, {
            ...payload,
            message: { role: 'assistant', content: 'fixture-live-part-1:' },
            done: false,
          });
          await new Promise(resolve => setTimeout(resolve, 3_000));
          ndjson(response, {
            ...payload,
            message: { role: 'assistant', content: 'fixture-live-part-2' },
          });
          response.end();
        } else {
          ndjson(response, payload);
          response.end();
        }
      } else {
        json(response, 200, payload);
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/videos') {
      counts.set('video-submit', (counts.get('video-submit') || 0) + 1);
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || !idempotencyKey) {
        json(response, 400, { error: 'Idempotency-Key is required' });
        return;
      }
      let acceptedJobId = videoIdempotencyKeys.get(idempotencyKey);
      if (!acceptedJobId) {
        acceptedJobId = videoJobId;
        videoIdempotencyKeys.set(idempotencyKey, acceptedJobId);
        counts.set(
          'video-submit-effects',
          (counts.get('video-submit-effects') || 0) + 1
        );
      }
      json(response, 202, { id: acceptedJobId, status: 'pending' });
      return;
    }
    if (request.method === 'GET' && url.pathname === `/videos/${videoJobId}`) {
      const count = (counts.get('video-poll') || 0) + 1;
      counts.set('video-poll', count);
      json(response, 200, {
        id: videoJobId,
        status: 'completed',
        usage: { fixture: true },
      });
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === `/videos/${videoJobId}/content`
    ) {
      const video = Buffer.from('LIBRE_FAKE_MP4');
      counts.set('video-download', (counts.get('video-download') || 0) + 1);
      response.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': video.length,
      });
      response.end(video);
      return;
    }
    json(response, 404, {
      error: `Unhandled fixture route ${request.method} ${url.pathname}`,
    });
  } catch (error) {
    json(response, 500, {
      error: error instanceof Error ? error.message : 'fixture failure',
    });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`fake Ollama listening on ${PORT}\n`);
});
