import assert from "node:assert/strict";
import { assertCommandAllowed } from "../dist/security.js";

assert.doesNotThrow(() => assertCommandAllowed("git status"));
assert.doesNotThrow(() => assertCommandAllowed("Write-Output 'diskpart is a word, not a command'"));

for (const command of [
  "diskpart",
  "Write-Output ok; diskpart",
  "Write-Output ok | shutdown /s",
  "Write-Output ok && bcdedit",
  "Write-Output ok\nRestart-Computer"
]) {
  assert.throws(
    () => assertCommandAllowed(command),
    /blocked by Rob Desktop Commander safety policy/,
    `expected dangerous command to be blocked: ${command}`
  );
}

console.log(JSON.stringify({ ok: true, securityGuardRegressionCases: 5 }));
