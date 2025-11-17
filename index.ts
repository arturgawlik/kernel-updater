import { ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { styleText } from "node:util";
import { createInterface } from "node:readline/promises";
import { mkdir, stat } from "node:fs/promises";
import { parse } from "node:path";
// TODO: consider own implementations
import { JSDOM } from "jsdom";
import sudo from "sudo";
import { Loader } from "./loader.ts";

const kKernelsUrl = "https://kernel.ubuntu.com/mainline/?C=N;O=D";
const kKernelDetailsUrl = (version) =>
  `https://kernel.ubuntu.com/mainline/v${version}/amd64/`;
const kKernelDownloadUrl = (version, file) =>
  `https://kernel.ubuntu.com/mainline/v${version}/amd64/${file}`;
const kTmpMain = "/var/tmp/kernel-updater/";
const kTmpFile = (version, fileName) => `${kTmpCatalog(version)}/${fileName}`;
const kTmpCatalog = (version) => `${kTmpMain}${version}`;
const kCheckLastKernelVersionsCount = 10;
const kDateReg =
  /^((\d{4})-(0[1-9]|1[0-2]|[1-9])-([1-9]|0[1-9]|[1-2]\d|3[0-1]))( )((\d*):(\d*))$/;
const kVersionReg = /^v(((\d*)(\.(\d*))?(\.(\d*))?)(-)?(rc\d)?)(\/)$/;
const kHostLinuxVersion = /\d*[.]\d*[.]\d*[-]\d*[-][a-z]*/;

const main = async () => {
  try {
    const availableKernelVersions = await fetchAndParseLastKernelVersions();
    printAvailableKernels(availableKernelVersions);
    const hostKernelVersion = await getHostKernelVersion();
    printHostKernel(hostKernelVersion);
    const versionToInstall = await askWhichVersionToInstall(
      availableKernelVersions
    );
    const loader = new Loader({
      version: versionToInstall,
      output: process.stdout,
    });
    const kernelsToDownloadUrls = await fetchKernelUrlsToDownload(
      versionToInstall
    );
    const mainCatalogOfDownloadedKernels = await downloadKernels(
      versionToInstall,
      kernelsToDownloadUrls,
      loader
    );
    // TODO: stop loader here to not mess with password request
    //       probably it could be improved by wrapping child processes stdio into some
    //       special visual frame
    loader.pauseLoader();
    await installKernels(mainCatalogOfDownloadedKernels);
    loader.pauseLoader();
    printSuccess();
  } catch (e) {
    if (e.code === "ABORT_ERR") {
      console.log("/n");
      return;
    }
    throw e;
  }
};

const cleanup = () => {
  spawn("rm", ["-r", kTmpMain]);
};
process.once("exit", cleanup);
process.once("SIGINT", cleanup); // CTRL+C

const fetchAndParseLastKernelVersions = async () => {
  const rawFetchedKernelListStr = await fetch(kKernelsUrl).then((r) =>
    r.text()
  );
  // TODO: do I need whole JSDOM lib which comes with 45 dependencies?
  //       maybe I could use some lighter lib, or even not use any aat all
  const jsDom = new JSDOM(rawFetchedKernelListStr);
  const dom = jsDom.window.document;
  const [tableWithKernelsDom] = dom.getElementsByTagName("table");
  const tableRowsDom = tableWithKernelsDom.getElementsByTagName("tr");
  const tableRowsTopDom = Array.from(tableRowsDom);
  const kernels = [];
  tableRowsTopDom.forEach((rowDom) => {
    if (kernels.length >= kCheckLastKernelVersionsCount) return;
    const tdDom = Array.from(rowDom.getElementsByTagName("td"));
    if (!tdDom || !tdDom.length) return;
    const rawVersion = tdDom[1].textContent?.trim();
    const rawLastModified = tdDom[2].textContent?.trim();
    if (!kVersionReg.test(rawVersion) || !kDateReg.test(rawLastModified))
      return;
    const version = kVersionReg.exec(rawVersion).at(1);
    const lastModified = new Date(rawLastModified);
    kernels.push({
      version,
      lastModified,
    });
  });
  return kernels;
};

const getHostKernelVersion = async () => {
  const rawUnameResult: string = await new Promise(async (res, rej) => {
    try {
      const childProcess = spawn("uname", ["-a"]);
      let buffer = "";
      for await (const chunk of childProcess.stdout) {
        buffer += chunk;
      }
      res(buffer);
    } catch (e) {
      rej(e);
    }
  });
  const unameResult = kHostLinuxVersion.exec(rawUnameResult).at(0);
  return unameResult;
};

const printHostKernel = (hostKernelVersion) => {
  console.log("Your kernel version: " + styleText("bold", hostKernelVersion));
};

const printAvailableKernels = (lastKernelVersions) => {
  console.table(lastKernelVersions);
};

const parseAndValidatePickedIndex = (pickedIndex) => {
  if (!pickedIndex) exitErr();
  const parsed = Number(pickedIndex);
  if (
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > kCheckLastKernelVersionsCount - 1
  )
    exitErr();
  return parsed;
};

const askWhichVersionToInstall = async (availableKernelVersions) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const rawPickedIndex = await rl.question(
    "Pick index to install (or ctrl+c to kill the process):"
  );
  rl.close();
  const pickedIndex = parseAndValidatePickedIndex(rawPickedIndex);
  const versionToInstall = availableKernelVersions[pickedIndex];
  return versionToInstall;
};

