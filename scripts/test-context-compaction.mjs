import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-compaction-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'compaction-test-secret';
process.env.ENCRYPTION_KEY ||= '1'.repeat(64);

const distModule = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );

const { encryptionService } = await distModule('services/encryptionService.js');
const persistenceModule = await distModule('persistence/index.js');
const applicationPersistence = await persistenceModule.initializePersistence({
  dialect: 'sqlite',
  emailCodec: encryptionService,
  env: process.env,
});
const platformStorageModule = await distModule(
  'platform/storage/platformStorageRuntime.js'
);
await platformStorageModule.initializePlatformStorageRuntime({
  persistence: applicationPersistence,
  cipher: encryptionService,
  env: process.env,
});
const coordinationModule = await distModule('platform/coordination/service.js');
await coordinationModule.initializeCoordinator();

const [
  { getDatabase },
  { authService },
  compaction,
  { default: chatRouter },
  { default: chatService },
  { default: chatGenerationService },
] = await Promise.all([
  distModule('db.js'),
  distModule('services/authService.js'),
  distModule('services/contextCompactionService.js'),
  distModule('routes/chat.js'),
  distModule('services/chatService.js'),
  distModule('services/chatGenerationService.js'),
]);

const now = Date.now();
const insertUser = getDatabase().prepare(
  `INSERT INTO users (
    id, username, email, password_hash, role, avatar, created_at, updated_at
  ) VALUES (?, ?, NULL, 'unused', ?, NULL, ?, ?)`
);
insertUser.run('compaction-user', 'compaction-user', 'user', now, now);
insertUser.run('compaction-admin', 'compaction-admin', 'admin', now, now);

