// Flightplan: on the host the Langfuse sender finds real keys, so a test that starts a Claude turn sent a real
// span. Tests point the sender at a missing file; a test that wants the sender sets FP_LANGFUSE_ENV itself.
process.env.FP_LANGFUSE_ENV = "/nonexistent/fp-langfuse-env";
