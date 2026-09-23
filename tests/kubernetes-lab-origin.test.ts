import test from "node:test";
import assert from "node:assert/strict";
import { labRequestOriginAllowed } from "../src/lib/recruit/kubernetes-lab-origin";

test("public browser origin is accepted behind a hosting proxy without trusting request headers", () => {
  const internal = "https://internal-lambda.example";
  const publicSite = "https://www.uniqassess.org";
  assert.equal(labRequestOriginAllowed(publicSite, internal, publicSite), true);
  assert.equal(labRequestOriginAllowed(publicSite, internal, publicSite + "/"), true);
  for (const origin of [internal, "https://attacker.example", "https://www.uniqassess.org.attacker.example", "http://www.uniqassess.org", "null", "", publicSite + "/"]) {
    assert.equal(labRequestOriginAllowed(origin, internal, publicSite), false);
  }
});

test("origin configuration fails closed and direct local development retains same-origin checks", () => {
  const local = "http://localhost:3000";
  assert.equal(labRequestOriginAllowed(local, local, ""), true);
  assert.equal(labRequestOriginAllowed("https://attacker.example", local, ""), false);
  for (const configured of ["bad", "file:///tmp/site", "https://user:secret@example.org", "https://example.org/path", "https://example.org?x=1", "https://example.org#x"]) {
    assert.equal(labRequestOriginAllowed("https://example.org", local, configured), false);
  }
  assert.equal(labRequestOriginAllowed(null, local, ""), true);
});
