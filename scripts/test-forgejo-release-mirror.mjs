import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertValidTag,
  fetchPaginated,
  mirrorForgejoRelease,
  redactSecrets,
  requestWithRetry,
} from './lib/forgejoReleaseMirror.mjs';

const githubBaseUrl = 'https://api.github.test';
const forgejoBaseUrl = 'https://forgejo.test/api/v1';
const githubRepository = 'source/repository';
const forgejoRepository = 'mirror/repository';
const githubToken = 'github-token-value';
const forgejoToken = 'forgejo-token-value';
const tag = 'v0.8.6';
const tagObjectSha = '5efec255de18b6611c7af4f94edb80dc29baf9e9';
const peeledCommitSha = 'd9346771a1ba3443a5037d7f62cfb7a6a6f1aad4';

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

function textResponse(body, status = 200, headers = {}) {
  return new Response(body, { status, headers });
}

function parseJsonBody(init) {
  assert.equal(typeof init.body, 'string');
  return JSON.parse(init.body);
}

function assertRequestUsesOnlyToken(init, expectedToken, excludedToken) {
  const authorization = new Headers(init.headers).get('authorization') || '';
  assert.match(authorization, new RegExp(expectedToken));
  assert.doesNotMatch(authorization, new RegExp(excludedToken));
}

function sourceRelease(overrides = {}) {
  return {
    id: 42,
    tag_name: tag,
    name: 'Release v0.8.6',
    body: 'Release notes',
    draft: false,
    prerelease: false,
    assets: [],
    ...overrides,
  };
}

function targetRelease(overrides = {}) {
  return {
    id: 99,
    tag_name: tag,
    name: 'Release v0.8.6',
    body: 'Release notes',
    draft: false,
    prerelease: false,
    assets: [],
    ...overrides,
  };
}

function createMirrorFetch({
  source = sourceRelease(),
  target = targetRelease(),
  targetMissing = false,
  sourceAssets = source.assets,
  targetAssets = target.assets,
  githubTagRef = {
    ref: `refs/tags/${tag}`,
    object: {
      type: 'tag',
      sha: tagObjectSha,
    },
  },
  githubAnnotatedTag = {
    tag,
    sha: tagObjectSha,
    object: {
      type: 'commit',
      sha: peeledCommitSha,
    },
  },
  forgejoTag = {
    name: tag,
    id: tagObjectSha,
    commit: {
      sha: peeledCommitSha,
    },
  },
  githubTagMissing = false,
  githubAnnotatedTagMissing = false,
  forgejoTagMissing = false,
  onRequest = () => undefined,
} = {}) {
  const calls = [];

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method || 'GET').toUpperCase();
    const call = { url, method, init };
    calls.push(call);
    onRequest(call);

    if (
      url.origin === new URL(githubBaseUrl).origin &&
      url.pathname ===
        `/repos/${githubRepository}/git/ref/tags/${encodeURIComponent(tag)}` &&
      method === 'GET'
    ) {
      assertRequestUsesOnlyToken(init, githubToken, forgejoToken);
      return githubTagMissing
        ? jsonResponse({ message: 'not found' }, 404)
        : jsonResponse(githubTagRef);
    }

    if (
      url.origin === new URL(githubBaseUrl).origin &&
      url.pathname ===
        `/repos/${githubRepository}/git/tags/${githubTagRef?.object?.sha}` &&
      method === 'GET'
    ) {
      assertRequestUsesOnlyToken(init, githubToken, forgejoToken);
      return githubAnnotatedTagMissing
        ? jsonResponse({ message: 'not found' }, 404)
        : jsonResponse(githubAnnotatedTag);
    }

    if (
      url.origin === new URL(forgejoBaseUrl).origin &&
      url.pathname ===
        `/api/v1/repos/${forgejoRepository}/tags/${encodeURIComponent(tag)}` &&
      method === 'GET'
    ) {
      assertRequestUsesOnlyToken(init, forgejoToken, githubToken);
      return forgejoTagMissing
        ? jsonResponse({ message: 'not found' }, 404)
        : jsonResponse(forgejoTag);
    }

    if (
      url.origin === new URL(githubBaseUrl).origin &&
      url.pathname ===
        `/repos/${githubRepository}/releases/tags/${encodeURIComponent(tag)}` &&
      method === 'GET'
    ) {
      assertRequestUsesOnlyToken(init, githubToken, forgejoToken);
      return jsonResponse(source);
    }

    if (
      url.origin === new URL(githubBaseUrl).origin &&
      url.pathname ===
        `/repos/${githubRepository}/releases/${source.id}/assets` &&
      method === 'GET'
    ) {
      assertRequestUsesOnlyToken(init, githubToken, forgejoToken);
      return jsonResponse(sourceAssets);
    }

    if (
      url.origin === new URL(forgejoBaseUrl).origin &&
      url.pathname ===
        `/api/v1/repos/${forgejoRepository}/releases/tags/${encodeURIComponent(tag)}` &&
      method === 'GET'
    ) {
      assertRequestUsesOnlyToken(init, forgejoToken, githubToken);
      return targetMissing
        ? jsonResponse({ message: 'not found' }, 404)
        : jsonResponse({ ...target, assets: targetAssets });
    }

    if (
      url.origin === new URL(forgejoBaseUrl).origin &&
      url.pathname ===
        `/api/v1/repos/${forgejoRepository}/releases/${target.id}/assets` &&
      method === 'GET'
    ) {
      assertRequestUsesOnlyToken(init, forgejoToken, githubToken);
      return jsonResponse(targetAssets);
    }

    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  return { calls, fetchImpl };
}

