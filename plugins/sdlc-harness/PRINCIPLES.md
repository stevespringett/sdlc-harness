# Build principles

How code is built in every repo on the SDLC (decision 0006). Edit this file to fit your team; keep one line per principle. A repo's `CLAUDE.md` may narrow a principle with a named exception and its reason, never contradict it. Where `RULES.md` speaks, it wins.

## Design

- **High cohesion, low coupling** (the root): what changes together lives together; modules meet through small, stable interfaces.
- **Separation of concerns**: one module, one job. Domain logic never mixes with I/O, transport, or UI.
- **Deep modules**: a small interface over a rich implementation. Hide complexity; never pass it to the caller.
- **Composition over inheritance**: build behavior from parts. Inherit only for a true is-a with a stable base.
- **KISS**: the simplest design that meets the acceptance criteria.
- **YAGNI**: build for this ticket, not a guessed future.
- **DRY by the rule of three**: an abstraction waits for three real callers. The one exception: an interface at an external boundary (a vendor, a store, the network) may have a single implementation, so dependency inversion works.
- **Law of Demeter**: talk to direct collaborators only. No call chains into another module's internals.
- **Least astonishment**: names, defaults, and behavior do what a reader expects.

## SOLID

- **Single responsibility**: a module has one reason to change.
- **Open/closed**: extend behavior by adding code, not by editing stable code.
- **Liskov substitution**: every implementation can stand in for its interface without surprising the caller.
- **Interface segregation**: small interfaces per client. No caller depends on a method it does not use.
- **Dependency inversion**: domain code depends on abstractions it owns; adapters at the edge implement them.

## Correctness

- **Make illegal states unrepresentable**: types and schemas rule out invalid data, instead of checks scattered later.
- **Parse, don't validate**: turn untrusted input into a trusted type once, at the boundary. The inside trusts it.
- **Fail fast**: stop at the first broken invariant with a clear error. A check that cannot run fails closed.
- **Idempotency**: every write, job, and handler is safe to retry.
- **Immutability and pure functions**: prefer values that do not change and functions without side effects. Push effects to the edges.

## Architecture

- **Modular monolith first**: one deployable with enforced module boundaries. Split a service out only for a measured reason.
- **Bounded contexts follow the domain**: module boundaries match the domain's language, not technical layers.
- **Design for failure**: every remote call has a timeout, retries back off, and a failed dependency degrades one feature, not the app.
- **Contract-first APIs**: write the contract before the code. No silent breaking changes: version or deprecate first.
- **Observability by design**: structured logs, metrics, and traces ship with the feature.
- **Reversible decisions where possible**: prefer choices that are cheap to undo. Record the rest as an ADR (`RULES.md`, Decisions and ADRs).

## Security

- **Secure by design and by default**: the default configuration is the safe one; a risky option is opt-in.
- **Least privilege**: users, services, and AI agents get only the access a task needs, only while it needs it.
- **Defense in depth**: no single control is all that stands between an attacker and the data.
- **Zero trust**: authenticate and authorize every request, internal ones included. Network location grants nothing.
- **All input is untrusted, LLM output included**: parse it, bound it, and never execute or render it raw.
- **Never roll your own crypto**: use vetted libraries and platform primitives.

## UX

- **WCAG 2.2 AA** is the baseline for every user-facing UI.
- **Consistency through the design system**: use its components and tokens. A new pattern goes into the system first.
- **Errors say what happened and how to fix it**, in the user's words, never a stack trace or a bare code.
- **Undo beats confirmation**: in a user-facing UI, make an action reversible instead of asking "are you sure?". The SDLC's approval and go gates are process, not UI.
- **No dark patterns**: nothing that pushes a user into a choice they would not make knowingly.

## Testing

- **Test behavior, not implementation**: tests drive public interfaces and assert outcomes, so a refactor keeps them green.
- A test that pins a structural rule (a fitness or guard test) is allowed when the repo's `CLAUDE.md` names it.

## Delivery

- How we deliver (trunk, small changes, automation, the gates) is `RULES.md`. It is not restated here.
