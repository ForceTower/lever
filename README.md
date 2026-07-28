# lever

Self-hosted remote config: typed parameters, targeted values, instant propagation — one
deployment serving every project.

Lever replaces Firebase Remote Config for apps that want to own their config plane. The
server evaluates targeting rules and hands clients fully resolved values; SDKs (Kotlin,
Swift, TypeScript) stay thin: fetch-and-activate, disk cache, code defaults as the floor,
and a server-sent-events nudge for instant rollout.

**Status:** pre-implementation. The founding scope and every "why" behind it live in
[docs/research/0001-product-scope/research.md](docs/research/0001-product-scope/research.md).
