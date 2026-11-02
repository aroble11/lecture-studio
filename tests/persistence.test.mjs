import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

class FakeIndexedDB {
  data = new Map();
  failNext = false;
  upgraded = false;

  open() {
    const request = {};
    const db = {
      createObjectStore() {},
      close() {},
      transaction: () => {
        const tx = { error: null, oncomplete: null, onerror: null, onabort: null, objectStore: null };
        const operation = (run) => {
          const req = { result: undefined, error: null };
          setTimeout(() => {
            if (this.failNext) {
              this.failNext = false;
              req.error = new Error("storage blocked");
              tx.onerror?.();
              return;
            }
            req.result = run();
            tx.oncomplete?.();
          }, 0);
          return req;
        };
        const store = {
          get: (key) => operation(() => this.data.get(key)),
          put: (value, key) => operation(() => { this.data.set(key, value); return key; }),
          delete: (key) => operation(() => { this.data.delete(key); }),
        };
        tx.objectStore = () => store;
        return tx;
      },
    };
    setTimeout(() => {
      request.result = db;
      if (!this.upgraded) {
        this.upgraded = true;
        request.onupgradeneeded?.();
      }
      request.onsuccess?.();
    }, 0);
    return request;
  }
}

function loadSessionStore(indexedDB = new FakeIndexedDB()) {
  const source = ts.transpileModule(fs.readFileSync("lib/session-store.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const compiled = { exports: {} };
  vm.runInNewContext(source, { module: compiled, exports: compiled.exports, indexedDB, Blob, console, setTimeout });
  return { store: compiled.exports, indexedDB };
}

function loadProfileStore(initial) {
  const values = new Map();
  if (initial !== undefined) values.set("lecture-studio:profile", initial);
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const source = ts.transpileModule(fs.readFileSync("lib/profile-store.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const compiled = { exports: {} };
  vm.runInNewContext(source, { module: compiled, exports: compiled.exports, localStorage });
  return { store: compiled.exports, values };
}

const session = (audioRevision = null) => ({
  version: 1,
  audioRevision,
  keywords: "",
  lesson: { subject: "", grade: "", objective: "", standards: "" },
  turns: [],
  durationMs: 0,
  refImage: null,
  diagram: null,
  result: null,
  resultSource: null,
  resultDiagram: null,
  privacy: false,
});

test("session write failures are returned to the UI", async () => {
  const { store, indexedDB } = loadSessionStore();
  indexedDB.failNext = true;
  const result = await store.saveSession(session());
  assert.equal(result.ok, false);
  assert.match(result.error, /storage blocked/);
});

test("session read failures are distinguishable from an empty saved session", async () => {
  const { store, indexedDB } = loadSessionStore();
  indexedDB.failNext = true;
  const result = await store.loadSession();
  assert.equal(result.ok, false);
  assert.match(result.error, /storage blocked/);
});

test("audio is restored only when its revision matches the session", async () => {
  const { store } = loadSessionStore();
  const blob = new Blob(["audio"], { type: "audio/webm" });
  assert.equal((await store.saveAudio({ blob, label: "Lecture", revision: "audio-1" })).ok, true);
  assert.equal((await store.saveSession(session("audio-1"))).ok, true);
  const matched = await store.loadSession();
  assert.equal(matched.ok, true);
  assert.equal(matched.value.audio.revision, "audio-1");

  assert.equal((await store.saveAudio({ blob, label: "Other", revision: "audio-2" })).ok, true);
  const mismatched = await store.loadSession();
  assert.equal(mismatched.ok, true);
  assert.equal(mismatched.value.audio, null);
  assert.match(mismatched.warning, /did not match/);
});

test("oversized audio is removed and reported while session data remains saveable", async () => {
  const { store } = loadSessionStore();
  const small = new Blob(["audio"]);
  await store.saveAudio({ blob: small, label: "Old", revision: "old" });
  const oversized = { size: store.MAX_SAVED_AUDIO_BYTES + 1 };
  const result = await store.saveAudio({ blob: oversized, label: "Large", revision: "large" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "too-large");
  assert.equal(result.maxBytes, 100 * 1024 * 1024);
  assert.equal((await store.saveSession(session(null))).ok, true);
  const loaded = await store.loadSession();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.value.audio, null);
});

test("audio failures are returned and can succeed on a later retry", async () => {
  const { store, indexedDB } = loadSessionStore();
  const audio = { blob: new Blob(["audio"]), label: "Lecture", revision: "audio-1" };
  indexedDB.failNext = true;
  const failed = await store.saveAudio(audio);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "error");
  assert.equal((await store.saveAudio(audio)).ok, true);
});

test("invalid core saved data is rejected instead of reaching the UI", async () => {
  const { store, indexedDB } = loadSessionStore();
  indexedDB.data.set("current", { ...session(), turns: [{ startMs: 100, endMs: 50, text: "bad" }] });
  const loaded = await store.loadSession();
  assert.equal(loaded.ok, false);
  assert.match(loaded.error, /invalid/i);
});

test("invalid optional saved artifacts are removed while lecture data is preserved", async () => {
  const { store, indexedDB } = loadSessionStore();
  indexedDB.data.set("current", {
    ...session(),
    turns: [{ startMs: 0, endMs: 1000, text: "A valid transcript" }],
    refImage: { dataUrl: "data:image/jpeg;base64,AA==", width: 1, height: 1, name: "reference.jpg" },
    diagram: { kind: "objects", summary: "bad", items: [{ n: 99 }], model: "x", seconds: 1 },
  });
  const loaded = await store.loadSession();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.value.turns[0].text, "A valid transcript");
  assert.equal(loaded.value.durationMs, 1000);
  assert.equal(loaded.value.diagram, null);
  assert.match(loaded.warning, /image labels/);
});

test("invalid profile shapes are ignored with a visible warning", () => {
  const { store } = loadProfileStore(JSON.stringify({ subject: ["not text"], grade: "10" }));
  const loaded = store.loadProfile();
  assert.equal(loaded.profile, null);
  assert.match(loaded.warning, /invalid saved teaching profile/i);
  assert.equal(store.isEmptyProfile(loaded.profile), true);
});

test("legacy profiles receive missing fields but cannot exceed current limits", () => {
  const { store } = loadProfileStore(JSON.stringify({ subject: "Biology", grade: "9" }));
  const loaded = store.loadProfile();
  assert.deepEqual({ ...loaded.profile }, { subject: "Biology", grade: "9", style: "", classNotes: "" });
  assert.equal(store.saveProfile({ subject: "x".repeat(101), grade: "", style: "", classNotes: "" }), false);
});

test("profile deletion removes only the browser profile and reports blocked storage", () => {
  const values = new Map([["lecture-studio:profile", "saved"]]);
  let fail = false;
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => { if (fail) throw new Error("blocked"); values.delete(key); },
  };
  const source = ts.transpileModule(fs.readFileSync("lib/profile-store.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const compiled = { exports: {} };
  vm.runInNewContext(source, { module: compiled, exports: compiled.exports, localStorage });
  assert.equal(compiled.exports.clearProfile(), true);
  assert.equal(values.has("lecture-studio:profile"), false);
  values.set("lecture-studio:profile", "saved");
  fail = true;
  assert.equal(compiled.exports.clearProfile(), false);
  assert.equal(values.has("lecture-studio:profile"), true);
});