const fetchKernelUrlsToDownload = async (versionToInstall) => {
  // TODO: change back to fetching from web
  const rawFetchedKernelListStr = await fetch(
    kKernelDetailsUrl(versionToInstall.version)
  ).then((r) => r.text());
  // TODO: do I need whole JSDOM lib which comes with 45 dependencies?
  //       maybe I could use some lighter lib, or even not use any aat all
  const jsDom = new JSDOM(rawFetchedKernelListStr);
  const dom = jsDom.window.document;
  const [tableWithKernelsDom] = dom.getElementsByTagName("table");
  const tableRowsDom = tableWithKernelsDom.getElementsByTagName("tr");
  const tableRowsArrayDom = Array.from(tableRowsDom);
  const getHref = (index) => {
    return Array.from(
      Array.from(
        tableRowsArrayDom[index].getElementsByTagName("td")
      )[1].getElementsByTagName("a")
    )[0].href;
  };
  const kernelUrls = [];
  const indexesToDownload = [6, 7, 8, 9];
  for (const index of indexesToDownload) {
    const file = getHref(index);
    kernelUrls.push({
      url: kKernelDownloadUrl(versionToInstall.version, file),
      fileName: file,
    });
  }

  return kernelUrls;
};

const downloadKernels = async (kernelVersion, kernelUrls, loader: Loader) => {
  let mainCatalogOfDownloadedKernels: string;
  const getLoaderText = (kernelUrl) =>
    `Downloading ${styleText("bold", kernelUrl.fileName)}`;
  // TODO: probably this should be asynchronous
  for (const kernelUrl of kernelUrls) {
    loader.updateLoaderText(getLoaderText(kernelUrl));
    // TODO: maybe some smarter solution than overriding it while iterating in loop
    let filePath: string;
    await new Promise(async (res, rej) => {
      // TODO: handle progress
      filePath = kTmpFile(kernelVersion.version, kernelUrl.fileName);
      if (!mainCatalogOfDownloadedKernels) {
        const parsedFilePath = parse(filePath);
        mainCatalogOfDownloadedKernels = parsedFilePath.dir;
      }
      await createMissingCatalogs(filePath);
      const fileWriteStream = createWriteStream(filePath);
      const childProcess = spawn("curl", [
        "--fail", // do not save HTTP errors to files
        kernelUrl.url,
      ]);

      // TODO: handle errors from child process
      childProcess.stdout.pipe(fileWriteStream);
      childProcess.once("exit", (code, signal) => {
        fileWriteStream.close();
        if (code !== 0) {
          exitErr();
        }
        res(filePath);
      });
    });
    const fileContent = await stat(filePath);
    if (fileContent.size === 0) {
      // if curl does not saved anything that means error
      exitErr(`Error while downloading "${kernelUrl.url}" file.`);
    }
  }
  return mainCatalogOfDownloadedKernels;
};

const installKernels = async (mainCatalogOfDownloadedKernels) => {
  await new Promise((res, rej) => {
    const dpkgWildPath = mainCatalogOfDownloadedKernels + "/";
    const childProcess: ChildProcess = sudo([
      "dpkg",
      "--install",
      "--recursive",
      dpkgWildPath,
    ]);
    childProcess.stdout.pipe(process.stdout);
    childProcess.stderr.pipe(process.stderr);
    process.stdin.pipe(childProcess.stdin);
    childProcess.once("exit", () => res(null));
  });
};

const createMissingCatalogs = async (filePathStr) => {
  const path = parse(filePathStr);
  const dirFragments = path.dir.split("/").slice(1);
  let currDir = "";
  for (const dirFragment of dirFragments) {
    currDir += "/" + dirFragment;
    await stat(currDir).catch(() => mkdir(currDir));
  }
};

const printSuccess = () => {
  console.log("Succeed ✨");
};

const printFail = (msg?: string) => {
  if (msg) console.log(`Error with message "${msg}" 💣`);
  else console.log("Error 💣");
};

const exitErr = (msg?: string) => {
  printFail(msg);
  process.exit(1);
};

main();
