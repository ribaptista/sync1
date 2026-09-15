// tsc only compiles .ts files -- it never copies non-.ts assets, so the
// .sql migration files src/db/connection.ts loads relative to its own
// compiled location (dist/db/migrations/{state,cache}/*.sql) need to be
// copied there explicitly. Run as the "postbuild" npm lifecycle script,
// right after "build" (tsc). Uses only node:fs so no devDependency is
// needed for something this small, and works identically on every
// platform this project supports (see docs/platform-setup.md).
import { cpSync } from "node:fs";

for (const dir of ["state", "cache"]) {
  cpSync(`src/db/migrations/${dir}`, `dist/db/migrations/${dir}`, { recursive: true });
}
