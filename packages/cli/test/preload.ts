// The suite may itself run inside an agent shell, which carries OPENCODE_SESSION_ID and
// OPENCODE_SESSION_TOKEN. Tests exercise the operator CLI, so clear those before any test file
// loads; the dedicated auth tests set the variables explicitly and restore them.
delete process.env.OPENCODE_SESSION_ID
delete process.env.OPENCODE_SESSION_TOKEN
