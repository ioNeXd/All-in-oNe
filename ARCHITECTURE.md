# Architecture

## Purpose

This document describes the architectural principles and direction of the project.

It intentionally distinguishes between what exists today, what we intend to build, and what has not yet been decided.

The architecture is expected to evolve as requirements, implementation experience, and technical evidence emerge.

## Current Architecture

The project is currently in the initial reconstruction phase.

The application architecture has not been implemented yet.

At this stage, this document describes architectural intent rather than existing application components.

## Architectural Principles

### 1. Clear boundaries

Responsibilities should have explicit boundaries.

A component should not need to know implementation details that belong to another boundary.

### 2. Low coupling

Components should depend on stable contracts rather than unnecessary implementation details.

### 3. High cohesion

A component should have a focused and understandable responsibility.

### 4. Composition over unnecessary complexity

Prefer simple composition and explicit contracts before introducing complex inheritance hierarchies or infrastructure.

### 5. Public contracts

Modules should communicate through public contracts rather than internal implementation details.

### 6. Evidence-driven architecture

New abstractions and layers should be justified by real requirements or demonstrated problems.

> Evidence → need → abstraction

### 7. Testability

Business rules and important architectural behavior should be testable without unnecessary dependencies on external systems.

### 8. Evolution

The architecture is not treated as immutable.

It may change when new evidence shows that the current design no longer serves the project's requirements.

## Target Architecture

The current architectural direction is:

```text
                         OBSIDIAN
                            │
                            ▼
                  ADAPTERS / BOUNDARY
                            │
                            ▼
                       CORE / KERNEL
                            │
                            ▼
                       PUBLIC API
                            │
                            ▼
                         MODULES
```

This diagram represents the target direction, not an implementation that already exists.

### Obsidian

The external platform and runtime environment.

Obsidian-specific APIs should be isolated at appropriate boundaries instead of leaking unnecessarily into domain logic.

### Adapters / Boundary

The boundary between the application and Obsidian.

Its responsibility is to translate between platform-specific mechanisms and application-level contracts where such separation provides real value.

### Core / Kernel

The common application infrastructure and contracts.

The Core should remain independent from module-specific implementation details.

Potential responsibilities may include lifecycle, registries, events, settings, commands, persistence, logging, and other shared capabilities.

These responsibilities are intentionally candidates, not commitments. Each should be introduced only when a concrete requirement justifies it.

### Public API

The stable contract through which modules interact with the common system.

The public API should expose capabilities intentionally rather than exposing Core internals.

### Modules

Independent units of functionality.

The preferred dependency direction is:

```text
Module → Public API → Core
```

Modules should not depend on Core internals.

Modules should not directly depend on other modules unless a future architectural decision explicitly establishes a stable contract for such communication.

## Dependency Direction

The target dependency direction is:

```text
External Platform
       ↓
Adapters
       ↓
Core
       ↑
Public Contracts
       ↑
Modules
```

The important principle is that implementation details should not unnecessarily become dependencies across boundaries.

The exact dependency graph will be validated as implementation begins.

## Current vs Target

It is important to distinguish these states:

| State | Meaning |
|---|---|
| Current Architecture | What actually exists |
| Target Architecture | Direction we intend to investigate and build |
| Roadmap | Possible steps toward the target |
| Open Questions | Decisions that still require investigation |
| Architectural Decision | A decision that has been consciously made |

## Roadmap

The roadmap is intentionally small and provisional.

- [ ] Establish the minimal Obsidian plugin bootstrap.
- [ ] Define the first meaningful application boundary.
- [ ] Identify the first real module boundary.
- [ ] Define the smallest useful public contract.
- [ ] Evaluate whether a module registry is necessary.
- [ ] Evaluate whether an event bus is necessary.
- [ ] Establish appropriate testing boundaries.
- [ ] Revisit the architecture based on implementation evidence.

Items may be removed, changed, or replaced as the project evolves.

## Open Questions

The following questions are intentionally unresolved:

- What is the smallest useful Core?
- Which responsibilities truly belong in the Core?
- How should modules be discovered and registered?
- What lifecycle guarantees should modules receive?
- When is an Event Bus justified?
- How much of Obsidian should be exposed through adapters?
- Which capabilities belong in the public API?
- How should external modules be supported?
- Which architectural rules should be enforced automatically by tests?

These questions should be answered through requirements, investigation, prototypes, and implementation experience rather than speculation.

## Architectural Decision Guidelines

Before introducing a new abstraction, dependency, or layer, ask:

1. What problem are we solving?
2. Is the problem real and observable?
3. Who owns the responsibility?
4. Who needs to know about whom?
5. Which direction should the dependency flow?
6. Is there a stable contract?
7. Does the abstraction reduce complexity or merely move it?
8. What are the trade-offs?
9. Can the decision be tested?
10. What evidence would make us revisit the decision?

## Documentation Rule

This document must not silently turn intentions into facts.

When describing a future capability, make its status explicit.

Prefer:

> "The project intends to evaluate an Event Bus."

over:

> "The Core provides an Event Bus."

until the latter is actually true.

The architecture should remain understandable, honest, and small enough to evolve with the project.
