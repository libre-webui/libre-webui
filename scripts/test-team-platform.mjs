/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import WebSocket from 'ws';

const enabled = process.env.TEST_TEAM_PLATFORM === '1';

const freePort = async () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });

const sleep = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

test(
  'team profile survives cross-replica replay, worker death, and dependency outages',
  { skip: !enabled, timeout: 20 * 60_000 },
  async t => {
    const project = `libreteam${process.pid}${randomBytes(3).toString('hex')}`;
    const [gatewayPort, postgresPort, redisPort, minioPort, ollamaPort] =
      await Promise.all(Array.from({ length: 5 }, () => freePort()));
    const legacyKey = '31'.repeat(32);
    const activeKey = '42'.repeat(32);
    const composeEnvironment = {
      ...process.env,
      PORT: String(gatewayPort),
      TEST_POSTGRES_PORT: String(postgresPort),
      TEST_REDIS_PORT: String(redisPort),
      TEST_MINIO_PORT: String(minioPort),
      TEST_FAKE_OLLAMA_PORT: String(ollamaPort),
      POSTGRES_PASSWORD: 'libre-team-postgres-password',
      MINIO_ROOT_USER: 'libreteam',
      MINIO_ROOT_PASSWORD: 'libre-team-minio-password',
      JWT_SECRET: '53'.repeat(32),
      ENCRYPTION_KEY: legacyKey,
      STORAGE_ENCRYPTION_ACTIVE_KEY_ID: 'active',
      STORAGE_ENCRYPTION_KEYS: JSON.stringify({
        legacy: legacyKey,
        active: activeKey,
      }),
      LIBRE_TEAM_IMAGE: `${project}:app`,
    };
    const composeArgs = [
      'compose',
      '--project-name',
      project,
      '-f',
      'docker-compose.team.yml',
      '-f',
      'docker-compose.team.work.yml',
      '-f',
      'docker-compose.team.test.yml',
    ];
    const command = (args, options = {}) => {
      const result = spawnSync('docker', [...composeArgs, ...args], {
        cwd: process.cwd(),
        env: composeEnvironment,
        encoding: 'utf8',
        timeout: options.timeout ?? 180_000,
        stdio: options.inherit ? 'inherit' : 'pipe',
      });
      if (result.status !== 0) {
        throw new Error(
          `docker compose ${args.join(' ')} failed:\n${result.stdout || ''}\n${result.stderr || ''}`
        );
      }
      return (result.stdout || '').trim();
    };
    const hostDocker = args => {
      const result = spawnSync('docker', args, {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30_000,
      });
      if (result.status !== 0) {
        throw new Error(
          `docker ${args.join(' ')} failed:\n${result.stdout || ''}\n${result.stderr || ''}`
        );
      }
      return (result.stdout || '').trim();
    };
    const s3ObjectExists = blobId => {
      const objectKey = `v1/v1/${blobId.slice(0, 2)}/${blobId.slice(2, 4)}/${blobId}.blob`;
      const result = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          `${project}_default`,
          '--env',
          'MC_HOST_local=http://libreteam:libre-team-minio-password@minio:9000',
          'minio/mc:RELEASE.2025-07-21T05-28-08Z',
          'stat',
          `local/libre-blobs/${objectKey}`,
        ],
        { encoding: 'utf8', timeout: 30_000 }
      );
      return result.status === 0;
    };
    const baseUrl = `http://127.0.0.1:${gatewayPort}`;
    const fixtureUrl = `http://127.0.0.1:${ollamaPort}`;
    const upstreams = new Set();
    const request = async (
      path,
      { token, method = 'GET', body, headers = {}, expected, raw = false } = {}
    ) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined && !(body instanceof FormData)
            ? { 'Content-Type': 'application/json' }
            : {}),
          ...headers,
        },
        body:
          body === undefined || body instanceof FormData
            ? body
            : JSON.stringify(body),
      });
      const upstream = response.headers.get('x-libre-upstream');
      if (upstream) upstreams.add(upstream);
      if (expected !== undefined) {
        const expectedStatuses = Array.isArray(expected)
          ? expected
          : [expected];
        assert.ok(
          expectedStatuses.includes(response.status),
          `${method} ${path} returned ${response.status}, expected ${expectedStatuses.join(' or ')}: ${await response.clone().text()}`
        );
      } else {
        assert.ok(
          response.ok,
          `${method} ${path} returned ${response.status}: ${await response.clone().text()}`
        );
      }
      return raw ? response : response.json();
    };
    const waitFor = async (description, operation, timeout = 120_000) => {
      const deadline = Date.now() + timeout;
      let lastError;
      while (Date.now() < deadline) {
        try {
          const value = await operation();
          if (value) return value;
        } catch (error) {
          lastError = error;
        }
        await sleep(500);
      }
      let diagnostics = '';
      try {
        diagnostics = command([
          'logs',
          '--no-color',
          '--tail',
          '80',
          'durable-worker',
          'libre-webui',
          'gateway',
        ]);
      } catch (error) {
        diagnostics = `Unable to collect team service logs: ${error}`;
      }
      throw new Error(
        `Timed out waiting for ${description}${lastError ? `: ${lastError}` : ''}` +
          `\nTeam service diagnostics:\n${diagnostics}`
      );
    };
    const waitForJob = async (jobId, token, states, timeout = 120_000) =>
      waitFor(
        `job ${jobId} to enter ${states.join('/')}`,
        async () => {
          const payload = await request(`/api/jobs/${jobId}`, { token });
          return states.includes(payload.data.job.state) ? payload.data : false;
        },
        timeout
      );
    const sql = statement =>
      command([
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'libre',
        '-d',
        'libre',
        '-Atqc',
        statement,
      ]);
    const providerStats = async () =>
      await (await fetch(`${fixtureUrl}/__stats`)).json();
    const consumeChatTicket = ticket =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(
          `${baseUrl.replace(/^http/, 'ws')}/ws?ticket=${encodeURIComponent(ticket)}`
        );
        let upstream;
        const timeout = setTimeout(() => {
          socket.terminate();
          reject(new Error('Timed out consuming a shared WebSocket ticket'));
        }, 10_000);
        socket.once('upgrade', response => {
          upstream = response.headers['x-libre-upstream'];
        });
        socket.once('open', () => {
          clearTimeout(timeout);
          socket.close();
          resolve(upstream);
        });
        socket.once('unexpected-response', (_request, response) => {
          clearTimeout(timeout);
          reject(
            new Error(
              `WebSocket ticket was rejected with status ${response.statusCode}`
            )
          );
        });
        socket.once('error', error => {
          clearTimeout(timeout);
          reject(error);
        });
      });
    const killAndRestartWorker = () => {
      command(['kill', '--signal', 'KILL', 'durable-worker']);
      command(['start', 'durable-worker']);
    };
    const readSseEvent = async response => {
      assert.ok(response.body, 'SSE response must have a body');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          buffer += decoder
            .decode(value, { stream: !done })
            .replace(/\r\n/g, '\n');
          const boundary = buffer.indexOf('\n\n');
          if (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            const id = Number(
              block
                .split('\n')
                .find(line => line.startsWith('id:'))
                ?.slice(3)
                .trim()
            );
            const data = block
              .split('\n')
              .filter(line => line.startsWith('data:'))
              .map(line => line.slice(5).trimStart())
              .join('\n');
            if (Number.isSafeInteger(id) && data) {
              return { cursor: id, payload: JSON.parse(data) };
            }
          }
          if (done) throw new Error('SSE stream ended before an event');
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    };

    t.after(() => {
      try {
        command(['down', '--volumes', '--remove-orphans'], {
          timeout: 180_000,
        });
      } catch (error) {
        process.stderr.write(`${error}\n`);
      }
    });

    command(['build', 'libre-webui'], { timeout: 10 * 60_000, inherit: true });
    command([
      'up',
      '-d',
      '--scale',
      'libre-webui=3',
      'postgres',
      'redis',
      'minio',
      'minio-init',
      'fake-ollama',
      'libre-webui',
      'durable-worker',
      'gateway',
    ]);

    await waitFor('team application readiness', async () => {
      const response = await fetch(`${baseUrl}/health/ready`);
      return response.status === 200;
    });
    const runningReplicas = command(['ps', '--format', 'json'])
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
      .filter(container => container.Service === 'libre-webui')
      .filter(container => container.State === 'running');
    assert.equal(
      runningReplicas.length,
      3,
      'exactly three application replicas must run'
    );
    const expectedAppUpstreams = new Set(
      runningReplicas.map(replica => {
        const containerId = replica.ID || replica.Name;
        assert.ok(containerId, 'application container ID must be observable');
        const inspected = JSON.parse(hostDocker(['inspect', containerId]))[0];
        const network =
          inspected?.NetworkSettings?.Networks?.[`${project}_default`];
        assert.ok(
          network?.IPAddress,
          'application network IP must be observable'
        );
        return `${network.IPAddress}:3001`;
      })
    );

    const adminPassword = 'Libre-Team-Admin!2026';
    const signup = await request('/api/auth/signup', {
      method: 'POST',
      body: {
        username: 'team-admin',
        password: adminPassword,
        email: 'team-admin@example.invalid',
      },
    });
    const adminToken = signup.data.token;
    assert.equal(signup.data.user.role, 'admin');

    // The gateway re-resolves the replica set every few seconds and restarts
    // its round-robin cursor when it does, so two back-to-back requests can
    // land on the same replica by chance. Issue fresh tickets until the
    // consume hop observably crosses replicas; every attempt still proves the
    // ticket is honoured by whichever replica answers the upgrade.
    let ticketIssueUpstream;
    let ticketConsumeUpstream;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const ticketResponse = await request('/api/auth/websocket-ticket', {
        token: adminToken,
        method: 'POST',
        body: { audience: 'chat' },
        raw: true,
      });
      ticketIssueUpstream = ticketResponse.headers.get('x-libre-upstream');
      const ticketPayload = await ticketResponse.json();
      ticketConsumeUpstream = await consumeChatTicket(
        ticketPayload.data.ticket
      );
      assert.ok(ticketIssueUpstream, 'ticket issue replica must be observable');
      assert.ok(
        ticketConsumeUpstream,
        'ticket consume replica must be observable on the WebSocket upgrade'
      );
      if (ticketConsumeUpstream !== ticketIssueUpstream) break;
    }
    assert.notEqual(
      ticketConsumeUpstream,
      ticketIssueUpstream,
      'a ticket issued by one replica must be consumable by another replica'
    );

    const ordinarySession = await request('/api/chat/sessions', {
      token: adminToken,
      method: 'POST',
      body: { model: 'libre-test', title: 'Cross replica chat' },
    });
    const sessionId = ordinarySession.data.id;
    await request(`/api/chat/sessions/${sessionId}`, { token: adminToken });

    await request('/api/preferences', {
      token: adminToken,
      method: 'PUT',
      body: {
        theme: {
          mode: 'dark',
          adaptToAccent: false,
          accent: 'orange',
          customAccent: '#f97316',
        },
        embeddingSettings: {
          enabled: true,
          model: 'nomic-embed-text',
          chunkSize: 256,
          chunkOverlap: 32,
          similarityThreshold: 0,
        },
      },
    });
    const settings = await request('/api/preferences', { token: adminToken });
    assert.equal(settings.data.theme.accent, 'orange');

    // Two disjoint preference mutations must serialize through PostgreSQL,
    // even when different application replicas read the same starting row.
    let distinctPreferenceReplicas = false;
    for (
      let attempt = 0;
      attempt < 6 && !distinctPreferenceReplicas;
      attempt += 1
    ) {
      const [showUsernameResponse, hapticsResponse] = await Promise.all([
        request('/api/preferences', {
          token: adminToken,
          method: 'PUT',
          body: { showUsername: true },
          raw: true,
        }),
        request('/api/preferences', {
          token: adminToken,
          method: 'PUT',
          body: { hapticFeedbackEnabled: true },
          raw: true,
        }),
      ]);
      const showUsernameUpstream =
        showUsernameResponse.headers.get('x-libre-upstream');
      const hapticsUpstream = hapticsResponse.headers.get('x-libre-upstream');
      await Promise.all([
        showUsernameResponse.arrayBuffer(),
        hapticsResponse.arrayBuffer(),
      ]);
      distinctPreferenceReplicas = Boolean(
        showUsernameUpstream &&
        hapticsUpstream &&
        showUsernameUpstream !== hapticsUpstream
      );
    }
    assert.equal(
      distinctPreferenceReplicas,
      true,
      'concurrent preference mutations must be observed on different replicas'
    );
    const mergedSettings = await request('/api/preferences', {
      token: adminToken,
    });
    assert.equal(mergedSettings.data.showUsername, true);
    assert.equal(mergedSettings.data.hapticFeedbackEnabled, true);

    const form = new FormData();
    const documentText =
      'LIBRE_TEAM_DOCUMENT_NEEDLE cross replica durable extraction and search.';
    form.append(
      'document',
      new Blob([documentText], { type: 'text/plain' }),
      'team.txt'
    );
    form.append('sessionId', sessionId);
    // Hold the external worker so one app replica observes the authoritative
    // queued placeholder before any chunks exist. After completion, route
    // back through that exact app and prove its earlier empty read did not
    // become an authoritative process-local cache entry.
    command(['stop', 'durable-worker']);
    const uploaded = await request('/api/documents/upload', {
      token: adminToken,
      method: 'POST',
      body: form,
      expected: 202,
    });
    assert.equal(
      sql(
        `SELECT state FROM platform_jobs WHERE id = '${uploaded.data.jobId}'`
      ),
      'queued'
    );
    const queuedSearchResponse = await request('/api/documents/search', {
      token: adminToken,
      method: 'POST',
      body: { query: 'LIBRE_TEAM_DOCUMENT_NEEDLE', sessionId, limit: 5 },
      raw: true,
    });
    const queuedSearchUpstream =
      queuedSearchResponse.headers.get('x-libre-upstream');
    assert.ok(
      queuedSearchUpstream,
      'queued document search replica must be observable'
    );
    const queuedSearch = await queuedSearchResponse.json();
    assert.deepEqual(
      queuedSearch.data,
      [],
      'queued document has no searchable chunks before worker completion'
    );
    command(['start', 'durable-worker']);
    await waitForJob(uploaded.data.jobId, adminToken, ['succeeded']);
    const source = await request(`/api/documents/${uploaded.data.id}/source`, {
      token: adminToken,
      raw: true,
    });
    assert.equal(await source.text(), documentText);
    const search = await waitFor(
      'the queued-document replica to observe completed vector state',
      async () => {
        const response = await request('/api/documents/search', {
          token: adminToken,
          method: 'POST',
          body: { query: 'LIBRE_TEAM_DOCUMENT_NEEDLE', sessionId, limit: 5 },
          raw: true,
        });
        const upstream = response.headers.get('x-libre-upstream');
        const payload = await response.json();
        return upstream === queuedSearchUpstream && payload.data.length > 0
          ? payload
          : false;
      }
    );
    assert.ok(
      search.data.length > 0,
      'document search must find extracted content'
    );
    assert.equal(
      Number(
        sql(
          `SELECT count(*) FROM platform_vector_entries WHERE resource_id = '${uploaded.data.id}'`
        )
      ),
      Number(
        sql(
          `SELECT count(*) FROM document_chunks WHERE document_id = '${uploaded.data.id}'`
        )
      ),
      'queued reads must not delete or suppress the completed document vectors'
    );

    // Kill the only worker in the exact post-PGVector-upsert window. SQL/blob
    // state survives, deterministic chunk IDs are replayed, and replace-all
    // indexing cannot leave stale vectors from the abandoned attempt.
    const extractionForm = new FormData();
    extractionForm.append(
      'document',
      new Blob(
        [
          'LIBRE_DOCUMENT_POST_VECTOR_KILL durable extraction must resume without duplicate chunks.',
        ],
        { type: 'text/plain' }
      ),
      'extraction-kill.txt'
    );
    extractionForm.append('sessionId', sessionId);
    const extraction = await request('/api/documents/upload', {
      token: adminToken,
      method: 'POST',
      body: extractionForm,
      expected: 202,
    });
    await waitForJob(extraction.data.jobId, adminToken, ['running']);
    await waitFor('document vectors written before completion', async () => {
      return (
        Number(
          sql(
            `SELECT count(*) FROM platform_vector_entries WHERE resource_id = '${extraction.data.id}'`
          )
        ) > 0
      );
    });
    killAndRestartWorker();
    const extracted = await waitForJob(
      extraction.data.jobId,
      adminToken,
      ['succeeded'],
      120_000
    );
    assert.ok(
      extracted.attempts.length >= 2,
      'extraction must be reclaimed after worker death'
    );
    const extractedChunks = Number(
      sql(
        `SELECT count(*) FROM document_chunks WHERE document_id = '${extraction.data.id}'`
      )
    );
    assert.ok(extractedChunks > 0, 'reclaimed extraction must persist chunks');
    assert.equal(
      Number(
        sql(
          `SELECT count(*) FROM platform_vector_entries WHERE resource_id = '${extraction.data.id}'`
        )
      ),
      extractedChunks,
      'reclaimed extraction must persist exactly one vector per chunk'
    );
    assert.equal(
      sql(
        `SELECT string_agg(id, ',' ORDER BY id) FROM document_chunks WHERE document_id = '${extraction.data.id}'`
      ),
      sql(
        `SELECT string_agg(id, ',' ORDER BY id) FROM platform_vector_entries WHERE resource_id = '${extraction.data.id}'`
      ),
      'replayed extraction must retain exactly the deterministic current chunk identities'
    );
    assert.equal(
      Number(
        sql(
          `SELECT count(*) FROM platform_events WHERE stream_id = 'job:${extraction.data.jobId}' AND event_type = 'job.succeeded'`
        )
      ),
      1,
      'reclaimed extraction must publish one terminal success'
    );

    // A fresh generation must not replay or count the session's prior
    // generations against the bounded SSE catch-up. Seed this in one SQL
    // statement so the three-replica route regression remains deterministic.
    const chatStreamId = `chat:${sessionId}`;
    // Retention is active during this drill. Sequence controls replay order;
    // the event timestamp must remain fresh enough to survive the sweep.
    const priorEventOccurredAt = Date.now();
    sql(`
      INSERT INTO platform_event_stream_heads (stream_id, last_sequence)
      VALUES ('${chatStreamId}', 10001);
      INSERT INTO platform_events
        (event_id, request_fingerprint, stream_id, stream_sequence, event_type,
         subject_id, actor_user_id, payload_format, payload, occurred_at)
      SELECT md5('${sessionId}:prior:' || sequence)::uuid,
             repeat('0', 64), '${chatStreamId}', sequence, 'chat.stream.v1',
             'prior-assistant-' || sequence, NULL, 'reference',
             'prior-chat-event', ${priorEventOccurredAt}
        FROM generate_series(1, 10001) AS sequence;
    `);
    assert.equal(
      Number(
        sql(
          `SELECT count(*) FROM platform_events WHERE stream_id = '${chatStreamId}'`
        )
      ),
      10_001
    );

    const generationId = `assistant-${randomBytes(8).toString('hex')}`;
    const durableUserMessageId = `user-${randomBytes(8).toString('hex')}`;
    const queued = await request(
      `/api/chat/sessions/${sessionId}/generations`,
      {
        token: adminToken,
        method: 'POST',
        expected: 202,
        body: {
          message: 'LIBRE_LIVE_STREAM durable cross replica response.',
          userMessageId: durableUserMessageId,
          assistantMessageId: generationId,
          options: {},
          webSearch: false,
        },
      }
    );
    const firstStream = await request(
      `/api/chat/sessions/${sessionId}/events?generation=${generationId}&after=0`,
      { token: adminToken, headers: { Accept: 'text/event-stream' }, raw: true }
    );
    const firstUpstream = firstStream.headers.get('x-libre-upstream');
    const firstEvent = await readSseEvent(firstStream);
    assert.equal(firstEvent.payload.type, 'chunk');
    // Chunk events carry only their delta; consumers accumulate in order.
    assert.equal(firstEvent.payload.content, 'fixture-live-part-1:');
    assert.equal(firstEvent.payload.total, undefined);
    const observedLiveDeltas = [firstEvent.payload.content];
    const observedLiveCursors = [firstEvent.cursor];
    let afterCursor = firstEvent.cursor;
    let crossedReplica = false;
    let terminalEvent;
    for (let attempt = 0; attempt < 12 && !terminalEvent; attempt += 1) {
      const stream = await request(
        `/api/chat/sessions/${sessionId}/events?generation=${generationId}&after=${afterCursor}`,
        {
          token: adminToken,
          headers: { Accept: 'text/event-stream' },
          raw: true,
        }
      );
      const resumedUpstream = stream.headers.get('x-libre-upstream');
      const resumed = await readSseEvent(stream);
      crossedReplica ||= Boolean(
        resumedUpstream && resumedUpstream !== firstUpstream
      );
      assert.ok(resumed.cursor > afterCursor, 'SQL cursor must be ordered');
      afterCursor = resumed.cursor;
      observedLiveCursors.push(resumed.cursor);
      if (resumed.payload.type === 'chunk') {
        observedLiveDeltas.push(resumed.payload.content);
      }
      if (resumed.payload.type === 'done') terminalEvent = resumed;
    }
    assert.equal(
      crossedReplica,
      true,
      'an active stream reconnect must cross replicas'
    );
    assert.equal(terminalEvent?.payload.type, 'done');
    assert.deepEqual(observedLiveDeltas, [
      'fixture-live-part-1:',
      'fixture-live-part-2',
    ]);
    assert.equal(
      observedLiveDeltas.join(''),
      'fixture-live-part-1:fixture-live-part-2'
    );
    assert.equal(
      terminalEvent?.payload.content,
      'fixture-live-part-1:fixture-live-part-2'
    );
    assert.ok(
      observedLiveCursors.length >= 3,
      'live generation must expose partial and terminal SQL events'
    );
    await waitForJob(queued.data.jobId, adminToken, ['succeeded']);
    const streamedSession = await request(`/api/chat/sessions/${sessionId}`, {
      token: adminToken,
    });
    assert.equal(
      streamedSession.data.messages.find(message => message.id === generationId)
        ?.content,
      'fixture-live-part-1:fixture-live-part-2',
      'the ordered durable stream must match the final persisted assistant'
    );

    // Regeneration uses the same durable transaction/event path, retaining
    // branch identity while a second replica resumes the active stream.
    const regenerationId = `assistant-${randomBytes(8).toString('hex')}`;
    const regeneration = await request(
      `/api/chat/sessions/${sessionId}/generations`,
      {
        token: adminToken,
        method: 'POST',
        expected: 202,
        body: {
          message: 'LIBRE_LIVE_STREAM durable cross replica response.',
          userMessageId: durableUserMessageId,
          assistantMessageId: regenerationId,
          originalMessageId: generationId,
          regenerate: true,
          options: {},
          webSearch: false,
        },
      }
    );
    const regenerationStream = await request(
      `/api/chat/sessions/${sessionId}/events?generation=${regenerationId}&after=0`,
      { token: adminToken, headers: { Accept: 'text/event-stream' }, raw: true }
    );
    const regenerationUpstream =
      regenerationStream.headers.get('x-libre-upstream');
    const regenerationFirst = await readSseEvent(regenerationStream);
    assert.equal(regenerationFirst.payload.type, 'chunk');
    let regenerationCursor = regenerationFirst.cursor;
    let regenerationCrossedReplica = false;
    let regenerationTerminal;
    for (let attempt = 0; attempt < 12 && !regenerationTerminal; attempt += 1) {
      const stream = await request(
        `/api/chat/sessions/${sessionId}/events?generation=${regenerationId}&after=${regenerationCursor}`,
        {
          token: adminToken,
          headers: { Accept: 'text/event-stream' },
          raw: true,
        }
      );
      const upstream = stream.headers.get('x-libre-upstream');
      const event = await readSseEvent(stream);
      regenerationCrossedReplica ||= Boolean(
        upstream && upstream !== regenerationUpstream
      );
      assert.ok(event.cursor > regenerationCursor);
      regenerationCursor = event.cursor;
      if (event.payload.type === 'done') regenerationTerminal = event;
    }
    assert.equal(regenerationCrossedReplica, true);
    assert.equal(regenerationTerminal?.payload.type, 'done');
    await waitForJob(regeneration.data.jobId, adminToken, ['succeeded']);
    const regeneratedSession = await request(
      `/api/chat/sessions/${sessionId}`,
      { token: adminToken }
    );
    const regeneratedMessage = regeneratedSession.data.messages.find(
      message => message.id === regenerationId
    );
    assert.equal(regeneratedMessage?.parentId, generationId);
    assert.equal(regeneratedMessage?.isActive, true);
    assert.equal(
      regeneratedSession.data.messages.find(
        message => message.id === generationId
      )?.isActive,
      false
    );

    // Old REST and persisted WebSocket generation are process-owned. Team
    // mode rejects the REST compatibility aliases before contacting a model.
    const callsBeforeCompatibilityCheck = (await providerStats()).ordinary || 0;
    await request(`/api/chat/sessions/${sessionId}/generate`, {
      token: adminToken,
      method: 'POST',
      expected: 409,
      body: { message: 'must not execute in an app replica' },
    });
    await request(`/api/chat/sessions/${sessionId}/generate/stream`, {
      token: adminToken,
      method: 'POST',
      expected: 409,
      body: { message: 'must not execute in an app replica' },
    });
    assert.equal(
      (await providerStats()).ordinary || 0,
      callsBeforeCompatibilityCheck,
      'team compatibility routes must not invoke the provider'
    );

    const observedEveryAppReplica = () =>
      [...expectedAppUpstreams].every(upstream => upstreams.has(upstream));
    for (
      let attempt = 0;
      attempt < 12 && !observedEveryAppReplica();
      attempt += 1
    ) {
      await request(`/api/chat/sessions/${sessionId}`, { token: adminToken });
    }
    assert.equal(
      observedEveryAppReplica(),
      true,
      `gateway must exercise all three application replicas; expected ${JSON.stringify(
        [...expectedAppUpstreams]
      )}, observed ${JSON.stringify([...upstreams])}`
    );

    const killGenerationId = `assistant-${randomBytes(8).toString('hex')}`;
    const killQueued = await request(
      `/api/chat/sessions/${sessionId}/generations`,
      {
        token: adminToken,
        method: 'POST',
        expected: 202,
        body: {
          message: 'LIBRE_KILL_WORKER_ONCE',
          userMessageId: `user-${randomBytes(8).toString('hex')}`,
          assistantMessageId: killGenerationId,
          options: {},
          webSearch: false,
        },
      }
    );
    await waitForJob(killQueued.data.jobId, adminToken, ['running']);
    killAndRestartWorker();
    const recovered = await waitForJob(
      killQueued.data.jobId,
      adminToken,
      ['succeeded'],
      120_000
    );
    assert.ok(
      recovered.attempts.length >= 2,
      'worker death must create a reclaimed attempt'
    );
    const recoveredSession = await request(`/api/chat/sessions/${sessionId}`, {
      token: adminToken,
    });
    assert.equal(
      recoveredSession.data.messages.filter(
        message => message.id === killGenerationId
      ).length,
      1,
      'reclaimed chat job must persist one assistant message'
    );
    assert.equal(
      Number(
        sql(
          `SELECT count(*) FROM platform_events WHERE subject_id = '${killGenerationId}' AND event_type = 'chat.done.v1'`
        )
      ),
      1,
      'reclaimed chat job must publish one terminal event'
    );
    const providerCallStats = await providerStats();
    assert.ok(
      providerCallStats.LIBRE_KILL_WORKER_ONCE >= 2,
      'provider call is explicitly at-least-once after process death'
    );

    // A provider-backed media job is claimed by the same external worker.
    // Kill it while the status request is in flight, then prove conditional
    // gallery completion prevents duplicate media/blob terminal effects.
    const videoEndpoint = 'http://fake-ollama:11434/videos';
    await request('/api/plugins/install', {
      token: adminToken,
      method: 'POST',
      body: {
        id: 'libre-team-video-fixture',
        name: 'Libre team video fixture',
        type: 'video',
        endpoint: videoEndpoint,
        auth: {
          header: 'Authorization',
          prefix: 'Bearer ',
          key_env: 'LIBRE_TEAM_VIDEO_KEY',
        },
        model_map: ['libre-video-model'],
        capabilities: {
          video: {
            endpoint: videoEndpoint,
            model_map: ['libre-video-model'],
            config: {
              max_prompt_length: 1000,
              poll_interval_ms: 100,
              timeout_ms: 120000,
              supports_idempotency: true,
            },
          },
        },
      },
    });
    await request('/api/plugins/libre-team-video-fixture/credentials', {
      token: adminToken,
      method: 'POST',
      body: { api_key: 'team-video-fixture-key' },
    });
    await request('/api/plugins/activate/libre-team-video-fixture', {
      token: adminToken,
      method: 'POST',
    });
    const jobsBeforeVideo = new Set(
      (
        await request('/api/jobs?mine=true&limit=100', { token: adminToken })
      ).data.map(job => job.id)
    );
    const video = await request('/api/media/video/generate', {
      token: adminToken,
      method: 'POST',
      expected: 202,
      body: {
        model: 'libre-video-model',
        pluginId: 'libre-team-video-fixture',
        prompt:
          'LIBRE_VIDEO_POST_SUBMIT_KILL LIBRE_MEDIA_POST_SAVE_KILL durable video',
      },
    });
    const videoSubmitJob = await waitFor(
      'durable media submission job',
      async () => {
        const jobs = await request('/api/jobs?mine=true&limit=100', {
          token: adminToken,
        });
        return (
          jobs.data.find(
            job =>
              job.jobType === 'media.video.submit.v1' &&
              !jobsBeforeVideo.has(job.id)
          ) || false
        );
      },
      30_000
    );
    await waitForJob(videoSubmitJob.id, adminToken, ['running']);
    await waitFor(
      'video provider to accept the prepared submission',
      async () => {
        const stats = await providerStats();
        return stats['video-submit-effects'] === 1;
      }
    );
    assert.equal(
      sql(
        `SELECT provider_job_id FROM platform_media_generation_jobs WHERE id = '${video.data.id}'`
      ),
      'libre:prepared',
      'provider acceptance must precede the reconciled SQL commit in this fault window'
    );
    killAndRestartWorker();
    const recoveredSubmission = await waitForJob(
      videoSubmitJob.id,
      adminToken,
      ['succeeded'],
      120_000
    );
    assert.ok(
      recoveredSubmission.attempts.length >= 2,
      'provider submission must be reclaimed after worker death'
    );
    const submissionStats = await providerStats();
    assert.ok(
      submissionStats['video-submit'] >= 2,
      'reconciliation must repeat the provider request after the ambiguous outcome'
    );
    assert.equal(
      submissionStats['video-submit-effects'],
      1,
      'stable Idempotency-Key must produce one provider-side job'
    );
    const videoJob = await waitFor(
      'durable media polling job',
      async () => {
        const jobs = await request('/api/jobs?mine=true&limit=100', {
          token: adminToken,
        });
        return (
          jobs.data.find(
            job =>
              job.jobType === 'media.video.resume.v1' &&
              !jobsBeforeVideo.has(job.id)
          ) || false
        );
      },
      30_000
    );
    await waitForJob(videoJob.id, adminToken, ['running']);
    await waitFor('gallery row written before media-job claim', async () => {
      return (
        Number(
          sql(
            `SELECT count(*) FROM platform_generated_media WHERE id = '${video.data.id}'`
          )
        ) === 1 &&
        sql(
          `SELECT COALESCE(gallery_id, '') FROM platform_media_generation_jobs WHERE id = '${video.data.id}'`
        ) === ''
      );
    });
    killAndRestartWorker();
    const recoveredVideo = await waitForJob(
      videoJob.id,
      adminToken,
      ['succeeded'],
      120_000
    );
    assert.ok(
      recoveredVideo.attempts.length >= 2,
      'post-save media completion must be reclaimed after worker death'
    );
    const completedVideo = await request(
      `/api/media/video/jobs/${video.data.id}`,
      { token: adminToken }
    );
    assert.equal(completedVideo.data.status, 'completed');
    assert.ok(
      completedVideo.data.media?.id,
      'completed media must be readable'
    );
    assert.equal(
      Number(
        sql(
          `SELECT count(*) FROM platform_media_generation_jobs WHERE id = '${video.data.id}' AND gallery_id IS NOT NULL`
        )
      ),
      1
    );
    assert.equal(
      Number(
        sql(
          `SELECT count(*) FROM platform_generated_media WHERE id = '${completedVideo.data.media.id}'`
        )
      ),
      1,
      'reclaimed media completion must persist one gallery row'
    );
    assert.equal(
      Number(
        sql(
          `SELECT count(*) FROM platform_blob_references WHERE resource_type = 'generated-media' AND resource_id = '${completedVideo.data.media.id}'`
        )
      ),
      1,
      'reclaimed media completion must retain one blob reference'
    );
    assert.equal(
      completedVideo.data.media.id,
      video.data.id,
      'durable media identity must be derived from the prepared job'
    );
    assert.equal(
      Number(
        sql(
          `SELECT count(*) FROM platform_blob_objects WHERE owner_user_id = '${signup.data.user.id}' AND id IN (SELECT blob_id FROM platform_blob_references WHERE resource_type = 'generated-media' AND resource_id = '${video.data.id}')`
        )
      ),
      1,
      'post-save recovery must retain one physical blob inventory record'
    );

    // Exercise an actual Work function call in an isolated sandbox. The
    // worker dies while `run_command` is sleeping; durable replay records the
    // missing result as outcome-unknown instead of executing the call twice.
    const jobsBeforeWork = new Set(
      (
        await request('/api/jobs?mine=true&limit=100', { token: adminToken })
      ).data.map(job => job.id)
    );
    const work = await request('/api/work/tasks', {
      token: adminToken,
      method: 'POST',
      expected: 201,
      body: {
        message: 'LIBRE_WORK_TOOL_KILL invoke the requested command once.',
        model: 'libre-test',
        providerType: 'ollama',
      },
    });
    const workRunId = work.data.activeRun?.id;
    assert.ok(workRunId, 'Work task must expose its active durable run');
    const workJob = await waitFor(
      'durable Work job',
      async () => {
        const jobs = await request('/api/jobs?mine=true&limit=100', {
          token: adminToken,
        });
        return (
          jobs.data.find(
            job =>
              job.jobType === 'work.execute.v1' && !jobsBeforeWork.has(job.id)
          ) || false
        );
      },
      30_000
    );
    await waitForJob(workJob.id, adminToken, ['running']);
    const workContainer = sql(
      `SELECT container_name FROM work_tasks WHERE id = '${work.data.id}'`
    );
    await waitFor('Work run_command side-effect acknowledgement', async () => {
      const messages = await request(
        `/api/work/tasks/${work.data.id}/messages?limit=200`,
        { token: adminToken }
      );
      if (
        !messages.data.messages.some(message => message.kind === 'tool_call')
      ) {
        return false;
      }
      const marker = spawnSync(
        'docker',
        [
          'exec',
          workContainer,
          'test',
          '-s',
          '/workspace/.libre-work-tool-ready',
        ],
        { encoding: 'utf8', timeout: 30_000 }
      );
      return marker.status === 0;
    });

    // A graceful HTTP-replica shutdown and restart must not run global Work
    // recovery or teardown against the external worker's active sandbox.
    const appReplicaId = runningReplicas[0]?.ID || runningReplicas[0]?.Name;
    assert.ok(appReplicaId, 'an application replica ID must be observable');
    hostDocker(['stop', '--time', '15', appReplicaId]);
    assert.equal(
      sql(`SELECT state FROM platform_jobs WHERE id = '${workJob.id}'`),
      'running',
      'HTTP app shutdown must not rewrite the external worker job'
    );
    assert.equal(
      sql(`SELECT status FROM work_runs WHERE id = '${workRunId}'`),
      'running',
      'HTTP app shutdown must not fail the shared Work run'
    );
    assert.equal(
      hostDocker(['inspect', '--format', '{{.State.Running}}', workContainer]),
      'true',
      'HTTP app shutdown must not stop the worker-owned sandbox'
    );
    hostDocker(['start', appReplicaId]);
    await waitFor('all three application replicas after restart', async () => {
      return (
        command(['ps', '--format', 'json'])
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line))
          .filter(container => container.Service === 'libre-webui')
          .filter(container => container.State === 'running').length === 3
      );
    });
    // Give the restarted process time to enter the Work recovery branch; the
    // shared job, run, and sandbox must remain untouched afterward.
    await sleep(1_000);
    assert.equal(
      sql(`SELECT state FROM platform_jobs WHERE id = '${workJob.id}'`),
      'running'
    );
    assert.equal(
      sql(`SELECT status FROM work_runs WHERE id = '${workRunId}'`),
      'running'
    );
    assert.equal(
      hostDocker(['inspect', '--format', '{{.State.Running}}', workContainer]),
      'true'
    );
    killAndRestartWorker();
    const recoveredWork = await waitForJob(
      workJob.id,
      adminToken,
      ['succeeded'],
      120_000
    );
    assert.ok(
      recoveredWork.attempts.length >= 2,
      'tool execution must be reclaimed after worker death'
    );
    const workMessages = await request(
      `/api/work/tasks/${work.data.id}/messages?limit=200`,
      { token: adminToken }
    );
    assert.equal(
      workMessages.data.messages.filter(message => message.kind === 'tool_call')
        .length,
      1,
      'tool call intent must be persisted once'
    );
    assert.equal(
      workMessages.data.messages.filter(
        message => message.kind === 'tool_result'
      ).length,
      1,
      'interrupted tool call must settle once as an outcome-unknown result'
    );
    assert.match(
      workMessages.data.messages.find(message => message.kind === 'tool_result')
        ?.content || '',
      /outcome unknown|interrupted/i
    );
    assert.equal(
      Number(
        sql(
          `SELECT count(*) FROM platform_events WHERE stream_id = 'job:${workJob.id}' AND event_type = 'job.succeeded'`
        )
      ),
      1,
      'reclaimed Work job must have one terminal success'
    );
    const workDeleteDeadline = Date.now() + 30_000;
    while (true) {
      const response = await request(`/api/work/tasks/${work.data.id}`, {
        token: adminToken,
        method: 'DELETE',
        expected: [200, 202, 204, 409],
        raw: true,
      });
      if (response.ok) break;
      const payload = await response.json();
      assert.equal(
        payload.message,
        'WORK_RUNTIME_LEASE_CONFLICT',
        `unexpected Work deletion conflict: ${JSON.stringify(payload)}`
      );
      assert.match(payload.error, /lifecycle operation on another replica/i);
      assert.ok(
        Date.now() < workDeleteDeadline,
        'timed out waiting for the completed Work lifecycle lease to release'
      );
      await sleep(500);
    }

    // Document deletion is its own retriable lifecycle, separate from account
    // deletion. Relational tombstone + enqueue are atomic; physical vectors,
    // ciphertext, cache, and competing queued work converge after S3 returns.
    const extractionBlobId = sql(
      `SELECT blob_id FROM platform_blob_references WHERE resource_type = 'document' AND resource_id = '${extraction.data.id}'`
    );
    assert.ok(extractionBlobId, 'document must retain its source blob');
    assert.equal(s3ObjectExists(extractionBlobId), true);
    const resourceCacheDigest = createHash('sha256')
      .update(`resource:${signup.data.user.id}:document:${extraction.data.id}`)
      .digest('base64url');
    command([
      'exec',
      '-T',
      'redis',
      'redis-cli',
      'SET',
      `libre-team:cache:${resourceCacheDigest}`,
      '{"stale":true}',
    ]);
    const jobsBeforeDocumentDelete = new Set(
      (
        await request('/api/jobs?mine=true&limit=100', { token: adminToken })
      ).data.map(job => job.id)
    );
    command(['stop', 'minio']);
    await request(`/api/documents/${extraction.data.id}`, {
      token: adminToken,
      method: 'DELETE',
    });
    assert.equal(
      Number(
        sql(`SELECT count(*) FROM documents WHERE id = '${extraction.data.id}'`)
      ),
      0,
      'document row is tombstoned in the enqueue transaction'
    );
    const documentDeleteJob = await waitFor(
      'durable document cleanup job',
      async () => {
        const jobs = await request('/api/jobs?mine=true&limit=100', {
          token: adminToken,
        });
        return (
          jobs.data.find(
            job =>
              job.jobType === 'resource.delete.v1' &&
              !jobsBeforeDocumentDelete.has(job.id)
          ) || false
        );
      },
      30_000
    );
    await waitFor('document cleanup retry after S3 outage', async () => {
      const current = await request(`/api/jobs/${documentDeleteJob.id}`, {
        token: adminToken,
      });
      return current.data.attempts.some(
        attempt => attempt.outcome === 'retry_scheduled'
      );
    });
    command(['start', 'minio']);
    await waitFor(
      'MinIO live endpoint after document cleanup fault',
      async () => {
        const response = await fetch(
          `http://127.0.0.1:${minioPort}/minio/health/live`
        );
        return response.ok;
      }
    );
    await waitForJob(documentDeleteJob.id, adminToken, ['succeeded'], 120_000);
    for (const table of ['document_chunks', 'platform_vector_entries']) {
      assert.equal(
        Number(
          sql(
            `SELECT count(*) FROM ${table} WHERE ${
              table === 'document_chunks' ? 'document_id' : 'resource_id'
            } = '${extraction.data.id}'`
          )
        ),
        0,
        `${table} must be clean after retry`
      );
    }
    assert.equal(
      Number(
        sql(
          `SELECT count(*) FROM platform_blob_references WHERE resource_type = 'document' AND resource_id = '${extraction.data.id}'`
        )
      ),
      0
    );
    assert.equal(
      Number(
        sql(
          `SELECT count(*) FROM platform_blob_objects WHERE id = '${extractionBlobId}'`
        )
      ),
      0
    );
    assert.equal(s3ObjectExists(extractionBlobId), false);
    assert.equal(
      Number(
        command([
          'exec',
          '-T',
          'redis',
          'redis-cli',
          'EXISTS',
          `libre-team:cache:${resourceCacheDigest}`,
        ])
      ),
      0
    );
    assert.equal(
      Number(
        sql(
          `SELECT count(*) FROM platform_jobs WHERE actor_user_id = '${signup.data.user.id}' AND id <> '${documentDeleteJob.id}' AND state IN ('queued','running') AND job_type = 'document.extract-embed.v1'`
        )
      ),
      0,
      'document cleanup must leave no active ingestion work'
    );

    const userPassword = 'Libre-Team-User!2026';
    const createdUser = await request('/api/users', {
      token: adminToken,
      method: 'POST',
      body: {
        username: 'team-user',
        email: 'team-user@example.invalid',
        password: userPassword,
        role: 'user',
      },
    });
    const userId = createdUser.data.id;
    const login = await request('/api/auth/login', {
      method: 'POST',
      body: { username: 'team-user', password: userPassword },
    });
    const userToken = login.data.token;
    // Alternating replicas share the same Redis-backed security bucket. The
    // first login above consumed one permit; four more invalid attempts pass
    // and every later attempt is rejected globally, independent of upstream.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await request('/api/auth/login', {
        method: 'POST',
        expected: 401,
        body: { username: 'team-user', password: `wrong-${attempt}` },
      });
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await request('/api/auth/login', {
        method: 'POST',
        expected: 429,
        body: { username: 'team-user', password: `blocked-${attempt}` },
      });
    }
    const userSession = await request('/api/chat/sessions', {
      token: userToken,
      method: 'POST',
      body: { model: 'libre-test', title: 'Tenant private' },
    });
    await request(`/api/chat/sessions/${sessionId}`, {
      token: userToken,
      expected: 404,
    });
    await request(`/api/chat/sessions/${userSession.data.id}`, {
      token: adminToken,
      expected: 404,
    });
    await request(`/api/documents/${uploaded.data.id}`, {
      token: userToken,
      expected: 404,
    });

    await request('/api/preferences', {
      token: userToken,
      method: 'PUT',
      body: {
        embeddingSettings: {
          enabled: true,
          model: 'nomic-embed-text',
          chunkSize: 256,
          chunkOverlap: 32,
          similarityThreshold: 0,
        },
      },
    });
    const userForm = new FormData();
    userForm.append(
      'document',
      new Blob(['LIBRE_OWNER_DELETE_NEEDLE retriable owner content.'], {
        type: 'text/plain',
      }),
      'owner.txt'
    );
    userForm.append('sessionId', userSession.data.id);
    const userUpload = await request('/api/documents/upload', {
      token: userToken,
      method: 'POST',
      body: userForm,
      expected: 202,
    });
    await waitForJob(userUpload.data.jobId, userToken, ['succeeded']);
    // The deterministic fixture embeddings put exact-owner matches above
    // 0.99 while the other tenant's nearest row stays below it. Assert both
    // directions so SQL owner predicates remain part of vector retrieval.
    await request('/api/preferences', {
      token: adminToken,
      method: 'PUT',
      body: {
        embeddingSettings: {
          enabled: true,
          model: 'nomic-embed-text',
          chunkSize: 256,
          chunkOverlap: 32,
          similarityThreshold: 0.99,
        },
      },
    });
    await request('/api/preferences', {
      token: userToken,
      method: 'PUT',
      body: {
        embeddingSettings: {
          enabled: true,
          model: 'nomic-embed-text',
          chunkSize: 256,
          chunkOverlap: 32,
          similarityThreshold: 0.99,
        },
      },
    });
    const userOwnSearch = await request('/api/documents/search', {
      token: userToken,
      method: 'POST',
      body: {
        query: 'LIBRE_OWNER_DELETE_NEEDLE',
        sessionId: userSession.data.id,
        limit: 5,
      },
    });
    assert.ok(
      userOwnSearch.data.length > 0,
      'the owner must find its document'
    );
    const adminForeignSearch = await request('/api/documents/search', {
      token: adminToken,
      method: 'POST',
      body: {
        query: 'LIBRE_OWNER_DELETE_NEEDLE',
        sessionId,
        limit: 5,
      },
    });
    assert.deepEqual(
      adminForeignSearch.data,
      [],
      'an administrator vector search must not cross the document owner ACL'
    );
    const userForeignSearch = await request('/api/documents/search', {
      token: userToken,
      method: 'POST',
      body: {
        query: 'LIBRE_TEAM_DOCUMENT_NEEDLE',
        sessionId: userSession.data.id,
        limit: 5,
      },
    });
    assert.deepEqual(
      userForeignSearch.data,
      [],
      'a user vector search must not expose the administrator document'
    );
    const authGeneration = await request(
      `/api/chat/sessions/${userSession.data.id}/generations`,
      {
        token: userToken,
        method: 'POST',
        expected: 202,
        body: {
          message: 'LIBRE_AUTH_OUTAGE_JOB',
          userMessageId: `user-${randomBytes(8).toString('hex')}`,
          assistantMessageId: `assistant-${randomBytes(8).toString('hex')}`,
          options: {},
          webSearch: false,
        },
      }
    );
    await waitForJob(authGeneration.data.jobId, userToken, ['running']);
    const userCacheDigest = createHash('sha256')
      .update(`user:${userId}`)
      .digest('base64url');
    command([
      'exec',
      '-T',
      'redis',
      'redis-cli',
      'SET',
      `libre-team:cache:${userCacheDigest}`,
      '{"stale":true}',
    ]);
    // Redis loss may not turn a protected coordination-dependent mutation
    // into an uncoordinated write. Database-backed identity/ownership checks
    // also remain authoritative while coordination is unavailable.
    command(['stop', 'redis']);
    await waitFor('Redis outage readiness failure', async () => {
      const response = await fetch(`${baseUrl}/health/ready`);
      return response.status === 503;
    });

    await request('/api/auth/login', {
      method: 'POST',
      expected: 503,
      body: { username: 'nobody', password: 'never-valid' },
    });

    const jobsBeforeCoordinationOutageMutation = Number(
      sql('SELECT count(*) FROM platform_jobs')
    );
    await request(`/api/chat/sessions/${sessionId}/generations`, {
      token: adminToken,
      method: 'POST',
      expected: 503,
      body: {
        message: 'must not enqueue without coordination',
        userMessageId: `user-${randomBytes(8).toString('hex')}`,
        assistantMessageId: `assistant-${randomBytes(8).toString('hex')}`,
        options: {},
        webSearch: false,
      },
    });
    assert.equal(
      Number(sql('SELECT count(*) FROM platform_jobs')),
      jobsBeforeCoordinationOutageMutation,
      'shared admission failure must not enqueue a generation job'
    );
    // Revoke the actor in authoritative SQL without asking the job service to
    // cancel it. The in-flight worker must perform its own database-backed
    // actor recheck after the delayed provider returns, even with Redis down.
    sql(
      `UPDATE users SET account_status = 'retiring', updated_at = ${Date.now()} WHERE id = '${userId}'`
    );
    assert.equal(
      sql(`SELECT account_status FROM users WHERE id = '${userId}'`),
      'retiring'
    );
    await request('/api/preferences', { token: userToken, expected: 503 });
    await request('/api/auth/websocket-ticket', {
      token: userToken,
      method: 'POST',
      body: { audience: 'chat' },
      expected: 503,
    });
    await request(`/api/chat/sessions/${userSession.data.id}`, {
      token: adminToken,
      expected: 503,
    });
    await waitFor(
      'retired actor job rejection while Redis is unavailable',
      async () => {
        return (
          sql(
            `SELECT state FROM platform_jobs WHERE id = '${authGeneration.data.jobId}'`
          ) === 'dead_letter'
        );
      },
      90_000
    );
    assert.equal(
      sql(
        `SELECT error_code FROM platform_jobs WHERE id = '${authGeneration.data.jobId}'`
      ),
      'actor-revoked'
    );
    command(['start', 'redis']);
    await waitFor('Redis reconnection', async () => {
      const response = await fetch(`${baseUrl}/health/ready`);
      return response.status === 200;
    });
    // Once shared admission is available again, authoritative SQL must still
    // reject the retired actor and preserve cross-user resource isolation.
    await request('/api/preferences', { token: userToken, expected: 403 });
    await request('/api/auth/websocket-ticket', {
      token: userToken,
      method: 'POST',
      body: { audience: 'chat' },
      expected: 403,
    });
    await request(`/api/chat/sessions/${userSession.data.id}`, {
      token: adminToken,
      expected: 404,
    });

    // Keep Redis available for the authorized deletion transaction, but make
    // physical S3 cleanup fail so the owner job must durably retry.
    command(['stop', 'minio']);
    await request(`/api/users/${userId}`, {
      token: adminToken,
      method: 'DELETE',
    });
    const ownerJob = await waitFor(
      'owner cleanup job',
      async () => {
        const jobs = await request('/api/jobs?limit=100', {
          token: adminToken,
        });
        return (
          jobs.data.find(job => job.jobType === 'owner.delete-content.v1') ||
          false
        );
      },
      30_000
    );
    await waitFor(
      'owner cleanup retry while storage is unavailable',
      async () => {
        const current = await request(`/api/jobs/${ownerJob.id}`, {
          token: adminToken,
        });
        return current.data.attempts.some(
          attempt => attempt.outcome === 'retry_scheduled'
        );
      }
    );
    command(['start', 'minio']);
    await waitFor('MinIO live endpoint', async () => {
      const response = await fetch(
        `http://127.0.0.1:${minioPort}/minio/health/live`
      );
      return response.ok;
    });
    const ownerCompleted = await waitForJob(
      ownerJob.id,
      adminToken,
      ['succeeded'],
      120_000
    );
    assert.ok(
      ownerCompleted.attempts.length >= 2,
      'owner cleanup must retry after outage'
    );
    assert.equal(
      Number(sql(`SELECT count(*) FROM users WHERE id = '${userId}'`)),
      0
    );
    assert.equal(
      Number(sql(`SELECT count(*) FROM documents WHERE user_id = '${userId}'`)),
      0
    );
    assert.equal(
      Number(
        sql(
          `SELECT count(*) FROM platform_vector_entries WHERE owner_user_id = '${userId}'`
        )
      ),
      0
    );
    assert.equal(
      Number(
        sql(
          `SELECT count(*) FROM platform_blob_references WHERE owner_user_id = '${userId}'`
        )
      ),
      0
    );
    assert.equal(
      Number(
        sql(
          `SELECT count(*) FROM platform_blob_objects WHERE owner_user_id = '${userId}'`
        )
      ),
      0
    );
    assert.equal(
      Number(
        sql(
          `SELECT count(*) FROM platform_jobs WHERE actor_user_id = '${userId}' AND state IN ('queued','running')`
        )
      ),
      0,
      'owner cleanup must leave no active queued work'
    );
    assert.equal(
      Number(
        command([
          'exec',
          '-T',
          'redis',
          'redis-cli',
          'EXISTS',
          `libre-team:cache:${userCacheDigest}`,
        ])
      ),
      0,
      'owner cleanup must invalidate shared cache state'
    );
  }
);