function mirrorOptions(fetchImpl, overrides = {}) {
  return {
    tag,
    githubToken,
    forgejoToken,
    githubBaseUrl,
    forgejoBaseUrl,
    githubRepository,
    forgejoRepository,
    fetchImpl,
    maxAttempts: 1,
    sleep: async () => undefined,
    ...overrides,
  };
}

test('release tags use strict canonical semantic-version syntax', () => {
  for (const validTag of ['v0.8.6', 'v1.2.3', 'v999.0.42']) {
    assert.equal(assertValidTag(validTag), validTag);
  }

  for (const invalidTag of [
    '',
    '0.8.6',
    'v1.2',
    'v1.2.3.4',
    'v01.2.3',
    'v1.02.3',
    'v1.2.03',
    'v1.2.3-rc.1',
    'v1.2.3+build',
    'v1.2.3/../../main',
    'v1.2.3^{}',
    'v1.2.3\nrefs/heads/main',
    ' v1.2.3',
    'v1.2.3 ',
  ]) {
    assert.throws(
      () => assertValidTag(invalidTag),
      /invalid|tag|semantic/i,
      invalidTag
    );
  }
});

test('mirror validation rejects an unsafe tag before making requests', async () => {
  let requestCount = 0;

  await assert.rejects(
    mirrorForgejoRelease(
      mirrorOptions(
        async () => {
          requestCount += 1;
          throw new Error('fetch must not run');
        },
        { tag: 'v0.8.6^{}' }
      )
    ),
    /invalid|tag|semantic/i
  );

  assert.equal(requestCount, 0);
});

test('exact annotated tag object and peeled commit parity permits mirroring', async () => {
  const { calls, fetchImpl } = createMirrorFetch();

  await mirrorForgejoRelease(mirrorOptions(fetchImpl));

  assert.ok(
    calls.some(
      call =>
        call.url.pathname === `/repos/${githubRepository}/git/ref/tags/${tag}`
    )
  );
  assert.ok(
    calls.some(
      call =>
        call.url.pathname ===
        `/repos/${githubRepository}/git/tags/${tagObjectSha}`
    )
  );
  assert.ok(
    calls.some(
      call =>
        call.url.pathname === `/api/v1/repos/${forgejoRepository}/tags/${tag}`
    )
  );
});

