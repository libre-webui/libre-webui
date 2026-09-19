---
sidebar_position: 66
title: 'Cordis Plugin Authoring'
description: 'Write Cordis plugins for the Libre WebUI host: services, injection, lifecycle ownership, and safe teardown.'
slug: /CORDIS_PLUGIN_AUTHORING
keywords:
  [
    cordis plugin,
    plugin authoring,
    cordis service,
    dependency injection,
    plugin lifecycle,
    libre webui plugin,
  ]
---

# Cordis Plugin Authoring

The Cordis bridge mounts a plugin tree whose rows are named in
`cordis.patch.yml`. Adding a capability means writing a Cordis plugin and adding
a row, not editing Libre WebUI's source. This page covers the conventions the
host relies on.

Read [Cordis Bridge](./64-CORDIS_BRIDGE.md) first for how the tree fits
together, and [Cordis Configuration](./65-CORDIS_CONFIGURATION.md) for the row
fields.

## The two plugin shapes

A Cordis plugin is either a function or an object with an `apply` method. Both
are resolved by the Loader.

```js
// Function form.
export function apply(ctx, config) {
  // ...
}
```

```js
// Object form, when the plugin also declares dependencies.
export const name = 'my-plugin';
export const inject = ['tools'];

export function apply(ctx, config) {
  // ...
}
```

The Loader reads the **module namespace**, so a plugin loaded from a row needs
`apply` (and `inject`) as named exports. A default export also works, but the
shipped DSH plugins use the named form, so prefer it for consistency.

## Declaring dependencies

`inject` is the whole dependency mechanism. Cordis does not run the plugin until
every named service exists, and re-runs it if one is withdrawn and restored.

```js
export const inject = ['tools', 'systemPrompt'];

export function apply(ctx, config) {
  // `ctx.tools` and `ctx.systemPrompt` are guaranteed present here.
}
```

Two consequences matter:

- **A missing service is not an error.** The row stays pending forever, silently.
  That is why `GET /api/cordis/health` reports per-service state instead of a
  single boolean.
- **Injection is the ordering mechanism.** You never sequence rows yourself; the
  shipped composition's row order carries no load semantics.

For a dependency that is optional at author time, use `ctx.inject` inside
`apply` instead. It runs the callback immediately when the services already
exist and again whenever they appear:

```js
export function apply(ctx) {
  ctx.inject(['typert'], inner => {
    inner.typert.lookups.register('session', {/* ... */});
  });
}
```

`ctx.inject` runs synchronously when its dependencies are already present, so a
plugin mounted late still registers during `apply` rather than on a later tick.

## Publishing a service

Extend `Service` and pass the service name to `super`. The name is the property
consumers read, and the registration is owned by the plugin's fiber.

```js
import { Service } from '@deepseek-ai/cordis';

export class WidgetRegistry extends Service {
  static provide = 'widgets';

  constructor(ctx) {
    super(ctx, 'widgets');
    this.widgets = new Map();
  }

  register(widget) {
    // Return the disposer so the caller's fiber owns the entry.
    return this.ctx.effect(() => {
      this.widgets.set(widget.id, widget);
      return () => this.widgets.delete(widget.id);
    }, 'widgets.register()');
  }
}

export default WidgetRegistry;
```

Prefer a `Service` subclass over `ctx.reflect.provide(...)` for anything with
behaviour: the subclass registers the name once, exposes typed methods, and is
withdrawn automatically with its fiber.

## Owning side effects

**Every side effect must be owned.** This is the single rule that makes the
bridge's rollback guarantee true, and the easiest one to break.

| Side effect                | Owned by                              |
| -------------------------- | ------------------------------------- |
| A service registration     | The plugin's fiber, automatically     |
| An event listener          | `ctx.on(...)` inside the plugin       |
| A resource needing cleanup | `ctx.effect(() => disposer)`          |
| A timer                    | `ctx.setTimeout` / `ctx.setInterval`  |
| A tool registration        | Return the disposer from `ctx.effect` |

`ctx.effect` takes a function that returns a disposer, or a generator yielding
disposers:

```js
ctx.effect(() => {
  const registration = ctx.llm.registerAdapter(['my-route'], adapter);
  return () => registration();
}, 'my-adapter.register');
```

The label is a diagnostic, not decoration: it is what names the effect when
teardown fails.

Adopting a resource that Cordis cannot know about — a socket, a worker, a
handle — means disposing it yourself:

```js
ctx.effect(() => {
  const worker = startWorker();
  return () => worker.terminate();
}, 'my-plugin.worker');
```

### What breaks rollback

- Registering on a **different** context than the one passed to `apply`. The
  service then outlives its row.
- Creating a timer with the global `setTimeout`. It keeps the process alive and
  is never cancelled.
- Subscribing to an external emitter without unsubscribing in the disposer.
- Writing to a module-level singleton. Disposal cannot undo it, so the value
  stays visible after the row is removed — make it per-fiber state instead.

## Configuration

A plugin's config is the `config` mapping of its row. Declare a schema so a
typo fails at mount instead of silently using a default:

```js
import z from '@deepseek-ai/schemastery';

export const Config = z.object({
  route: z.string().required(),
  maxRetries: z.number().default(2),
});

export function apply(ctx, config) {
  // `config` is validated before this runs.
}
```

Config values may use `!!js` in the composition document. The expression is
evaluated in the owning row's fiber with the loader context in scope:
`process.env` and `ctx.get(...)` work, `import.meta` does not. `name` is never
evaluated, so a row's module specifier must be a literal string.

## A complete example

The repository ships two working fixtures used by the bridge's test suite.
Both are small enough to copy.

**A model adapter** — `scripts/fixtures/cordis/fake-adapter.mjs` registers a
provider route on `ctx.llm`, returns the registration's disposer from an effect,
and answers every request with fixed text. That is the whole provider contract:
declare `inject`, register, own the registration.

**A lifecycle probe** — `scripts/fixtures/cordis/lifecycle-probe.mjs` publishes
a service, subscribes to an event, and records its own teardown, which is how
the rollback test proves both actually stop existing.

Mount either by adding a row:

```yaml
- id: my-adapter
  name: './scripts/fixtures/cordis/fake-adapter.mjs'
  config:
    route: my-route
```

Relative specifiers resolve against the composition file's directory; bare
specifiers resolve through the backend package.

## Testing a plugin

The bridge suites show the pattern:

- `scripts/test-cordis-bridge.mjs` mounts a real tree in a temporary directory,
  asserts service availability, exercises the contract, and asserts that
  disposal withdrew the service and released the listener.
- `scripts/test-cordis-bridge-http.mjs` drives the routes over a real HTTP
  server, including NDJSON streaming.

To test a plugin without a provider, set `model.provider: none` and mount your
plugin plus the engine rows. To test one that depends on `llm`, mount a fixture
adapter on a route no real adapter claims, and set `model.provider: none` so the
host does not mount a competing adapter for that route.

A plugin is only correct if removing its row leaves no trace. Assert that:
register, observe, dispose, observe again.

## Checklist

- [ ] `apply` and `inject` are named exports.
- [ ] The service is a `Service` subclass with a stable `provide` name.
- [ ] Every registration returns a disposer, and every disposer is returned from
      `ctx.effect`.
- [ ] Timers come from `ctx`, not from globals.
- [ ] Mutable state lives on the instance, not on a module singleton.
- [ ] Config is validated by a schema.
- [ ] No secret appears in the composition or settings document.
- [ ] A test asserts the plugin leaves nothing behind after disposal.
