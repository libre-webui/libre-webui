import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { format } from 'prettier';
import ts from 'typescript';

const repoRoot = path.resolve(import.meta.dirname, '..');
const contractPath = path.join(
  repoRoot,
  'scripts',
  'global-capability-contracts.json'
);
const inventoryPath = path.join(
  repoRoot,
  'docs',
  '46-GLOBAL_CAPABILITY_CONTRACTS.md'
);
const contracts = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const sourceFileCache = new Map();
const read = relativePath =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const HTTP_METHODS = new Set([
  'all',
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
]);

const canonicalCapabilityIds = [
  'home',
  'chat',
  'model-management',
  'personas',
  'media-gallery',
  'notes',
  'work',
  'agent-cli',
  'artifacts',
  'usage',
  'system-diagnostics',
  'user-administration',
  'authentication',
  'access-control',
  'data-portability',
  'document-knowledge',
  'persona-memory',
  'web-search',
  'settings-preferences',
  'speech',
  'hugging-face-hub',
  'libre-claw',
  'durable-jobs',
  'deployment-profiles',
  'recovery-backup',
];

function sorted(values) {
  return [...values].sort();
}

function assertExactKeys(value, expected, label) {
  assert.deepEqual(
    sorted(Object.keys(value)),
    sorted(expected),
    `${label} shape`
  );
}

function scriptKind(relativePath) {
  if (relativePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (relativePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (relativePath.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function parsedSource(relativePath) {
  if (!sourceFileCache.has(relativePath)) {
    sourceFileCache.set(
      relativePath,
      ts.createSourceFile(
        relativePath,
        read(relativePath),
        ts.ScriptTarget.Latest,
        true,
        scriptKind(relativePath)
      )
    );
  }
  return sourceFileCache.get(relativePath);
}

function findNodes(sourceFile, predicate) {
  const matches = [];
  const visit = node => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matches;
}

function isRouterRootedExpression(node) {
  if (ts.isIdentifier(node)) return node.text === 'router';
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    isRouterRootedExpression(node.expression.expression)
  );
}

function routerHttpCalls(sourceFile) {
  return findNodes(
    sourceFile,
    node =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      HTTP_METHODS.has(node.expression.name.text) &&
      isRouterRootedExpression(node.expression.expression)
  );
}

function literalValue(node, sourceFile) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'String' &&
    node.name.text === 'raw'
  ) {
    return node.getText(sourceFile);
  }
  return undefined;
}

function findNamedTest(focusedTest) {
  const sourceFile = parsedSource(focusedTest.file);
  const matches = findNodes(
    sourceFile,
    node =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'test' &&
      literalValue(node.arguments[0], sourceFile) === focusedTest.name
  );
  assert.equal(
    matches.length,
    1,
    `${focusedTest.file} must contain exactly one test named ${focusedTest.name}`
  );
  return matches[0].getText(sourceFile);
}

function registeredPackageTests(rootPackage) {
  const files = new Set();
  for (const segment of rootPackage.scripts['test:package'].split(/\s*&&\s*/)) {
    const match = segment.trim().match(/^node\s+--test\s+(.+)$/);
    if (!match) continue;
    for (const token of match[1].trim().split(/\s+/)) {
      if (/^scripts\/.+\.mjs$/.test(token)) files.add(token);
    }
  }
  return files;
}

function routeKey(route) {
  return `${route.file}\u0000${route.mount}\u0000${route.method}\u0000${route.path}`;
}

function fullRoutePath(route) {
  if (route.path === '/') return route.mount;
  return `${route.mount.replace(/\/$/, '')}/${route.path.replace(/^\//, '')}`;
}

function webSocketRouteKey(route) {
  return `${route.file}\u0000${route.path}`;
}

function importedStringConstant(sourceFile, localName) {
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      if (element.name.text !== localName) continue;
      const importedFile = path.posix.join(
        path.posix.dirname(contracts.scope.websocketSource),
        specifier.replace(/\.js$/, '.ts')
      );
      const importedSource = parsedSource(importedFile);
      const importedName = element.propertyName?.text || element.name.text;
      const declaration = findNodes(
        importedSource,
        node =>
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === importedName &&
          node.initializer !== undefined
      );
      assert.equal(
        declaration.length,
        1,
        `${importedFile} must declare ${importedName} exactly once`
      );
      const value = literalValue(declaration[0].initializer, importedSource);
      assert.equal(
        typeof value,
        'string',
        `${importedFile} ${importedName} must be a literal string`
      );
      return value;
    }
  }
  return undefined;
}

