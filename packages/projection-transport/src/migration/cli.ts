#!/usr/bin/env node
// The old replay path bypasses accepted-baseline admission; preserve its modules for audit, not execution.
process.stderr.write('Projection rebuild migration CLI is disabled pending accepted-baseline audit.\n');
process.exitCode = 1;