test('exact lightweight tag parity permits mirroring without an annotated-tag lookup', async () => {
  const lightweightCommitSha = '12a1ef93d3b4a19bac59d4810e08200f6a5b7ecb';
  const { calls, fetchImpl } = createMirrorFetch({
    githubTagRef: {
      ref: `refs/tags/${tag}`,
      object: {
        type: 'commit',
        sha: lightweightCommitSha,
      },
    },
    forgejoTag: {
      name: tag,
      id: lightweightCommitSha,
      commit: {
        sha: lightweightCommitSha,
      },
    },
  });

  await mirrorForgejoRelease(mirrorOptions(fetchImpl));

  assert.ok(
    calls.some(
      call =>
        call.url.pathname === `/repos/${githubRepository}/git/ref/tags/${tag}`
    )
  );
  assert.ok(
    calls.some(
      call =>
        call.url.pathname === `/api/v1/repos/${forgejoRepository}/tags/${tag}`
    )
  );
  assert.equal(
    calls.some(call =>
      call.url.pathname.startsWith(`/repos/${githubRepository}/git/tags/`)
    ),
    false,
    'a lightweight tag has no annotated tag object to peel'
  );
});

test('missing or malformed remote tag identity fails before release writes', async t => {
  const cases = [
    {
      name: 'missing GitHub tag ref',
      overrides: { githubTagMissing: true },
    },
    {
      name: 'missing GitHub annotated tag object',
      overrides: { githubAnnotatedTagMissing: true },
    },
    {
      name: 'missing Forgejo tag',
      overrides: { forgejoTagMissing: true },
    },
    {
      name: 'Forgejo tag without an object SHA',
      overrides: {
        forgejoTag: {
          name: tag,
          commit: { sha: peeledCommitSha },
        },
      },
    },
    {
      name: 'Forgejo tag without a peeled commit SHA',
      overrides: {
        forgejoTag: {
          name: tag,
          id: tagObjectSha,
          commit: {},
        },
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const { calls, fetchImpl } = createMirrorFetch(fixture.overrides);

      await assert.rejects(
        mirrorForgejoRelease(mirrorOptions(fetchImpl)),
        /annotated|commit|missing|not found|object|parity|tag/i
      );

      assert.equal(
        calls.some(call => !['GET', 'HEAD'].includes(call.method)),
        false,
        'tag validation must fail before any remote write'
      );
      assert.equal(
        calls.some(call => call.url.pathname.includes('/releases')),
        false,
        'release state must not be inspected until tag parity is proven'
      );
    });
  }
});

test('a lightweight tag mismatch fails before release writes', async t => {
  const lightweightCommitSha = '12a1ef93d3b4a19bac59d4810e08200f6a5b7ecb';
  const mismatchedSha = '505072012e9d154f9c3cdf3b2a943bb1fd25843b';
  const cases = [
    {
      name: 'Forgejo id differs from the GitHub commit',
      forgejoTag: {
        name: tag,
        id: mismatchedSha,
        commit: { sha: lightweightCommitSha },
      },
    },
    {
      name: 'Forgejo peeled commit differs from the GitHub commit',
      forgejoTag: {
        name: tag,
        id: lightweightCommitSha,
        commit: { sha: mismatchedSha },
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const { calls, fetchImpl } = createMirrorFetch({
        githubTagRef: {
          ref: `refs/tags/${tag}`,
          object: {
            type: 'commit',
            sha: lightweightCommitSha,
          },
        },
        forgejoTag: fixture.forgejoTag,
      });

      await assert.rejects(
        mirrorForgejoRelease(mirrorOptions(fetchImpl)),
        /differ|mismatch|parity|sha|tag/i
      );

      assert.equal(
        calls.some(call => !['GET', 'HEAD'].includes(call.method)),
        false,
        'a lightweight parity mismatch must never trigger a release write'
      );
      assert.equal(
        calls.some(call => call.url.pathname.includes('/releases')),
        false,
        'release state must not be inspected after a lightweight mismatch'
      );
    });
  }
});

