/**
 * UDP discovery responder — lets MCP servers announce themselves to the aggregator.
 * Zero dependencies, uses built-in Node.js dgram module.
 */

import dgram from "dgram";

export interface DiscoveryResponderOptions {
  name: string;
  description: string;
  tools: unknown[];
  port?: number;
  listenPort?: number;
}

export function createDiscoveryResponder({
  name,
  description,
  tools,
  port = 9099,
  listenPort = 9099,
}: DiscoveryResponderOptions): dgram.Socket {
  const manifest = JSON.stringify({
    type: "announce",
    name,
    description,
    tools,
    port,
  });

  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

  socket.on("message", (data: Buffer, rinfo: dgram.RemoteInfo) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "discovery") {
        console.log(`Discovery request from ${rinfo.address}:${rinfo.port}, announcing`);
        socket.send(manifest, rinfo.port, rinfo.address);
      }
    } catch {
      // ignore malformed messages
    }
  });

  socket.on("error", (err: Error) => {
    console.error("Announce socket error:", err.message);
  });

  socket.bind(listenPort, "0.0.0.0", () => {
    socket.addMembership("239.255.99.1");
    console.log(`Discovery responder listening on UDP :${listenPort} (multicast 239.255.99.1) for ${name}`);
  });

  return socket;
}