function extractWebSocketRoutes() {
  const sourceFile = parsedSource(contracts.scope.websocketSource);
  const paths = findNodes(
    sourceFile,
    node =>
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === 'pathname'
  ).map(expression => {
    const literal = literalValue(expression.right, sourceFile);
    if (typeof literal === 'string') return literal;
    assert.ok(
      ts.isIdentifier(expression.right),
      'a WebSocket pathname comparison must use a literal or imported string constant'
    );
    const imported = importedStringConstant(sourceFile, expression.right.text);
    assert.equal(
      typeof imported,
      'string',
      `cannot resolve WebSocket pathname constant ${expression.right.text}`
    );
    return imported;
  });
  assert.equal(
    new Set(paths).size,
    paths.length,
    'WebSocket upgrade source contains duplicate pathname declarations'
  );
  return paths.map(routePath => ({
    file: contracts.scope.websocketSource,
    path: routePath,
  }));
}

function mountedRouteSources() {
  const sourceFile = parsedSource(contracts.scope.backendSource);
  const routeImports = new Map();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause?.name ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('./routes/') || !specifier.endsWith('.js')) {
      continue;
    }
    routeImports.set(statement.importClause.name.text, {
      file: path.posix.join(
        path.posix.dirname(contracts.scope.backendSource),
        specifier.replace(/^\.\//, '').replace(/\.js$/, '.ts')
      ),
    });
  }

  const mounted = new Map();
  for (const call of findNodes(
    sourceFile,
    node =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'app' &&
      node.expression.name.text === 'use'
  )) {
    const mount = literalValue(call.arguments[0], sourceFile);
    if (typeof mount !== 'string') continue;
    const routeArguments = call.arguments.filter(
      argument => ts.isIdentifier(argument) && routeImports.has(argument.text)
    );
    if (routeArguments.length === 0) continue;
    assert.equal(
      routeArguments.length,
      1,
      `mount ${mount} must register exactly one imported router`
    );
    const imported = routeImports.get(routeArguments[0].text);
    assert.equal(
      mounted.has(imported.file),
      false,
      `${imported.file} is mounted more than once`
    );
    mounted.set(imported.file, mount);
  }

  assert.deepEqual(
    sorted(mounted.keys()),
    sorted([...routeImports.values()].map(value => value.file)),
    'every imported Express router must have one literal mount'
  );

  const routeDirectory = path.join(
    repoRoot,
    contracts.scope.backendRouteDirectory
  );
  const routeFiles = fs
    .readdirSync(routeDirectory)
    .filter(name => name.endsWith('.ts'))
    .map(name => path.posix.join(contracts.scope.backendRouteDirectory, name));
  const filesWithRoutes = routeFiles.filter(
    file => routerHttpCalls(parsedSource(file)).length > 0
  );
  assert.deepEqual(
    sorted(mounted.keys()),
    sorted(filesWithRoutes),
    'every route file with HTTP declarations must be imported and mounted'
  );
  return mounted;
}

function extractBackendRoutes() {
  const routes = [];
  for (const [file, mount] of mountedRouteSources()) {
    const sourceFile = parsedSource(file);
    const unsupportedRouteBuilders = findNodes(
      sourceFile,
      node =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'router' &&
        node.expression.name.text === 'route'
    );
    assert.equal(
      unsupportedRouteBuilders.length,
      0,
      `${file} uses router.route(), which the capability inventory does not silently ignore`
    );
    const httpCalls = routerHttpCalls(sourceFile);
    for (const call of httpCalls) {
      assert.ok(
        ts.isIdentifier(call.expression.expression) &&
          call.expression.expression.text === 'router',
        `${file} uses a chained router.${call.expression.name.text}() declaration, which the capability inventory does not silently ignore`
      );
    }
    for (const call of httpCalls) {
      const routePath = literalValue(call.arguments[0], sourceFile);
      assert.equal(
        typeof routePath,
        'string',
        `${file} ${call.expression.name.text} route needs a literal path`
      );
      routes.push({
        file,
        mount,
        method: call.expression.name.text.toUpperCase(),
        path: routePath,
      });
    }
  }
  assert.equal(
    new Set(routes.map(routeKey)).size,
    routes.length,
    'source contains duplicate method/path declarations'
  );
  return routes;
}

