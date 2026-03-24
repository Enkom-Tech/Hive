# Plugin Design Rationale

Status: design report, not an implementation commitment

The current implementation defers a full plugin framework. The long‑horizon product specification requires an extensible core so that capabilities like knowledge management and revenue tracking can be added without modifying core logic. This document explains the design rationale for the target plugin system specified in `PLUGIN_SPEC.md`. It references prior art only at the level of general patterns; all conclusions are specific to this system.

## Executive Summary

We want a plugin system that is:

- Low‑friction for authors.
- Deterministic and observable for operators.
- Safe for a multi‑company control plane that enforces budgets, approvals, and auditability.

Conclusions:

- The system should provide a small, typed SDK, deterministic loading and precedence, low authoring friction, and clearly documented extension surfaces.
- Third‑party code should not run by default in the same trust domain as core business logic.
- The platform should distinguish multiple extension classes:
  - Trusted in‑process platform modules (adapters, storage, secrets, run‑log).
  - Out‑of‑process plugins for external systems and workspace tooling.
  - Plugin‑contributed tools for agents, with namespacing and capability gating.
  - Plugin‑shipped UI, mounted into host‑owned extension slots through a typed bridge.
  - Automation plugins listening to a typed event bus and running scheduled jobs.

## Existing Extension Surfaces

The current system already has extension‑like seams. Plugin work should unify and harden these, not replace them:

- Adapter registry for agent execution backends.
- UI adapter registry for adapter‑specific presentation.
- Storage provider registry for artifact and object storage.
- Secrets provider registry for secret backends.
- Run‑log store abstraction.
- Activity / live‑event streams.

These become first‑class extension points under the plugin platform.

## Desired Properties

What we want to *copy* as patterns:

- **SDK vs host separation**  
  Authors code against a stable, versioned SDK package. Host internals evolve behind a loader boundary.

- **Deterministic loading and precedence**  
  Explicit plugin sources, clear configuration merge rules, and well‑defined load order. Ambiguities must be rejected or explicitly resolved rather than implicitly "winning".

- **Low‑ceremony authoring**  
  A plugin is a module that exports a single factory function returning declared capabilities (hooks, tools, UI contributions, jobs). No large framework or inheritance hierarchy.

- **Typed definitions**  
  All extension surfaces (tools, events, config, UI schemas) are declared via typed interfaces or schemas, which drive validation and documentation.

- **Uniform shapes for built‑ins and plugins**  
  Platform modules and plugins present compatible interfaces wherever possible (e.g. adapters, storage providers, secret backends), to reduce special cases.

- **Incremental extension**  
  We introduce specific extension points as needed for concrete features, rather than designing for a large marketplace up front.

What we explicitly *do not* want:

- **Arbitrary in‑process code from third parties as default**  
  The control plane enforces security, approvals, budgets, and auditability. Untrusted code must not execute in the same trust boundary as core invariants.

- **Per‑workspace implicit plugin loading**  
  The unit of trust is the instance (one operator, many companies), not an arbitrary project directory. There should be no automatic loading from project-local paths.

- **Mutation hooks for core invariants**  
  Decisions around approvals, budgets, issue state machines, and audit logging remain core responsibilities. Plugins can observe and react, but not override.

- **Implicit override‑by‑name semantics**  
  Collisions must be explicit and opt‑in. Plugins should extend or delegate, not silently replace core routes, authentication, or audit logic.

- **Auto‑install and execute on configuration alone**  
  Installation and activation must be explicit operator actions. Server startup should not fetch, install, and execute third‑party code implicitly.

## Why This System Needs a Different Shape

| Topic                   | Local tooling model                    | This control plane                                  |
|-------------------------|----------------------------------------|-----------------------------------------------------|
| Primary unit            | Single user, local project             | Operator‑managed instance with multiple companies   |
| Trust assumption        | Local power user on own machine        | Operator responsible for all tenant companies       |
| Failure blast radius    | Single editor/session                  | Entire control plane and all tenant data            |
| Extension style         | Freely mutate local behavior           | Preserve governance, constraints, and auditability |
| Security model          | Host‑trusted user plugins              | Explicit capability boundaries and observability    |

Because a malfunctioning or malicious plugin can affect all companies on an instance, we design for explicit trust tiers and strong separation between core and extensions.

## Extension Classes

We distinguish several extension classes, each with its own runtime and trust level:

