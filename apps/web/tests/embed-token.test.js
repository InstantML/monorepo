import assert from "node:assert/strict";
import test from "node:test";

import {
  forbiddenEmbedQueryKeys,
  parseEmbedTokenLocation,
} from "../src/embed-token.js";

const VALID_TOKEN = `instantml_embed_${"a".repeat(43)}`;

test("parseEmbedTokenLocation accepts exactly one fragment token and scrubs URL state", () => {
  const parsed = parseEmbedTokenLocation({
    pathname: "/embed/runs/86d2",
    search: "",
    hash: `#token=${VALID_TOKEN}`,
  });

  assert.equal(parsed.token, VALID_TOKEN);
  assert.equal(parsed.cleanUrl, "/embed/runs/86d2");
  assert.equal(parsed.error, "");
});

test("parseEmbedTokenLocation rejects duplicate or malformed fragment tokens", () => {
  assert.equal(
    parseEmbedTokenLocation({
      pathname: "/embed/runs/86d2",
      search: "",
      hash: `#token=${VALID_TOKEN}&token=${VALID_TOKEN}`,
    }).token,
    "",
  );
  assert.equal(
    parseEmbedTokenLocation({
      pathname: "/embed/runs/86d2",
      search: "",
      hash: "#token=instantml_embed_short",
    }).token,
    "",
  );
});

test("parseEmbedTokenLocation refuses query-string bearer material before using a valid fragment", () => {
  const parsed = parseEmbedTokenLocation({
    pathname: "/embed/runs/86d2",
    search: "?api_key=instantml_secret&safe=1",
    hash: `#token=${VALID_TOKEN}`,
  });

  assert.equal(parsed.token, "");
  assert.equal(parsed.cleanUrl, "/embed/runs/86d2");
  assert.match(parsed.error, /query string/);
  assert.deepEqual(forbiddenEmbedQueryKeys("?token=x&api-key=y&safe=1"), ["token", "api-key"]);
});