test('different tag object or peeled commit SHAs fail before release writes', async t => {
  const cases = [
    {
      name: 'annotated tag object mismatch',
      forgejoTag: {
        name: tag,
        id: '723b0b599f1972c9ab3a8bdab9db20558c3c6f2b',
        commit: { sha: peeledCommitSha },
      },
    },
    {
      name: 'peeled commit mismatch',
      forgejoTag: {
        name: tag,
        id: tagObjectSha,
        commit: {
          sha: '92d95a35b3e543c4f2939935d121515b053ddfdd',
        },
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const { calls, fetchImpl } = createMirrorFetch({
        forgejoTag: fixture.forgejoTag,
      });

      await assert.rejects(
        mirrorForgejoRelease(mirrorOptions(fetchImpl)),
        /differ|mismatch|parity|sha|tag/i
      );

      assert.equal(
        calls.some(call => !['GET', 'HEAD'].includes(call.method)),
        false,
        'a parity mismatch must never trigger a release write'
      );
      assert.equal(
        calls.some(call => call.url.pathname.includes('/releases')),
        false,
        'release state must not be inspected after a parity mismatch'
      );
    });
  }
});

test('fetchPaginated follows next links and preserves source authentication', async () => {
  const requests = [];
  const firstUrl = `${githubBaseUrl}/repos/${githubRepository}/releases/42/assets?per_page=2`;
  const secondUrl = `${firstUrl}&page=2`;

  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    assertRequestUsesOnlyToken(init, githubToken, forgejoToken);

    if (url === firstUrl) {
      return jsonResponse([{ id: 1 }, { id: 2 }], 200, {
        link: `<${secondUrl}>; rel="next"`,
      });
    }

    if (url === secondUrl) {
      return jsonResponse([{ id: 3 }]);
    }

    throw new Error(`Unexpected pagination URL: ${url}`);
  };

  const items = await fetchPaginated(firstUrl, {
    token: githubToken,
    fetchImpl,
    maxAttempts: 1,
    sleep: async () => undefined,
    secrets: [githubToken, forgejoToken],
  });

  assert.deepEqual(
    items.map(item => item.id),
    [1, 2, 3]
  );
  assert.deepEqual(
    requests.map(request => request.url),
    [firstUrl, secondUrl]
  );
});

test('a missing Forgejo release is created without target_commitish', async () => {
  const source = sourceRelease();
  const calls = [];
  const { fetchImpl: readFetch } = createMirrorFetch({
    source,
    targetMissing: true,
  });

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ url, method, init });

    if (
      url.origin === new URL(forgejoBaseUrl).origin &&
      url.pathname === `/api/v1/repos/${forgejoRepository}/releases` &&
      method === 'POST'
    ) {
      assertRequestUsesOnlyToken(init, forgejoToken, githubToken);
      const body = parseJsonBody(init);
      assert.deepEqual(body, {
        tag_name: tag,
        name: source.name,
        body: source.body,
        draft: source.draft,
        prerelease: source.prerelease,
      });
      assert.equal('target_commitish' in body, false);
      return jsonResponse(targetRelease(), 201);
    }

    return readFetch(input, init);
  };

  const summary = await mirrorForgejoRelease(mirrorOptions(fetchImpl));

  assert.equal(
    calls.filter(call => call.method === 'POST').length,
    1,
    'the missing release should be created exactly once'
  );
  assert.equal(summary.release, 'created');
  assert.equal(
    calls.some(call => ['PUT', 'DELETE'].includes(call.method)),
    false,
    'release mirroring must not mutate a git tag'
  );
});

test('an existing Forgejo release is updated when metadata differs', async () => {
  const source = sourceRelease({
    name: 'Correct release title',
    body: 'Correct release notes',
    prerelease: true,
  });
  const target = targetRelease({
    name: 'Old title',
    body: 'Old notes',
    prerelease: false,
  });
  const writes = [];
  const { fetchImpl: readFetch } = createMirrorFetch({ source, target });

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method || 'GET').toUpperCase();

    if (
      url.pathname ===
        `/api/v1/repos/${forgejoRepository}/releases/${target.id}` &&
      method === 'PATCH'
    ) {
      writes.push({ url, method, init });
      assertRequestUsesOnlyToken(init, forgejoToken, githubToken);
      assert.deepEqual(parseJsonBody(init), {
        tag_name: tag,
        name: source.name,
        body: source.body,
        draft: source.draft,
        prerelease: source.prerelease,
      });
      return jsonResponse({ ...target, ...source, id: target.id });
    }

    return readFetch(input, init);
  };

  const summary = await mirrorForgejoRelease(mirrorOptions(fetchImpl));

  assert.equal(writes.length, 1);
  assert.equal(summary.release, 'updated');
});