function compileEvidencePattern(pattern, label) {
  assert.equal(typeof pattern, 'string', `${label} must be a string`);
  assert.ok(pattern.length >= 8, `${label} is too broad`);
  const expression = new RegExp(pattern, 'm');
  assert.equal(expression.test(''), false, `${label} matches empty text`);
  assert.equal(
    expression.test('unrelated capability evidence'),
    false,
    `${label} matches unrelated text`
  );
  return expression;
}

function assertEvidence(evidenceList, label) {
  assert.ok(Array.isArray(evidenceList), `${label} must be an array`);
  assert.ok(evidenceList.length > 0, `${label} needs evidence`);
  for (const evidence of evidenceList) {
    assert.deepEqual(sorted(Object.keys(evidence)), ['file', 'patterns']);
    const source = read(evidence.file);
    assert.ok(evidence.patterns.length > 0);
    for (const [index, pattern] of evidence.patterns.entries()) {
      assert.match(
        source,
        compileEvidencePattern(pattern, `${label} pattern ${index}`)
      );
    }
  }
}

function assertDocumentation(capability) {
  assertEvidence(capability.documentation, `${capability.id} documentation`);
}

function assertContractSurfaces(capability) {
  assertExactKeys(
    capability.contractSurfaces,
    ['schemas', 'manifests', 'defaults'],
    `${capability.id} contract surfaces`
  );
  for (const surfaceName of ['schemas', 'manifests', 'defaults']) {
    const surface = capability.contractSurfaces[surfaceName];
    assert.ok(surface && typeof surface === 'object');
    if (Object.hasOwn(surface, 'evidence')) {
      assertExactKeys(surface, ['evidence'], `${capability.id} ${surfaceName}`);
      assertEvidence(
        surface.evidence,
        `${capability.id} ${surfaceName} applicability`
      );
    } else {
      assertExactKeys(
        surface,
        ['notApplicable'],
        `${capability.id} ${surfaceName}`
      );
      assert.equal(typeof surface.notApplicable, 'string');
      assert.ok(
        surface.notApplicable.trim().length >= 24,
        `${capability.id} ${surfaceName} needs a specific not-applicable reason`
      );
    }
  }
}

function assertFocusedTests(capability, rootPackage, frontendPackage) {
  assert.ok(capability.focusedTests.length > 0);
  const packageTests = registeredPackageTests(rootPackage);
  for (const focusedTest of capability.focusedTests) {
    assertExactKeys(
      focusedTest,
      ['file', 'runner', 'name', 'behaviorPatterns'],
      `${capability.id} focused test`
    );
    if (focusedTest.runner === 'test:package') {
      assert.ok(
        packageTests.has(focusedTest.file),
        `${focusedTest.file} is not registered in test:package`
      );
    } else {
      assert.equal(focusedTest.runner, 'test:e2e');
      assert.match(focusedTest.file, /^frontend\/e2e\/.+\.spec\.ts$/);
      assert.equal(
        rootPackage.scripts['test:e2e'],
        'npm run e2e --workspace=frontend'
      );
      assert.match(frontendPackage.scripts.e2e, /^playwright test(?: |$)/);
    }
    const namedTest = findNamedTest(focusedTest);
    assert.ok(
      focusedTest.behaviorPatterns.length >= 2,
      `${capability.id} focused test needs at least two behavior patterns`
    );
    for (const [index, pattern] of focusedTest.behaviorPatterns.entries()) {
      assert.match(
        namedTest,
        compileEvidencePattern(
          pattern,
          `${capability.id} focused test pattern ${index}`
        ),
        `${focusedTest.name} does not prove ${pattern}`
      );
    }
  }
}

function describeSurface(surface) {
  if (surface.evidence) {
    return surface.evidence.map(value => `\`${value.file}\``).join('<br />');
  }
  return `N/A — ${surface.notApplicable}`;
}

