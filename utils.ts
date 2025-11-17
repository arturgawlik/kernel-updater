export const wait = (ms: number, unref = false) =>
  new Promise((res) => {
    const timeout = setTimeout(res, ms);
    if (unref) {
      timeout.unref();
    }
  });