const tokenFor = (id, role) =>
  authService.generateToken({
    id,
    username: id,
    email: null,
    role,
    status: 'active',
    avatar: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
const userToken = tokenFor('compaction-user', 'user');
const adminToken = tokenFor('compaction-admin', 'admin');

const app = express();
app.use(express.json());
app.use('/api/chat', chatRouter);
const server = createServer(app);
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const baseUrl = `http://127.0.0.1:${server.address().port}/api/chat`;

const originalPrepareGenerationTarget =
  chatGenerationService.prepareGenerationTarget;
const originalExecuteNonStreaming = chatGenerationService.executeNonStreaming;

after(async () => {
  chatGenerationService.prepareGenerationTarget =
    originalPrepareGenerationTarget;
  chatGenerationService.executeNonStreaming = originalExecuteNonStreaming;
  await new Promise(resolve => server.close(resolve));
  await coordinationModule.closeCoordinator();
  await platformStorageModule.closePlatformStorageRuntime();
  await persistenceModule.closePersistence();
  await rm(dataDir, { recursive: true, force: true });
});

let summarizerCalls = 0;
let lastSummarizerPrompt = '';
let summaryText = 'The user is building a forest scene and prefers Three.js.';
chatGenerationService.prepareGenerationTarget = async modelName => ({
  actualModelName: modelName,
  mergedOptions: {},
  activePlugin: null,
  providerType: 'ollama',
});
chatGenerationService.executeNonStreaming = async ({ ollamaMessages }) => {
  summarizerCalls += 1;
  lastSummarizerPrompt = ollamaMessages[0].content;
  assert.match(ollamaMessages[0].content, /Conversation:/);
  return {
    response: {},
    assistantContent: summaryText,
    source: 'ollama',
  };
};

const userId = 'compaction-user';
const filler = 'x'.repeat(2000);
const addTurns = async (sessionId, label, count) => {
  for (let i = 0; i < count; i += 1) {
    await chatService.addMessage(
      sessionId,
      { role: 'user', content: `${label} question ${i}: ${filler}` },
      userId
    );
    await chatService.addMessage(
      sessionId,
      { role: 'assistant', content: `${label} answer ${i}: ${filler}` },
      userId
    );
  }
};

test('config defaults are off and PUT values are clamped to bounds', async () => {
  const defaults = await compaction.getCompactionConfig();
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.thresholdTokens, 8000);
  assert.equal(defaults.keepRecentMessages, 8);

  const clamped = await compaction.setCompactionConfig({
    thresholdTokens: 5,
    keepRecentMessages: 100000,
  });
  assert.equal(clamped.thresholdTokens, 500, 'threshold clamped up');
  assert.equal(clamped.keepRecentMessages, 200, 'keep clamped down');
  await compaction.setCompactionConfig({
    thresholdTokens: 8000,
    keepRecentMessages: 8,
  });
});

test('token estimator scales with content and thinking length', () => {
  assert.equal(compaction.estimateChatTokens([]), 0);
  const estimate = compaction.estimateChatTokens([
    { content: 'a'.repeat(400) },
    { content: 'b'.repeat(400), thinking: 'c'.repeat(400) },
  ]);
  assert.equal(estimate, 4 + 100 + (4 + 100 + 100));
});

test('token estimator prices CJK text and images realistically', () => {
  // CJK characters cost roughly a token each, not a quarter of one.
  assert.equal(
    compaction.estimateChatTokens([{ content: '日本語のテスト' }]),
    4 + 7
  );
  // Mixed text: CJK per character, the rest per four characters.
  assert.equal(
    compaction.estimateChatTokens([{ content: `你好${'a'.repeat(8)}` }]),
    4 + 2 + 2
  );
  // Images carry a flat cost instead of counting as zero.
  const withImage = compaction.estimateChatTokens([
    { content: 'look', images: ['data:image/png;base64,xyz'] },
  ]);
  const withoutImage = compaction.estimateChatTokens([{ content: 'look' }]);
  assert.equal(withImage - withoutImage, 768);
});

test('disabled compaction never summarizes an oversized session', async () => {
  const session = await chatService.createSession(
    'No compaction',
    'test-model',
    userId
  );
  await addTurns(session.id, 'quiet', 12);
  const context = await chatService.getMessagesForContext(
    session.id,
    userId,
    100
  );
  assert.equal(summarizerCalls, 0);
  assert.ok(
    !context.some(message =>
      message.content.startsWith(compaction.COMPACTION_SUMMARY_PREFIX)
    )
  );
});

test('oversized history compacts into one summary on a user-turn boundary', async () => {
  const session = await chatService.createSession(
    'Compacted',
    'test-model',
    userId
  );
  await addTurns(session.id, 'first', 12);
  await compaction.setCompactionConfig({
    enabled: true,
    thresholdTokens: 500,
    keepRecentMessages: 4,
  });

  const context = await chatService.getMessagesForContext(
    session.id,
    userId,
    100
  );
  assert.equal(summarizerCalls, 1, 'summarizer ran once');
  const summary = context.find(
    message =>
      message.role === 'system' &&
      message.content.startsWith(compaction.COMPACTION_SUMMARY_PREFIX)
  );
  assert.ok(summary, 'summary message is in the model context');
  assert.match(summary.content, /forest scene/);

  const stored = await chatService.getSession(session.id, userId);
  const deactivated = stored.messages.filter(
    message => message.isActive === false
  );
  assert.ok(deactivated.length >= 18, `older messages deactivated`);
  const survivors = stored.messages.filter(
    message => message.isActive !== false && message.role !== 'system'
  );
  assert.ok(survivors.length >= 4 && survivors.length <= 6);
  assert.equal(survivors[0].role, 'user', 'survivors start on a user turn');

  // Under threshold now: a second read must not re-summarize.
  await chatService.getMessagesForContext(session.id, userId, 100);
  assert.equal(summarizerCalls, 1, 'no re-compaction while under threshold');

  // Growing past the threshold again folds the old summary into a new one.
  summaryText = 'Folded: forest scene progress plus new lighting decisions.';
  await addTurns(session.id, 'second', 10);
  const foldedContext = await chatService.getMessagesForContext(
    session.id,
    userId,
    100
  );
  assert.equal(summarizerCalls, 2, 'summarizer ran again');
  const contextSummaries = foldedContext.filter(
    message =>
      message.role === 'system' &&
      message.content.startsWith(compaction.COMPACTION_SUMMARY_PREFIX)
  );
  assert.equal(
    contextSummaries.length,
    1,
    'replaced summaries stay out of model context'
  );
  assert.match(contextSummaries[0].content, /Folded/);
  const after = await chatService.getSession(session.id, userId);
  const liveSummaries = after.messages.filter(
    message =>
      message.isActive !== false &&
      message.role === 'system' &&
      message.content.startsWith(compaction.COMPACTION_SUMMARY_PREFIX)
  );
  assert.equal(liveSummaries.length, 1, 'exactly one live summary');
  assert.match(liveSummaries[0].content, /Folded/);
});

test('replacement patterns in chat content reach the summarizer verbatim', async () => {
  const session = await chatService.createSession(
    'Dollar signs',
    'test-model',
    userId
  );
  const marker = "code costs $& and $' plus $1 dollars";
  await chatService.addMessage(
    session.id,
    { role: 'user', content: `${marker} ${filler}` },
    userId
  );
  await addTurns(session.id, 'dollar', 8);
  await compaction.setCompactionConfig({
    enabled: true,
    thresholdTokens: 500,
    keepRecentMessages: 4,
  });
  await chatService.getMessagesForContext(session.id, userId, 100);
  assert.ok(
    lastSummarizerPrompt.includes(marker),
    'string replacement patterns are not interpreted'
  );
});

test('a failing summarizer fails open and context is still served', async () => {
  chatGenerationService.executeNonStreaming = async () => {
    throw new Error('provider down');
  };
  const session = await chatService.createSession(
    'Fail open',
    'test-model',
    userId
  );
  await addTurns(session.id, 'broken', 12);
  const context = await chatService.getMessagesForContext(
    session.id,
    userId,
    100
  );
  assert.ok(context.length > 0, 'context served despite summarizer failure');
  assert.ok(
    !context.some(message =>
      message.content.startsWith(compaction.COMPACTION_SUMMARY_PREFIX)
    )
  );
  await compaction.setCompactionConfig({ enabled: false });
});

test('compaction config routes: admin-only in both directions', async () => {
  // The custom summarizer prompt is administrator configuration; regular
  // users have no reason to read it.
  const forbiddenRead = await fetch(`${baseUrl}/compaction-config`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  assert.equal(forbiddenRead.status, 403);

  const read = await fetch(`${baseUrl}/compaction-config`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(read.status, 200);
  const readBody = await read.json();
  assert.equal(readBody.success, true);
  assert.equal(typeof readBody.data.enabled, 'boolean');

  const forbidden = await fetch(`${baseUrl}/compaction-config`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${userToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(forbidden.status, 403);

  const updated = await fetch(`${baseUrl}/compaction-config`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ thresholdTokens: 9000, model: 'llama3.2:3b' }),
  });
  assert.equal(updated.status, 200);
  const updatedBody = await updated.json();
  assert.equal(updatedBody.data.thresholdTokens, 9000);
  assert.equal(updatedBody.data.model, 'llama3.2:3b');

  const config = await compaction.getCompactionConfig();
  assert.equal(config.thresholdTokens, 9000);
  assert.equal(config.enabled, false, 'partial update leaves enabled alone');
});
