import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const modulePath = pathToFileURL(
  path.resolve('backend/dist/services/workHostWorkspaceService.js')
).href;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-work-host-'));
const project = path.join(root, 'project');
const nested = path.join(project, 'src');
const secrets = path.join(root, '.ssh');
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-work-outside-'));
fs.mkdirSync(nested, { recursive: true });
fs.mkdirSync(secrets, { recursive: true });

process.env.WORK_HOST_WORKSPACES_ENABLED = 'true';
process.env.WORK_HOST_WORKSPACE_ROOTS = root;

const { default: service, WorkHostWorkspaceError } = await import(modulePath);

const realRoot = fs.realpathSync(root);

test('resolves a folder inside an allowed root', () => {
  assert.equal(
    service.resolveWorkspacePath(project),
    path.join(realRoot, 'project')
  );
  assert.equal(
    service.resolveWorkspacePath(nested),
    path.join(realRoot, 'project', 'src')
  );
});

test('rejects a folder outside every allowed root', () => {
  assert.throws(
    () => service.resolveWorkspacePath(outside),
    WorkHostWorkspaceError
  );
});

test('rejects credential folders even inside an allowed root', () => {
  assert.throws(
    () => service.resolveWorkspacePath(secrets),
    WorkHostWorkspaceError
  );
});

test('rejects a symlink that escapes an allowed root', () => {
  const escape = path.join(root, 'escape');
  fs.symlinkSync(outside, escape, 'dir');
  assert.throws(
    () => service.resolveWorkspacePath(escape),
    WorkHostWorkspaceError
  );
});

test('rejects relative paths, missing folders, and files', () => {
  const file = path.join(project, 'note.txt');
  fs.writeFileSync(file, 'x');
  assert.throws(
    () => service.resolveWorkspacePath('project'),
    WorkHostWorkspaceError
  );
  assert.throws(
    () => service.resolveWorkspacePath(path.join(root, 'nope')),
    WorkHostWorkspaceError
  );
  assert.throws(
    () => service.resolveWorkspacePath(file),
    WorkHostWorkspaceError
  );
  assert.throws(() => service.resolveWorkspacePath(''), WorkHostWorkspaceError);
});

test('reports the feature as disabled when the flag is off', async () => {
  process.env.WORK_HOST_WORKSPACES_ENABLED = 'false';
  assert.equal(service.isEnabled(), false);
  assert.deepEqual(service.listRoots(), []);
  assert.throws(
    () => service.resolveWorkspacePath(project),
    WorkHostWorkspaceError
  );
  process.env.WORK_HOST_WORKSPACES_ENABLED = 'true';
});

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
