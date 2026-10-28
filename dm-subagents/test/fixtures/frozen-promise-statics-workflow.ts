import { runWorkflowScript } from "../../src/workflows/scripted-workflow.ts";

try {
  const result = await runWorkflowScript({
    script: `const [a, b] = await Promise.all([runs.run("a", { agent: "scout", task: "ping" }), runs.run("b", { agent: "scout", task: "ping" })]);
const [c] = await Promise.allSettled([runs.run("c", { agent: "scout", task: "ping" })]);
const d = await Promise.resolve(new Promise((resolve) => resolve("ready")));
return { outputs: [a.output, b.output, c.value.output], d };`,
    async launch(key) { return { key, ok: true, output: "pong", artifactPaths: [] }; },
    async status(key) { return { key, ok: true, output: "pong", artifactPaths: [] }; },
  });
  process.stdout.write(JSON.stringify({ ok: true, value: result.value }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
}
