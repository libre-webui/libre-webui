const TAG_PATTERN = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export function assertValidTag(tag) {
  if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) {
    throw new Error(
      `Invalid release tag ${JSON.stringify(tag)}; expected canonical semantic version vX.Y.Z`
    );
  }

  return tag;
}

export function redactSecrets(value, secrets = []) {
  let redacted = String(value);

  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      redacted = redacted.split(secret).join('[REDACTED]');
    }
  }

  return redacted;
}

function parseRetryAfter(value) {
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }

  return null;
}

function defaultSleep(delay) {
  return new Promise(resolve => setTimeout(resolve, delay));
}

export async function requestWithRetry(
  url,
  {
    init = {},
    fetchImpl = globalThis.fetch,
    maxAttempts = 4,
    sleep = defaultSleep,
    secrets = [],
    allowedStatuses = [],
  } = {}
) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required');
  }

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer');
  }

  const allowed = new Set(allowedStatuses);
  const method = String(init.method || 'GET').toUpperCase();
  const mayRetry = method !== 'POST';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;

    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (mayRetry && attempt < maxAttempts) {
        await sleep(Math.min(4000, 250 * 2 ** (attempt - 1)));
        continue;
      }

      throw new Error(
        redactSecrets(
          `Request failed for ${url}: ${error instanceof Error ? error.message : error}`,
          secrets
        )
      );
    }

    if (response.ok || allowed.has(response.status)) {
      return response;
    }

    if (
      mayRetry &&
      RETRYABLE_STATUS.has(response.status) &&
      attempt < maxAttempts
    ) {
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      await sleep(retryAfter ?? Math.min(4000, 250 * 2 ** (attempt - 1)));
      continue;
    }

    const responseText = await response.text().catch(() => '');
    const details = responseText.trim().slice(0, 1000);
    throw new Error(
      redactSecrets(
        `Request failed with status ${response.status} for ${url}${
          details ? `: ${details}` : ''
        }`,
        secrets
      )
    );
  }

  throw new Error('Request retry loop ended unexpectedly');
}

function parseNextLink(linkHeader) {
  if (!linkHeader) {
    return null;
  }

  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) {
      return match[1];
    }
  }

  return null;
}

function authHeaders(token, scheme, headers = {}) {
  const result = new Headers(headers);
  result.set('accept', 'application/json');
  result.set('user-agent', 'libre-webui-release-mirror');

  if (token) {
    result.set('authorization', `${scheme} ${token}`);
  }

  return result;
}

export async function fetchPaginated(
  initialUrl,
  {
    token,
    authScheme = 'Bearer',
    fetchImpl = globalThis.fetch,
    maxAttempts = 4,
    sleep = defaultSleep,
    secrets = [],
  } = {}
) {
  const initialOrigin = new URL(initialUrl).origin;
  const results = [];
  let nextUrl = initialUrl;
  let pageCount = 0;

  while (nextUrl) {
    const currentUrl = new URL(nextUrl);
    if (currentUrl.origin !== initialOrigin) {
      throw new Error(
        `Refusing to forward credentials to pagination origin ${currentUrl.origin}`
      );
    }

    pageCount += 1;
    if (pageCount > 100) {
      throw new Error('Pagination exceeded the 100-page safety limit');
    }

    const response = await requestWithRetry(currentUrl, {
      init: {
        headers: authHeaders(token, authScheme),
      },
      fetchImpl,
      maxAttempts,
      sleep,
      secrets,
    });
    const page = await response.json();

    if (!Array.isArray(page)) {
      throw new Error(`Expected an array response from ${currentUrl}`);
    }

    results.push(...page);
    nextUrl = parseNextLink(response.headers.get('link'));
  }

  return results;
}

function assertRepository(repository, label) {
  if (
    typeof repository !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
  ) {
    throw new Error(`Invalid ${label} repository identifier`);
  }
}

function assertSha(value, label) {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    throw new Error(`Missing or invalid ${label} SHA`);
  }

  return value;
}

async function requestJson(
  url,
  {
    token,
    authScheme,
    method = 'GET',
    body,
    fetchImpl,
    maxAttempts,
    sleep,
    secrets,
    allowedStatuses = [],
  }
) {
  const headers = authHeaders(token, authScheme);
  let requestBody = body;

  if (body !== undefined && !(body instanceof FormData)) {
    headers.set('content-type', 'application/json');
    requestBody = JSON.stringify(body);
  }

  const response = await requestWithRetry(url, {
    init: {
      method,
      headers,
      ...(requestBody === undefined ? {} : { body: requestBody }),
    },
    fetchImpl,
    maxAttempts,
    sleep,
    secrets,
    allowedStatuses,
  });

  if (response.status === 204) {
    return { response, data: null };
  }

  const data = await response.json().catch(() => null);
  return { response, data };
}