| Extension class   | Examples (non‑binding)                             | Runtime                                  | Trust level | Rationale                                         |
|-------------------|-----------------------------------------------------|------------------------------------------|-------------|---------------------------------------------------|
| Platform module   | Agent adapters, storage backends, secret backends, run‑log implementations | In‑process, same runtime as core         | High        | Tight coupling with low‑level platform concerns   |
| Connector plugin  | External task systems, analytics sinks, billing and metrics backends | Out‑of‑process, via HTTP/RPC             | Medium      | Integrate external systems with instance isolation|
| Workspace plugin  | File browsing, shell/terminal, source control, process tracking | Out‑of‑process, OS / workspace facing    | Medium      | Direct OS and filesystem access, isolated from core |
| UI contribution   | Dashboard panels, settings forms, detail views     | Plugin bundles mounted into host slots    | Medium      | Host controls placement, lifecycle, and bridge    |
| Automation plugin | Alerts, schedulers, synchronizers, webhooks       | Out‑of‑process, event‑driven             | Medium      | React to domain events without mutating invariants |

Third‑party plugins:

- Subscribe to typed domain events.
- Emit plugin‑namespaced events.
- Register webhooks, jobs, and tools.
- Ship UI bundles mounted into predefined slots.

They do **not**:

- Change approvals or core decision logic.
- Bypass budget enforcement.
- Rewrite audit logs or state machines.

Core invariants are *observable* but not *overrideable*.

## Recommended Architecture Decision

Instead of a generic, in‑process hook system, the platform should implement:

- A **plugin platform with explicit trust tiers**:
  - Platform modules (high‑trust, in‑process).
  - Out‑of‑process plugins with constrained capabilities and well‑typed protocols.

- **Plugin‑contributed agent tools**:
  - Namespaced identifiers.
  - Capability‑gated exposure to agents.
  - Typed input/output schemas.

- **Plugin‑shipped UI**:
  - Extension slots defined by the host.
  - Typed bridge for data exchange.
  - Structured error propagation and health reporting.

- **Typed event bus**:
  - Domain events emitted by core (e.g. issue lifecycle, cost events, approvals).
  - Plugin events under a `plugin.*` namespace.
  - Server‑side filtering and access control.

- **Lifecycle and observability**:
  - Install/upgrade/uninstall without host restart.
  - Structured logging and plugin health indicators.
  - Versioned SDK with multi‑version support and clear deprecation policy.

Core behavior remains defined by the product specification; plugins observe and extend but do not redefine core invariants.

## Concrete Next Steps

1. **Formalize extension model**  
   Write a concise RFC that distinguishes platform modules from plugins, and defines trust tiers and runtime boundaries.

2. **Introduce plugin manifest and configuration**  
   Add a typed plugin manifest to shared types, and define a `plugins` section in instance configuration (install location, enabled state, configuration schema).

3. **Build a typed event bus**  
   Wrap existing activity / live‑event streams into a typed domain event bus with:
   - Core‑owned event types for domain changes.
   - A `plugin.*` event namespace for cross‑plugin communication.
   - Server‑side filtering and access control.

4. **Implement MVP plugin host**  
   - Global installation and configuration.
   - Secret references.
   - Jobs and webhooks.
   - UI bundles and extension slots.
   - Auto‑generated settings UI from plugin config schema.
   - Typed error propagation over the host–plugin bridge.

5. **Add agent tool contributions**  
   Allow plugins to register namespaced tools callable by agents, scoped by capability and company.

6. **Add plugin observability**  
   - Structured logging via a provided logger context.
   - Health status surface (per plugin).
   - Internal health events on the event bus.

7. **Define shutdown and uninstall semantics**  
   - Graceful shutdown policy for long‑running plugin processes.
   - Data lifecycle rules for plugin state, including retention and deletion guarantees.

8. **Provide tooling for authors**  
   - A test harness package for local plugin testing.
   - A minimal "create‑plugin" template.

9. **Support hot plugin lifecycle**  
   - Install, upgrade, enable/disable, and configuration changes without restarting the core server, with clear failure modes and rollbacks.

10. **Establish SDK versioning policy**  
    - Semantic versioning for the plugin SDK.
    - Multi‑version compatibility window.
    - Deprecation and migration guidance.

11. **Grow first‑party plugins**  
    Implement a small set of workspace and connector plugins using this model (e.g. workspace file/terminal/git, external issue tracking, metrics dashboards) to validate the design and sharpen the extension surfaces.

---

The full target specification is in [PLUGIN_SPEC.md](./PLUGIN_SPEC.md).
