// A runtime's way to Lumiverse that a test can pull, as a process that was killed has none: its
// socket closes under it and nothing of it gets through afterwards. A runtime a test only closes is
// still there in the test's own process, and opens its socket again the moment anything of it asks
// the extension something (a job's end to write, say), which no dead process does.

import type { FakeLumiverse } from "./fake-lumiverse";

export interface Plug {
  /** What `RigOptions.wire` takes: the fake's own HTTP routes and event socket, until the plug is pulled. */
  wire(lumiverse: FakeLumiverse): Pick<FakeLumiverse, "http" | "openSocket">;
  /** The process is gone: every socket it had open closes, and no request or socket of its is let through again. */
  pull(): void;
}

export function plug(): Plug {
  let pulled = false;
  const open: { close(): void }[] = [];
  const gone = (): Error => new Error("the runtime's process is gone");
  return {
    wire: (lumiverse) => ({
      http: async (request) => {
        if (pulled) throw gone();
        return lumiverse.http(request);
      },
      openSocket: (url, events) => {
        if (pulled) throw gone();
        const socket = lumiverse.openSocket(url, events);
        open.push(socket);
        return socket;
      },
    }),
    pull() {
      pulled = true;
      for (const socket of open.splice(0)) socket.close();
    },
  };
}
