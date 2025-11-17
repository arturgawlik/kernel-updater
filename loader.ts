import { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import { wait } from "./utils.ts";
import { clearLine, cursorTo } from "node:readline";
import EventEmitter, { once } from "node:events";
import { pipeline } from "node:stream/promises";

type Version = {
  version: string;
  latestModified: Date;
};

const Events = {
  unpause: "unpause",
};

export class Loader {
  private refreshRateMs = 750;
  private output: Writable;
  private dots = "";
  private version: Version;
  private loaderText = "";
  private mainLoaderStream: Readable;
  private firstPrint = true;
  private loaderPaused = false;
  private internalEventsBus = new EventEmitter();
  constructor(options: { version: Version; output: Writable }) {
    this.version = options.version;
    this.loaderText = `Calculating files to fetch for ${styleText(
      "bold",
      this.version.version
    )}`;
    this.output = options.output;
    this.initMainLoaderStream();
    this.initPipeline();
  }
  updateLoaderText(text: string) {
    this.loaderText = text;
  }
  pauseLoader() {
    this.loaderPaused = true;
    this.clearLine();
  }
  unPauseLoader() {
    this.loaderPaused = false;
    this.internalEventsBus.emit(Events.unpause);
  }
  private initMainLoaderStream() {
    const that = this;
    this.mainLoaderStream = new Readable({
      async read() {
        if (!that.firstPrint) {
          await wait(that.refreshRateMs, true);
        } else {
          that.firstPrint = false;
        }
        if (that.loaderPaused) {
          await once(that.internalEventsBus, Events.unpause);
        }
        if (that.dots.length < 3) that.dots += ".";
        else that.dots = ".";
        const msg = `${that.loaderText} ${that.dots}`;
        that.clearLine();
        this.push(msg);
      },
    });
  }
  private async initPipeline() {
    await pipeline(this.mainLoaderStream, this.output);
  }
  private clearLine() {
    clearLine(this.output, 0);
    cursorTo(this.output, 0);
  }
}
