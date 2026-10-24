/**
 * The project-root marker vocabulary the startup scan resolves (#4560).
 * `findNearestProjectRoot` (clients/startup-scan.ts) is the owner that walks it;
 * the list lives here so the test harness can prove, at compile time, that the
 * marker `setupTestEnvironment` plants is one of them
 * (`TEST_FIXTURE_ROOT_MARKER` in tests/clients/test-utils.ts) without importing
 * the scan module into the harness.
 *
 * This is NOT the only marker list in the tree, and it must not claim to be:
 * `clients/analysis-root.ts` declares a wider `PROJECT_MARKERS` that adds
 * `pom.xml`, `build.gradle`, `Gemfile`, and `mix.exs`. The divergence is safe
 * for the fixture marker because the two lists answer different questions —
 * where a startup scan may warm, and which directory a heavyweight analyzer may
 * adopt — and `resolveAnalysisRootPath` refuses a candidate equal to
 * `os.tmpdir()` itself, so a tmp root that carries a build marker cannot become
 * an analysis root either. Fold them only when one adapter needs both answers.
 */
export const PROJECT_ROOT_MARKERS = [
	".git",
	"package.json",
	"pyproject.toml",
	"Cargo.toml",
	"go.mod",
	"composer.json",
] as const;