async function getGitHubTagIdentity(options) {
  const {
    tag,
    githubBaseUrl,
    githubRepository,
    githubToken,
    fetchImpl,
    maxAttempts,
    sleep,
    secrets,
  } = options;
  const encodedTag = encodeURIComponent(tag);
  const refResult = await requestJson(
    `${githubBaseUrl}/repos/${githubRepository}/git/ref/tags/${encodedTag}`,
    {
      token: githubToken,
      authScheme: 'Bearer',
      fetchImpl,
      maxAttempts,
      sleep,
      secrets,
      allowedStatuses: [404],
    }
  );

  if (refResult.response.status === 404) {
    throw new Error(`GitHub tag ${tag} was not found`);
  }

  const objectType = refResult.data?.object?.type;
  const objectSha = assertSha(
    refResult.data?.object?.sha,
    `GitHub ${tag} tag object`
  );

  if (objectType === 'commit') {
    return {
      kind: 'lightweight',
      objectSha,
      peeledCommitSha: objectSha,
    };
  }

  if (objectType !== 'tag') {
    throw new Error(`GitHub tag ${tag} has unsupported object type`);
  }

  const tagResult = await requestJson(
    `${githubBaseUrl}/repos/${githubRepository}/git/tags/${objectSha}`,
    {
      token: githubToken,
      authScheme: 'Bearer',
      fetchImpl,
      maxAttempts,
      sleep,
      secrets,
      allowedStatuses: [404],
    }
  );

  if (tagResult.response.status === 404) {
    throw new Error(`GitHub annotated tag object ${objectSha} was not found`);
  }

  if (tagResult.data?.object?.type !== 'commit') {
    throw new Error(`GitHub annotated tag ${tag} does not peel to a commit`);
  }

  return {
    kind: 'annotated',
    objectSha,
    peeledCommitSha: assertSha(
      tagResult.data?.object?.sha,
      `GitHub ${tag} peeled commit`
    ),
  };
}

async function assertRemoteTagParity(options) {
  const {
    tag,
    forgejoBaseUrl,
    forgejoRepository,
    forgejoToken,
    fetchImpl,
    maxAttempts,
    sleep,
    secrets,
  } = options;
  const githubIdentity = await getGitHubTagIdentity(options);
  const forgejoResult = await requestJson(
    `${forgejoBaseUrl}/repos/${forgejoRepository}/tags/${encodeURIComponent(tag)}`,
    {
      token: forgejoToken,
      authScheme: 'token',
      fetchImpl,
      maxAttempts,
      sleep,
      secrets,
      allowedStatuses: [404],
    }
  );

  if (forgejoResult.response.status === 404) {
    throw new Error(`Forgejo tag ${tag} was not found`);
  }

  const forgejoObjectSha = assertSha(
    forgejoResult.data?.id,
    `Forgejo ${tag} tag object`
  );
  const forgejoCommitSha = assertSha(
    forgejoResult.data?.commit?.sha,
    `Forgejo ${tag} peeled commit`
  );

  if (forgejoObjectSha !== githubIdentity.objectSha) {
    throw new Error(
      `Tag parity mismatch for ${tag}: GitHub and Forgejo object SHAs differ`
    );
  }

  if (forgejoCommitSha !== githubIdentity.peeledCommitSha) {
    throw new Error(
      `Tag parity mismatch for ${tag}: GitHub and Forgejo peeled commit SHAs differ`
    );
  }

  return githubIdentity;
}

function releasePayload(sourceRelease, tag) {
  return {
    tag_name: tag,
    name: sourceRelease.name || `Release ${tag}`,
    body: sourceRelease.body || '',
    draft: Boolean(sourceRelease.draft),
    prerelease: Boolean(sourceRelease.prerelease),
  };
}

function releaseMetadataMatches(targetRelease, payload) {
  return (
    targetRelease.tag_name === payload.tag_name &&
    targetRelease.name === payload.name &&
    (targetRelease.body || '') === payload.body &&
    Boolean(targetRelease.draft) === payload.draft &&
    Boolean(targetRelease.prerelease) === payload.prerelease
  );
}

