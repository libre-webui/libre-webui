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
  'capability-contracts.json'
);
const inventoryPath = path.join(repoRoot, 'docs', '43-CAPABILITY_CONTRACTS.md');
const contracts = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const sourceFileCache = new Map();

const read = relativePath =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function assertExactKeys(value, expected, label) {
  assert.deepEqual(sortedKeys(value), [...expected].sort(), `${label} shape`);
}

function quotedUnionValues(source, typeName) {
  const match = source.match(
    new RegExp(`export type ${typeName}\\s*=([\\s\\S]*?);`)
  );
  assert.ok(match, `could not find ${typeName}`);
  return [...match[1].matchAll(/['\"]([a-z]+)['\"]/g)].map(value => value[1]);
}

function interfaceOptionalKeys(source, interfaceName) {
  const match = source.match(
    new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`)
  );
  assert.ok(match, `could not find ${interfaceName}`);
  return [...match[1].matchAll(/^\s{2}([a-z]+)\?:/gm)].map(value => value[1]);
}

function compileEvidencePattern(pattern, label) {
  assert.equal(typeof pattern, 'string', `${label} must be a string`);
  assert.ok(pattern.length >= 8, `${label} is too broad: ${pattern}`);
  let expression;
  try {
    expression = new RegExp(pattern, 'm');
  } catch (error) {
    assert.fail(`${label} is not a valid regular expression: ${error.message}`);
  }
  assert.equal(
    expression.test(''),
    false,
    `${label} must not match empty text`
  );
  assert.equal(
    expression.test('unrelated capability evidence'),
    false,
    `${label} must not match unrelated evidence`
  );
  return expression;
}

function assertPatterns(source, patterns, label, minimum = 1) {
  assert.ok(Array.isArray(patterns), `${label} patterns must be an array`);
  assert.ok(
    patterns.length >= minimum,
    `${label} needs at least ${minimum} explicit pattern${minimum === 1 ? '' : 's'}`
  );
  for (const [index, pattern] of patterns.entries()) {
    const expression = compileEvidencePattern(pattern, `${label}[${index}]`);
    assert.match(source, expression, `${label} lacks ${pattern}`);
  }
}

function assertForbiddenPatterns(source, patterns, label) {
  for (const [index, pattern] of (patterns || []).entries()) {
    const expression = compileEvidencePattern(pattern, `${label}[${index}]`);
    assert.doesNotMatch(
      source,
      expression,
      `${label} unexpectedly has ${pattern}`
    );
  }
}

function scriptKind(relativePath) {
  if (relativePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (relativePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (relativePath.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function parsedSource(relativePath) {
  if (!sourceFileCache.has(relativePath)) {
    const absolutePath = path.join(repoRoot, relativePath);
    assert.ok(
      fs.existsSync(absolutePath),
      `missing source file ${relativePath}`
    );
    sourceFileCache.set(
      relativePath,
      ts.createSourceFile(
        relativePath,
        fs.readFileSync(absolutePath, 'utf8'),
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

function findUniqueNode(sourceFile, predicate, label) {
  const matches = findNodes(sourceFile, predicate);
  assert.equal(matches.length, 1, `${label} matched ${matches.length} nodes`);
  return matches[0];
}

function literalValue(node, sourceFile) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (!ts.isTemplateExpression(node)) return undefined;
  let value = node.head.text;
  for (const span of node.templateSpans) {
    value += `\${${span.expression.getText(sourceFile)}}${span.literal.text}`;
  }
  return value;
}

function routeLiteralValue(node, sourceFile) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (!ts.isTemplateExpression(node)) return undefined;
  let value = node.head.text;
  for (const span of node.templateSpans) {
    const expression = span.expression.getText(sourceFile);
    const identifiers = [...expression.matchAll(/[A-Za-z_$][\w$]*/g)];
    const parameter = identifiers.at(-1)?.[0];
    assert.ok(
      parameter,
      `could not resolve route parameter from ${expression}`
    );
    value += `:${parameter}${span.literal.text}`;
  }
  return value;
}

function propertyAccessMatches(expression, owner, member, sourceFile) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.expression.getText(sourceFile) === owner &&
    expression.name.text === member
  );
}

function findExpressMount(registration) {
  const sourceFile = parsedSource(registration.file);
  return findUniqueNode(
    sourceFile,
    node =>
      ts.isCallExpression(node) &&
      propertyAccessMatches(node.expression, 'app', 'use', sourceFile) &&
      literalValue(node.arguments[0], sourceFile) === registration.mount &&
      node.arguments.some(
        argument =>
          ts.isIdentifier(argument) && argument.text === registration.router
      ),
    `${registration.file} mount ${registration.mount} -> ${registration.router}`
  );
}

function findExpressRoute(route) {
  const sourceFile = parsedSource(route.file);
  return findUniqueNode(
    sourceFile,
    node =>
      ts.isCallExpression(node) &&
      propertyAccessMatches(
        node.expression,
        'router',
        route.method,
        sourceFile
      ) &&
      literalValue(node.arguments[0], sourceFile) === route.path,
    `${route.file} ${route.method.toUpperCase()} ${route.path}`
  );
}

function assertExpressRegistration(registration) {
  assertExactKeys(
    registration,
    ['kind', 'file', 'mount', 'router'],
    `${registration.mount} registration`
  );
  assert.equal(registration.kind, 'express-mount');
  findExpressMount(registration);
}

function findWebSocketUpgrade(route) {
  const sourceFile = parsedSource(route.file);
  return findUniqueNode(
    sourceFile,
    node =>
      ts.isIfStatement(node) &&
      new RegExp(
        `^pathname === ['\"]${route.path.replaceAll('/', '\\/')}['\"]$`
      ).test(node.expression.getText(sourceFile)),
    `${route.file} WebSocket upgrade ${route.path}`
  );
}

function findWebSocketMessage(route) {
  const sourceFile = parsedSource(route.file);
  return findUniqueNode(
    sourceFile,
    node =>
      ts.isIfStatement(node) &&
      new RegExp(`^message\\.type === ['\"]${route.messageType}['\"]$`).test(
        node.expression.getText(sourceFile)
      ),
    `${route.file} WebSocket message ${route.messageType}`
  );
}

function assertRoute(route) {
  if (route.kind === 'express-route') {
    const allowedKeys = route.forbiddenPatterns
      ? [
          'kind',
          'file',
          'method',
          'path',
          'operationPatterns',
          'forbiddenPatterns',
        ]
      : route.handler
        ? ['kind', 'file', 'method', 'path', 'handler', 'operationPatterns']
        : ['kind', 'file', 'method', 'path', 'operationPatterns'];
    assertExactKeys(route, allowedKeys, `${route.file} ${route.path}`);
    assert.ok(['get', 'post', 'put', 'patch', 'delete'].includes(route.method));
    const sourceFile = parsedSource(route.file);
    const routeCall = findExpressRoute(route).getText(sourceFile);
    const scope = route.handler
      ? findFunctionScope(route.file, route.handler)
      : routeCall;
    if (route.handler) {
      assert.match(
        routeCall,
        new RegExp(`\\b${route.handler}\\b`),
        `${route.file} ${route.path} must register ${route.handler}`
      );
    }
    assertPatterns(
      scope,
      route.operationPatterns,
      `${route.file} ${route.method.toUpperCase()} ${route.path} operations`
    );
    assertForbiddenPatterns(
      scope,
      route.forbiddenPatterns,
      `${route.file} ${route.path} forbidden operations`
    );
    return;
  }

  assertExactKeys(
    route,
    ['kind', 'file', 'path', 'messageType', 'operationPatterns'],
    `${route.file} ${route.messageType}`
  );
  assert.equal(route.kind, 'websocket-message');
  const sourceFile = parsedSource(route.file);
  const upgradeScope = findWebSocketUpgrade(route).getText(sourceFile);
  assertPatterns(
    upgradeScope,
    ['wss\\.handleUpgrade\\('],
    `${route.file} ${route.path} upgrade`
  );
  const messageScope = findWebSocketMessage(route).getText(sourceFile);
  assertPatterns(
    messageScope,
    route.operationPatterns,
    `${route.file} ${route.messageType} operations`
  );
}

function findHttpClientCall(client) {
  const sourceFile = parsedSource(client.file);
  return findUniqueNode(
    sourceFile,
    node =>
      ts.isCallExpression(node) &&
      propertyAccessMatches(
        node.expression,
        client.callee,
        client.method,
        sourceFile
      ) &&
      routeLiteralValue(node.arguments[0], sourceFile) === client.path,
    `${client.file} ${client.method.toUpperCase()} ${client.path}`
  );
}

function findVariableInitializer(relativePath, variableName) {
  const sourceFile = parsedSource(relativePath);
  const declaration = findUniqueNode(
    sourceFile,
    node =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      Boolean(node.initializer),
    `${relativePath} variable ${variableName}`
  );
  return declaration.initializer.getText(sourceFile);
}

function findFunctionScope(relativePath, functionName) {
  const sourceFile = parsedSource(relativePath);
  const matches = findNodes(
    sourceFile,
    node =>
      (ts.isFunctionDeclaration(node) && node.name?.text === functionName) ||
      (ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === functionName &&
        Boolean(node.initializer))
  );
  assert.equal(
    matches.length,
    1,
    `${relativePath} function ${functionName} matched ${matches.length} nodes`
  );
  return matches[0].getText(sourceFile);
}

function findWebSocketClientCall(client) {
  const sourceFile = parsedSource(client.file);
  const matches = findNodes(sourceFile, node => {
    if (
      !ts.isCallExpression(node) ||
      !propertyAccessMatches(
        node.expression,
        'websocketService',
        'send',
        sourceFile
      ) ||
      !ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      return false;
    }
    const typeProperty = node.arguments[0].properties.find(
      property =>
        ts.isPropertyAssignment(property) &&
        property.name.getText(sourceFile).replaceAll(/['\"]/g, '') === 'type'
    );
    return (
      typeProperty &&
      literalValue(typeProperty.initializer, sourceFile) === client.messageType
    );
  });
  assert.ok(
    matches.length > 0,
    `${client.file} does not send WebSocket message ${client.messageType}`
  );

  const pathValue = findVariableInitializer(
    client.pathFile,
    client.pathConstant
  ).replace(/^['\"]|['\"]$/g, '');
  assert.equal(pathValue, client.path, `${client.pathConstant} route`);
}

function clientPathForRoute(registration, route) {
  assert.equal(registration.kind, 'express-mount');
  assert.ok(
    registration.mount.startsWith('/api/'),
    `${registration.mount} must be an API mount`
  );
  return `${registration.mount.slice('/api'.length)}${route.path}`;
}

function assertExecution(capability) {
  const execution = capability.execution;
  const executionKeys = execution.discoveryOnly
    ? ['registration', 'routes', 'clientCalls', 'discoveryOnly']
    : ['registration', 'routes', 'clientCalls'];
  assertExactKeys(execution, executionKeys, `${capability.id} execution`);
  assert.ok(execution.routes.length > 0, `${capability.id} needs a handler`);
  assert.ok(
    execution.clientCalls.length > 0,
    `${capability.id} needs a browser client call`
  );

  if (execution.registration.kind === 'express-mount') {
    assertExpressRegistration(execution.registration);
    for (const route of execution.routes) assertRoute(route);
    for (const client of execution.clientCalls) {
      assert.ok(
        client.kind === 'http' || client.kind === 'http-template',
        `${capability.id} has an invalid HTTP client kind`
      );
      assertExactKeys(
        client,
        ['kind', 'file', 'callee', 'method', 'path'],
        `${capability.id} client ${client.path}`
      );
      findHttpClientCall(client);
      assert.ok(
        execution.routes.some(
          route =>
            route.method === client.method &&
            clientPathForRoute(execution.registration, route) === client.path
        ),
        `${capability.id} client ${client.method.toUpperCase()} ${client.path} has no execution handler`
      );
    }
    for (const route of execution.routes) {
      assert.ok(
        execution.clientCalls.some(
          client =>
            client.method === route.method &&
            client.path === clientPathForRoute(execution.registration, route)
        ),
        `${capability.id} route ${route.method.toUpperCase()} ${route.path} has no browser client`
      );
    }
  } else {
    assertExactKeys(
      execution.registration,
      ['kind', 'file', 'function'],
      `${capability.id} WebSocket registration`
    );
    assert.equal(execution.registration.kind, 'websocket-server');
    const sourceFile = parsedSource(execution.registration.file);
    findUniqueNode(
      sourceFile,
      node =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === execution.registration.function,
      `${execution.registration.file} ${execution.registration.function} call`
    );
    for (const route of execution.routes) assertRoute(route);
    for (const client of execution.clientCalls) {
      assertExactKeys(
        client,
        ['kind', 'file', 'pathFile', 'pathConstant', 'path', 'messageType'],
        `${capability.id} WebSocket client`
      );
      assert.equal(client.kind, 'websocket-message');
      findWebSocketClientCall(client);
      assert.ok(
        execution.routes.some(
          route =>
            route.path === client.path &&
            route.messageType === client.messageType
        ),
        `${capability.id} WebSocket client has no execution handler`
      );
    }
  }

  for (const discovery of execution.discoveryOnly || []) {
    assertExactKeys(
      discovery,
      ['label', 'registration', 'route'],
      `${capability.id} discovery-only route`
    );
    assertExpressRegistration(discovery.registration);
    assertRoute(discovery.route);
    const expected = `${discovery.route.method.toUpperCase()} ${discovery.registration.mount}${discovery.route.path}`;
    assert.equal(discovery.label, expected);
    assert.ok(
      !execution.routes.some(
        route =>
          route.kind === 'express-route' &&
          route.method === discovery.route.method &&
          execution.registration.mount === discovery.registration.mount &&
          route.path === discovery.route.path
      ),
      `${discovery.label} cannot be both discovery-only and executable`
    );
  }
}

function assertUi(ui, capabilityId) {
  assertExactKeys(
    ui,
    ['file', 'action', 'operationPatterns', 'trigger'],
    `${capabilityId} UI`
  );
  const actionScope = findVariableInitializer(ui.file, ui.action);
  assertPatterns(
    actionScope,
    ui.operationPatterns,
    `${capabilityId} UI action ${ui.action}`
  );
  assertExactKeys(ui.trigger, ['file', 'patterns'], `${capabilityId} trigger`);
  assertPatterns(
    read(ui.trigger.file),
    ui.trigger.patterns,
    `${capabilityId} visible trigger`
  );
}

function findNamedTest(focusedTest) {
  const sourceFile = parsedSource(focusedTest.file);
  return findUniqueNode(
    sourceFile,
    node =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'test' &&
      literalValue(node.arguments[0], sourceFile) === focusedTest.name,
    `${focusedTest.file} test ${focusedTest.name}`
  ).getText(sourceFile);
}

function assertDocumentation(documentation, capabilityId) {
  assert.ok(
    documentation.length > 0,
    `${capabilityId} needs documented behavior`
  );
  for (const evidence of documentation) {
    assertExactKeys(evidence, ['file', 'patterns'], `${capabilityId} docs`);
    assertPatterns(
      read(evidence.file),
      evidence.patterns,
      `${capabilityId} documentation ${evidence.file}`,
      2
    );
  }
}

function assertFocusedTests(focusedTests, capabilityId) {
  const rootPackage = JSON.parse(read('package.json'));
  const frontendPackage = JSON.parse(read('frontend/package.json'));
  assert.ok(focusedTests.length > 0, `${capabilityId} needs a behavioral test`);
  for (const focusedTest of focusedTests) {
    assertExactKeys(
      focusedTest,
      ['file', 'runner', 'name', 'behaviorPatterns'],
      `${capabilityId} focused test`
    );
    if (focusedTest.runner === 'test:package') {
      assert.match(
        rootPackage.scripts['test:package'],
        new RegExp(
          `(?:^|&& )node --test ${focusedTest.file.replaceAll('/', '\\/')}(?: &&|$)`
        ),
        `${focusedTest.file} is not registered in test:package`
      );
    } else {
      assert.equal(focusedTest.runner, 'test:e2e');
      assert.equal(
        rootPackage.scripts['test:e2e'],
        'npm run e2e --workspace=frontend'
      );
      assert.match(frontendPackage.scripts.e2e, /^playwright test(?: |$)/);
      assert.match(
        focusedTest.file,
        /^frontend\/e2e\/.+\.spec\.ts$/,
        `${focusedTest.file} is not a Playwright-discovered spec`
      );
    }
    assertPatterns(
      findNamedTest(focusedTest),
      focusedTest.behaviorPatterns,
      `${capabilityId} behavior in ${focusedTest.name}`,
      2
    );
  }
}

function objectLiteralStringMap(relativePath, variableName) {
  const sourceFile = parsedSource(relativePath);
  const declaration = findUniqueNode(
    sourceFile,
    node =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      ts.isObjectLiteralExpression(node.initializer),
    `${relativePath} object ${variableName}`
  );
  const result = {};
  for (const property of declaration.initializer.properties) {
    assert.ok(
      ts.isPropertyAssignment(property),
      `${variableName} must contain only property assignments`
    );
    const key = property.name.getText(sourceFile).replaceAll(/['\"]/g, '');
    const value = literalValue(property.initializer, sourceFile);
    assert.equal(typeof value, 'string', `${variableName}.${key} must be text`);
    result[key] = value;
  }
  return result;
}

function bundledManifests() {
  return fs
    .readdirSync(path.join(repoRoot, 'plugins'))
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => ({
      name,
      definition: JSON.parse(read(path.join('plugins', name))),
    }));
}

function capabilityForPluginType(pluginType) {
  return contracts.capabilities.find(capability =>
    capability.pluginTypes.includes(pluginType)
  );
}

function manifestCapabilities(definition) {
  const result = new Set(Object.keys(definition.capabilities || {}));
  const primaryCapability = capabilityForPluginType(definition.type);
  if (primaryCapability) result.add(primaryCapability.id);
  return result;
}

function assertExecutableManifestDescriptor(descriptor, label) {
  assert.equal(
    typeof descriptor.endpoint,
    'string',
    `${label} needs an endpoint`
  );
  assert.ok(descriptor.endpoint.trim(), `${label} endpoint cannot be empty`);
  assert.ok(
    Array.isArray(descriptor.model_map) && descriptor.model_map.length > 0,
    `${label} needs a fallback model map`
  );
  assert.ok(
    descriptor.model_map.every(
      model => typeof model === 'string' && model.trim()
    ),
    `${label} model map contains an empty model`
  );
}

function assertManifestDefaults(name, capability, descriptor) {
  const config = descriptor.config || {};
  const optionDefaults = new Map([
    ['default_voice', 'voices'],
    ['default_format', 'formats'],
    ['default_size', 'sizes'],
    ['default_quality', 'qualities'],
    ['default_style', 'styles'],
    ['default_resolution', 'resolutions'],
    ['default_aspect_ratio', 'aspect_ratios'],
    ['default_duration', 'durations'],
  ]);
  const defaultKeys = Object.keys(config).filter(key =>
    key.startsWith('default_')
  );
  for (const defaultKey of defaultKeys) {
    if (defaultKey === 'default_generate_audio') {
      assert.equal(
        typeof config[defaultKey],
        'boolean',
        `${name} ${capability} ${defaultKey} must be boolean`
      );
      assert.equal(
        config.supports_audio,
        true,
        `${name} ${capability} ${defaultKey} requires supports_audio`
      );
      continue;
    }
    const optionsKey = optionDefaults.get(defaultKey);
    assert.ok(
      optionsKey,
      `${name} ${capability} ${defaultKey} has no validated option contract`
    );
    if (config[defaultKey] === undefined || config[defaultKey] === '') continue;
    assert.ok(
      Array.isArray(config[optionsKey]),
      `${name} ${capability} ${defaultKey} needs ${optionsKey}`
    );
    assert.ok(
      config[optionsKey].includes(config[defaultKey]),
      `${name} ${capability} ${defaultKey} is not in ${optionsKey}`
    );
  }
}

function assertContractShape(capability) {
  assertExactKeys(
    capability,
    [
      'id',
      'title',
      'pluginTypes',
      'catalogLabel',
      'execution',
      'ui',
      'documentation',
      'focusedTests',
      'manifest',
    ],
    `${capability.id || 'unknown'} contract`
  );
  assert.match(capability.id, /^[a-z]+$/);
  assert.ok(capability.title.trim());
  assert.ok(capability.pluginTypes.length > 0);
  assert.ok(capability.catalogLabel.trim());
  assertExactKeys(
    capability.manifest,
    ['exposure', 'requiresBundledDefinition'],
    `${capability.id} manifest contract`
  );
  assert.equal(capability.manifest.exposure, 'root-or-capability');
  assert.equal(capability.manifest.requiresBundledDefinition, true);
}

function publicRouteLabels(capability) {
  const registration = capability.execution.registration;
  return capability.execution.routes.map(route =>
    route.kind === 'websocket-message'
      ? `WS ${route.path} (${route.messageType})`
      : `${route.method.toUpperCase()} ${registration.mount}${route.path}`
  );
}

async function renderInventory(manifests) {
  const lines = [
    '---',
    "title: 'Capability Contracts'",
    "description: 'Generated inventory of every executable provider capability in Libre WebUI.'",
    'slug: /CAPABILITY_CONTRACTS',
    '---',
    '',
    '# Capability Contracts',
    '',
    '<!-- Generated from scripts/capability-contracts.json. Do not edit this table by hand. -->',
    '',
    'This inventory is enforced by `scripts/test-capability-contracts.mjs`. A',
    'provider capability is not complete until its schema and catalog mapping,',
    'executable handler, matching browser client, named UI action, documentation,',
    'focused behavioral test, and bundled manifests agree.',
    '',
    '| Capability | Plugin types | Executable route | Browser client | UI action | Documentation | Focused behavior tests | Bundled definitions |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  for (const capability of contracts.capabilities) {
    const definitions = manifests
      .filter(({ definition }) =>
        manifestCapabilities(definition).has(capability.id)
      )
      .map(({ definition }) => `\`${definition.id}\``)
      .join(', ');
    const discoveryOnly = (capability.execution.discoveryOnly || [])
      .map(discovery => `\`${discovery.label}\` (discovery only)`)
      .join('<br />');
    const routeCell = [
      ...publicRouteLabels(capability).map(value => `\`${value}\``),
      ...(discoveryOnly ? [discoveryOnly] : []),
    ].join('<br />');
    const clientCell = capability.execution.clientCalls
      .map(client => `\`${client.file}\``)
      .join('<br />');
    const testCell = capability.focusedTests
      .map(
        testEvidence =>
          `\`${testEvidence.file}\` (\`${testEvidence.runner}\`) — ${testEvidence.name}`
      )
      .join('<br />');
    const cells = [
      capability.title,
      capability.pluginTypes.map(value => `\`${value}\``).join(', '),
      routeCell,
      clientCell,
      `\`${capability.ui.file}\` — \`${capability.ui.action}\``,
      capability.documentation.map(value => `\`${value.file}\``).join('<br />'),
      testCell,
      definitions,
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }

  lines.push(
    '',
    '## Enforcement',
    '',
    'The package gate rejects undeclared schema or plugin types, stale catalog',
    'mappings, discovery-only routes presented as execution, handlers without a',
    'matching browser transport, UI actions without an invocation and visible',
    'trigger, documentation without capability-specific claims, tests without',
    'behavior inside the named test case, stale generated inventory, and invalid',
    'manifest endpoints, model maps, or defaults.',
    '',
    'Embedding generation executes through `POST /api/ollama/embed` and can route',
    'to a selected embedding plugin. `GET /api/embeddings/models` lists models;',
    'the gate records it as discovery-only and never accepts it as proof that',
    'embedding generation works.',
    '',
    'The source contract identifies each focused behavior test and its runner.',
    'Backend scripts must be registered in `test:package`; frontend specs must',
    'be discoverable by the Playwright-based `test:e2e` script. Live discovery',
    'may narrow a model catalog, but it does not create a new executable',
    'capability.',
    ''
  );
  return format(lines.join('\n'), {
    parser: 'markdown',
    proseWrap: 'preserve',
    singleQuote: true,
  });
}

test('evidence patterns reject empty and unrelated source', () => {
  assert.throws(
    () => assertPatterns('', ['executeProvider\\('], 'empty fixture'),
    /lacks/
  );
  assert.throws(
    () =>
      assertPatterns(
        'const unrelated = true;',
        ['executeProvider\\('],
        'unrelated fixture'
      ),
    /lacks/
  );
  assert.throws(
    () => compileEvidencePattern('(?:thing)?', 'empty-matching fixture'),
    /must not match empty text/
  );
});

test('capability contracts prove schema, routes, clients, UI, docs, and tests', () => {
  assert.equal(contracts.schemaVersion, 2);
  const ids = contracts.capabilities.map(capability => capability.id);
  assert.equal(new Set(ids).size, ids.length);

  const backendTypes = read('backend/src/types/index.ts');
  const frontendTypes = read('frontend/src/types/index.ts');
  const declaredIds = new Set(ids);
  const declaredPluginTypes = new Set(
    contracts.capabilities.flatMap(capability => capability.pluginTypes)
  );

  assert.deepEqual(
    new Set(interfaceOptionalKeys(backendTypes, 'PluginCapabilities')),
    declaredIds,
    'backend capability schema and contract inventory must match exactly'
  );
  assert.deepEqual(
    new Set(quotedUnionValues(frontendTypes, 'PluginCapabilityType')),
    declaredIds,
    'frontend capability schema and contract inventory must match exactly'
  );
  assert.deepEqual(
    new Set(quotedUnionValues(backendTypes, 'PluginType')),
    declaredPluginTypes,
    'backend plugin types and contract inventory must match exactly'
  );
  assert.deepEqual(
    new Set(quotedUnionValues(frontendTypes, 'PluginType')),
    declaredPluginTypes,
    'frontend plugin types and contract inventory must match exactly'
  );

  for (const capability of contracts.capabilities) {
    assertContractShape(capability);
    assertExecution(capability);
    assertUi(capability.ui, capability.id);
    assertDocumentation(capability.documentation, capability.id);
    assertFocusedTests(capability.focusedTests, capability.id);
  }
});

test('provider catalog and bundled manifests match executable contracts', () => {
  const catalogFile = 'frontend/src/utils/pluginProviderCatalog.ts';
  const primaryCatalog = objectLiteralStringMap(
    catalogFile,
    'PRIMARY_CAPABILITY'
  );
  const capabilityCatalog = objectLiteralStringMap(
    catalogFile,
    'PLUGIN_CAPABILITY'
  );
  const expectedPrimaryCatalog = Object.fromEntries(
    contracts.capabilities.flatMap(capability =>
      capability.pluginTypes.map(pluginType => [
        pluginType,
        capability.catalogLabel,
      ])
    )
  );
  const expectedCapabilityCatalog = Object.fromEntries(
    contracts.capabilities.map(capability => [
      capability.id,
      capability.catalogLabel,
    ])
  );
  assert.deepEqual(primaryCatalog, expectedPrimaryCatalog);
  assert.deepEqual(capabilityCatalog, expectedCapabilityCatalog);

  const manifests = bundledManifests();
  const declaredIds = new Set(
    contracts.capabilities.map(capability => capability.id)
  );
  const declaredPluginTypes = new Set(
    contracts.capabilities.flatMap(capability => capability.pluginTypes)
  );

  for (const { name, definition } of manifests) {
    assert.ok(
      declaredPluginTypes.has(definition.type),
      `${name} uses undeclared plugin type ${definition.type}`
    );
    assertExecutableManifestDescriptor(definition, `${name} root`);
    const primaryCapability = capabilityForPluginType(definition.type);
    assert.ok(primaryCapability, `${name} has no primary capability contract`);
    assertManifestDefaults(name, primaryCapability.id, definition);
    for (const [capability, descriptor] of Object.entries(
      definition.capabilities || {}
    )) {
      assert.ok(
        declaredIds.has(capability),
        `${name} uses undeclared capability ${capability}`
      );
      assertExecutableManifestDescriptor(descriptor, `${name} ${capability}`);
      assertManifestDefaults(name, capability, descriptor);
    }
  }

  for (const capability of contracts.capabilities) {
    const matching = manifests.filter(({ definition }) =>
      manifestCapabilities(definition).has(capability.id)
    );
    assert.ok(
      matching.length > 0,
      `${capability.id} requires a bundled executable definition`
    );
    for (const { name, definition } of matching) {
      const isPrimary = capability.pluginTypes.includes(definition.type);
      const descriptor = definition.capabilities?.[capability.id];
      assert.ok(
        isPrimary || descriptor,
        `${name} does not expose ${capability.id} at its root or capability block`
      );
      if (isPrimary) {
        assertExecutableManifestDescriptor(
          definition,
          `${name} ${capability.id} root`
        );
      }
      if (descriptor) {
        assertExecutableManifestDescriptor(
          descriptor,
          `${name} ${capability.id}`
        );
      }
    }
  }
});

test('generated capability inventory is current', async () => {
  const expected = await renderInventory(bundledManifests());
  if (process.env.UPDATE_CAPABILITY_CONTRACTS === '1') {
    fs.writeFileSync(inventoryPath, expected);
  }
  assert.equal(fs.readFileSync(inventoryPath, 'utf8'), expected);
});