test('matching release metadata and assets are skipped idempotently', async () => {
  const asset = {
    id: 501,
    name: 'Libre-WebUI-Desktop-0.8.6.AppImage',
    browser_download_url:
      'https://github.test/downloads/Libre-WebUI-Desktop-0.8.6.AppImage',
    type: 'external',
  };
  const source = sourceRelease({ assets: [asset] });
  const target = targetRelease({ assets: [asset] });
  const { calls, fetchImpl } = createMirrorFetch({
    source,
    target,
    sourceAssets: [asset],
    targetAssets: [asset],
  });

  const summary = await mirrorForgejoRelease(mirrorOptions(fetchImpl));

  assert.equal(
    calls.some(call => !['GET', 'HEAD'].includes(call.method)),
    false
  );
  assert.equal(summary.release, 'unchanged');
  assert.equal(summary.assets.unchanged, 1);
});

test('a missing asset is created as an external attachment by name', async () => {
  const asset = {
    id: 701,
    name: 'Libre WebUI 0.8.6 mac-arm64.zip',
    browser_download_url:
      'https://github.test/downloads/Libre%20WebUI%200.8.6%20mac-arm64.zip',
  };
  const source = sourceRelease({ assets: [asset] });
  const target = targetRelease();
  const writes = [];
  const { fetchImpl: readFetch } = createMirrorFetch({
    source,
    target,
    sourceAssets: [asset],
    targetAssets: [],
  });

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method || 'GET').toUpperCase();

    if (
      url.pathname ===
        `/api/v1/repos/${forgejoRepository}/releases/${target.id}/assets` &&
      method === 'POST'
    ) {
      writes.push({ url, method, init });
      assertRequestUsesOnlyToken(init, forgejoToken, githubToken);
      assert.equal(url.searchParams.get('name'), asset.name);
      assert.ok(init.body instanceof FormData);
      assert.equal(init.body.get('external_url'), asset.browser_download_url);
      return jsonResponse({ ...asset, id: 801, type: 'external' }, 201);
    }

    return readFetch(input, init);
  };

  const summary = await mirrorForgejoRelease(mirrorOptions(fetchImpl));

  assert.equal(writes.length, 1);
  assert.equal(summary.assets.created, 1);
});

test('an existing external asset is updated by matching its name', async () => {
  const sourceAsset = {
    id: 701,
    name: 'Libre-WebUI-Desktop-0.8.6.exe',
    browser_download_url:
      'https://github.test/current/Libre-WebUI-Desktop-0.8.6.exe',
  };
  const targetAsset = {
    id: 802,
    name: sourceAsset.name,
    browser_download_url:
      'https://github.test/stale/Libre-WebUI-Desktop-0.8.6.exe',
    type: 'external',
  };
  const source = sourceRelease({ assets: [sourceAsset] });
  const target = targetRelease({ assets: [targetAsset] });
  const writes = [];
  const { fetchImpl: readFetch } = createMirrorFetch({
    source,
    target,
    sourceAssets: [sourceAsset],
    targetAssets: [targetAsset],
  });

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method || 'GET').toUpperCase();

    if (
      url.pathname ===
        `/api/v1/repos/${forgejoRepository}/releases/${target.id}/assets/${targetAsset.id}` &&
      method === 'PATCH'
    ) {
      writes.push({ url, method, init });
      assertRequestUsesOnlyToken(init, forgejoToken, githubToken);
      assert.deepEqual(parseJsonBody(init), {
        name: sourceAsset.name,
        browser_download_url: sourceAsset.browser_download_url,
      });
      return jsonResponse(
        { ...targetAsset, ...sourceAsset, id: targetAsset.id },
        201
      );
    }

    return readFetch(input, init);
  };

  const summary = await mirrorForgejoRelease(mirrorOptions(fetchImpl));

  assert.equal(writes.length, 1);
  assert.equal(summary.assets.updated, 1);
});