function assertExternalAsset(asset) {
  if (typeof asset?.name !== 'string' || asset.name.length === 0) {
    throw new Error('GitHub release asset is missing a name');
  }

  let downloadUrl;
  try {
    downloadUrl = new URL(asset.browser_download_url);
  } catch {
    throw new Error(`GitHub release asset ${asset.name} has an invalid URL`);
  }

  if (downloadUrl.protocol !== 'https:') {
    throw new Error(`GitHub release asset ${asset.name} must use HTTPS`);
  }

  return {
    name: asset.name,
    browser_download_url: downloadUrl.toString(),
  };
}

export async function mirrorForgejoRelease({
  tag,
  githubToken = '',
  forgejoToken = '',
  githubBaseUrl = 'https://api.github.com',
  forgejoBaseUrl = 'https://git.kroonen.ai/api/v1',
  githubRepository = 'libre-webui/libre-webui',
  forgejoRepository = 'libre-webui/libre-webui',
  fetchImpl = globalThis.fetch,
  dryRun = false,
  maxAttempts = 4,
  sleep = defaultSleep,
} = {}) {
  assertValidTag(tag);
  assertRepository(githubRepository, 'GitHub');
  assertRepository(forgejoRepository, 'Forgejo');

  if (!dryRun && !forgejoToken) {
    throw new Error('FORGEJO_TOKEN is required unless --dry-run is used');
  }

  const secrets = [githubToken, forgejoToken].filter(Boolean);
  const commonOptions = {
    tag,
    githubToken,
    forgejoToken,
    githubBaseUrl,
    forgejoBaseUrl,
    githubRepository,
    forgejoRepository,
    fetchImpl,
    maxAttempts,
    sleep,
    secrets,
  };

  await assertRemoteTagParity(commonOptions);

  const githubReleaseResult = await requestJson(
    `${githubBaseUrl}/repos/${githubRepository}/releases/tags/${encodeURIComponent(tag)}`,
    {
      token: githubToken,
      authScheme: 'Bearer',
      fetchImpl,
      maxAttempts,
      sleep,
      secrets,
    }
  );
  const sourceRelease = githubReleaseResult.data;

  if (!Number.isInteger(sourceRelease?.id)) {
    throw new Error(`GitHub release ${tag} returned an invalid response`);
  }

  const sourceAssets = await fetchPaginated(
    `${githubBaseUrl}/repos/${githubRepository}/releases/${sourceRelease.id}/assets?per_page=100`,
    {
      token: githubToken,
      authScheme: 'Bearer',
      fetchImpl,
      maxAttempts,
      sleep,
      secrets,
    }
  );
  const assets = sourceAssets.map(assertExternalAsset);
  const duplicateNames = assets.filter(
    (asset, index) =>
      assets.findIndex(candidate => candidate.name === asset.name) !== index
  );

  if (duplicateNames.length > 0) {
    throw new Error(
      `GitHub release ${tag} contains duplicate asset name ${duplicateNames[0].name}`
    );
  }

  const payload = releasePayload(sourceRelease, tag);
  const forgejoReleaseResult = await requestJson(
    `${forgejoBaseUrl}/repos/${forgejoRepository}/releases/tags/${encodeURIComponent(tag)}`,
    {
      token: forgejoToken,
      authScheme: 'token',
      fetchImpl,
      maxAttempts,
      sleep,
      secrets,
      allowedStatuses: [404],
    }
  );
  let targetRelease =
    forgejoReleaseResult.response.status === 404
      ? null
      : forgejoReleaseResult.data;
  let releaseAction = 'unchanged';

  if (!targetRelease) {
    releaseAction = dryRun ? 'would-create' : 'created';

    if (!dryRun) {
      const createResult = await requestJson(
        `${forgejoBaseUrl}/repos/${forgejoRepository}/releases`,
        {
          token: forgejoToken,
          authScheme: 'token',
          method: 'POST',
          body: payload,
          fetchImpl,
          maxAttempts,
          sleep,
          secrets,
        }
      );
      targetRelease = createResult.data;
    }
  } else if (!releaseMetadataMatches(targetRelease, payload)) {
    releaseAction = dryRun ? 'would-update' : 'updated';

    if (!dryRun) {
      const updateResult = await requestJson(
        `${forgejoBaseUrl}/repos/${forgejoRepository}/releases/${targetRelease.id}`,
        {
          token: forgejoToken,
          authScheme: 'token',
          method: 'PATCH',
          body: payload,
          fetchImpl,
          maxAttempts,
          sleep,
          secrets,
        }
      );
      targetRelease = updateResult.data;
    }
  }

  const summary = {
    tag,
    release: releaseAction,
    assets: {
      created: 0,
      updated: 0,
      unchanged: 0,
      wouldCreate: 0,
      wouldUpdate: 0,
    },
  };

  if (!targetRelease && dryRun) {
    summary.assets.wouldCreate = assets.length;
    return summary;
  }

  if (!Number.isInteger(targetRelease?.id)) {
    throw new Error(`Forgejo release ${tag} returned an invalid response`);
  }

  const targetAssets = Array.isArray(targetRelease.assets)
    ? targetRelease.assets
    : [];
  const targetByName = new Map();

  for (const asset of targetAssets) {
    if (targetByName.has(asset.name)) {
      throw new Error(
        `Forgejo release ${tag} contains duplicate asset name ${asset.name}`
      );
    }
    targetByName.set(asset.name, asset);
  }

  for (const asset of assets) {
    const existing = targetByName.get(asset.name);

    if (!existing) {
      if (dryRun) {
        summary.assets.wouldCreate += 1;
        continue;
      }

      const form = new FormData();
      form.set('external_url', asset.browser_download_url);
      await requestJson(
        `${forgejoBaseUrl}/repos/${forgejoRepository}/releases/${targetRelease.id}/assets?name=${encodeURIComponent(asset.name)}`,
        {
          token: forgejoToken,
          authScheme: 'token',
          method: 'POST',
          body: form,
          fetchImpl,
          maxAttempts,
          sleep,
          secrets,
        }
      );
      summary.assets.created += 1;
      continue;
    }

    if (
      existing.type === 'external' &&
      existing.browser_download_url === asset.browser_download_url
    ) {
      summary.assets.unchanged += 1;
      continue;
    }

    if (existing.type !== 'external') {
      throw new Error(
        `Forgejo asset ${asset.name} is stored locally; refusing to replace it with an external link`
      );
    }

    if (dryRun) {
      summary.assets.wouldUpdate += 1;
      continue;
    }

    await requestJson(
      `${forgejoBaseUrl}/repos/${forgejoRepository}/releases/${targetRelease.id}/assets/${existing.id}`,
      {
        token: forgejoToken,
        authScheme: 'token',
        method: 'PATCH',
        body: {
          name: asset.name,
          browser_download_url: asset.browser_download_url,
        },
        fetchImpl,
        maxAttempts,
        sleep,
        secrets,
      }
    );
    summary.assets.updated += 1;
  }

  return summary;
}