async function renderInventory() {
  const lines = [
    '---',
    'sidebar_position: 46',
    "title: 'Global Capability Contracts'",
    "description: 'Generated inventory of global product capabilities and application routes in Libre WebUI.'",
    'slug: /GLOBAL_CAPABILITY_CONTRACTS',
    '---',
    '',
    '# Global Capability Contracts',
    '',
    '<!-- Generated from scripts/global-capability-contracts.json. Do not edit this file by hand. -->',
    '',
    'This executable inventory covers every explicit page route in `frontend/src/App.tsx`, every literal method/path declaration in every mounted `backend/src/routes/*.ts` Express router, and every literal WebSocket upgrade pathname in `backend/src/websocketServer.ts`. Each endpoint has exactly one capability owner, and every WebSocket endpoint has authentication evidence. Every capability also declares whether schemas, manifests, and defaults apply, with source evidence or a specific not-applicable reason, plus documentation and a named behavioral test registered in normal package or browser CI.',
    '',
    'Executable provider details remain governed by `scripts/capability-contracts.json` and `scripts/test-capability-contracts.mjs`; this global inventory links to that contract instead of duplicating its manifest and default rules.',
    '',
    '| Capability | UI routes | HTTP endpoints | WebSocket endpoints | Schemas | Manifests | Defaults | Documentation | Named behavioral tests |',
    '| --- | --- | ---: | ---: | --- | --- | --- | --- | --- |',
  ];

  for (const capability of contracts.capabilities) {
    lines.push(
      `| ${capability.title} | ${capability.uiRoutes.map(value => `\`${value}\``).join('<br />') || '—'} | ${capability.backendRoutes.length} | ${capability.websocketRoutes?.length || 0} | ${describeSurface(capability.contractSurfaces.schemas)} | ${describeSurface(capability.contractSurfaces.manifests)} | ${describeSurface(capability.contractSurfaces.defaults)} | ${capability.documentation.map(value => `\`${value.file}\``).join('<br />')} | ${capability.focusedTests.map(value => `\`${value.name}\`<br />\`${value.file}\` (\`${value.runner}\`)`).join('<br />')} |`
    );
  }

  lines.push('', '## Exact backend route inventory', '');
  for (const capability of contracts.capabilities) {
    lines.push(`### ${capability.title}`, '');
    if (capability.backendRoutes.length === 0) {
      lines.push(
        'No mounted Express endpoint. The executable boundary is the UI and/or source evidence recorded above.',
        ''
      );
      continue;
    }
    for (const route of [...capability.backendRoutes].sort((left, right) =>
      routeKey(left).localeCompare(routeKey(right))
    )) {
      lines.push(
        `- \`${route.method} ${fullRoutePath(route)}\` — \`${route.file}\` (mount \`${route.mount}\`, subpath \`${route.path}\`)`
      );
    }
    lines.push('');
  }

  lines.push('', '## Exact WebSocket route inventory', '');
  for (const capability of contracts.capabilities) {
    for (const route of capability.websocketRoutes || []) {
      lines.push(
        `- \`WEBSOCKET ${route.path}\` — **${capability.title}**, \`${route.file}\`; authentication evidence: ${route.authenticationEvidence.map(value => `\`${value.file}\``).join(', ')}`
      );
    }
  }
  lines.push('');

  lines.push(
    '## Enforcement boundary',
    '',
    'The package gate parses TypeScript/JavaScript source, resolves every imported Express router to its literal application mount, and reconciles every literal router method/path declaration and WebSocket upgrade pathname one-for-one with this inventory. It fails on an unmounted route file, an unsupported `router.route()` builder, a dynamic route path, a missing or duplicate endpoint owner, missing WebSocket authentication evidence, a changed UI route, missing schema/manifest/default applicability, stale evidence, or a stale generated document.',
    '',
    'Focused-test evidence is scoped to one exact named `test(...)` declaration and at least two behavior patterns inside that test body. Backend tests must be exact file arguments to `test:package`; Playwright specs must match normal discovery. The gate also proves that both runners execute in the normal pull-request and `dev`/`main` Format & Lint workflow.',
    ''
  );
  return format(lines.join('\n'), {
    parser: 'markdown',
    proseWrap: 'preserve',
    singleQuote: true,
  });
}

if (process.argv.includes('--write-inventory')) {
  fs.writeFileSync(inventoryPath, await renderInventory());
}

test('global inventory is bounded to every explicit page route', () => {
  assert.equal(contracts.schemaVersion, 3);
  assert.deepEqual(sorted(Object.keys(contracts.scope)), [
    'backendRouteDirectory',
    'backendSource',
    'excludedUiRoutes',
    'providerContract',
    'uiSource',
    'websocketSource',
  ]);
  assert.equal(
    contracts.scope.providerContract,
    'scripts/capability-contracts.json'
  );
  assert.deepEqual(
    contracts.capabilities.map(capability => capability.id),
    canonicalCapabilityIds
  );

  const declaredRoutes = contracts.capabilities.flatMap(
    capability => capability.uiRoutes
  );
  assert.equal(new Set(declaredRoutes).size, declaredRoutes.length);

  const uiSource = read(contracts.scope.uiSource);
  const sourceRoutes = new Set(
    [...uiSource.matchAll(/\bpath\s*=\s*['"]([^'"]+)['"]/g)].map(
      match => match[1]
    )
  );
  for (const excluded of contracts.scope.excludedUiRoutes) {
    assert.ok(
      sourceRoutes.delete(excluded),
      `excluded route ${excluded} vanished`
    );
  }
  assert.deepEqual(sorted(sourceRoutes), sorted(declaredRoutes));
});

test('global capabilities own every mounted router method and path exactly once', () => {
  const rootPackage = JSON.parse(read('package.json'));
  const frontendPackage = JSON.parse(read('frontend/package.json'));
  const sourceRoutes = extractBackendRoutes();
  const declaredRoutes = contracts.capabilities.flatMap(
    capability => capability.backendRoutes
  );
  assert.equal(
    new Set(declaredRoutes.map(routeKey)).size,
    declaredRoutes.length,
    'an endpoint can have only one capability owner'
  );
  assert.deepEqual(
    sorted(sourceRoutes.map(routeKey)),
    sorted(declaredRoutes.map(routeKey))
  );

  for (const capability of contracts.capabilities) {
    const expectedKeys = [
      'backendRoutes',
      'contractSurfaces',
      'documentation',
      'focusedTests',
      'id',
      'title',
      'uiRoutes',
      ...(capability.sourceEvidence ? ['sourceEvidence'] : []),
      ...(capability.websocketRoutes ? ['websocketRoutes'] : []),
    ];
    assert.deepEqual(sorted(Object.keys(capability)), sorted(expectedKeys));
    assert.match(capability.id, /^[a-z][a-z0-9-]+$/);
    assert.ok(capability.title.trim());
    assert.ok(
      capability.uiRoutes.length > 0 ||
        capability.backendRoutes.length > 0 ||
        capability.websocketRoutes?.length > 0 ||
        capability.sourceEvidence?.length > 0,
      `${capability.id} has no executable/source boundary`
    );
    for (const route of capability.backendRoutes) {
      assertExactKeys(
        route,
        ['file', 'mount', 'method', 'path'],
        `${capability.id} backend route`
      );
      assert.match(route.file, /^backend\/src\/routes\/.+\.ts$/);
      assert.match(route.mount, /^\//);
      assert.ok(HTTP_METHODS.has(route.method.toLowerCase()));
      assert.match(route.path, /^\//);
    }
    if (capability.sourceEvidence) {
      assertEvidence(capability.sourceEvidence, `${capability.id} source`);
    }
    if (capability.websocketRoutes) {
      for (const route of capability.websocketRoutes) {
        assertExactKeys(
          route,
          ['authenticationEvidence', 'file', 'path'],
          `${capability.id} WebSocket route`
        );
        assert.equal(route.file, contracts.scope.websocketSource);
        assert.match(route.path, /^\/ws(?:\/|$)/);
        assertEvidence(
          route.authenticationEvidence,
          `${capability.id} WebSocket authentication`
        );
      }
    }
    assertContractSurfaces(capability);
    assertDocumentation(capability);
    assertFocusedTests(capability, rootPackage, frontendPackage);
  }
});

test('global capabilities own and authenticate every WebSocket upgrade path', () => {
  const sourceRoutes = extractWebSocketRoutes();
  const declaredRoutes = contracts.capabilities.flatMap(
    capability => capability.websocketRoutes || []
  );
  assert.equal(
    new Set(declaredRoutes.map(webSocketRouteKey)).size,
    declaredRoutes.length,
    'a WebSocket endpoint can have only one capability owner'
  );
  assert.deepEqual(
    sorted(sourceRoutes.map(webSocketRouteKey)),
    sorted(declaredRoutes.map(webSocketRouteKey))
  );
});

test('global conformance evidence runs in normal pull-request and branch CI', () => {
  const rootPackage = JSON.parse(read('package.json'));
  const packageTests = registeredPackageTests(rootPackage);
  assert.ok(packageTests.has('scripts/test-global-capability-contracts.mjs'));
  assert.ok(packageTests.has('scripts/test-capability-contracts.mjs'));

  const workflow = read('.github/workflows/format.yml');
  assert.match(workflow, /push:\s*\n\s+branches: \[dev, main\]/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /run: npm run test:package/);
  assert.match(workflow, /run: npm run test:e2e/);
});

test('generated global capability inventory is current', async () => {
  assert.equal(
    read('docs/46-GLOBAL_CAPABILITY_CONTRACTS.md'),
    await renderInventory()
  );
});