test('requestWithRetry retries rate limits and transient server failures', async () => {
  const responses = [
    textResponse('rate limited', 429, { 'retry-after': '0' }),
    textResponse('temporarily unavailable', 503),
    jsonResponse({ ok: true }),
  ];
  const delays = [];
  let attempts = 0;

  const response = await requestWithRetry('https://api.test/transient', {
    fetchImpl: async () => {
      const next = responses[attempts];
      attempts += 1;
      return next;
    },
    maxAttempts: 3,
    sleep: async delay => {
      delays.push(delay);
    },
    secrets: [githubToken, forgejoToken],
  });

  assert.equal(attempts, 3);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(delays.length, 2);
  assert.ok(delays.every(delay => Number.isFinite(delay) && delay >= 0));
});

test('requestWithRetry never retries an ambiguous POST create', async () => {
  let attempts = 0;
  const delays = [];

  await assert.rejects(
    requestWithRetry('https://api.test/releases', {
      fetchImpl: async () => {
        attempts += 1;
        return textResponse('temporarily unavailable', 503);
      },
      init: {
        method: 'POST',
      },
      maxAttempts: 3,
      sleep: async delay => {
        delays.push(delay);
      },
    }),
    /503/
  );

  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
});

test('dry-run inspects state but performs no release or asset writes', async () => {
  const asset = {
    id: 701,
    name: 'Libre-WebUI-Desktop-0.8.6-amd64.deb',
    browser_download_url:
      'https://github.test/current/Libre-WebUI-Desktop-0.8.6-amd64.deb',
  };
  const source = sourceRelease({
    name: 'Updated title',
    body: 'Updated notes',
    assets: [asset],
  });
  const target = targetRelease({
    name: 'Stale title',
    body: 'Stale notes',
  });
  const { calls, fetchImpl } = createMirrorFetch({
    source,
    target,
    sourceAssets: [asset],
    targetAssets: [],
  });

  const summary = await mirrorForgejoRelease(
    mirrorOptions(fetchImpl, {
      dryRun: true,
    })
  );

  assert.ok(calls.length >= 2, 'dry-run should still inspect both services');
  assert.equal(
    calls.some(call => !['GET', 'HEAD'].includes(call.method)),
    false
  );
  assert.equal(summary.release, 'would-update');
  assert.equal(summary.assets.wouldCreate, 1);
});

test('redactSecrets removes every credential without exposing partial values', () => {
  const input =
    `GitHub Bearer ${githubToken}; Forgejo token ${forgejoToken}; ` +
    `again ${githubToken}`;
  const redacted = redactSecrets(input, [githubToken, forgejoToken]);

  assert.doesNotMatch(redacted, new RegExp(githubToken));
  assert.doesNotMatch(redacted, new RegExp(forgejoToken));
  assert.match(redacted, /\[REDACTED\]|\*\*\*/);
});

test('request failures redact tokens from response and request diagnostics', async () => {
  const failingUrl = `https://api.test/releases?access_token=${githubToken}`;

  let caught;
  try {
    await requestWithRetry(failingUrl, {
      fetchImpl: async (_input, init = {}) => {
        assert.match(
          new Headers(init.headers).get('authorization') || '',
          new RegExp(forgejoToken)
        );
        return textResponse(
          `authorization failed for ${githubToken} and ${forgejoToken}`,
          401
        );
      },
      init: {
        headers: {
          authorization: `token ${forgejoToken}`,
        },
      },
      maxAttempts: 1,
      sleep: async () => undefined,
      secrets: [githubToken, forgejoToken],
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof Error);
  assert.match(caught.message, /401|unauthorized|authorization/i);
  assert.doesNotMatch(caught.message, new RegExp(githubToken));
  assert.doesNotMatch(caught.message, new RegExp(forgejoToken));
});