export async function mirrorAllForgejoReleases({
  githubToken = '',
  forgejoToken = '',
  githubBaseUrl = 'https://api.github.com',
  forgejoBaseUrl = 'https://git.kroonen.ai/api/v1',
  githubRepository = 'libre-webui/libre-webui',
  forgejoRepository = 'libre-webui/libre-webui',
  fetchImpl = globalThis.fetch,
  dryRun = false,
  maxAttempts = 4,
  sleep = defaultSleep,
  onProgress = () => undefined,
} = {}) {
  assertRepository(githubRepository, 'GitHub');
  assertRepository(forgejoRepository, 'Forgejo');

  if (!dryRun && !forgejoToken) {
    throw new Error('FORGEJO_TOKEN is required unless --dry-run is used');
  }

  if (!githubToken) {
    throw new Error(
      'GITHUB_TOKEN is required for --all to avoid GitHub API rate limits'
    );
  }

  const secrets = [githubToken, forgejoToken].filter(Boolean);
  const releases = await fetchPaginated(
    `${githubBaseUrl}/repos/${githubRepository}/releases?per_page=100`,
    {
      token: githubToken,
      authScheme: 'Bearer',
      fetchImpl,
      maxAttempts,
      sleep,
      secrets,
    }
  );
  const summaries = [];

  for (const release of releases) {
    const tag = assertValidTag(release.tag_name);
    const summary = await mirrorForgejoRelease({
      tag,
      githubToken,
      forgejoToken,
      githubBaseUrl,
      forgejoBaseUrl,
      githubRepository,
      forgejoRepository,
      fetchImpl,
      dryRun,
      maxAttempts,
      sleep,
    });
    summaries.push(summary);
    onProgress(summary, summaries.length, releases.length);
  }

  return summaries;
}
