import { test } from "node:test";
import { Loader } from "../loader.ts";
import { Writable } from "node:stream";
import { wait } from "../utils.ts";

const dummyVersion = { latestModified: new Date(), version: "6.17.1" };

test("Loader", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const waitTime = 2000;

  test("should write generic loading message", async () => {
    const { buffer, mockOutput } = mockBuffer();
    new Loader({ version: dummyVersion, output: mockOutput });
    await fakeWait(t, waitTime);
    t.assert.snapshot(buffer);
  });

  test("should write updated loading message", async () => {
    const { buffer, mockOutput } = mockBuffer();
    const loader = new Loader({ version: dummyVersion, output: mockOutput });
    loader.updateLoaderText("test updated text");
    await fakeWait(t, waitTime);
    t.assert.snapshot(buffer);
  });

  test("should pause and then unpause", async () => {
    const { buffer, mockOutput } = mockBuffer();
    const loader = new Loader({ version: dummyVersion, output: mockOutput });
    loader.pauseLoader();
    await fakeWait(t, waitTime);
    t.assert.snapshot(buffer);
    loader.unPauseLoader();
    await fakeWait(t, waitTime);
    t.assert.snapshot(buffer);
  });
});

function mockBuffer() {
  let buffer = [];
  const mockOutput = new Writable({
    write(chunk, encoding, callback) {
      buffer.push(chunk.toString());
      callback();
    },
  });
  return { buffer, mockOutput };
}

async function fakeWait(t: test.TestContext, waitTime: number) {
  setImmediate(() => t.mock.timers.tick(waitTime));
  await wait(waitTime);
}
