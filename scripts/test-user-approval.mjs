import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-user-approval-'));
const databasePath = path.join(dataDir, 'data.sqlite');
const legacyDb = new Database(databasePath);
legacyDb.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    avatar TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO users (
    id, username, email, password_hash, role, avatar, created_at, updated_at
  ) VALUES (
    'default', 'admin', NULL, 'default', 'admin', NULL, 1, 1
  );
`);
legacyDb.close();

process.env.DATA_DIR = dataDir;
process.env.ENABLE_SIGNUP = 'true';
process.env.JWT_SECRET = 'user-approval-test-secret-that-is-long-enough';

const importBuilt = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);
const [{ authService, JWT_SECRET }, { userModel }, { authenticate }, database] =
  await Promise.all([
    importBuilt('services/authService.js'),
    importBuilt('models/userModel.js'),
    importBuilt('middleware/auth.js'),
    importBuilt('db.js'),
  ]);

test('public registrations require administrator approval before authentication', async () => {
  try {
    const migratedDefault = userModel.getUserById('default');
    assert.equal(migratedDefault?.status, 'active');

    const credentials = [
      {
        username: 'owner',
        password: 'owner-password',
        email: 'owner@example.test',
      },
      {
        username: 'waiting',
        password: 'waiting-password',
        email: 'waiting@example.test',
      },
    ];
    const registrations = await Promise.all(
      credentials.map(account =>
        authService.signup(account.username, account.password, account.email)
      )
    );
    const bootstrap = registrations.find(
      result => result?.status === 'authenticated'
    );
    const registration = registrations.find(
      result => result?.status === 'pending'
    );
    assert.ok(bootstrap);
    assert.ok(registration);
    assert.equal(bootstrap?.status, 'authenticated');
    assert.equal(bootstrap?.user.role, 'admin');
    assert.equal(bootstrap?.user.status, 'active');
    assert.ok(bootstrap && 'token' in bootstrap);

    assert.equal(registration?.status, 'pending');
    assert.equal(registration?.user.role, 'user');
    assert.equal(registration?.user.status, 'pending');
    assert.ok(registration && !('token' in registration));

    const pendingCredentials = credentials.find(
      account => account.username === registration.user.username
    );
    assert.ok(pendingCredentials);
    const pendingLogin = await authService.login(
      pendingCredentials.username,
      pendingCredentials.password
    );
    assert.equal(pendingLogin?.status, 'pending');
    assert.throws(
      () => authService.generateToken(registration.user),
      /inactive account/
    );

    const forgedPendingToken = jwt.sign(
      {
        userId: registration.user.id,
        username: registration.user.username,
        role: registration.user.role,
      },
      JWT_SECRET,
      { expiresIn: '5m' }
    );
    let responseStatus = 200;
    let responseBody;
    let nextCalled = false;
    const response = {
      status(status) {
        responseStatus = status;
        return this;
      },
      json(body) {
        responseBody = body;
        return this;
      },
    };
    await authenticate(
      { headers: { authorization: `Bearer ${forgedPendingToken}` } },
      response,
      () => {
        nextCalled = true;
      }
    );
    assert.equal(nextCalled, false);
    assert.equal(responseStatus, 403);
    assert.equal(responseBody.code, 'ACCOUNT_PENDING');

    assert.deepEqual(userModel.getPendingApprovalSummary(), {
      count: 1,
      latestCreatedAt: registration.user.createdAt,
    });
    const approved = userModel.approveUser(
      registration.user.id,
      bootstrap.user.id
    );
    assert.equal(approved?.status, 'active');
    assert.equal(approved?.approvedBy, bootstrap.user.id);
    assert.equal(userModel.getPendingApprovalSummary().count, 0);

    const approvedLogin = await authService.login(
      pendingCredentials.username,
      pendingCredentials.password
    );
    assert.equal(approvedLogin?.status, 'authenticated');
    assert.ok(approvedLogin && 'token' in approvedLogin);
  } finally {
    database.closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
