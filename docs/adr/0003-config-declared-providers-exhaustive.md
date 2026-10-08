# Config-declared providers and models are exhaustive

The seat must work on a censored network, so ModelsDev reads only its disk cache or bundled snapshot and never fetches implicitly (explicit refresh only: `opencode models --refresh`). A non-empty provider `models` block is exhaustive, and env keys, auth.json, plugin providers, and autoload loaders only supply credentials for providers declared in the config; `getSmallModel` never infers a model. This is a deliberate deviation from upstream's registry-merge behavior — do not "fix" it back.
