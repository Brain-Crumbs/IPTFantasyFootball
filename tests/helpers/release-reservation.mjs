import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";

export async function assertReleaseWaitsForReservation(t, lock, taskId, lockPath) {
  const reservationPath = `${lockPath}.release-reservation`;
  // Prestart the competing process so the lock wait measures its critical
  // section independently of the time it takes Node to start.
  const childScript = `
    const { existsSync, unlinkSync } = require("node:fs");
    const path = ${JSON.stringify(reservationPath)};
    const poll = setInterval(() => {
      if (!existsSync(path)) return;
      clearInterval(poll);
      setTimeout(() => {
        unlinkSync(path);
        process.disconnect();
      }, 20);
    }, 2);
    process.send("ready");
  `;
  const child = spawn(process.execPath, ["-e", childScript], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  try {
    const [ready] = await Promise.race([
      once(child, "message", { signal: t.signal }),
      closed.then(() => { throw new Error("Reservation helper exited before readiness."); }),
    ]);
    assert.equal(ready, "ready");
    lock.withLock(taskId, () => {
      writeFileSync(reservationPath, "", { encoding: "utf8", flag: "wx" });
    });
    assert.equal(existsSync(reservationPath), false, "release must wait for the competing reservation");
    assert.equal(existsSync(lockPath), false, "release must remove the held lock");
    assert.equal(await closed, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
}
